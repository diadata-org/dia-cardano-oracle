# Milestone 3 — Proof of Achievement (Catalyst)

**Project:** DIA Oracles on Cardano
**Milestone:** 3 — Implement Monitoring Library for DIA Oracles on Cardano
**Public repository:** <https://github.com/diadata-org/dia-cardano-oracle>
**Submission commit:** `7749df66fa8953818d75945126dd2e4cb705a0f5`

Primary evidence:

- **QA demo video** (live mainnet dashboards, feed health checks, the alerting pipeline —
  Alertmanager + the alert-log API — and an alert firing and clearing):
  <https://youtu.be/W-vfgsoeXp4>
- **Mainnet monitoring evidence pack** (live mainnet run + a manual alert fired through the
  full pipeline):
  [`evidence/m3-mainnet-20260616-074413/`](evidence/m3-mainnet-20260616-074413/) —
  [`milestone-3-mainnet-evidence.md`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md)
  and [`SUMMARY.json`](evidence/m3-mainnet-20260616-074413/SUMMARY.json).
- **Preview monitoring evidence pack** (full dry-run; every alert rule fired and cleared by hand):
  [`evidence/m3-preview-20260608-040304/`](evidence/m3-preview-20260608-040304/) —
  [`milestone-3-preview-evidence.md`](evidence/m3-preview-20260608-040304/milestone-3-preview-evidence.md).

---

## Contents

