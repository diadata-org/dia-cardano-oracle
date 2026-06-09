# Mainnet Cost Forecast — Recurring Feeder Network Fees

**Date:** 2026-06-09 · **Status:** estimate for Mainnet planning · **Audience:** DIA + PROTOFIRE
**Scope:** how much ADA, in on-chain network fees, it costs to keep the feeder running on
Mainnet for a short evidence window — projected from real Preview data.

This forecast is produced by a pure calculator,
[`offchain/feeder/scripts/cost-forecast/forecast-mainnet-cost.ts`](../../offchain/feeder/scripts/cost-forecast/forecast-mainnet-cost.ts),
which reads an existing M2 evidence pack and never touches a chain. The machine-readable
output is committed alongside this note:
[`20260609-mainnet-cost-forecast.json`](./20260609-mainnet-cost-forecast.json). Regenerate with:

```sh
# from offchain/feeder/
npm run forecast:cost -- --minutes 90 \
  --fee-report ../../docs/milestones/evidence/_archived/m1-fee-benchmark-20260506-162133/fee-report.json
```

## Contents

- [What this covers (and what it does not)](#what-this-covers-and-what-it-does-not)
- [Scenario](#scenario)
- [Observed baseline](#observed-baseline)
- [Forecast for the run window](#forecast-for-the-run-window)
- [Bottom line and ADA request](#bottom-line-and-ada-request)
- [Method and assumptions](#method-and-assumptions)

## What this covers (and what it does not)

This note sizes **only the recurring on-chain network fees of keeping the feeder alive** while
it produces the Mainnet evidence run. It deliberately excludes two cost categories that are
accounted for separately:

- **One-off deploy / bootstrap / teardown fees.** Standing up the protocol, the client, and the
  ten pairs on Mainnet is a one-time spend. The current Mainnet deployment from Milestone 1 is
  reclaimed by the teardown flow (asset burns + ADA recovery), so most of the previously locked
  ADA is returned before the redeploy. This is requested and tracked apart from the figures here.
- **Client-paid protocol fees.** The per-update protocol fee (`0.6 ADA + 0.4 ADA × pairs`) is paid
  by the client into their Receiver balance, not by the operator. It is a transfer into the
  protocol, not an operating cost of the feeder.

## Scenario

Identical to the Preview configuration (`offchain/feeder/config/routers/preview/client-a.yaml`):

| Parameter | Value |
| --- | --- |
| Pairs | 10 |
| Clients | 1 |
| Heartbeat (`time_threshold`) | 10 min |
| Price deviation | 0.1% |
| Push policy | OR-gate of price deviation + cron heartbeat |
| Forecast window | 90 min (1 h 30 m) |

## Observed baseline

Source pack: [`m2-preview-20260609-093407`](../milestones/evidence/m2-preview-20260609-093407/milestone-2-preview-evidence.md).

| Metric | Value |
| --- | --- |
| Confirmed transactions | 30 |
| Failed transactions | 12 |
| Average network fee per transaction | 0.886333 ADA (886,333 lovelace) |
| Confirmed-transaction throughput | 0.5234 tx/min |

The average fee is the mean of the `dia_bridge_transaction_fee_lovelace` histogram (19 samples).
Throughput is derived from the window-scoped `SUMMARY.json` totals, not from the Prometheus
counters (those reset on daemon restart and would understate a rate).

## Forecast for the run window

### Method 1 — observed rate (primary)

The pack ran the exact configuration planned for Mainnet, so its confirmed-transaction rate is the
most faithful predictor. Scaling it to 90 minutes and pricing each transaction at the observed
average fee:

- Projected transactions: **≈ 47**
- Projected network fees: **≈ 41.75 ADA**

### Method 2 — heartbeat floor (cross-check, indicative)

A lower bound that assumes the cron heartbeat is the only trigger and the client's due pairs ride a
single coalesced batch transaction per 10-minute cycle. Pricing the batch from the CLI
fee-benchmark curve (`fee = 0.457 + 0.281 × pairs`, real Preview network).

> **Note:** this batch curve is from a benchmark on the **previous contracts** (`m1-fee-benchmark-20260506-162133`,
> measured up to batch-6; batch-of-10 is a linear extrapolation). It is included only as an
> indicative cross-check and is **not** the basis of the ADA request — the request is grounded in
> Method 1 (current-contract observed data). The two are close, so it is left in for context.

- Batch transactions: 9 (one per cycle)
- Fee per batch-of-10 transaction: ≈ 3.26 ADA
- Projected network fees: **≈ 29.36 ADA**

## Bottom line and ADA request

Recurring network fees to keep the feeder alive for **1 h 30 m** on Mainnet fall in the range:

> **≈ 29 – 42 ADA** (heartbeat floor → observed rate)

For the Mainnet evidence run we therefore request **operating ADA on the order of ~50 ADA** for the
feeder window itself (the upper estimate plus a modest safety margin for price-deviation bursts and
retries). This is **separate** from the deploy/bootstrap working capital, which is requested
independently and is largely recovered from the Milestone 1 teardown.

## Method and assumptions

- **Pure calculation, no chain interaction.** All inputs come from files already in the repository.
- **Per-transaction fee** is an average over real confirmed transactions on the current contracts
  (Preview). Mainnet protocol parameters match Preview for fee calculation, so per-transaction fees
  are expected to be comparable.
- **Throughput** is taken from window-scoped pack totals. The observed-rate method captures the
  real mix of heartbeat and price-deviation pushes; the heartbeat-floor method ignores deviation
  pushes and is therefore a lower bound.
- **Batch curve** is from the most recent real-network CLI fee benchmark on file
  (`m1-fee-benchmark-20260506-162133`). It was measured up to batch-6; the batch-of-10 figure is a
  linear extrapolation of that curve.
- **Excluded by design:** one-off deploy/bootstrap/teardown fees and client-paid protocol fees, as
  described above.
