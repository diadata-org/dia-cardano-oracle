# Idea: cut the cron↔event-flow submission race (in-flight guard)

> **STATUS — SUPERSEDED (2026-06-19).** The core proposal (a cron in-flight guard with the
> TTL safeguard + `cron_resubmissions_total{outcome="skipped_in_flight"}`) was implemented for
> the **cron↔cron** case in commit `e9a468e` (the aligned-heartbeat burst on the mainnet
> ARS/USDT run). The **residual** — extending the guard to **event↔cron** collisions by
> marking in-flight at the coalescer flush — is tracked in
> [`m4-plan.md` §2 · Feeder stability hardening](../m4-plan.md#2--feeder-stability-hardening).
> Kept for the analysis below (the ~58 % NonMonotonicNonce breakdown and the TTL risk).

- **Recorded:** 2026-06-14 19:06 (-08 / local)
- **Status:** IDEA ONLY — not scheduled, not approved for implementation.
- **Origin:** Preview evidence run `preview_run_20260608-040304`, ~5 h in. Operator
  noticed average on-chain batch size ≈ 1 and one pair (LTC/USD) stale ~17 min,
  then asked to investigate the dashboards.

## Contents

- [What we observed](#what-we-observed)
- [Root cause](#root-cause)
- [Proposed change](#proposed-change)
- [Why it does NOT need a config change](#why-it-does-not-need-a-config-change)
- [What it does NOT fix (orthogonal to batching)](#what-it-does-not-fix-orthogonal-to-batching)
- [Cons / risks](#cons--risks)
- [Decision](#decision)

## What we observed

Over a ~5 h Preview run, summing the 10 router symbols:

- **216** confirmed updates.
- **432** transactions submitted to chain.
- **587** intents rejected **before** submission with `NonMonotonicNonce`
  (≈ **58 %** of all attempts).

The rejections are **benign**: they are caught at build time ("not submitted"),
so they cost **no fees** and create **no on-chain churn**. They do, however,
inflate the failure counters and make the Transactions dashboard's success
ratio look bad — undesirable for the M2 demo.

The scanner is healthy (`dia_bridge_events_detected_total` ≈ 57 011). The cron's
existing nonce pre-filter already skips most doomed resubmits
(`cron_resubmissions_total{outcome="skipped_superseded"}` ≈ 280–320 per symbol);
only ~40 per symbol slip through and collide.

## Root cause

Two independent paths can submit an update for the same pair and they do not see
each other's in-flight work:

- **Event-flow:** a new `IntentRegistered` arrives → passes the deviation gate → submits.
- **Cron heartbeat:** at the aligned 10-min boundary, the cron resubmits the latest
  known intent for any pair older than `time_threshold`.

Race timeline (e.g. LTC):

1. Cron submits LTC (nonce N+1). The tx goes **in flight** (~20–40 s on Preview).
2. While in flight, `priceCache` still shows the **old** confirmed state (nonce N),
   because nothing has confirmed yet.
3. A new event (or the next cron tick) sees LTC as "still old" and submits the
   **same** nonce N+1 again.
4. The first confirms → on-chain nonce becomes N+1. The second one (also N+1)
   now fails `NonMonotonicNonce` ("nonce must be greater than the current on-chain
   nonce"). This is the bulk of the ~58 %.

Relevant code: [`cron-service.ts`](../../../offchain/feeder/src/cron/cron-service.ts)
(nonce pre-filter at lines ~236–242), coalescer/queue
[`coalescer.ts`](../../../offchain/feeder/src/submitter/coalescer.ts),
[`queue.ts`](../../../offchain/feeder/src/submitter/queue.ts).

## Proposed change

A per-lane **in-flight set** of symbols that currently have a submission in progress:

1. **Mark** a symbol in-flight when its batch flushes from the coalescer toward chain.
2. **Clear** it in `onResult` (on confirm OR fail), on every exit path.
3. The **cron consults** the set before resubmitting: if the symbol is in flight,
   skip it and increment a new outcome `cron_resubmissions_total{outcome="skipped_in_flight"}`
   instead of piling on.

This mirrors an existing, proven pattern in the repo: the `inProgress` guard used by
auto-settle / auto-withdraw / auto-consolidate in
[`auto-remediation.ts`](../../../offchain/feeder/src/submitter/auto-remediation.ts)
(~line 39). The change follows that convention; it does not introduce a new mechanism.

The guard belongs on the **cron path only**. Genuinely new event-driven intents
(higher nonce, real data) must still flow through the coalescer untouched.

## Why it does NOT need a config change

- The heartbeat **stays at `time_threshold: 10m`**. No YAML touched.
- When DIA advances a pair's nonce, it still refreshes at the 10-min cadence.
- When DIA is quiet (no higher nonce available), the pair still exceeds 10 min —
  that staleness is a **separate, inherent** limitation (the on-chain monotonicity
  rule requires a strictly-greater nonce; we cannot refresh without one). This idea
  does not change that.
- The only effect: stop **duplicating** a submit that is already in flight → the
  ~58 % rejection rate drops sharply → clean dashboard.

## What it does NOT fix (orthogonal to batching)

This is unrelated to the batch-sync knobs (`aligned_heartbeat`, `coalesce_window`,
`max_batch_size`). Those control **how updates are grouped**; this guard controls
**whether the cron duplicates an in-progress submit**.

Average batch size ≈ 1 is a consequence of **DIA's per-pair nonce cadence**
(each pair advances ~once per 7–10 min, staggered), not of this race. Widening
`coalesce_window` (e.g. to minutes) would batch more pairs but would delay **every**
update — including urgent deviation-driven ones — defeating the deviation gate.
Not recommended. This idea leaves batch size unchanged.

## Cons / risks

1. **Stuck in-flight flag → silent staleness (the real risk).** If a submit is
   marked in-flight but `onResult` never fires (process dies mid-flight, an
   exception bypasses the callback, a lost tx), the symbol stays marked forever →
   the cron skips it permanently → that pair silently stops refreshing. This trades
   *visible* noise (failures) for *invisible* staleness. Mitigation: a **TTL** that
   auto-releases the mark after N seconds. That is extra complexity that must be
   done correctly.
2. **More mutable state**, tied to every `onResult` exit path (confirm / fail /
   timeout / abort). A missed clear on any path re-creates risk #1.
3. New code + tests. Small, but not free.

Pro: clean dashboard / lower failure ratio. Net positive **only** if done with the
TTL safeguard.

## Decision

**Recorded as an idea; we are NOT implementing it now.** Revisit if/when the
failure-ratio optics on the Transactions dashboard become a priority and there is
time to add the in-flight guard *with* the TTL safeguard and tests.
