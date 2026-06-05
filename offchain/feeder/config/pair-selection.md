# Oracle Pair Selection — DIA Cardano Oracle

> Reference for which DIA price pairs the feeder publishes to Cardano and why.
> The **canonical source of truth** is the router config
> ([`routers/client-a.preview.yaml`](./routers/client-a.preview.yaml)); this document
> explains the selection behind it. Candidate pairs are discovered on-chain with the
> `scan-dia-intents.ts` helper (see
> [`../scripts/README.md`](../scripts/README.md)).

## Contents

- [Selected pairs](#selected-pairs)
- [Update policy](#update-policy)
- [Selection criteria](#selection-criteria)
- [Configuration](#configuration)

## Selected pairs

The feeder monitors and updates the following 10 price pairs on Cardano for
`client-a` (Preview):

| Symbol | Description |
|--------|-------------|
| BTC/USD | Bitcoin / US Dollar |
| ETH/USD | Ethereum / US Dollar |
| USDC/USD | USD Coin / US Dollar |
| USDT/USD | Tether / US Dollar |
| DOGE/USD | Dogecoin / US Dollar |
| LTC/USD | Litecoin / US Dollar |
| ARB/USD | Arbitrum / US Dollar |
| SHIB/USD | Shiba Inu / US Dollar |
| NEIRO/USD | Neiro / US Dollar |
| XVG/USD | Verge / US Dollar |

## Update policy

All pairs use the same destination policy on this router (the OR-gate — an update is
submitted when **either** condition is met):

- **Price deviation:** `0.1%` — submit if the new price differs from the last on-chain
  price by at least 0.1%.
- **Time threshold:** `5m` — submit if 5 minutes have elapsed since the last on-chain
  update, regardless of deviation (keeps the pair fresh in flat markets).

These values are set per-destination in the router YAML; see
[`docs/architecture/feeder.md` §4](../../../docs/architecture/feeder.md#4-the-update-decision-two-filter-stages)
for how the OR-gate evaluates them.

## Selection criteria

Pairs were selected based on:

- High liquidity and trading volume on DIA data sources.
- Active price feeds available on DIA's Lasernet testnet.
- Relevance to the Cardano DeFi ecosystem.

## Configuration

The authoritative list lives in the router config that the feeder loads at startup:
[`routers/client-a.preview.yaml`](./routers/client-a.preview.yaml) (the
`triggers.conditions` symbol list). To add or remove a pair, edit that file and restart
the feeder — this document should be updated to match.
