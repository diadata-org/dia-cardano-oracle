# Oracle Pair Selection — DIA Cardano Oracle M2

## Selected pairs

The following 10 price pairs are monitored and updated on-chain:

| Symbol | Description | Update threshold |
|--------|-------------|-----------------|
| BTC/USD | Bitcoin / US Dollar | 0.5% deviation or 5 min |
| ETH/USD | Ethereum / US Dollar | 0.5% deviation or 5 min |
| ADA/USD | Cardano / US Dollar | 0.5% deviation or 5 min |
| USDT/USD | Tether / US Dollar | 0.1% deviation or 5 min |
| SOL/USD | Solana / US Dollar | 0.5% deviation or 5 min |
| DOT/USD | Polkadot / US Dollar | 0.5% deviation or 5 min |
| LINK/USD | Chainlink / US Dollar | 0.5% deviation or 5 min |
| AVAX/USD | Avalanche / US Dollar | 0.5% deviation or 5 min |
| MATIC/USD | Polygon / US Dollar | 0.5% deviation or 5 min |
| UNI/USD | Uniswap / US Dollar | 0.5% deviation or 5 min |

## Selection criteria

Pairs were selected based on:
- High liquidity and trading volume on DIA data sources
- Active price feeds available on DIA's Lasernet testnet
- Relevance to the Cardano DeFi ecosystem

## Configuration

See `offchain/feeder/config/routers/client-a.preview.yaml` for the router configuration that monitors these pairs.
