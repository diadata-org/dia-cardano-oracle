# Feeder scripts

## Contents

- [Evidence pack](#evidence-pack)
  - [Prerequisites](#prerequisites)
  - [Scripts](#scripts)
  - [Output](#output)
- [Other scripts](#other-scripts)
  - [`scan-dia-intents.ts`](#scan-dia-intentsts)

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

`make evidence` runs all three into one shared `m2-<network>-<stamp>/` dir
(the `.sh` for the pack, the two `.ts` for the DB-authoritative stats).

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
