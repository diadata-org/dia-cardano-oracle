# Feeder Push-Policy Configuration — Reference

Every way the feeder can be configured to decide **when to push an oracle update**,
and what each combination does to push frequency, max staleness, and tx volume.
Grounded in the code: [`src/router/policy.ts`](../../offchain/feeder/src/router/policy.ts)
(the gate), [`src/cron/cron-service.ts`](../../offchain/feeder/src/cron/cron-service.ts)
(the heartbeat), and [`src/config/validate.ts`](../../offchain/feeder/src/config/validate.ts)
(the schema).

## Contents

- [TL;DR — what is configured right now](#tldr--what-is-configured-right-now)
- [The knobs](#the-knobs)
- [The pre-gate (always on): timestamp monotonicity](#the-pre-gate-always-on-timestamp-monotonicity)
- [How the policy picks a mode](#how-the-policy-picks-a-mode)
- [All combinations and their effects](#all-combinations-and-their-effects)
- [Gotchas (read these)](#gotchas-read-these)
- [Where it is configured](#where-it-is-configured)
- [Reasons you see on the "Intents filtered" dashboard](#reasons-you-see-on-the-intents-filtered-dashboard)

## TL;DR — what is configured right now

Active Preview client (`config/routers/preview/client-a.yaml`):

```yaml
price_deviation: "0.1%"   # push as soon as the price moves >= 0.1%
time_threshold: 10m       # OR-gate time arm; also the cron heartbeat cadence
cron: true                # heartbeat ON — guarantees an update even with no live intent
```

→ **Mode: classic OR-gate + cron heartbeat.** A pair pushes when the price moves
≥ 0.1% **OR** when 10 minutes have elapsed; `cron: true` makes the 10-minute arm fire
even if no new DIA intent arrives, so **max staleness ≈ 10 min**. There is **no
`max_staleness` key set** — and with `time_threshold > 0` it would be ignored anyway
(see Gotchas). The 10-minute ceiling here comes from `time_threshold` + `cron`, not
from `max_staleness`.

## The knobs

| Key | Type | Meaning |
| --- | --- | --- |
| `price_deviation` | percent string (`"0.1%"`) | Push when `abs(new − last) / last × 100 ≥ this`. The "price moved enough" arm. `oldPrice == 0` is treated as passing (no divide-by-zero). |
| `time_threshold` | duration string (`10m`, `30s`, `1h30m`) | The periodic arm: a live intent passes once this much time has elapsed since the last update. Also the **cron heartbeat cadence**. `"0s"`/absent = the time arm is OFF. |
| `max_staleness` | duration string | Deviation-only-mode ceiling: force a push once the pair has gone this long without an update. **Only consulted when `time_threshold` is absent or `0`** (see Gotchas). |
| `cron` | bool | Master switch for the cron liveness heartbeat for this destination. When `true`, the cron service re-submits the latest cached intent every `time_threshold`, so a **flat** pair still updates without waiting for a live DIA intent. Without it, a flat pair only updates when a live intent happens to arrive after the time arm opens. |

All durations use the Spectra format (`ms`/`s`/`m`/`h`/`d`, composable like `1h30m10s`).
A negative value throws; `0s` is the explicit "disabled" sentinel.

## The pre-gate (always on): timestamp monotonicity

Before any threshold is considered, every intent is checked against the last cached
state for that pair:

- **`timestamp_regression`** — new timestamp `<` last → dropped (can't go backwards).
- **`timestamp_duplicate`** — new timestamp `==` last → dropped (nothing new).
- **First-ever update for a pair** (no cached state) → always passes.

These are not configurable and apply in every mode. They cost no tx (filtered before build).

## How the policy picks a mode

From `createPolicyGate` in `policy.ts`:

```
deviationOnlyMode = (time_threshold is absent OR 0) AND max_staleness is set
```

- **If `time_threshold > 0`** → the **classic OR-gate** runs (`time_threshold` OR
  `price_deviation`). `max_staleness` is **ignored**.
- **Else if `max_staleness` is set** → **deviation-only mode** (`price_deviation` OR
  `age > max_staleness`); there is no short periodic arm.
- **Else (nothing set)** → every monotonic intent passes (push-everything).

## All combinations and their effects

`T` = time_threshold, `D` = price_deviation, `M` = max_staleness, `C` = cron.
"Max staleness" = the longest a flat pair can go without an on-chain update.

| # | T | D | M | C | Mode | Pushes when | Max staleness | Tx volume |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | ✅ | ✅ | – | ✅ | **OR-gate + heartbeat** ← **CURRENT** | move ≥ D **or** every T (cron fires even with no live intent) | **= T** (10 m) | medium — bounded |
| 2 | ✅ | ✅ | – | ❌ | OR-gate, no heartbeat | move ≥ D **or** a live intent arrives after T elapsed | ~T **if** live intents keep arriving; unbounded if the source goes silent | medium |
| 3 | ✅ | – | – | ✅ | Periodic heartbeat only | every T | = T | steady, T-paced (no fast path on a price spike) |
| 4 | ✅ | – | – | ❌ | Time arm, no heartbeat | a live intent arrives after T elapsed | unbounded if source silent | low–medium |
| 5 | – | ✅ | – | – | Deviation-only, **no ceiling** | move ≥ D only | **UNBOUNDED** ⚠️ a flat pair never updates | lowest — risky |
| **6** | – | ✅ | ✅ | – | **Deviation-only mode (B6)** | move ≥ D **or** age > M | **= M** | low — fewest tx with a safety ceiling |
| 7 | – | – | ✅ | – | Pure staleness | age > M only | = M | minimal |
| 8 | – | – | – | – | Push-everything | every monotonic intent | n/a (always fresh) | **highest** |

Notes:
- Rows 1–4 are the **`time_threshold > 0`** family (classic OR-gate; `M` ignored).
- Rows 5–7 are the **deviation-only family** (`T` off, `M` is the ceiling). Cron is
  inert here because the cron cadence reads `time_threshold`, which is `0`.
- **Row 5 is a foot-gun**: deviation alone with no staleness ceiling means a pair whose
  price never moves enough is never refreshed. Always pair `price_deviation` with either
  `time_threshold`+`cron` (row 1) or `max_staleness` (row 6).
- **Row 6 is the "fewer tx" mode** the project added (B6): only real price moves push,
  with `max_staleness` as the backstop — no periodic heartbeat traffic.

## Gotchas (read these)

1. **`max_staleness` is ignored when `time_threshold > 0`.** The two are mutually
   exclusive ceilings. To use `max_staleness` (row 6), set `time_threshold: 0s` (or omit
   it). With our current `time_threshold: 10m`, adding `max_staleness` does nothing.
2. **The 10-minute ceiling today is `time_threshold` + `cron`, not `max_staleness`.**
   `cron: true` is what makes a flat pair update every 10 min; without `cron`, a flat pair
   in the OR-gate only ticks when a live intent arrives after 10 min (row 2).
3. **`cron: true` is meaningless without `time_threshold > 0`** — the cron cadence is the
   `time_threshold`. In deviation-only mode (`time_threshold: 0s`) the heartbeat has no
   cadence; `max_staleness` is the ceiling instead.
4. **`time_threshold: "0s"` is "disabled", not "every event".** It turns the time arm OFF
   (and tells cron this destination has no cadence). Push-everything is row 8 (no knobs).
5. **`price_deviation` alone never expires** (row 5). Pair it with a ceiling.

## Where it is configured

Per destination, inside each router file:

- Preview: `offchain/feeder/config/routers/preview/<client>.yaml`
- Mainnet: `offchain/feeder/config/routers/mainnet/<client>.yaml`

The knobs live under `destinations[].{ price_deviation, time_threshold, max_staleness, cron }`;
the subscribed pairs live under `triggers.conditions` (a `Symbol in [...]` list). The
cron service is also globally gated by the `cron` infrastructure block
(`infrastructure.<network>.yaml`, see `CronConfig` in `src/config/types.ts`).

## Reasons you see on the "Intents filtered" dashboard

The `dia_bridge_intents_filtered_total{reason}` metric (the "Intents filtered (5m, by
reason)" panel) maps directly to this policy:

| reason | Source | Meaning |
| --- | --- | --- |
| `condition` | router trigger `conditions` | Intent is not one of this client's subscribed pairs (the DIA registry firehose minus your feeds). Usually the largest line — expected. |
| `time_threshold` | policy OR-gate | Subscribed pair, but within the time window and price didn't move enough. |
| `price_deviation` | policy OR-gate | Subscribed pair, enough time has not passed and the price move was below the threshold. |
| `max_staleness` | deviation-only mode | Within the staleness window and the price move was below the threshold (row 6/7 only). |
| `timestamp_duplicate` | pre-gate | Same timestamp as the last update. |
| `timestamp_regression` | pre-gate | Older timestamp than the last update. |

None of these cost a tx or a fee — they are filtered before anything is built. A high
filtered count (especially `condition`) is healthy: it is the policy doing its job.
