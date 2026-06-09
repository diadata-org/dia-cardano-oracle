# Feeder scripts

## Contents

- [Evidence pack](#evidence-pack)
  - [Prerequisites](#prerequisites)
  - [Scripts](#scripts)
  - [Output](#output)
- [Other scripts](#other-scripts)
  - [`scan-dia-intents.ts`](#scan-dia-intentsts)
  - [`cost-forecast/forecast-mainnet-cost.ts`](#cost-forecastforecast-mainnet-costts)

## Evidence pack

Run `make evidence` from `offchain/` to generate the **complete** M2 evidence
pack into one dated directory.

### Prerequisites

- Feeder running with accumulated data: `make up`
- Monitoring stack up for the Grafana PNGs: `make up MONITORING=1`
  (Grafana at <http://localhost:3000>, default credentials admin/admin; set
  `GRAFANA_ADMIN_PASSWORD` if you changed it)
- Network resolved from `feeder/.env` `CARDANO_NETWORK` (override with
  `make evidence EVIDENCE_NETWORK=Mainnet`)

### Scripts

- `scripts/m2-evidence/package-m2-evidence.sh` — assembles the complete pack:
  raw logs, DB CSVs, live API snapshots, Grafana PNGs (full dashboard + every
  panel), and the `milestone-2-preview-evidence.md` report with each panel
  embedded and its metric explained. This is what `make evidence` runs.
- `scripts/m2-evidence/build-stats.ts` — query DB for transaction/event statistics
- `scripts/m2-evidence/build-error-counts.ts` — bucket failed transactions by error_code

### Output

Each run writes to `docs/milestones/evidence/m2-<network>-<timestamp>/`:

- `logs/` — raw `feeder.log`, `transactions.jsonl`, `lane.jsonl`, `intents/`
- `db/` — `transaction_log`, `processed_events`, `chain_state` as CSV
- `api/` — `/api/v1/{prices,chains,symbols}` + Prometheus `/metrics` snapshots
- `dashboards/` — full Grafana dashboard PNG + one PNG per panel
- `stats/` — intermediate TSVs the report table is built from
- `stats.json` — DB-authoritative transaction/event statistics
- `error-counts.tsv` — DB-authoritative failed-tx counts by error code
- `SUMMARY.json` — machine-readable totals
- `milestone-2-preview-evidence.md` — the reviewer-facing report (embeds the
  dashboards and explains each metric)

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

### `cost-forecast/forecast-mainnet-cost.ts`

Pure calculator that forecasts the **recurring on-chain network-fee cost of
keeping the feeder alive**, from data that already exists in an M2 evidence
pack. It reads files only — it never touches a chain and never submits a
transaction.

It uses the pack's window-scoped `SUMMARY.json` (confirmed-tx throughput) and
`api/metrics.txt` (`dia_bridge_transaction_fee_lovelace` → average fee per tx)
to project a forecast window, and — when given a CLI fee-benchmark report — adds
a heartbeat-floor cross-check from the `batch-N` fee curve.

It deliberately **excludes** one-off deploy/bootstrap/teardown fees (a separate,
largely recoverable spend) and client-paid protocol fees (`0.6 ADA + 0.4 ADA ×
pairs`).

```sh
# Run from offchain/feeder/
npm run forecast:cost                              # newest m2-preview-* pack, 90 min
npm run forecast:cost -- --minutes 120             # forecast a 2-hour window
npm run forecast:cost -- \
  --fee-report ../../docs/milestones/evidence/_archived/m1-fee-benchmark-20260506-162133/fee-report.json \
  --out ../../docs/audit/cost-forecast.md \
  --json ../../docs/audit/cost-forecast.json
```

Options:

| Flag | Default | Description |
| --- | --- | --- |
| `--pack DIR` | newest `m2-preview-*` | Evidence pack to read (excludes `_archived`) |
| `--minutes N` | `90` | Forecast window in minutes |
| `--pairs N` | `10` | Pairs in the forecast scenario |
| `--clients N` | `1` | Clients in the forecast scenario |
| `--heartbeat-min N` | `10` | Cron heartbeat (`time_threshold`) in minutes |
| `--fee-report PATH` | — | CLI fee-benchmark `fee-report.json` for the batch-curve cross-check |
| `--out PATH` | — | Write the Markdown report (else stdout JSON only) |
| `--json PATH` | — | Write the JSON report (else stdout JSON only) |

Always prints the JSON report to stdout.
