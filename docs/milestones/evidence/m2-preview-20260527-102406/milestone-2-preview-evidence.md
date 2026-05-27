# Milestone 2 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 2 (Data Feeder and Documentation) validation on
Cardano Preview ↔ DIA Testnet.

Pack stamp: **20260527-102406**

Window observed in `transactions.jsonl`:

- First tx event: `2026-05-27T06:19:50.878Z`
- Last tx event:  `2026-05-27T10:13:36.077Z`

Evidence pack location: this directory.

## Official Milestone 2 Outputs

| Official output | Repository status |
| --- | --- |
| Feeder scripts | Complete: `offchain/feeder/` (TypeScript, Node 22, ESM). |
| Test coverage | Complete: `npm test` in `offchain/feeder/` (passing, full surface). |
| Uptime / accuracy reports | This pack: per-pair confirmed counts + latency + reorg stats. |
| QA review logs | This pack: `logs/feeder.log`, `logs/transactions.jsonl`, `logs/lane.jsonl`, `logs/intents/`. |
| Automated alerts | Complete: `offchain/feeder/monitoring/alerts.yml` (8 alert rules; canonical thresholds in `infrastructure.<network>.yaml::alerting.*`). |
| Real-time dashboards | Complete: `dashboards/` (PNG snapshots taken at pack time). Source JSON: [`offchain/feeder/monitoring/grafana/dashboards/feeder.json`](../../../offchain/feeder/monitoring/grafana/dashboards/feeder.json). |
| Developer documentation | Complete: [feeder README](../../../offchain/feeder/README.md), [CLI README](../../../offchain/cli/README.md), [architecture](../../architecture/cardano-oracle-architecture.md). |

## Totals (this window)

| Metric | Value |
| --- | ---: |
| Confirmed Cardano oracle update txs | 55 |
| Failed Cardano tx attempts          | 247 |
| Chain reorgs that dropped a tx      | 0 |

## Confirmed Cardano tx count per pair

| Pair | Confirmed txs |
| --- | --- |
| ARB/USD | 15 |
| NEIRO/USD | 10 |
| XVG/USD | 9 |
| ETH/USD | 6 |
| DOGE/USD | 5 |
| BTC/USD | 3 |
| LTC/USD | 3 |
| SHIB/USD | 3 |
| USDC/USD | 1 |

## Sample Cardano tx hashes (one per pair, first observed)

| Pair | Tx hash |
| --- | --- |
| ARB/USD | ac55dd39c1caa1b4415dd51ca201cbe8b7c64468fdef87e481044fecd4a6cb33 |
| BTC/USD | 4c7f767f65f7002b01461d562d0c6e889cb8edadad31f4a9dfe932b51c223197 |
| DOGE/USD | eb4763e5342ab8344d5b698242b3e3562dbe64ec94f48a4babb958c52d65214c |
| ETH/USD | 3541da6f41fd31868c440f31fcbfca99d1f893468a9271d6d0c96f68db143762 |
| LTC/USD | e1bf70fd264681aace102990be243148ae2651afb59c5ccbe26cf705a3ef07db |
| NEIRO/USD | 95b54e2525ca9032f4b52a9882808826b0896ea064f57f00ed84848f5aeb69d6 |
| SHIB/USD | f852cb9ec04734e7774a88d2e2a4dc8647dc1008b639a8a655b404301968d1a4 |
| USDC/USD | 4a134d15e281c67e243a161c174f39a20f7c8edea10107b1bc263eb6b5b9b8e2 |
| XVG/USD | 3c8a84e9bc383fed150be6d094637212ddcc485fc550f58a6bb962f36f6f5106 |

