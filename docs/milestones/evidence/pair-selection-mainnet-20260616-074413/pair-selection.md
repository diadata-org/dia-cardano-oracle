# Oracle Pair Selection — Mainnet (client-test-01)

> **Rationale snapshot — not a config source.** Records which DIA mainnet price
> feeds the feeder publishes to Cardano, and why. The **authoritative source of
> truth is the router config**
> [`offchain/feeder/config/routers/mainnet/client-test-01-router-default.yaml`](../../../../offchain/feeder/config/routers/mainnet/client-test-01-router-default.yaml)
> (its `triggers.conditions` symbol list). The raw scan that backs this selection
> is [`pair-selection-scan.md`](./pair-selection-scan.md) / [`scan.json`](./scan.json),
> produced by `scripts/scan-dia-intents.ts` against the DIA mainnet registry.

## Contents

- [Selected pairs](#selected-pairs)
- [Selection criteria](#selection-criteria)
- [Update policy](#update-policy)

## Selected pairs

These 10 symbols are real DIA **mainnet** (chain 1050) feeds — confirmed emitting
`IntentRegistered` events on registry `0x5612599C…` (scan run `20260616-074413`,
60 000-block window). The feeder mints each Pair UTxO on the first DIA intent it
sees for the symbol, then updates it.

| Symbol | Asset class | Avg update on DIA mainnet |
|--------|-------------|---------------------------|
| SPYM | S&P 500 ETF | ~12 min |
| CRCL | US equity | ~21 min |
| TSLA | US equity | ~22 min |
| NVDA | US equity | ~22 min |
| IAU  | Gold ETF | ~24 min |
| PPLT | Platinum ETF | ~24 min |
| MSTR | US equity | ~24 min |
| AMZN | US equity | ~24 min |
| SIVR | Silver ETF | ~23 min |
| COIN | US equity | ~24 min |

## Selection criteria

- **Must exist on DIA mainnet.** Unlike the M1 demo pairs (which we bootstrapped
  ourselves with self-signed intents), the feeder only publishes symbols DIA
  actually emits on mainnet. The candidate set is the scan output in
  [`pair-selection-scan.md`](./pair-selection-scan.md) (21 symbols total).
- **Real-world assets, distinct and clean.** Chosen the 10 single-asset RWA feeds
  (US equities, gold/silver/platinum ETFs) over the structured-product components
  (`fairValue:spSEI`, `*:hemiBTC`, …) and FX (`ARS/USDT`), so each feed maps to one
  clear asset — matching DIA's "real-world asset price feeds" value proposition.
- **Update cadence noted, not gating.** RWA feeds update roughly every 12–24 min
  during market activity; the router's cron heartbeat (`time_threshold: 10m`)
  guarantees an on-chain refresh per pair even when the source is flat.

## Update policy

Same OR-gate as Preview (the router's `destinations[]`):

- **Price deviation:** `0.5%` — submit when the new price differs from the last
  on-chain price by at least 0.5%.
- **Heartbeat (`time_threshold`):** `10m` with `cron: true` — guarantees an update
  at least every 10 minutes per pair, bounding staleness when the price is flat.
