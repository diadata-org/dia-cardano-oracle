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

- [x] **Automated alerts — 12 rules**,
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
  rules are Prometheus-side only. (Relevant to M3-B: in-process firings are queryable
  via `/api/v1/alerts`; Prometheus-only firings are captured from `/api/v1/alerts`
  Prometheus state.)
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

- [ ] A script/command that, per configured feed, reads the **live Pair UTxO**
  (price, timestamp, nonce, signer, intent-hash) from the on-chain datum and compares
  it against the **current DIA source price** for the same symbol, emitting:
  - absolute + relative price delta vs the DIA source at read time,
  - on-chain timestamp age vs the source publish time (freshness),
  - a PASS/WARN/FAIL verdict per feed against thresholds sourced from
    `infrastructure.<network>.yaml` (NO hardcoded tolerances — reuse the
    `price_deviation` / freshness keys; add a dedicated `sanity_check.*` block only if
    no existing key fits).
- [ ] Reuse the existing on-chain read path (the `pair-state` reconcile datum decode)
  rather than a second decoder; reuse the feeder's DIA price cache / source client for
  the source side.
- [ ] Output: machine-readable JSON (per-feed rows) + a human table, written under the
  evidence tree so M3-F can fold it in.

**Tests:** unit tests on the comparison/verdict logic (matching, within-tolerance,
stale, missing-on-chain, source-unavailable). Adversarial: tampered/old on-chain datum
→ FAIL; source outage → WARN not crash.

**Deliverable:** the script + a sample per-feed accuracy table (10 Preview feeds, then
the 10 Mainnet RWA feeds for the live run).

### M3-B · Alert-trigger harness + captured alert logs

**Why:** AC requires "automated alerts" validated by "expected alert behavior," and the
evidence list calls out **alert-trigger logs**. Today firing is **manual** (documented
in [`_archived/m2-demo-video-script.md`](./_archived/m2-demo-video-script.md)); no
automated trigger exists.

**Scope:**

- [ ] A harness (script or `node:test` suite) that **deliberately drives each
  safe alert** to fire and captures the transition. Safe-on-Preview set first:
  `OraclePairStale` (stop refreshing a pair / lower its staleness threshold for the
  run), `PriceDeviationHigh`, `PriceAgeHigh`, `ReceiverBalanceLow`, `SettleOverdue`,
  `ReceiverDepositsPending`. Financial-drain alerts (`AdminWalletLow`) stay
  **simulated/never forced on Mainnet**.
- [ ] For in-process alerts (`OraclePairStale`) capture the `alert_log` fire→resolve
  rows via `/api/v1/alerts`; for Prometheus-only rules capture the `/api/v1/alerts`
  Prometheus state (pending→firing→resolved) snapshots.
- [ ] Decide per alert whether it is forced **live** (state manipulation) or
  **demonstrated** via a unit test that feeds the evaluator/PromQL a synthetic series —
  prefer a real firing where safe, a deterministic test where forcing is unsafe/slow.

**Tests:** the harness itself is test-shaped; assert each targeted alert reaches
`firing` and then `resolved` after remediation.

**Deliverable:** captured alert-trigger logs (one bundle per alert: the rule, the
forced condition, the fire timestamp, the `/alerts` transition, the remediation, the
resolve) — feeds the QA report and the M3 video.

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

- [ ] **Verify emission first.** The Explore pass flagged several of these as
  *defined but possibly not incremented at runtime* (stubs). Before adding a panel,
  confirm the metric actually moves in a live run — a panel for a never-incremented
  metric is worse than none. Drop or fix any stub instead of dashboarding a flat line.
- [ ] New dashboard JSON (e.g. `feeder-internals.json`) grouped by subsystem
  (scanner / workers / http+db / recovery+cron / per-phase latency), wired into
  Grafana provisioning, with template vars consistent with the existing dashboards.
- [ ] Align panel windows with the alert windows (PriceAge/PriceDeviation alert at
  10 m) so panels and alerts agree.
- [ ] Extend `threshold-drift.test.ts` template-var assertions to the new dashboard.

