# Milestone — Feeder Plan

Tasks for the DIA Cardano Oracle feeder: done, left for M2, Mainnet, and deferred.

## Contents

- [Done](#done)
- [Pending — Milestone 2](#pending--milestone-2)
  - [Evidence pack](#evidence-pack)
  - [Monitoring, config \& API](#monitoring-config--api)
- [Pending — Mainnet](#pending--mainnet)
- [Deferred — M3 / M4](#deferred--m3--m4)
- [Open — DIA decisions](#open--dia-decisions-operational-not-code)

## Done

- [x] Feeder core: HTTP+WS scanner (head-tracker + gap-detection loops), dedup cache, enricher, router policy gate, per-lane coalescer (supersession + batch buffer), event + update worker pools, cron re-submission, alert evaluator.
- [x] DB as source of truth: 6-table SQLite/Postgres schema, crash-safe checkpoint, no runtime JSON state.
- [x] HTTP API: prices, symbols, transactions, chains, status, events, alerts, performance, pools + health/metrics.
- [x] Metrics: `dia_bridge_*`, 6-phase latency, Cardano balance gauges, Prometheus aliases.
- [x] Security hardening + adversarial-audit remediation; 475 feeder tests pass.
- [x] On-chain adversarial coverage: 117 inline Aiken tests across the validators — expired / stale / replayed / tampered intents, unauthorized + non-admin signer, accrued-drain-via-withdraw rejection, duplicate-receiver + manifest-mismatch + zero/wrong-delta settle, cross-script redeemer confusion, wrong-pair-NFT.
- [x] In-process tx waits: confirmation → wallet settlement (spent wallet inputs derived from the built tx) → script-side replacement.
- [x] CLI state flags unified: `--protocol-state` / `--client-state` / `--pair-state` (no overloaded `--state`).
- [x] Alert thresholds corrected to real ADA values in both infrastructure YAMLs; alert exprs evaluate in ADA.
- [x] Alert descriptions match the real fee flow, with Docker + npm commands; AdminWalletLow = collect accrued revenue (settle + payment-hook:withdraw); ReceiverBalanceLow names the client's Receiver address.
- [x] Grafana balance panels render ADA; per-metric thresholds on the accrued panel.
- [x] Balance gauges don't report a default 0 (no spurious AdminWalletLow on restart); balances refresh on a timer, independent of update traffic.
- [x] `make evidence` writes one folder; network read from `feeder/.env`.
- [x] `make down` stops all profiles; `init: true` so Ctrl+C / stop reach the container.
- [x] M2 Preview evidence pack captured — `docs/milestones/evidence/m2-preview-20260604-100120/`: ~30 h window (2026-06-03 → 06-04), 10 pairs (ARB, BTC, DOGE, ETH, LTC, NEIRO, SHIB, USDC, USDT, XVG), real Grafana PNGs (`dashboard-full.png` 1600×2400 + `panel-1..13`) embedded in the writeup `milestone-2-preview-evidence.md`, plus db CSVs, API snapshots, per-intent logs, `error-counts.tsv`, and an "Alerts active during the window" section. In-window totals: 416 confirmed / 12022 failed / 0 reorgs.
- [x] Mainnet protocol + client bootstrapped on-chain via CLI — `docs/milestones/evidence/m1-mainnet-20260517-063917/`: protocol-init, config (parameterize/bootstrap/reference-scripts), payment-hook (parameterize/bootstrap/reference-script), client-init, receiver (parameterize/bootstrap), client reference-scripts, receiver top-ups, and the 10 pairs.

## Pending — Milestone 2

### Evidence pack

The Preview evidence pack is captured and complete (see Done — `m2-preview-20260604-100120`: sustained ~30 h window, 10 pairs, real PNGs embedded in the writeup, db/api/logs/error-counts, alerts section). Remaining:

- [ ] **Demo video.** Operator flow + live dashboard + confirmed tx + alert firing — if required as a Catalyst deliverable.

### Monitoring, config & API

- [ ] **Thresholds — single source of truth.** `monitoring/alerts.yml` and `grafana/dashboards/feeder.json` hardcode numbers (2/5/10/50 ADA, 3600 s, 5 %, 600 s, `for:` durations) that should come from `infrastructure.<network>.yaml::alerting.*`. Generate them from the YAML at build/deploy, or add a test that fails on drift. Only the in-process evaluator reads the YAML today. Also: dashboard template vars `stale_threshold_seconds` and `receiver_warn_lovelace` exist in the UI but the panels hardcode the values; `coordinator_warn_lovelace` is unused — wire them from the YAML or remove them.
- [ ] **Fix misleading rate panels** (`feeder.json`). "Tx failed rate" does `sum by (error_code)` (drops `symbol`) and shows `rate[5m]` (per-second average). Switch to `increase[5m]` counts (or per-minute), keep `symbol`, unit `tx` not `ops`. Same for "Tx confirmed rate" and "Intents filtered by reason".
- [ ] **New metrics dashboard** (separate; leave `feeder.json` as is). Cover the registered-but-unshown families: per-stage latency (the 5 phases), `scanner_rpc_errors_total` + backfill, worker active/queue/pool + task counters, `transaction_fee_lovelace`, `http_request_duration_seconds`, `component_health`, `recovery_attempts_total`, ingest/sanitation counters, `cron_resubmissions_total`, db ops, plus node/process defaults. Align panel windows with the alert windows (PriceAge/PriceDeviation alert at 10 m; panels are 1 h).
- [ ] **Dashboard filter variables.** `$client` first, then `$symbol` / `$customer` / `$error_code`. Each per-label panel filters with `{client_id=~"$client", …}` + `sum by(…)`; "All" (`.*`) aggregates across the label instead of vanishing. Filterable (carry `client_id`): tx submitted/confirmed/failed/reorg, latency phases 3–5 + end-to-end, `oracle_last_confirmed_timestamp`, receiver balance/accrued, topup_warnings, pair_is_create, cron_resubmissions, intents_*_lifecycle, transaction_fee. Global (NOT client-filterable, document as such): admin_wallet, payment_hook_accrued, scanner/http/db/worker, price_deviation/age, latency phases 1–2.
- [ ] **Network-scoped router config.** Routers are loaded from a flat `config/routers/*.yaml` ignoring network (`loadRouterDirectory`, `loader.ts:136,184-211`); the `.preview` suffix and the `cardano.network` field are not enforced (`validate.ts:740` only checks the value is valid). Move to `config/routers/<network>/*.yaml` and load only the active network's folder; keep `cardano.network` as a warn-and-skip guard (log + skip a misfiled router). Move `client-a.preview.yaml` → `routers/preview/client-a.yaml`; update `config/README.md` + the feeder README.
- [ ] **OpenAPI / Swagger — generated from a route table.** The server is raw `node:http` with every route in one `Route` union (`src/api/server.ts:57-80`). Refactor the union + dispatch into a metadata table (method / path / params / summary + response schema via zod-to-openapi or TypeBox) that drives routing, the generated spec, and optional output validation; serve `/api/v1/openapi.json` and Swagger UI/Redoc at `/docs` from bundled assets (offline, works in Docker). Drift-proof by construction.
- [ ] **Multi-client batch settle (CLI).** `settle` is single-client today (`settle.ts:50,132` rejects manifest length ≠ 1) but the coordinator settles N receivers in one tx (`coordinator_logic.ak:18-34`, validates non-empty + unique + sum-of-drains == hook delta). Add repeatable `--client-state` (or a `--manifest`), build the N-receiver `SettleManifest`, `collectFrom` all receivers + the hook in one tx, drop the exactly-1 preflight. Amortizes coordinator + hook cost across clients.
- [ ] **Per-client deviation + heartbeat push policy** (fewer tx, lower fees on Cardano). The gate is `time_threshold || price_deviation` (`policy.ts:12-25`) and the cron re-submits every `time_threshold` regardless of price change (`types.ts:261`), so a flat price still pushes every few minutes. Add a per-client mode that pushes only on price deviation OR a much-longer max-staleness/heartbeat (new param); disable the short time-based push (gate + cron) for those clients. Document the consumer trade-off — an unchanged on-chain price can't be told apart from "feeder skipped it" vs "feeder down"; mitigate via the heartbeat bound + `/health` liveness + the `OraclePairStale` alert. It's an operational decision DIA makes per client. Default OFF.

## Pending — Mainnet

Protocol + client are already bootstrapped on-chain (see Done — `m1-mainnet-20260517-063917`). Remaining:

- [ ] **Run the M2 feeder daemon on Mainnet** and capture verified update tx logs — gated on DIA confirming the live signer set + WebSocket credentials. The bootstrap above used the CLI, not the daemon.

## Deferred — M3 / M4

Real future work, intentionally outside Milestone 2 (M2 is the feeder + its operational surface). Each is understood and scoped, just not started.

- [ ] **Indexer (Workstream D — M3/M4).** A read/query service the feeder does not provide today. It would expose, from the live Pair UTxOs, each pair's latest price / timestamp / nonce / signer / intent-hash; a client-level query surface (Receiver balance, subscribed pairs, accrued fees per Hook); and integration examples for Cardano dApp developers. Deferred because M2 is the write path (feeder); the consumer-facing read API is a later milestone.
- [ ] **HA / replica failover (M3/M4).** The config types carry `replica.{enabled,role,monitor_chain_id}` but nothing consumes them: no leader election, no heartbeat loop, no secondary-takeover path, no `bridge_failover_*` metrics. The feeder assumes a single instance throughout. Spectra's `internal/leader` + `internal/grpc` failover is not ported. Deferred to the HA workstream — M2 runs one instance.
- [ ] **Per-router retry policy.** Retry is global today — `createDefaultRetryPolicy` is applied uniformly to every router. Spectra allows a per-router `worker_pool.retry_policy` override; that override is not wired. Deferred — one global policy is enough for M2.
- [ ] **Distributed cron lock.** The cron re-submission service is only single-instance-safe: there is no Postgres advisory lock or leader election, so two feeder instances would double-fire the cron. Deferred until HA (depends on the leader work above).
- [ ] **Developer documentation on DIA's dev site (M4).** The operator runbook exists locally; publishing developer-facing docs on DIA's website (oracle configuration, on-chain contracts available for consumption, how to request DIA's price / real-world-asset feeds) is an M4 deliverable.
- [ ] **QA validation report + anomaly-detection evidence (M3).** The Monitoring milestone's formal QA write-up (validation results + anomaly detection) on top of the metrics/alerts that already exist. Needs a sustained live run to produce.
- [ ] **Final closeout report + video (M4).** The Catalyst closeout deliverable for the whole integration.
- [ ] **End-to-end emulator negative scenarios (extra hardening).** The on-chain adversarial cases are already covered by the 117 inline Aiken tests (see Done). What's missing is the *multi-transaction, end-to-end* layer on the Lucid emulator — scenarios that aren't expressible as a single-validator unit test: two-client parallelism, an NFT-redirect attempt spanning settle + config-update, a duplicate-live-pair race. Happy-path emulator orchestrator exists. Not gating (contracts delivered + unit-tested) — added integration hardening.

**Excluded by design — NOT pending, will never be done:** EVM gas semantics (`default_gas_limit` / `gas_multiplier` / `max_gas_price` — Cardano fees are deterministic); EVM method ABIs (`contracts.yaml::methods`); router `processing.transformations` (the validator rejects them — they would mutate the payload and break EIP-712 signature verification); `processing.validation_enabled: false` (intent-signature validation is mandatory); `processing.datasource: "processed"` (only `event` / `enrichment` are accepted).

## Open — DIA decisions (operational, not code)

- [ ] **Confirm the authorized signer set is complete.** Two signer keys per environment were recovered from live `IntentRegistered` events via EIP-712 recovery; DIA has not confirmed there are no others. Until confirmed, an intent signed by an unknown-but-legitimate DIA key would be rejected by the on-chain signer check.
- [ ] **Define DIA's change-notification policy.** How DIA will notify the operator of future changes to chain ids, registry addresses, or the signer set, so the feeder never runs against stale values.
- [ ] **Decide daemon key custody.** The long-running daemon reads the updater wallet seed from `.env` today; a production custody strategy (Vault / KMS / k8s secrets) is undecided.
