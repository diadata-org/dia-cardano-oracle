# Feeder Push-Policy Configuration — Reference

Every way the feeder can be configured to decide **when to push an oracle update**,
what each combination does to push frequency / max staleness / tx volume, and how
the cron heartbeat can be **timed** so updates batch together. Grounded in the code:
[`src/router/policy.ts`](../../offchain/feeder/src/router/policy.ts) (the gate),
[`src/cron/cron-service.ts`](../../offchain/feeder/src/cron/cron-service.ts) (the
heartbeat), [`src/submitter/coalescer.ts`](../../offchain/feeder/src/submitter/coalescer.ts)
(the batcher), and [`src/config/validate.ts`](../../offchain/feeder/src/config/validate.ts)
(the schema).

## Contents

- [TL;DR — what is configured right now](#tldr--what-is-configured-right-now)
- [The three questions a push answers](#the-three-questions-a-push-answers)
- [The knobs](#the-knobs)
- [The pre-gate (always on): timestamp monotonicity](#the-pre-gate-always-on-timestamp-monotonicity)
- [How the policy picks a mode](#how-the-policy-picks-a-mode)
- [All combinations and their effects](#all-combinations-and-their-effects)
- [Heartbeat timing: per-pair vs aligned](#heartbeat-timing-per-pair-vs-aligned)
- [Gotchas (read these)](#gotchas-read-these)
- [Where it is configured](#where-it-is-configured)
- [Reasons you see on the "Intents filtered" dashboard](#reasons-you-see-on-the-intents-filtered-dashboard)

## TL;DR — what is configured right now

Active Preview client (`config/routers/preview/client-test-01-router-default.yaml`) + cron block
(`infrastructure.preview.yaml::cron_service`):

```yaml
price_deviation: "0.5%"   # push as soon as the price moves >= 0.5%
time_threshold: 10m       # OR-gate time arm; also the cron heartbeat cadence
cron: true                # heartbeat ON — guarantees an update even with no live intent
aligned_heartbeat: true   # all pairs' heartbeats fire on the same 10m boundary → one batch
```

→ **Mode: classic OR-gate + aligned cron heartbeat.** A pair pushes when the price
moves ≥ 0.5% **OR** when the 10-minute heartbeat is due; `cron: true` makes the
heartbeat fire even if no new DIA intent arrives, so **max staleness ≈ 10 min**.
`aligned_heartbeat: true` makes all pairs' heartbeats land on the **same** 10-minute
wall-clock boundary, so they coalesce into **one batch every 10 min** instead of
ten small staggered transactions. There is **no `max_staleness` key set** — and with
`time_threshold > 0` it would be ignored anyway (see Gotchas).

## The three questions a push answers

The knobs feel tangled until you see that each one answers a **different**
question. They do not overlap:

```
1. Should THIS intent push now?      → price_deviation (D)  + timestamp monotonicity (always on)
2. How stale can a FLAT pair get?    → time_threshold (T)   [heartbeat modes]
                                        or max_staleness (M) [deviation-only mode]
3. Is the heartbeat ON for flat pairs?→ cron (C)
4. WHEN does the heartbeat fire?      → aligned_heartbeat (A): per-pair (default) | aligned
```

Question 4 (`aligned_heartbeat`) is a **timing-only** layer: it changes *when within
the staleness tolerance* the heartbeat fires — which decides whether pairs batch
together — **without** changing whether or how-stale a pair pushes. It is orthogonal
to D / T / M / C.

## The knobs

| Key | Type | Lives in | Meaning |
| --- | --- | --- | --- |
| `price_deviation` | percent string (`"0.5%"`) | router dest | Push when `abs(new − last) / last × 100 ≥ this`. The "price moved enough" arm. `oldPrice == 0` is treated as passing (no divide-by-zero). |
| `time_threshold` | duration string (`10m`, `30s`, `1h30m`) | router dest | The periodic arm: a live intent passes once this much time has elapsed since the last update. Also the **cron heartbeat cadence**. `"0s"`/absent = the time arm is OFF. |
| `max_staleness` | duration string | router dest | Deviation-only-mode ceiling: force a push once the pair has gone this long without an update. **Only consulted when `time_threshold` is absent or `0`** (see Gotchas). |
| `cron` | bool | router dest | Master switch for the cron liveness heartbeat for this destination. When `true`, the cron service re-submits the latest cached intent so a **flat** pair still updates without a live DIA intent. |
| `aligned_heartbeat` | bool | `cron_service` (infra) | **Timing of the heartbeat.** `false` (default) = per-pair cadence (each pair relative to its own last confirm → staggered, small batches). `true` = all pairs due on the same `time_threshold` boundary → one batch. Only affects `time_threshold` heartbeat destinations; ignored in deviation-only mode. |

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

```
                 ┌─ time_threshold > 0 ? ── YES ─► HEARTBEAT MODES (rows 1-4)
                 │                                  ceiling = time_threshold
   intent ──────►┤                                  └─ aligned_heartbeat APPLIES here
                 │
                 └─ NO (T = 0/absent) ──┬─ max_staleness set? ─ YES ─► DEVIATION-ONLY (rows 5-7)
                                        │                              ceiling = max_staleness
                                        │                              └─ aligned_heartbeat IGNORED
                                        └─ NO ─► PUSH-EVERYTHING (row 8)
```

- **If `time_threshold > 0`** → the **classic OR-gate** runs (`time_threshold` OR
  `price_deviation`). `max_staleness` is **ignored**. `aligned_heartbeat` **applies**.
- **Else if `max_staleness` is set** → **deviation-only mode** (`price_deviation` OR
  `age > max_staleness`); no short periodic arm. `aligned_heartbeat` is **ignored**.
- **Else (nothing set)** → every monotonic intent passes (push-everything).

## All combinations and their effects

`T` = time_threshold, `D` = price_deviation, `M` = max_staleness, `C` = cron,
`A` = aligned_heartbeat. "Max staleness" = the longest a flat pair can go without an
on-chain update.

| # | T | D | M | C | Mode | Pushes when | Max staleness | Tx volume | `A` applies? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | ✅ | ✅ | – | ✅ | **OR-gate + heartbeat** ← **CURRENT** | move ≥ D **or** every T | **= T** (10 m) | medium — bounded | **✅ yes** |
| 2 | ✅ | ✅ | – | ❌ | OR-gate, no heartbeat | move ≥ D **or** live intent after T | ~T if intents keep arriving | medium | ⚠️ no cron → inert |
| 3 | ✅ | – | – | ✅ | Periodic heartbeat only | every T | = T | steady, T-paced | **✅ yes** |
| 4 | ✅ | – | – | ❌ | Time arm, no heartbeat | live intent after T | unbounded if source silent | low–medium | ⚠️ no cron → inert |
| 5 | – | ✅ | – | – | Deviation-only, **no ceiling** | move ≥ D only | **UNBOUNDED** ⚠️ | lowest — risky | ❌ no |
| **6** | – | ✅ | ✅ | – | Deviation-only (B6) | move ≥ D **or** age > M | = M | low — safety ceiling | ❌ no |
| 7 | – | – | ✅ | – | Pure staleness | age > M only | = M | minimal | ❌ no |
| 8 | – | – | – | – | Push-everything | every monotonic intent | n/a | **highest** | ❌ no |

Notes:
- Rows 1–4 are the **`time_threshold > 0`** family (classic OR-gate; `M` ignored;
  `A` applies when cron is on).
- Rows 5–7 are the **deviation-only family** (`T` off, `M` is the ceiling). Cron and
  `A` are inert — the cron cadence reads `time_threshold`, which is `0`.
- **Row 5 is a foot-gun**: deviation alone with no staleness ceiling means a pair whose
  price never moves enough is never refreshed. Always pair `price_deviation` with either
  `time_threshold`+`cron` (row 1) or `max_staleness` (row 6).
- **Row 6 is the "fewer tx" mode** the project added (B6): only real price moves push,
  with `max_staleness` as the backstop — no periodic heartbeat traffic.
- **`A` only changes batching, never the mode or the max staleness.** Turning it on
  in rows 1/3 keeps the same "pushes when" and the same ceiling — it only makes the
  heartbeats land together.

## Heartbeat timing: per-pair vs aligned

`aligned_heartbeat` decides **when** the cron heartbeat fires within the staleness
tolerance — and that is what controls whether pairs batch. The deviation arm is
**independent** in both cases (a ≥ D move pushes immediately, outside the batch).

```
PER-PAIR (A=false): each pair counts T from ITS OWN last confirm → timers drift apart
 10:00  10:01  10:02  10:03  10:04 ...      each tick ~1 pair crosses its ceiling
   │      │      │      │      │
  tx[BTC] tx[ETH] tx[ADA] tx[DOGE] tx[LTC] ...   → ~10 txs of 1 pair over 10 min
                                                   avg ≈ 1.3 pairs/tx

ALIGNED (A=true): all pairs due at the shared T boundary → one tick collects them
 10:00 ▼boundary          10:10 ▼boundary          10:20 ▼boundary
  tx[BTC,ETH,ADA,DOGE,LTC,NEIRO,SHIB,USDC,USDT,XVG]  tx[…10…]   tx[…10…]
  = 1 tx of 10 pairs            = 1 tx of 10          = 1 tx of 10
  + (mid-period) BTC moves 0.7% @10:04 → tx[BTC]   ← deviation arm, separate
```

How aligned works (in [`cron-service.ts`](../../offchain/feeder/src/cron/cron-service.ts)):
a pair is "due" once the shared boundary `floor(now / T) * T` is newer than its last
confirm. At the first tick after each boundary, **every** pair whose last update
predates the boundary is due in the same tick, so the [coalescer](../../offchain/feeder/src/submitter/coalescer.ts)
gathers them (within `coalesce_window`) into one batch.

What `aligned_heartbeat` does and does **not** touch:

| Aspect | Affected by `aligned_heartbeat`? |
| --- | --- |
| Deviation push (event-driven, ≥ D) | ❌ No — still immediate, outside the batch |
| Timestamp monotonicity pre-gate | ❌ No |
| Cron heartbeat with `time_threshold` (rows 1, 3) | ✅ **Yes** — aligns resubmissions to the boundary |
| `max_staleness` backstop (rows 6, 7) | ❌ No (out of scope; `max_staleness` stays per-pair) |
| Max staleness guarantee | ❌ No — still ≈ T |
| Batch-size cap (`max_batch_size`) | ❌ No |

Things worth knowing:
- **Max staleness is unchanged (≈ T).** A pair confirmed at time *t* is due again at
  the next boundary, at most T later — same ceiling as per-pair.
- **A pair that pushed by deviation rejoins the batch** at the next boundary (its
  confirm predates that boundary), so deviation traffic does not permanently desync
  the heartbeat — it just adds a separate mid-period tx for the volatile pair.
- **A pair with no newer-nonce intent at the boundary is skipped** (`skipped_already_fresh`
  / `skipped_superseded`) — you cannot re-push a duplicate, so a quiet pair simply
  isn't in that period's batch.
- **Load is spikier**: one larger batch every T instead of a trickle. The receiver
  lane is serial, so a batch of N pairs is still one tx — cheaper per pair, not more
  contention.

## Gotchas (read these)

1. **`max_staleness` is ignored when `time_threshold > 0`.** The two are mutually
   exclusive ceilings. To use `max_staleness` (row 6), set `time_threshold: 0s` (or omit
   it). With the current `time_threshold: 10m`, adding `max_staleness` does nothing.
2. **`aligned_heartbeat` is ignored when `time_threshold` is `0`/absent** (deviation-only
   mode) — the symmetric rule to #1. The heartbeat alignment only has meaning where there
   *is* a `time_threshold` heartbeat. In deviation-only mode the `max_staleness` backstop
   stays per-pair.
3. **The 10-minute ceiling today is `time_threshold` + `cron`, not `max_staleness`.**
   `cron: true` is what makes a flat pair update every 10 min; `aligned_heartbeat` only
   changes *when within that window* it fires (all together vs staggered).
4. **`cron: true` is meaningless without `time_threshold > 0`** — the cron cadence is the
   `time_threshold`. In deviation-only mode (`time_threshold: 0s`) the heartbeat has no
   cadence; `max_staleness` is the ceiling instead, and `aligned_heartbeat` is inert.
5. **`time_threshold: "0s"` is "disabled", not "every event".** It turns the time arm OFF
   (and tells cron this destination has no cadence). Push-everything is row 8 (no knobs).
6. **`price_deviation` alone never expires** (row 5). Pair it with a ceiling.

## Where it is configured

Per destination, inside each router file:

- Preview: `offchain/feeder/config/routers/preview/<client>.yaml`
- Mainnet: `offchain/feeder/config/routers/mainnet/<client>.yaml`

The per-destination knobs live under `destinations[].{ price_deviation, time_threshold,
max_staleness, cron }`; the subscribed pairs live under `triggers.conditions` (a
`Symbol in [...]` list).

The heartbeat **timing** (`aligned_heartbeat`) and the cron master switch /
scan cadence live in the infra block `infrastructure.<network>.yaml::cron_service`
(see `CronServiceConfig` in `src/config/types.ts`). Batching itself is also shaped by
`event_processor.coalesce_window` and `event_processor.max_batch_size` in the same infra
file — a wider `coalesce_window` gives the aligned heartbeat more room to gather pairs
into one flush.

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
