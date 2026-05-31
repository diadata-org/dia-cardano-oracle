# Feeder scripts

## Evidence pack

Run `make evidence` from `offchain/` to generate the M2 evidence pack.

### Prerequisites

- Feeder running: `make up`
- Grafana reachable at <http://localhost:3000> (default credentials admin/admin)
- SQLite DB at the path in `DATABASE_PATH_TESTNET` env var

### Scripts

- `scripts/m2-evidence/render-dashboards.ts` — capture Grafana PNG screenshots via the render API
- `scripts/m2-evidence/build-stats.ts` — query DB for transaction/event statistics
- `scripts/m2-evidence/build-error-counts.ts` — bucket failed transactions by error_code

### Output

Each run writes to `docs/evidence/m2-<timestamp>/`:

- `grafana/` — PNG screenshots of each Grafana dashboard
- `stats.json` — transaction and event statistics from DB
- `error-counts.tsv` — failed transaction counts by error code

## Other scripts

### `scan-dia-intents.ts`

One-shot scan for DIA oracle intents without submission. Useful for inspecting
recent on-chain activity before running the feeder.

```sh
# Run from offchain/feeder/
npm run scan:pairs                      # scan last 100 blocks, top 10 pairs
npm run scan:pairs -- --blocks 500      # scan last 500 blocks
npm run scan:pairs -- --top 20          # show top 20 pairs by volume
npm run scan:pairs -- --chunk 50        # use 50-block RPC chunks (default: 100)
npm run scan:pairs -- --blocks 200 --top 5 --chunk 25
```

Options:

| Flag | Default | Description |
| --- | --- | --- |
| `--blocks N` | `100` | Number of blocks to scan from chain head |
| `--top N` | `10` | Maximum pairs to display in the summary table |
| `--chunk N` | `100` | Block range per RPC `eth_getLogs` call |
