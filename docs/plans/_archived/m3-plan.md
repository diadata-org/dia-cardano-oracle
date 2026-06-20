# Plan — Milestone 3 (Monitoring Library)

> **STATUS — Milestone 3 COMPLETE (delivered).** Every "what remains" item below was
> delivered: the live mainnet monitoring run (ARS/USDT), the demo video, the uptime/accuracy
> + QA validation evidence, and the PoA. See [`milestone-3-poa.md`](../../milestones/milestone-3-poa.md)
> (submission commit `7749df66fa8953818d75945126dd2e4cb705a0f5`). Archived for history.

What is left for **Milestone 3 — Implement Monitoring Library for DIA Oracles on
Cardano**, grounded in the official Catalyst wording
([`final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)) and the
accepted PoA format
([`milestone-1-poa.md`](../milestones/milestone-1-poa.md) /
[`milestone-2-poa.md`](../milestones/milestone-2-poa.md)).

Every "already built" claim was verified against the tree on 2026-06-18 (file given).
Tasks: `[x]` done · `[ ]` open · `[~]` partial.

## Contents

- [Plan — Milestone 3 (Monitoring Library)](#plan--milestone-3-monitoring-library)
  - [Contents](#contents)
  - [What M3 asks for](#what-m3-asks-for)
  - [Already built (verified)](#already-built-verified)
  - [What remains](#what-remains)
    - [1 · Live mainnet monitoring run](#1--live-mainnet-monitoring-run)
    - [2 · M3 demo video](#2--m3-demo-video)
    - [3 · Uptime \& accuracy report](#3--uptime--accuracy-report)
    - [4 · QA validation report](#4--qa-validation-report)
    - [5 · milestone-3-poa.md](#5--milestone-3-poamd)
  - [Dependencies and ordering](#dependencies-and-ordering)
  - [Open questions](#open-questions)

## What M3 asks for

Official outputs: **QA validation report · anomaly detection · uptime & accuracy
reports · automated alerts · developer documentation.**

Acceptance:

1. Real-time visibility of DIA oracle feeds operating **on Cardano mainnet**.
2. Anomalies in **uptime, accuracy, or data freshness** trigger automatic alerts.
3. Validated by **QA review and live on-chain performance**.
4. The **QA validation report** includes integration tests validating oracle data
   ingestion and alert triggering, plus **sanity checks confirming oracle timestamp and
   price accuracy for each price feed**.
5. Developer documentation (publication on DIA's site is **deferred to M4** per the
   accepted M1 precedent; in-repo docs stay complete and current).

Evidence: monitoring source + config examples + dev docs, a **demo video** of dashboards
and **live mainnet logs** showing feed health checks, plus QA artifacts (test reports,
**alert-trigger logs**, dashboard screenshots/exports).

## Already built (verified)

The monitoring **machinery** was built alongside the M2 feeder and then overhauled into a
real notification pipeline. M3's remaining work is therefore validation artifacts and a
live-mainnet demonstration, not new infrastructure.

- [x] **Automated alerts — 13 rules**
  ([`monitoring/alerts.yml`](../../offchain/feeder/monitoring/alerts.yml)):
  `OraclePairStale`, `ReceiverBalanceLow`, `SettleOverdue`, `PaymentHookWithdrawReady`,
  `AdminWalletLow`, `AdminWalletFragmented`, `PriceDeviationHigh`, `PriceAgeHigh`,
  `FeedAccuracyFail`, `ReorgRateHigh`, `ReceiverDepositsPending`, `PrimaryProviderDown`,
  `SecondaryProviderDown`. Thresholds single-sourced from
  `infrastructure.<network>.yaml::alerting.*` by
  [`scripts/monitoring/generate-monitoring.ts`](../../offchain/feeder/scripts/monitoring/generate-monitoring.ts);
  a drift test fails CI if any mirror diverges.
- [x] **Real notification pipeline** — Prometheus rules → **Alertmanager**
  ([`monitoring/alertmanager.yml`](../../offchain/feeder/monitoring/alertmanager.yml)) →
  feeder webhook ([`src/alerting/webhook.ts`](../../offchain/feeder/src/alerting/webhook.ts))
  → `alert_log` + logs. All 13 rules now land in `alert_log` and notify; Telegram/email
  are one config flip away (`alerting.notifications`, secrets in `.env`). The old
  in-process evaluator was **retired** so there is a single source of truth.
- [x] **Anomaly-detection metrics** ([`src/api/metrics.ts`](../../offchain/feeder/src/api/metrics.ts)):
  `price_deviation_percent` (misreport), `price_age_seconds` + per-pair staleness (stale
  data), reorg counter (chain instability).
- [x] **Per-feed sanity check** (on-chain vs DIA source)
  ([`src/sanity-check/feed-sanity.ts`](../../offchain/feeder/src/sanity-check/feed-sanity.ts),
  run via `npm run sanity:feeds`): PASS/WARN/FAIL per feed against the latest DIA
  `IntentRegistered`, thresholds mirroring the push policy (no hardcoded tolerances),
  emitting `dia_bridge_feed_sanity_status{symbol}` and the `FeedAccuracyFail` alert.
- [x] **Three dashboards** (provisioned, all cascade-filter customer → client → symbol):
  [`feeder.json`](../../offchain/feeder/monitoring/grafana/dashboards/feeder.json)
  (operational overview), `feeder-tx.json` (per-transaction axis), and the new
  `feeder-internals.json` (scanner / workers / http+db / recovery+cron / per-phase
  latency — the "broad metrics dashboard" that was previously open).
- [x] **Alert-trigger harness** —
  [`scripts/monitoring/trigger-alert.sh`](../../offchain/feeder/scripts/monitoring/trigger-alert.sh)
  pushes a synthetic series across the **real** threshold via a Pushgateway so the actual
  rule fires through the whole pipeline; `trigger-alert-demo.sh` walks the alert list,
  captures the `/alerts` transition + `alert_log` row + dashboard PNG, and writes a
  timeline. Preview firing captured under
  [`alert-trigger-preview-20260618-063047`](../milestones/evidence/alert-trigger-preview-20260618-063047/).
- [x] **M3 evidence packager** ([`scripts/m3-evidence/`](../../offchain/feeder/scripts/m3-evidence/),
  `make evidence3`): emits an M3 QA pack with the three dashboard renders, the per-feed
  sanity step, the alert-trigger bundle, the test-suite run, and DB/API snapshots. A
  Preview pack exists (`m3-preview-20260608-040304`).
- [x] **Monitoring HTTP surface** ([`src/api/routes.ts`](../../offchain/feeder/src/api/routes.ts)):
  `/api/v1/alerts`(+`/{id}`,`/{id}/ack`,`/ingest`), `/api/v1/performance`,
  `/api/v1/status`(+`/components`), `/health/*`, `/metrics`.
- [x] **In-repo documentation** updated in place: feeder architecture
  ([`../architecture/feeder.md`](../architecture/feeder.md)), feeder README + `config/README.md`
  (the `feed_sanity` + `notifications` blocks, the Alertmanager service), and the
  maintained Grafana dashboards guide.

## What remains

The remaining work is one live-mainnet capture plus the reports/PoA assembled from it.
The machinery above is all proven on Preview; M3 acceptance is explicit that visibility
and alerting are over **mainnet** feeds.

### 1 · Live mainnet monitoring run

- [ ] Short **Mainnet** monitoring run with the full stack attached (Prometheus + Grafana
  + Alertmanager) against the live `client-test-01` mainnet feeds, reusing the M2 mainnet
  deployment (`m2-mainnet-20260616-074413` is the baseline). Capture the **monitoring-centric**
  pack via `make evidence3`: dashboards live, the per-feed sanity check run on the mainnet
  feeds, and at least one safe alert firing → resolving.

### 2 · M3 demo video

- [ ] Demo video (distinct from the M2 video): dashboards + live mainnet logs + feed
  health checks + at least one alert firing → resolving on screen.

### 3 · Uptime & accuracy report

- [ ] A sustained-window report: **uptime** as confirmed-oracle-update liveness (fraction
  of expected heartbeats that produced a confirmed on-chain update, plus feeder process
  liveness), and **accuracy** as the per-feed price/timestamp deltas from the sanity check
  aggregated over the window. Render as `uptime-accuracy.md` + CSV/JSON in the M3 pack.
  (The 99.99% bar is M4; for M3 we report the real observed numbers honestly over the demo
  window.)

### 4 · QA validation report

- [ ] Assemble the final QA validation report (with `## Contents`) from the live mainnet
  pack: the integration-test results, the alert-trigger logs (each alert firing →
  resolving), and the per-feed sanity table. The packager produces all the inputs; this is
  the assembled human-facing artifact, which only exists once captured against a running
  mainnet deployment.

### 5 · milestone-3-poa.md

- [ ] `docs/milestones/milestone-3-poa.md` mapping M3 acceptance → evidence, mirroring the
  accepted M1/M2 PoAs (submission commit, AC→evidence tables, outputs-delivered table,
  how-to-verify, and the identical "dev-docs publication on DIA's site deferred to M4"
  paragraph). Headline evidence: the QA validation report, the alert-trigger logs, the
  uptime/accuracy report, the live-mainnet dashboards/video, and the per-feed accuracy
  table.

## Dependencies and ordering

1. **Mainnet monitoring run** is the gate — it produces the inputs for the reports, the
   video, and the PoA. Reuse the M2 mainnet deployment; do not redeploy.
2. **Uptime & accuracy report** and the **QA validation report** are assembled from that
   run.
3. **PoA** is last, once the artifacts exist.

A credible uptime number benefits from the feeder-stability work that is **M4** scope
(driving down the daemon crash-recovery / WASM self-exit restarts); for M3 we report the
real observed numbers over the demo window.

## Open questions

- [ ] **Mainnet demo window length / ADA budget** — how long the M3 live-mainnet run is
  (bounds ADA cost), and whether it is the same run that backs M4's sustained-uptime
  evidence.
- [ ] **Authorized signer-set completeness** — the accuracy of the signer field in the
  sanity check assumes the authorized set is complete; still unconfirmed by DIA.
</content>
</invoke>