Verify on [Cardanoscan Preview](https://preview.cardanoscan.io/) or any
public Preview explorer.

## End-to-end latency per pair

DIA `IntentRegistered` → Cardano `tx_confirmed`, milliseconds.

| Pair | Samples | p50 (ms) | p95 (ms) |
| --- | --- | --- | --- |
| DOGE/USD | 4 | 38501 | 53877 |
| ARB/USD | 14 | 59439 | 136899 |
| NEIRO/USD | 9 | 62462 | 149077 |
| BTC/USD | 2 | 77178 | 77178 |
| ETH/USD | 5 | 52820 | 86101 |
| LTC/USD | 2 | 80862 | 80862 |
| SHIB/USD | 2 | 139859 | 139859 |
| XVG/USD | 8 | 62240 | 113107 |
| USDC/USD | 0 | 0 | 0 |

## Failures (grouped by error_code)

_(no data)_

Failure semantics for each code are documented in
[`offchain/feeder/src/errors/codes.ts`](../../../offchain/feeder/src/errors/codes.ts).

## Raw artefacts in this pack

| Path | Contents |
| --- | --- |
| `logs/feeder.log`              | Daemon event stream (mirrors stderr). |
| `logs/transactions.jsonl`      | One JSON line per tx pipeline step. |
| `logs/lane.jsonl`              | Lane state events (intent_buffered, flush_triggered, …). |
| `logs/intents/`                | Per-intent lifecycle files (`<ts>_<hash>.log`). |
| `db/transaction_log.csv`       | Full `transaction_log` table dump from `feeder.sqlite`. |
| `db/processed_events.csv`      | Full `processed_events` table dump. |
| `db/chain_state.csv`           | Scanner checkpoint snapshot. |
| `api/prices.json`              | `GET /api/v1/prices` at pack time. |
| `api/chains.json`              | `GET /api/v1/chains` at pack time. |
| `api/symbols.json`             | `GET /api/v1/symbols` at pack time. |
| `api/metrics.txt`              | Prometheus `/metrics` exposition at pack time. |
| `dashboards/dashboard-full.png` | Full Grafana dashboard at pack time. |
| `dashboards/panel-*.png`       | Per-panel snapshots. |
| `stats/`                       | Intermediate TSV files this markdown was built from. |
| `SUMMARY.json`                 | Machine-readable totals (top of this document, as JSON). |

## Dashboards

The Grafana dashboard `DIA Cardano Oracle Feeder` covers:

- **Oracle Feed Liveness — M2 Evidence** (top row): cumulative confirmed
  tx count per pair (proof of liveness), price data age p95 per pair.
- **Row 1 — Balances & Staleness**: pair staleness, receiver balance,
  admin wallet / PaymentHook / receiver accrued.
- **Row 2 — Throughput & Latency**: end-to-end latency p50/p95/p99,
  tx confirmed rate, tx failed rate by error code.
- **Row 3 — Chain & Scanner Health**: reorg counter, scanner block lag,
  intents filtered by reason.
- **Row 4 — Price Quality & Anomaly Detection**: price deviation p95
  per pair, price deviation distribution heatmap.

To reproduce this dashboard yourself:

```sh
cd offchain && make up-monitoring
# then open http://localhost:3000 (default admin/admin) — dashboard is auto-provisioned.
```

See the [feeder README — Daemon + monitoring section](../../../offchain/feeder/README.md#daemon--monitoring)
for the canonical operator instructions.

## Alerts active during the window

Source of truth: [`offchain/feeder/monitoring/alerts.yml`](../../../offchain/feeder/monitoring/alerts.yml).
Canonical thresholds: `infrastructure.<network>.yaml::alerting.*`.

| Alert | Metric | Operator action |
| --- | --- | --- |
| OraclePairStale          | `dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds` | Investigate scanner / DIA source. |
| ReceiverBalanceLow       | `dia_bridge_cardano_receiver_balance_lovelace`               | `dia-cli receiver:top-up`. |
| SettleOverdue            | `dia_bridge_cardano_receiver_accrued_lovelace`               | `dia-cli settle`. |
| PaymentHookWithdrawReady | `dia_bridge_cardano_payment_hook_accrued_lovelace`           | `dia-cli payment-hook:withdraw`. |
| AdminWalletLow           | `dia_bridge_cardano_admin_wallet_lovelace`                   | Refill operator wallet. |
| PriceDeviationHigh       | `dia_bridge_price_deviation_percent_bucket` (p95)            | Investigate DIA source (possible misreport). |
| PriceAgeHigh             | `dia_bridge_price_age_seconds_bucket` (p95)                  | Investigate DIA Lasernet scanner. |
| ReorgRateHigh            | `dia_bridge_transactions_reorg_total`                        | Check provider lag + scanner block-lag panel. |