**Deliverable:** the dashboard + PNGs captured by `make evidence`.

### M3-E · Live Mainnet monitoring demo + M3 video

**Why:** AC #1 is explicit that visibility/alerting is over **mainnet** feeds; evidence
requires a **demo video** of dashboards + live mainnet logs showing feed health checks.

**Scope:**

- [ ] Short **Mainnet** monitoring run with the full stack attached (Prometheus +
  Grafana + alert evaluator) against the live `client-test-01` mainnet feeds — reuse
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

- [ ] **Generalize the evidence packaging** beyond M2: the scripts hardcode
  `m2-`/`milestone-2-` naming (dir `m2-<network>-<stamp>`, `milestone-2-<network>-evidence.md`).
  Parameterize the milestone number (or add an M3 mode) so `make evidence` can emit an
  M3 QA pack with the same capture machinery. Keep it DRY — one packaging path, a
  milestone variable.
- [ ] **Integration tests** validating (a) oracle data ingestion end-to-end and
  (b) alert triggering — wire the existing feeder + Aiken suites + the M3-B harness into
  a named QA run, capture exit codes/counts (the pack already records test results).
- [ ] **Per-feed sanity checks** (M3-A output) embedded as the accuracy section.
- [ ] Assemble `qa-validation-report.md` (with `## Contents` TOC) + supporting logs.

**Deliverable:** the QA validation report doc + its evidence pack.

### M3-G · milestone-3-poa.md

- [ ] `docs/milestones/milestone-3-poa.md` mapping M3 AC → evidence, mirroring the
  accepted M1/M2 PoAs: submission commit, AC→evidence tables, outputs-delivered table,
  how-to-verify, and the identical "dev-docs publication on DIA's site deferred to M4"
  paragraph. Headline evidence: the QA validation report, the alert-trigger logs, the
  uptime/accuracy report, the live-mainnet dashboards/video, and the per-feed accuracy
  table.

## Dependencies & ordering

1. **M3-A (per-feed sanity check)** — start here. Pure code, testable on Preview now,
   no long run needed; it is the core of the QA report and the accuracy report.
2. **M3-B (alert-trigger harness)** — parallel to A; both feed M3-F.
3. **M3-D (broad dashboard)** — independent code; do the *verify-emission* sub-step
   early since it may surface stub metrics to fix.
4. **M3-C (uptime/accuracy)** — needs a sustained window; consumes A's output.
5. **M3-F (QA report)** — generalize evidence packaging, then assemble A+B+tests.
6. **M3-E (live mainnet demo + video)** — needs A, B, D ready so the demo shows the
   real sanity check + a real alert + the dashboards; reuses the M2 mainnet deployment.
7. **M3-G (PoA)** — last, once the artifacts exist.

A→(B,D) parallel → C → F → E → G.

## Plan alignment status

The grounded discrepancies found on 2026-06-16 were applied to
[`m3-m4-plan.md`](./m3-m4-plan.md) and [`work-plan.md`](./work-plan.md) on 2026-06-17:

- The alert count is **12**, not 8.
- The in-process evaluator writes **only `OraclePairStale`**; `PriceDeviationHigh` and
  the other non-staleness rules are Prometheus-only.
- The M2 Mainnet feeder pack (`m2-mainnet-20260616-074413`) is now treated as the
  baseline for the M3 monitoring-centric mainnet capture, not as work still to bring up from zero.

## Open questions / decisions

- [ ] **DIA source for the accuracy comparison.** M3-A compares on-chain vs the DIA
  source — confirm the canonical source endpoint/price semantics to compare against
  (the same source the feeder consumes vs the DIA public API), so "accuracy" is
  measured against the right reference.
- [ ] **Authorized signer set completeness** (carried from the feeder plan) — accuracy
  of the signer field in M3-A's read assumes the authorized set is complete; still
  unconfirmed by DIA.
- [ ] **Mainnet demo window length / ADA budget** — how long the M3 live-mainnet run
  is (bounds ADA cost) and whether it is the same run that backs M4's sustained-uptime
  evidence.
