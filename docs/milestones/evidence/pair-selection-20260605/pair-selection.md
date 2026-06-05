# Oracle Pair Selection — M2 (snapshot 2026-06-05)

> **Rationale snapshot — not a config source.** This records which DIA price pairs the
> feeder publishes to Cardano, and why, as of 2026-06-05. The **authoritative source of
> truth is the router config**
> [`offchain/feeder/config/routers/client-a.preview.yaml`](../../../../offchain/feeder/config/routers/client-a.preview.yaml)
> (its `triggers.conditions` symbol list). If that file and this snapshot ever disagree,
> the YAML wins — update this note to match.

## Contents

- [Selected pairs](#selected-pairs)
- [Update policy](#update-policy)
- [Selection criteria](#selection-criteria)

## Selected pairs

As of this snapshot the feeder monitors and updates these 10 pairs for `client-a` on
Preview:

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

All pairs use the same OR-gate policy on this router (an update is submitted when
**either** condition is met):

- **Price deviation:** `0.1%` — submit if the new price differs from the last on-chain
  price by at least 0.1%.
- **Time threshold:** `5m` — submit if 5 minutes have elapsed since the last on-chain
  update, regardless of deviation.

See [`docs/architecture/feeder.md` §4](../../../architecture/feeder.md#4-the-update-decision-two-filter-stages)
for how the OR-gate evaluates these.

## Selection criteria

Pairs were selected based on:

- High liquidity and trading volume on DIA data sources.
- Active price feeds available on DIA's Lasernet testnet.
- Relevance to the Cardano DeFi ecosystem.
