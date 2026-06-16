# Plan — Milestones 3 & 4

What is left for **Milestone 3 (Monitoring Library)** and **Milestone 4 (End-to-End
Integration and Mainnet Deployment)**, grounded in the official Catalyst text
([`final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)) and the
accepted M1 PoA precedent
([`milestone-1-poa.md`](../milestones/milestone-1-poa.md)).

## Contents

- [Plan — Milestones 3 \& 4](#plan--milestones-3--4)
  - [Contents](#contents)
  - [How to read this](#how-to-read-this)
  - [Code still to write](#code-still-to-write)
  - [Cross-cutting: docs publication and PoA format](#cross-cutting-docs-publication-and-poa-format)
  - [Milestone 3 — Monitoring Library](#milestone-3--monitoring-library)
    - [M3 — already built (verified)](#m3--already-built-verified)
    - [M3 — remaining](#m3--remaining)
  - [Milestone 4 — End-to-End Integration and Mainnet Deployment](#milestone-4--end-to-end-integration-and-mainnet-deployment)
    - [M4 — already built](#m4--already-built)
    - [M4 — remaining](#m4--remaining)
  - [Dependencies and ordering](#dependencies-and-ordering)

## How to read this

`[x]` done · `[ ]` open · `[~]` partial. Workstream items (A–F) live in
[`work-plan.md`](./work-plan.md); the feeder detail lives in
[`milestone-feeder-plan.md`](./_archived/20260616-milestone-feeder-plan.md) (archived). This file is the milestone-facing
view of what those workstreams still owe M3 and M4. The **detailed M3 execution plan**
(code-grounded, per-workstream) lives in [`m3-monitoring-plan.md`](./m3-monitoring-plan.md).

A large share of the M3 monitoring **machinery** already exists (it was built alongside the
feeder for M2): Grafana dashboards, **12** Prometheus alert rules, the in-process
`OraclePairStale` evaluator, anomaly metrics (price deviation, staleness, data age), and the
M2 evidence-packaging script. M3's remaining work is therefore mostly **validation artifacts
and a monitoring-centric live-mainnet demonstration**, not new monitoring infrastructure. M4 is
where the most net-new work lives (sustained mainnet operation, the indexer, and the consolidated
documentation/closeout).

## Code still to write

Separating **code** from evidence / reports / video / ops, the remaining code surface is small
and lives almost entirely in M4:

**M3 — no core feature code.** The monitoring machinery (dashboards, `alerts.yml`, alert
evaluator, anomaly metrics) is already written. Only small, optional tooling:

- [ ] Broad metrics dashboard (JSON) for the still-unshown metric families — the metrics already
  exist as registered Prometheus families, but **runtime emission must be verified first** before
  dashboarding them. A panel for a never-incremented metric is worse than no panel.
- [ ] Per-feed **accuracy / sanity-check** script (on-chain price + timestamp vs the DIA source per
  pair) to back the QA validation report — does not exist today (only the abi-parser config
  sanity check does).
- [ ] Small script/test to deliberately **trigger each safe alert** so the QA pack can capture
  alert-trigger logs; unsafe financial/provider alerts should be demonstrated synthetically or on
  Preview only, not forced on Mainnet.

**M4 — two real code items + one minor:**

- [ ] **Indexer (Workstream D) — net-new, the largest remaining code deliverable.** Confirmed
  absent: the only "indexer" references in the repo are to the external chain indexer
  (Blockfrost/Koios) the CLI waits on, not a service of ours. Scope: per-pair latest
  price/timestamp/nonce/signer/intent-hash from live Pair UTxOs; a client-level query surface
  (Receiver balance, subscribed pairs, accrued per Hook); integration examples. Underpins the M4
  "how any developer requests any of the 2,500+ feeds" requirement.
- [ ] **Feeder stability hardening** — drive down the daemon crash-recovery / WASM self-exit loop
  (488 `CrashRecovery` rows in the Preview pack window). The self-exit guard exists
  (`offchain/feeder/src/submitter/wasm-failure-guard.ts`, `DEFAULT_WASM_FATAL_CONSECUTIVE_FAILURES`);
  the root cause of the recurrent WASM build failures must be diagnosed and fixed so a long mainnet
  window can hit the 99.99% uptime bar. This is feeder code, not ops.
- [ ] **On-chain consumption example** (minor): a small consumer script/validator reading a Pair
  UTxO as a reference input, to ship with the indexer integration examples. No first-party example
  exists today (only Spectra reference material).

Everything else in M3/M4 is **not code**: QA validation report, alert-trigger logs, uptime/accuracy
reports, demo videos, dashboard screenshots, sustained Mainnet run operations, contract-address
listings, the DIA-site documentation publication, and the closeout report/video.

## Cross-cutting: docs publication and PoA format

- **Developer-documentation publication on DIA's main developer-documentation website** is the
  same clause in M2, M3 and M4 acceptance. Per the accepted M1 PoA it is **deferred to M4** and
  published once, against the final stable surface. In-repo docs stay complete and current at
  each milestone; only the external publication consolidates at M4. Do not treat it as an M3
  blocker.
- Each milestone is submitted with a **`milestone-N-poa.md`** mapping the acceptance criteria to
  evidence, mirroring the accepted `milestone-1-poa.md` (submission commit, AC→evidence tables,
  outputs-delivered table, how-to-verify, deferral note). M3 and M4 each need one.

## Milestone 3 — Monitoring Library

> Official outputs: QA validation report · anomaly detection · uptime & accuracy reports ·
> automated alerts · developer documentation. Acceptance: real-time visibility of DIA oracle
> feeds on **mainnet**; anomalies in uptime/accuracy/freshness trigger automatic alerts;
> validated by QA review and live on-chain performance. Evidence: monitoring source + config
> examples + dev docs, a **demo video** of dashboards and **live mainnet logs** showing feed
> health checks, plus QA artifacts (test reports, alert-trigger logs, dashboard screenshots/exports).

### M3 — already built (verified)

- [x] Real-time dashboards (Grafana `feeder.json` + `feeder-tx.json`): balances, staleness, data
  age, per-symbol and per-transaction throughput, latency, price-deviation quality, billing.
- [x] Automated alerts: `monitoring/alerts.yml` (**12 rules**, thresholds single-sourced from
  `infrastructure.<network>.yaml::alerting.*`) — `OraclePairStale`, `ReceiverBalanceLow`,
  `SettleOverdue`, `PaymentHookWithdrawReady`, `AdminWalletLow`, `AdminWalletFragmented`,
  `PriceDeviationHigh`, `PriceAgeHigh`, `ReorgRateHigh`, `ReceiverDepositsPending`,
  `PrimaryProviderDown`, `SecondaryProviderDown`.
- [~] In-process alert evaluator writing **only `OraclePairStale`** to `alert_log`; the other 11
  rules, including `PriceDeviationHigh`, are Prometheus-side alerts.
- [x] Anomaly-detection metrics: `price_deviation_percent` (misreport), `price_age_seconds` +
  pair staleness (stale data), reorg counter (chain instability).
- [x] Anomaly/QA HTTP surface: `/api/v1/alerts`, `/api/v1/performance`, `/health/*`, `/metrics`.
- [x] Evidence packaging (`make evidence`) captures dashboards (both), error-counts, live alert
  snapshot, per-intent logs, db CSVs, and test logs — demonstrated by the M2 Preview and Mainnet
  packs (`m2-preview-20260608-040304`, `m2-mainnet-20260616-074413`).

### M3 — remaining

- [ ] **QA validation report**: integration tests validating (a) oracle data ingestion end-to-end
  and (b) alert triggering, plus **per-feed sanity checks** confirming on-chain timestamp and
  price accuracy for each of the 10 pairs. Assemble as a report doc + supporting logs. (Much of the
  test machinery exists — feeder + Aiken suites; this packages it as the QA validation artifact.)
- [ ] **Alert-trigger logs**: capture each alert actually firing (e.g. force a stale pair / a
  deviation / a low balance on Preview or mainnet) and export the `alert_log` + Prometheus
  `/alerts` state showing the transition. Today the evidence lists the alert rules but not a
  captured firing.
- [ ] **Uptime & accuracy report**: a sustained-window report (confirmed-tx liveness as uptime,
  price/timestamp accuracy vs the DIA source per feed). Builds on the evidence-pack stats.
- [ ] **Live mainnet monitoring demonstration**: the acceptance criterion is explicit that
  visibility and alerting are over **mainnet** feeds. Reuse the existing M2 Mainnet deployment/run
  (`mainnet_run_20260616-074413`) as the baseline, but capture a new **M3 monitoring-centric** pack:
  dashboards live, logs, M3-A sanity-check output, and at least one safe alert firing/resolving.
- [ ] **Demo video** (M3): dashboards + live mainnet logs showing feed health checks and alert
  behaviour. (Distinct from the M2 demo video, which previews the 10 feeds + QA logs.)
- [ ] **Broad metrics dashboard** (the families still unshown — 5 per-symbol latency phases,
  scanner RPC errors + backfill, worker pools, HTTP/db/component-health, cron resubmissions,
  node/process). Tracked in work-plan Workstream E.
- [ ] **`milestone-3-poa.md`** mapping M3 AC → evidence.

## Milestone 4 — End-to-End Integration and Mainnet Deployment

> Official outputs: contracts · feeders · monitoring stack · deployment scripts · sample live
> feeds · contract addresses · developer documentation (incl. how any developer requests any of
> DIA's 2,500+ price feeds / 10,000+ RWA feeds) · final close-out report · final closeout video.
> Acceptance: stable operation with **99.99% uptime and accuracy**; contracts + feeders +
> monitoring working together; docs published on DIA's site.

### M4 — already built

- [x] Aiken contracts deployed and exercised on **Mainnet** (M1: bootstrap, single + 10-pair
  batch update, settle, withdrawals, reference-script reclaim/republish, burn — see the M1 PoA).
- [x] Feeder service + CLI tooling (M2) — exercised on **Mainnet** in
  `m2-mainnet-20260616-074413` (10 DIA Mainnet feeds, 23 confirmed txs, 0 reorgs), plus the longer
  Preview QA/video run.
- [x] Monitoring stack (M3 machinery): dashboards, 12 alerts, `OraclePairStale` evaluator.
- [~] Mainnet rollout / rollback material exists in archived plan form
  (`docs/plans/_archived/mainnet-rollout.md`); there is **no active**
  `docs/plans/mainnet-rollout.md` file, so restore/update it only if M4 needs a standalone active
  runbook.

### M4 — remaining

- [ ] **Feeder live on Cardano Mainnet, sustained**: M2 already proved a short live Mainnet feeder
  run; M4 still needs a longer production-style window against mainnet contracts, with confirmed-tx
  logs, monitoring attached, and stable liveness/accuracy evidence for the 10 feeds.
- [ ] **99.99% uptime & accuracy evidence**: a sustained mainnet window with an uptime/accuracy
  report meeting the bar (this is the headline M4 acceptance number). The frequent daemon
  crash-recovery seen in the Preview pack (488 restarts) must be driven down first — investigate
  the WASM-rebuild self-exits and supervisor restart loop so a long mainnet window is clean.
- [ ] **Indexer (Workstream D)** — not started. Per-pair latest price/timestamp/nonce/signer/intent
  from live Pair UTxOs; client-level query surface; integration examples. Underpins the
  "how to request any of the 2,500+ feeds" developer instructions.
- [ ] **Sample live feeds + contract addresses doc**: published list of mainnet contract
  addresses and live Pair UTxOs for the 10 feeds, with how-to-read instructions.
- [ ] **Developer documentation published on DIA's main developer-documentation website** (the
  consolidated publication deferred from M1/M2/M3): oracle configuration, contracts for
  consumption, and the procedure + timeline to request any of DIA's 2,500+ price feeds and
  10,000+ RWA feeds.
- [ ] **Final close-out report** and **final closeout video** (+ the end-to-end install/access
  demo for future adopters).
- [ ] **`milestone-4-poa.md`** mapping M4 AC → evidence (mainnet addresses, feeder logs, E2E
  results, uptime/accuracy, doc-site link, closeout links).
- [ ] Off-chain Lucid emulator adversarial matrix (work-plan A, `[~]`) — finish the negative-case
  matrix if it is to back the E2E functional-verification claim.

## Dependencies and ordering

1. **Drive down daemon restarts** (crash-recovery / WASM self-exit) — prerequisite for any
   credible sustained mainnet uptime window.
2. **Run a sustained Mainnet monitoring window** — the short M2 Mainnet run exists; M3 needs a
   monitoring-centric capture, and M4 needs the longer 99.99%-style evidence window. Capture both
   from the same operational run if budget/timing allows.
3. **Indexer** can proceed in parallel (independent of the live run); it gates the M4 "request any
   feed" developer instructions.
4. **Documentation publication on DIA's site** and the **closeout report/video** land last, at M4,
   against the final stable surface.