- [1. Executive summary](#1-executive-summary)
- [2. Acceptance Criteria → Evidence](#2-acceptance-criteria--evidence)
- [3. Outputs delivered (Milestone 3)](#3-outputs-delivered-milestone-3)
- [4. How to verify this deliverable](#4-how-to-verify-this-deliverable)
- [5. Pointers (one-stop links)](#5-pointers-one-stop-links)

---

## 1. Executive summary

Milestone 3 is delivered. A monitoring and alerting library was built to track the DIA
oracle feeds operating on Cardano: a Prometheus + Grafana + Alertmanager stack, **13
automated alert rules** over uptime, accuracy and data-freshness signals, a per-feed
sanity check (on-chain value vs DIA source), and an end-to-end alert pipeline that does not
stop at a dashboard — **Prometheus rule → Alertmanager → feeder webhook → persisted
`alert_log`, exposed over an API (`GET /api/v1/alerts`, with acknowledge)**. That auditable
alert surface and the per-feed accuracy sanity are the substance Milestone 3 adds on top of
the Milestone 2 monitoring dashboards.

The monitoring system was exercised on **both networks**:

- **Cardano Mainnet ↔ DIA Mainnet.** The monitoring stack ran live against the Milestone 2
  mainnet deployment (no redeploy), tracking the **`ARS/USDT`** feed — the symbol DIA
  publishes continuously on its mainnet registry — with real-time dashboards, a per-feed
  accuracy check (**ARS/USDT PASS**), and **7 confirmed on-chain oracle updates** (0 failed,
  0 reorgs) over a **~2.4 h** window (2026-06-19 05:35–08:01 UTC). One alert
  (`OraclePairStale`) was driven through the full pipeline by hand (firing → resolving),
  captured in the pack's `alert-trigger/`.
- **Cardano Preview ↔ DIA Testnet** (the dry-run the machinery was validated on). The full
  QA surface was exercised: real-time dashboards across three dashboards (overview,
  transactions, internals), per-feed sanity (5 feeds, 5 PASS), and **every alert rule
  fired and cleared by hand** through the live pipeline (timeline + per-alert Prometheus
  state + feeder `alert_log` snapshots).

M3 acceptance is about **real-time visibility and alerting**, validated by QA review and
live on-chain performance — not a fixed uptime bar. The **99.99% sustained-uptime number
is Milestone 4**; for M3 the observed numbers over the demo window are reported honestly.

Feeder/monitoring source, the test suites (**665 feeder tests + CLI tests, all green**), the
monitoring configuration, and developer documentation are public in the repository above.
All transaction hashes are verifiable on Cardano explorers (Cardanoscan).

---

## 2. Acceptance Criteria → Evidence

The Acceptance Criteria of Milestone 3 are quoted verbatim and mapped to evidence below.

### AC #1 — Real-time visibility of DIA oracle feeds operating on Cardano mainnet

> *"The monitoring system provides real-time visibility of DIA oracle feeds operating on
> Cardano mainnet."*

| Evidence | Where |
| --- | --- |
| Monitoring library source (metrics, dashboards, alerts, sanity check) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/), [`offchain/feeder/src/api/metrics.ts`](../../offchain/feeder/src/api/metrics.ts) |
| Real-time dashboards (overview, transactions, internals) | mainnet pack [`Dashboards`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#dashboards) (rendered panel PNGs); source JSON in [`offchain/feeder/monitoring/mainnet/dashboards/`](../../offchain/feeder/monitoring/mainnet/dashboards/) |
| Live mainnet run — 7 confirmed on-chain oracle updates (`ARS/USDT`, 0 failed, 0 reorgs) | mainnet pack — [`Confirmed Cardano tx count per pair`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#confirmed-cardano-tx-count-per-pair), [`Sample Cardano tx hashes`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#sample-cardano-tx-hashes-one-per-pair-first-observed), [`SUMMARY.json`](evidence/m3-mainnet-20260616-074413/SUMMARY.json) |
| Provider health, staleness, latency surfaced in real time | mainnet pack panels (`Cardano provider health`, `Pair staleness`, `Symbol-update latency`) |
| Living Grafana guide (every panel documented) | [`docs/architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md) |

Headline mainnet transaction for immediate verification:

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| `ARS/USDT` oracle update (confirmed on Cardano mainnet) | `31dc1efb2789b6502cfe8c1312a56562e6522a8b97525c5ad53977f0532cd78e` | [Cardanoscan](https://cardanoscan.io/transaction/31dc1efb2789b6502cfe8c1312a56562e6522a8b97525c5ad53977f0532cd78e) |

### AC #2 — Anomalies in uptime, accuracy, or data freshness trigger automatic alerts

> *"Anomalies in uptime, accuracy, or data freshness trigger automatic alerts. Functionality
> is validated by … verifying expected alert behavior, data freshness thresholds, and
> consistency with on-chain oracle activity."*

| Evidence | Where |
| --- | --- |
| Alert rules (13) over deviation, price-age/staleness, reorg, feed-sanity, balances, providers | [`offchain/feeder/monitoring/mainnet/alerts.yml`](../../offchain/feeder/monitoring/mainnet/alerts.yml); canonical thresholds in `infrastructure.<network>.yaml::alerting.*` |
| End-to-end alert pipeline (Prometheus rule → Alertmanager routing → feeder webhook) | [per-network monitoring configuration](../../offchain/feeder/monitoring/), [`offchain/feeder/src/api/routes.ts`](../../offchain/feeder/src/api/routes.ts) |
| **Auditable alert log exposed by API** (`GET /api/v1/alerts`, `…/{id}/ack`) — each fired alert persisted, queryable, acknowledgeable | [`offchain/feeder/src/api/routes.ts`](../../offchain/feeder/src/api/routes.ts) |
| Config-driven notification channels (Telegram / email one flag away; secrets stay in `.env`) | `infrastructure.<network>.yaml::notifications`, generated per-network Alertmanager configuration in [`monitoring/`](../../offchain/feeder/monitoring/) |
| **Mainnet** — `OraclePairStale` fired → resolved live through the pipeline | mainnet pack [`alert-trigger/`](evidence/m3-mainnet-20260616-074413/alert-trigger/) (Prometheus state + `alert_log` + PNG) |
| **Preview** — every alert fired → resolved by hand (timeline + Prometheus state + `alert_log` + PNGs) | [`evidence/m3-preview-20260608-040304/alert-trigger/`](evidence/m3-preview-20260608-040304/alert-trigger/timeline.md) |
| Threshold ↔ config drift guard (alerts can never silently diverge from the YAML) | [`offchain/feeder/src/config/__tests__/threshold-drift.test.ts`](../../offchain/feeder/src/config/__tests__/threshold-drift.test.ts) |

### AC #3 — QA validation report: integration tests + per-feed accuracy sanity checks

> *"The QA validation report includes integration tests validating oracle data ingestion and
> alert triggering, and sanity checks confirming oracle timestamp and price accuracy for each
> price feed."*

| Evidence | Where |
| --- | --- |
| Integration tests — data ingestion + alert triggering (665 feeder tests, all green) | mainnet pack [`tests/`](evidence/m3-mainnet-20260616-074413/tests/); run `npm test` in [`offchain/feeder`](../../offchain/feeder/) and [`offchain/cli`](../../offchain/cli/) |
| Per-feed sanity — on-chain value vs latest DIA source (price + timestamp accuracy) | mainnet pack [`Per-feed sanity (accuracy)`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#per-feed-sanity-accuracy) (ARS/USDT PASS); preview pack [`sanity/`](evidence/m3-preview-20260608-040304/sanity/) (5 feeds, 5 PASS) |
| Uptime & accuracy report (confirmed-update liveness + per-feed deltas over the window) | mainnet pack [`Totals`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#totals-this-window), `Confirmed tx count per pair`, [`End-to-end latency per pair`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md#end-to-end-latency-per-pair), sanity table |
| Consistency with on-chain activity (confirmed tx hashes match the dashboards) | mainnet pack `Sample Cardano tx hashes` cross-checked on Cardanoscan |

### AC #4 — Developer documentation

> *"Developer documentation is considered complete when comprehensive documentation is
> published via the DIA main developer documentation website. …"*

Comprehensive developer documentation is **complete and publicly available in the GitHub
repository** at submission time:

| Documentation surface | Location |
| --- | --- |
| Feeder architecture (data flow, routing, monitoring, alerting, metric coverage) | [`docs/architecture/feeder.md`](../architecture/feeder.md) |
| Grafana dashboards guide (every panel, every dashboard) | [`docs/architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md) |
| Feeder developer docs + monitoring runbook | [`offchain/feeder/README.md`](../../offchain/feeder/README.md), [`offchain/feeder/scripts/README.md`](../../offchain/feeder/scripts/README.md) |
| Protocol architecture (datums, redeemers, fee flow, trust model) | [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md) |

**Publication on the DIA main developer documentation website** is **deferred to Milestone 4
(End-to-End Integration and Deployment)**, with the same reasoning the evaluator accepted for
Milestones 1 and 2: the integration is still iterating across M3/M4, so publishing the final
stable surface once at M4 is materially better for downstream developers than republishing a
moving target. The repository documentation is complete now and meets the substantive content
requirements of AC #4.

---

## 3. Outputs delivered (Milestone 3)

| Official output | Status | Evidence |
| --- | --- | --- |
| QA validation report | Delivered | 665 integration tests + per-feed sanity (ARS/USDT PASS) + alert-trigger logs — see AC #3 (assembled in the mainnet pack) |
| Anomaly detection | Delivered | [`monitoring/mainnet/alerts.yml`](../../offchain/feeder/monitoring/mainnet/alerts.yml) — 13 rules over deviation, staleness/price-age, reorg, on-chain-vs-source feed-sanity |
| Uptime and accuracy reports | Delivered | 7 confirmed ARS/USDT updates (0 failed, 0 reorgs) + latency + per-feed accuracy — see AC #3 |
| Automated alerts | Delivered | Prometheus → Alertmanager → feeder webhook → `alert_log` (API-exposed); mainnet (`OraclePairStale`) + preview alert-trigger runs |
| Developer documentation | Delivered (in repo; DIA-site publication deferred to M4 — see AC #4) | See AC #4 table |

---

## 4. How to verify this deliverable

### 4.1. On-chain (no local setup required)

Open the Cardanoscan link in §AC #1, or any hash from the mainnet pack's *Sample Cardano tx
hashes* section. The transactions show the `ARS/USDT` oracle Pair UTxO being updated on
Cardano Mainnet.

### 4.2. Watch the QA demo video

<https://youtu.be/W-vfgsoeXp4> — the real-time Grafana dashboards on the live mainnet run, the per-feed
accuracy check, the alerting pipeline (Alertmanager UI + the `GET /api/v1/alerts` log), and
an alert firing and clearing. 

### 4.3. Local repro (feeder + monitoring)

```bash
git clone https://github.com/diadata-org/dia-cardano-oracle.git
cd dia-cardano-oracle && git checkout 7749df66fa8953818d75945126dd2e4cb705a0f5

# Tests
( cd offchain/feeder && npm ci && npm test )
( cd offchain/cli && npm ci && npm run test )

# Run the feeder + Prometheus + Grafana + Alertmanager (network from offchain/feeder/.env)
cd offchain && make up MONITORING=1     # Grafana at http://localhost:3000
```

### 4.4. Fire an alert through the live pipeline

```bash
cd offchain/feeder && scripts/monitoring/trigger-alert-demo.sh OraclePairStale
```

Pushes a synthetic metric so the real rule fires and flows through Prometheus → Alertmanager
→ the feeder webhook → `alert_log`, then clears. Inspect the persisted alert with
`curl -s 'http://localhost:8080/api/v1/alerts?limit=5' | jq`. Only the input metric is
synthetic; the rules, routing, and recording are production.

### 4.5. Re-generate the evidence pack

```bash
cd offchain && ALERT_TRIGGER_DIR=$(ls -dt docs/milestones/evidence/alert-trigger-mainnet-*/ | head -1) make evidence3
```

The pack is assembled only from the feeder's database, logs, live API, and Grafana — no
hand-edited numbers.

---

## 5. Pointers (one-stop links)

- QA demo video: <https://youtu.be/W-vfgsoeXp4>
- Mainnet evidence pack: [`evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md`](evidence/m3-mainnet-20260616-074413/milestone-3-mainnet-evidence.md)
- Preview evidence pack: [`evidence/m3-preview-20260608-040304/milestone-3-preview-evidence.md`](evidence/m3-preview-20260608-040304/milestone-3-preview-evidence.md)
- Monitoring source: [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/)
- Grafana dashboards guide: [`docs/architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md)
- Feeder architecture: [`docs/architecture/feeder.md`](../architecture/feeder.md)
- Milestone 1 PoA (accepted): [`milestone-1-poa.md`](milestone-1-poa.md)
- Milestone 2 PoA: [`milestone-2-poa.md`](milestone-2-poa.md)
- License: [`LICENSE`](../../LICENSE) (MIT)
