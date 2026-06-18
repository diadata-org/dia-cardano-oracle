# Milestone 3 — Monitoring Library: Detailed Plan

Detailed, code-grounded execution plan for **Milestone 3 (Implement Monitoring
Library for DIA Oracles on Cardano)**. This is the delivery-level companion to the
milestone-facing view in [`m3-m4-plan.md`](./m3-m4-plan.md); the official wording it
must satisfy is quoted in
[`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md),
and the accepted PoA format it mirrors is
[`../milestones/milestone-1-poa.md`](../milestones/milestone-1-poa.md) /
[`../milestones/milestone-2-poa.md`](../milestones/milestone-2-poa.md).

Every "already built" claim below was verified against the tree on 2026-06-16
(file:line given). Tasks are `[ ]` open · `[x]` done · `[~]` partial.

## Contents

- [Milestone 3 — Monitoring Library: Detailed Plan](#milestone-3--monitoring-library-detailed-plan)
  - [Contents](#contents)
  - [What M3 asks for](#what-m3-asks-for)
  - [Already built (verified)](#already-built-verified)
  - [What remains — workstreams](#what-remains--workstreams)
    - [M3-A · Per-feed sanity check (on-chain vs DIA source)](#m3-a--per-feed-sanity-check-on-chain-vs-dia-source)
    - [M3-B · Alert-trigger harness + captured alert logs](#m3-b--alert-trigger-harness--captured-alert-logs)
    - [M3-C · Uptime \& accuracy report](#m3-c--uptime--accuracy-report)
    - [M3-D · Broad metrics dashboard](#m3-d--broad-metrics-dashboard)
    - [M3-E · Live Mainnet monitoring demo + M3 video](#m3-e--live-mainnet-monitoring-demo--m3-video)
    - [M3-F · QA validation report](#m3-f--qa-validation-report)
    - [M3-G · milestone-3-poa.md](#m3-g--milestone-3-poamd)
    - [M3-H · Production alerting — notification delivery + single pipeline](#m3-h--production-alerting--notification-delivery--single-pipeline)
    - [M3-I · Documentation of the new work (in-repo, proportionate)](#m3-i--documentation-of-the-new-work-in-repo-proportionate)
  - [Dependencies \& ordering](#dependencies--ordering)
  - [Plan alignment status](#plan-alignment-status)
  - [Open questions / decisions](#open-questions--decisions)

## What M3 asks for

Official outputs: **QA validation report · anomaly detection · uptime & accuracy
reports · automated alerts · developer documentation.**

Acceptance criteria (verbatim intent):

1. Real-time visibility of DIA oracle feeds operating **on Cardano mainnet**.
2. Anomalies in **uptime, accuracy, or data freshness** trigger automatic alerts.
3. Validated by **QA review and live on-chain performance**.
4. The **QA validation report** includes integration tests validating oracle data
   ingestion and alert triggering, plus **sanity checks confirming oracle timestamp
   and price accuracy for each price feed**.
5. Developer documentation (publication on DIA's site is **deferred to M4** per the
   accepted M1 precedent; in-repo docs stay complete and current).

Evidence: monitoring source + config examples + dev docs, a **demo video** of
dashboards and **live mainnet logs** showing feed health checks, plus QA artifacts
(test reports, **alert-trigger logs**, dashboard screenshots/exports).

## Already built (verified)

The monitoring **machinery** was built alongside the M2 feeder. M3 reuses it; the
remaining work is validation artifacts + a live-mainnet demonstration, not new
monitoring infrastructure.

- [x] **Automated alerts — 12 rules at the M3 baseline** (M3-A added `FeedAccuracyFail` → **13 now**),
  [`offchain/feeder/monitoring/alerts.yml`](../../offchain/feeder/monitoring/alerts.yml):
  `OraclePairStale`, `ReceiverBalanceLow`, `SettleOverdue`, `PaymentHookWithdrawReady`,
  `AdminWalletLow`, `AdminWalletFragmented`, `PriceDeviationHigh`, `PriceAgeHigh`,
  `ReorgRateHigh`, `ReceiverDepositsPending`, `PrimaryProviderDown`,
  `SecondaryProviderDown`.
- [x] **Thresholds single-sourced** from
  [`config/infrastructure.<network>.yaml`](../../offchain/feeder/config/infrastructure.preview.yaml)
  `::alerting.*`, written into `alerts.yml` + the dashboard by
  [`scripts/monitoring/generate-monitoring.ts`](../../offchain/feeder/scripts/monitoring/generate-monitoring.ts)
  (`make generate-monitoring`, runs before `make up`); drift guarded by
  [`src/config/__tests__/threshold-drift.test.ts`](../../offchain/feeder/src/config/__tests__/threshold-drift.test.ts)
  (`make check-thresholds`).
- [~] **In-process alert evaluator**
  [`src/alerting/evaluator.ts`](../../offchain/feeder/src/alerting/evaluator.ts) —
  evaluates **only `OraclePairStale`** and writes the `alert_log` table; the other 11
  rules are Prometheus-side only, and Prometheus has **no Alertmanager** wired, so they
  fire but notify nowhere. **M3-H replaces this** with a single Prometheus → Alertmanager
  → webhook pipeline that lands all 13 rules in `alert_log` and can notify.
- [x] **Anomaly-detection metrics**: `price_deviation_percent` (misreport),
  `price_age_seconds` + per-pair staleness (stale data), reorg counter (chain
  instability) — defined in
  [`src/api/metrics.ts`](../../offchain/feeder/src/api/metrics.ts).
- [x] **Dashboards (2)**:
  [`feeder.json`](../../offchain/feeder/monitoring/grafana/dashboards/feeder.json)
  (~23 panels: balances, staleness, per-symbol + per-tx throughput, latency,
  price-deviation/age quality, billing, provider health) and
  [`feeder-tx.json`](../../offchain/feeder/monitoring/grafana/dashboards/feeder-tx.json)
  (per-transaction stage latency, success ratio, batch-size).
- [x] **Monitoring HTTP surface** ([`src/api/routes.ts`](../../offchain/feeder/src/api/routes.ts)):
  `/api/v1/alerts`(+`/{id}`,`/{id}/ack`), `/api/v1/performance`, `/api/v1/status`(+`/components`),
  `/health`,`/health/live`,`/health/ready`, `/metrics`.
- [x] **Evidence packaging** (`make evidence`):
  [`scripts/m2-evidence/package-m2-evidence.sh`](../../offchain/feeder/scripts/m2-evidence/package-m2-evidence.sh)
  + `build-stats.ts` + `build-error-counts.ts` + `build-alerts.ts` — captures raw logs,
  DB CSVs, API snapshots, Grafana PNGs (both dashboards), per-symbol stats + latency
  p50/p95, error-counts, and an alerts-active snapshot. **This is the template for the
  M3 QA pack** (see M3-F; the scripts are M2-named and need generalizing).

## What remains — workstreams

### M3-A · Per-feed sanity check (on-chain vs DIA source)

**Why:** AC #4 requires "sanity checks confirming oracle timestamp and price accuracy
for each price feed." **Confirmed absent today** — the closest code is
[`offchain/cli/src/lib/reconcile/pair-state.ts`](../../offchain/cli/src/lib/reconcile/pair-state.ts)
(reads live Pair UTxOs, decodes the datum, but reconciles **nonce only** — no
price/timestamp comparison); [`src/config/abi-parser.ts`](../../offchain/feeder/src/config/abi-parser.ts)
is shape validation only.

**Scope (code):**

> Status: the **pure verdict core is implemented + tested** —
> [`src/sanity-check/feed-sanity.ts`](../../offchain/feeder/src/sanity-check/feed-sanity.ts)
> (9 tests, the PASS/WARN/FAIL matrix). What remains below is `deriveThresholds`, the
> on-chain + registry I/O, the output, and the metric/alert.

- [x] Pure `evaluateFeedSanity(reading, thresholds)` → PASS/WARN/FAIL per feed, reusing
  `computePriceDeviationPct` (same math as the push gate). FAIL only on a confirmed
  misreport (price drifted past tolerance) that is ALSO stale.
- [x] Map the active router destination to the verdict thresholds, **mirroring the
  push-policy modes** ([push-policy ref](../audit/20260609-feeder-push-policy-config.md)),
  NO hardcoded tolerances: price tolerance = `price_deviation`; freshness ceiling =
  `time_threshold` when > 0 (modes 1–4), else `max_staleness` (modes 6–7), else no ceiling
  (mode 5 → never FAIL on freshness). Done + tested (4 tests). The check has its **own
  config block + clock** (`feed_sanity` in `infrastructure.<network>.yaml`: `enabled`,
  `interval`, `freshness_grace_seconds`), deliberately separate from `cron_service` and
  the balance refresh so cadence/naming are never conflated. The grace comes from
  `feed_sanity.freshness_grace_seconds` — not hardcoded.
- [x] I/O: on-chain side reuses `decodePairDatum` (via the feeder lib-bridge) — no
  second decoder. Source side reads the **latest `IntentRegistered` for the symbol from
  the DIA registry** (reuse the `scan-dia-intents.ts` path), robust for a standalone run
  without the daemon — not the in-memory price cache.
- [x] Output: machine-readable JSON (per-feed rows) + a human table, written under the
  evidence tree so M3-F can fold it in.
- [x] Emit a **`dia_bridge_feed_sanity_status{symbol}`** gauge (PASS/WARN/FAIL) + an
  on-chain-vs-source deviation gauge, and add a **`FeedAccuracyFail`** Prometheus alert.
  This fills the real gap: no current alert fires on on-chain-vs-source divergence
  (`PriceDeviationHigh` is event-driven at intent time, not a poll). Routes through the
  M3-H pipeline.

**Tests:** verdict logic + threshold derivation covered (13 tests). Still to test: the
aggregation across feeds and the metric emission. Adversarial: tampered/old on-chain
datum → FAIL; source outage → WARN not crash.

**Deliverable:** the script + a sample per-feed accuracy table (10 Preview feeds, then
the 10 Mainnet RWA feeds for the live run).

### M3-B · Alert-trigger harness + captured alert logs

**Why:** AC requires "automated alerts" validated by "expected alert behavior," and the
evidence list calls out **alert-trigger logs**. Today firing is **manual** (documented
in [`_archived/m2-demo-video-script.md`](./_archived/m2-demo-video-script.md)); no
automated trigger exists.

All alerts now flow through one pipeline (Prometheus rules → Alertmanager → the
feeder webhook → `alert_log`), so the harness fires a real alert by pushing a synthetic
metric value at the **input** of that pipeline and lets the rest run untouched.

- [x] **Trigger harness — Pushgateway (built + verified).**
  [`scripts/monitoring/trigger-alert.sh`](../../offchain/feeder/scripts/monitoring/trigger-alert.sh)
  pushes a synthetic metric value for one alert to a **Pushgateway** scraped by
  Prometheus (`honor_labels: true`, tagged with the active `network`). The metric crosses
  the **real** threshold from `alerts.yml`, so the actual rule fires after its `for:`
  window and flows through Alertmanager → the feeder webhook → `alert_log` — nothing is
  faked except the one input series. Covers every alert (single-push for
  gauge/timestamp/status rules; a rising-series push for the rate/histogram rules
  `ReorgRateHigh`, `PriceDeviationHigh`, `PriceAgeHigh` that are unsafe/slow to force
  live). `clear` resets. The pushed series is independent of the feeder's own series, so
  the feeder's live beats never overwrite it; the alert stays firing until `clear`.
  **Verified** on the live stack: `OraclePairStale`, `ReceiverBalanceLow`,
  `FeedAccuracyFail` reached `firing` with `network=Preview`. Replaces the earlier
  `promtool`-rule-test idea (dropped — `promtool` compares rule annotations with no
  ignore flag, so the network-injected annotations made it brittle; the Pushgateway
  exercises the whole pipeline, not just the rule, which is stronger evidence).
- [x] **Timed demo + evidence capture orchestrator — built.**
  [`scripts/monitoring/trigger-alert-demo.sh`](../../offchain/feeder/scripts/monitoring/trigger-alert-demo.sh)
  walks the alert list (a safe default set, `all`, or named alerts), and for each: fires
  it via `trigger-alert.sh` → polls Prometheus until it reports `firing` (capturing the
  real fire latency, up to `MAX_FIRE_WAIT`) → snapshots the Prometheus alert state AND the
  feeder `alert_log` row (`/api/v1/alerts`) AND a dashboard PNG → `clear` → polls until it
  resolves. It appends a documented timeline (alert · pushed-at · fire latency · cleared-at
  · resolved) to `timeline.md`. One tool produces both the on-screen demo for the M3 video
  and the **alert-trigger logs** evidence. Run live (against the up stack) in the live
  session.
- [ ] **Live forcing (optional, during the live session).** Where cheap and safe, also
  drive one or two alerts by real state on Preview (`OraclePairStale` by pausing a pair
  refresh; balance alerts by letting balances move) to show a non-synthetic firing
  alongside the harness. Financial-drain alerts (`AdminWalletLow`) stay synthetic, never
  forced on Mainnet.

**Deliverable:** the Pushgateway trigger harness (done) + the timed capture orchestrator,
producing a per-alert bundle (rule · forced condition · fire timestamp · `/alerts`
transition · `alert_log` row · resolve) — feeds the QA report (M3-F) and the M3 video.

### M3-C · Uptime & accuracy report

**Why:** official output "uptime and accuracy reports." Today only **post-hoc
evidence-pack stats** exist (confirmed/failed/condemned tx, reorgs, per-symbol latency
p50/p95 computed at pack-assembly in `package-m2-evidence.sh` + `build-stats.ts`); no
uptime-% or accuracy reporter.

**Scope:**

- [ ] **Uptime** defined operationally as confirmed-oracle-update liveness over a
  sustained window: per feed, the fraction of expected heartbeats (router
  `time_threshold`) that produced a confirmed on-chain update, plus feeder process
  liveness (gap analysis on the scanner/checkpoint + crash-recovery row count). Build
  on `build-stats.ts`; add an uptime aggregation rather than a new collector.
- [ ] **Accuracy** = the M3-A per-feed price/timestamp deltas aggregated over the
  window (mean/max deviation, max staleness per feed).
- [ ] Render as a report doc + supporting CSV/JSON in the evidence tree.

**Note:** a credible sustained-window number depends on driving down the daemon
crash-recovery / WASM self-exit restarts (the 99.99% bar is M4; for M3 we report the
real observed numbers honestly over the demo window).

**Deliverable:** `uptime-accuracy.md` + CSVs in the M3 pack.

### M3-D · Broad metrics dashboard

**Why:** plan item — surface the metric families that are emitted but shown on no
panel. Verified emitted-not-dashboarded families in
[`src/api/metrics.ts`](../../offchain/feeder/src/api/metrics.ts):

- 5 per-symbol latency phases (`intent_to_registration`, `registration_to_scan`,
  `scan_to_processing`, `processing_to_submission`, `submission_to_confirmation`),
- scanner `rpc_errors` + backfill (`backfill_blocks` / `backfill_chunks`),
- worker pools (`active_workers`, `worker_pool_size`, `worker_queue_size`,
  `worker_tasks_{completed,failed,dropped,retries}`),
- `http_request_duration_seconds`, `recovery_attempts_total`, db ops
  (`db_operations_total`, `db_operation_duration_seconds`), `cron_resubmissions_total`,
  plus event-level counters and node/process defaults.

**Scope:**

- [x] **Verify emission first.** Static check done (2026-06-17): most candidates ARE
  emitted in code (the 5 per-symbol latency phases, scanner rpc-errors + backfill,
  worker active/pool/queue/dropped, http duration, cron resubmissions, provider-last-ok).
  **Four are true stubs** — declared + registered but emitted by NO production code,
  only touched by `metrics.test.ts`: `workerTasksCompleted`, `bridgeRecoveryAttempts`,
  `bridgeDbOperations`, `bridgeDbOperationDuration`. They get NO panel.
- [x] **The 4 stubs — WIRED (DIA chose "connect them").** Now emitted by real code:
  `worker_tasks_completed` (the always-running submission pool), `recovery_attempts`
  (crash-recovery sweep), `db_operations` + `db_operation_duration` (a `instrumentDb`
  wrapper timing every data op). Also fixed: the worker active/queue/pool gauges now
  emit for the submission pool too, so they work in ANY mode (not only parallel).
- [x] New dashboard JSON (`feeder-internals.json`) grouped by subsystem
  (scanner / workers / http+db / recovery+cron / per-phase latency), wired into
  Grafana provisioning, with template vars consistent with the existing dashboards.
- [x] Align panel windows with the alert windows (PriceAge/PriceDeviation alert at
  10 m) so panels and alerts agree.
- [x] Extend `threshold-drift.test.ts` template-var assertions to the new dashboard.
- [x] **Coverage audit + close the gaps (2026-06-18).** Audited every declared
  `dia_bridge_*` metric vs every dashboard panel `expr`: 62 declared, 16 unshown. Two real
  gaps closed — the **`feed_sanity_status` verdict** (emitted + alerted by `FeedAccuracyFail`
  but on no panel; added to Overview Row 4) and the **event/intent funnel** (the "#1 suggested
  panel"; added to Internals as "Pipeline funnel & HTTP", with `http_requests_total`). Also
  corrected `feeder.md §19C`, which wrongly claimed `feed_sanity_status` was already on
  Internals. The remaining unshown metrics (Spectra lifecycle aliases, `scanner_last_block`,
  `receiver_topup_warnings`, `pair_is_create`) are low-value and deliberately skipped.

**Deliverable:** the dashboard + PNGs captured by `make evidence`.

### M3-E · Live Mainnet monitoring demo + M3 video

**Why:** AC #1 is explicit that visibility/alerting is over **mainnet** feeds; evidence
requires a **demo video** of dashboards + live mainnet logs showing feed health checks.

**Scope:**

- [ ] Short **Mainnet** monitoring run with the full stack attached (Prometheus +
  Grafana + Alertmanager) against the live `client-test-01` mainnet feeds — reuse
  the M2 mainnet deployment (`mainnet_run_20260616-074413`). The M2 mainnet pack
  (`m2-mainnet-20260616-074413`) is the baseline; M3 adds the **monitoring-centric**
  capture (dashboards live, M3-A sanity check on mainnet feeds, M3-B alert firing).
- [ ] **M3 demo video** (distinct from the M2 video): dashboards + live mainnet logs +
  feed health checks + at least one alert firing→resolving on screen.
- [ ] Capture the pack via the generalized evidence script (M3-F) named for the run-id.

**Deliverable:** M3 mainnet monitoring pack + the M3 video link.

### M3-F · QA validation report

**Why:** the headline M3 artifact. Assembles M3-A (per-feed sanity) + M3-B
(alert-trigger logs) + the existing integration tests into one report.

**Scope:**

- [x] **A fresh, standalone M3 evidence packager — built.** The M2 script
  (`scripts/m2-evidence/`) is left **untouched**. New
  [`scripts/m3-evidence/`](../../offchain/feeder/scripts/m3-evidence/)
  (`package-m3-evidence.sh` + `build-stats.ts` + `build-error-counts.ts` +
  `build-alerts.ts`) emits an M3 QA pack (`m3-<network>-<stamp>/`,
  `milestone-3-<network>-evidence.md`) via the new `make evidence3` target. Outputs table
  rewritten to M3's official outputs. M3-specific captures wired in: the **Internals**
  dashboard render (M3-D), a **per-feed sanity** step (`step 5e`, runs `sanity:feeds` into
  the pack) and an **alert-trigger logs** step (`step 5f`, folds in a
  `trigger-alert-demo.sh` bundle via `ALERT_TRIGGER_DIR`). Both degrade to a documented
  note when the live stack/chain is offline. The no-duplication rule is waived **here
  only** — these milestone packagers are single-use and frozen once delivered.
- [x] **Integration tests** — the pack runs the feeder + CLI suites (`step 5d`) and
  records exit codes/counts; the **alert-trigger logs** section is produced by the M3-B
  orchestrator (fire → capture `/alerts` + `alert_log` → resolve), folded in via `step 5f`.
- [x] **Per-feed sanity checks** (M3-A output) embedded as the accuracy section (`step 5e`
  → "Per-feed sanity (accuracy)").
- [ ] Assemble the final QA validation report from a live pack (with `## Contents` TOC) —
  the live-session output once the pack is captured against a running deployment.

**Deliverable:** the QA validation report doc + its evidence pack.

### M3-G · milestone-3-poa.md

- [ ] `docs/milestones/milestone-3-poa.md` mapping M3 AC → evidence, mirroring the
  accepted M1/M2 PoAs: submission commit, AC→evidence tables, outputs-delivered table,
  how-to-verify, and the identical "dev-docs publication on DIA's site deferred to M4"
  paragraph. Headline evidence: the QA validation report, the alert-trigger logs, the
  uptime/accuracy report, the live-mainnet dashboards/video, and the per-feed accuracy
  table.

### M3-H · Production alerting — notification delivery + single pipeline

**Why:** the system is going to **production**, not just a milestone demo. Today the 12
`alerts.yml` rules are evaluated by Prometheus but **route nowhere** (no Alertmanager →
no mail/Telegram; a firing alert is an alarm in an empty room), and a parallel in-process
evaluator independently writes only `OraclePairStale` to `alert_log`. A production oracle
needs anomalies to (a) be able to reach a human and (b) flow through **one** source of
truth.

**Target architecture** (decided 2026-06-17):

```
metrics → Prometheus (rules from infrastructure.<network>.yaml) → Alertmanager
                                                                    ├─ webhook → feeder ingest → alert_log + logs   [active now]
                                                                    ├─ telegram_configs   [scaffolded, disabled]
                                                                    └─ email_configs      [scaffolded, disabled]
```

**Scope:**

- [x] Add an **Alertmanager** service (docker-compose, network-scoped volume like the
  rest of the stack) + `monitoring/alertmanager.yml`; wire Prometheus
  `alerting.alertmanagers`.
- [x] **Webhook receiver → feeder.** New feeder endpoint (e.g. `POST /api/v1/alerts/ingest`)
  that accepts the Alertmanager webhook payload and writes each firing/resolved alert to
  `alert_log` + the feeder log. This makes **all 13 rules** land in `alert_log` and the
  `/api/v1/alerts` API, not just `OraclePairStale`; grouping/dedup/silencing are handled
  by Alertmanager (10 stale pairs → 1 notification, not 10).
- [x] **Single source of truth.** Retire the parallel in-process evaluator
  ([`src/alerting/evaluator.ts`](../../offchain/feeder/src/alerting/evaluator.ts)) now
  that Prometheus → Alertmanager → webhook owns the pipeline. If a thin app-side
  staleness net is still wanted, document it as deliberate, not a second evaluator that
  silently diverges.
- [x] **Notification channels — one place to configure, off for now.** Where you turn
  them on/off and set recipients: a new `alerting.notifications` block in
  [`config/infrastructure.preview.yaml`](../../offchain/feeder/config/infrastructure.preview.yaml)
  / `infrastructure.mainnet.yaml` — the **same file that already holds the alert
  thresholds** — e.g. `telegram: { enabled: false, chat_id: … }`,
  `email: { enabled: false, to: [ … ] }`. At startup the generator writes those into the
  generated `monitoring/alertmanager.yml` (you never hand-edit the generated file),
  exactly as it already writes thresholds into the alert rules. **Secrets** (Telegram bot
  token, SMTP password) live in `.env`, never in the YAML. Today both stay
  `enabled: false` → alerts go only to logs + the database; flipping `enabled: true` and
  adding the secret turns on delivery with no code change.
- [x] **Fix the hardcoded network in alert messages.** `generate-monitoring.ts` already
  injects per-config thresholds into `alerts.yml` at startup; extend it to inject the
  **active network** (from `CARDANO_NETWORK` / the active infra file) into the alert
  annotations instead of the hardcoded "Preview"/"Mainnet" strings — same
  generate-on-start mechanism, network becomes a variable, not a literal.

**Tests:** webhook ingest (payload → `alert_log` rows, fire + resolve); the generator
injects the network (drift test asserts no hardcoded network literal remains in
`alerts.yml` annotations); Alertmanager config validates (`amtool check-config`).

**Deliverable:** alerts flowing through one pipeline into `alert_log` + logs now, with
Telegram/email one config flip away; no hardcoded network in any alert message.

### M3-I · Documentation of the new work (in-repo, proportionate)

Document the M3 additions AND the changes to existing pieces (config blocks,
docker/monitoring, usage) — **only where a reader/operator would actually look**.
New code does not earn a line in every README; it goes where it belongs, no more,
no less, and is never weighted above existing content.

- [x] **Feeder architecture** ([`../architecture/feeder.md`](../architecture/feeder.md)):
  update in place (don't bolt on) the monitoring/alerting section to the pipeline as it
  now is (Prometheus → Alertmanager → webhook → `alert_log`; the in-process evaluator is
  gone), and add the per-feed sanity check (on-chain vs DIA source, its own clock).
- [x] **Feeder README / operator guide** (+ `config/README.md`): the `feed_sanity` + `notifications` config
  blocks (what they do, on/off), the `npm run sanity:feeds` command, the Alertmanager
  service + its `:9093` UI, and how to turn Telegram/email on (infra YAML + `.env`
  secret). A short usage section — not a re-paste of the YAML comments.
- [x] **Docker / monitoring section** (the `make up MONITORING=1` docs): mention the
  Alertmanager service + the secret-via-file mechanism where the stack is described —
  there, not everywhere.
- [x] `.env.example` documents the new notification secret keys.
- [x] Touch ONLY the docs a reader would consult for these features; do not spread the
  same paragraph across every README. Proportionate to weight.

## Dependencies & ordering

1. **M3-H (alerting pipeline)** — foundational. Alertmanager + webhook → `alert_log` is
   what makes alerts notify and unifies the source of truth; do early (parallel to the
   M3-A core). Underpins M3-B and M3-A's `FeedAccuracyFail` alert.
2. **M3-A (per-feed sanity check)** — core done; next `deriveThresholds` + I/O + output,
   then the metric/alert (needs M3-H). Core of the QA + accuracy reports.
3. **M3-B (alert-trigger harness)** — needs M3-H so firings land in `alert_log`; parallel
   to A. Both feed M3-F.
4. **M3-D (broad dashboard)** — independent code; do the *verify-emission* sub-step early
   (may surface stub metrics to fix).
5. **M3-C (uptime/accuracy)** — needs a sustained window; consumes A's output.
6. **M3-F (QA report)** — generalize evidence packaging, then assemble A+B+tests.
7. **M3-E (live mainnet demo + video)** — needs A, B, D, H ready; reuses the M2 mainnet
   deployment.
8. **M3-G (PoA)** — last, once the artifacts exist.

H + A-core in parallel → A-io/metric, B, D → C → F → E → G.

## Plan alignment status

The grounded discrepancies found on 2026-06-16 were applied to
[`m3-m4-plan.md`](./m3-m4-plan.md) and [`work-plan.md`](./work-plan.md) on 2026-06-17:

- The alert count is **12**, not 8.
- The in-process evaluator writes **only `OraclePairStale`**; `PriceDeviationHigh` and
  the other non-staleness rules are Prometheus-only.
- The M2 Mainnet feeder pack (`m2-mainnet-20260616-074413`) is now treated as the
  baseline for the M3 monitoring-centric mainnet capture, not as work still to bring up from zero.

## Open questions / decisions

- [x] **DIA source for the accuracy comparison — resolved.** The reference is the latest
  `IntentRegistered` for the symbol from the DIA registry (the same DIA-signed source the
  feeder consumes), not a public REST API.
- [ ] **Authorized signer set completeness** (carried from the feeder plan) — accuracy
  of the signer field in M3-A's read assumes the authorized set is complete; still
  unconfirmed by DIA.
- [ ] **Mainnet demo window length / ADA budget** — how long the M3 live-mainnet run
  is (bounds ADA cost) and whether it is the same run that backs M4's sustained-uptime
  evidence.
