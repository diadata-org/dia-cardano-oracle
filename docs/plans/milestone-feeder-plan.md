# Milestone — Feeder Plan

Tasks for the DIA Cardano Oracle feeder: done, left for M2, Mainnet, and deferred.

## Contents

- [Done](#done)
- [Pending — Milestone 2](#pending--milestone-2)
  - [Evidence pack](#evidence-pack)
  - [Monitoring, config \& API](#monitoring-config--api)
- [Pending — Mainnet](#pending--mainnet)
- [Deferred — M3 / M4](#deferred--m3--m4)
- [Open — DIA decisions](#open--dia-decisions)

## Done

- [x] Feeder core: HTTP+WS scanner (head-tracker + gap-detection loops), dedup cache, enricher, router policy gate, per-lane coalescer (supersession + batch buffer), event + update worker pools, cron re-submission, alert evaluator.
- [x] DB as source of truth: 6-table SQLite/Postgres schema, crash-safe checkpoint, no runtime JSON state.
- [x] HTTP API: prices, symbols, transactions, chains, status, events, alerts, performance, pools + health/metrics.
- [x] Metrics: `dia_bridge_*`, 6-phase latency, Cardano balance gauges, Prometheus aliases.
- [x] Security hardening + adversarial-audit remediation; 475 tests pass.
- [x] In-process tx waits: confirmation → wallet settlement (spent wallet inputs derived from the built tx) → script-side replacement.
- [x] CLI state flags unified: `--protocol-state` / `--client-state` / `--pair-state` (no overloaded `--state`).
- [x] Alert thresholds corrected to real ADA values in both infrastructure YAMLs; alert exprs evaluate in ADA.
- [x] Alert descriptions match the real fee flow, with Docker + npm commands; AdminWalletLow = collect accrued revenue (settle + payment-hook:withdraw); ReceiverBalanceLow names the client's Receiver address.
- [x] Grafana balance panels render ADA; per-metric thresholds on the accrued panel.
- [x] Balance gauges don't report a default 0 (no spurious AdminWalletLow on restart); balances refresh on a timer, independent of update traffic.
- [x] `make evidence` writes one folder; network read from `feeder/.env`.
- [x] `make down` stops all profiles; `init: true` so Ctrl+C / stop reach the container.

## Pending — Milestone 2

### Evidence pack

- [ ] Sustained Preview run across all 10 pairs (uptime, intent counts, fee totals, worker stats).
- [ ] All 10 pairs present in the evidence tables.
- [ ] Real Grafana PNGs in the pack.
- [ ] Alert-firing demonstration (`OraclePairStale` + `PriceDeviationHigh`).
- [ ] Dashboard images embedded in the evidence writeup.
- [ ] One complete pack (writeup + db + logs + stats + PNGs); unify `package-m2-evidence.sh` with `render-dashboards.ts`; remove the duplicate `m2-preview-*` folder.
- [ ] Demo video (operator flow + dashboard + confirmed tx + alert firing).

### Monitoring, config & API

- [ ] Thresholds single-source-of-truth: `monitoring/alerts.yml` and `grafana/dashboards/feeder.json` hardcode numbers that should come from `infrastructure.<network>.yaml::alerting.*`. Generate them from the YAML (or add a drift test). Wire or remove the unused dashboard vars `stale_threshold_seconds`, `receiver_warn_lovelace`, `coordinator_warn_lovelace`.
- [ ] Fix rate panels in `feeder.json`: "Tx failed rate" drops `symbol` (`sum by (error_code)`) and shows `rate[5m]` (per-second). Use `increase[5m]` counts, keep `symbol`, unit `tx`. Same for "Tx confirmed rate" and "Intents filtered by reason".
- [ ] New separate dashboard for the unused metric families: per-stage latency (5 phases), `scanner_rpc_errors_total` + backfill, worker active/queue/pool + task counters, `transaction_fee_lovelace`, `http_request_duration_seconds`, `component_health`, `recovery_attempts_total`, ingest counters, `cron_resubmissions_total`, db ops, node/process defaults. Align panel windows with alert windows.
- [ ] Dashboard filter variables — `$client` first, then `$symbol` / `$customer` / `$error_code`. Each per-label panel filters with `{client_id=~"$client", …}` + `sum by(…)`; "All" (`.*`) aggregates across the label. Filterable (carry `client_id`): tx submitted/confirmed/failed/reorg, latency phases 3–5 + end-to-end, `oracle_last_confirmed_timestamp`, receiver balance/accrued, topup_warnings, pair_is_create, cron_resubmissions, intents_*_lifecycle, transaction_fee. Global (not client-filterable): admin_wallet, payment_hook_accrued, scanner/http/db/worker, price_deviation/age, latency phases 1–2.
- [ ] Network-scoped router config: move routers to `config/routers/<network>/*.yaml` and load only the active network's folder; keep `cardano.network` as a warn-and-skip guard. Touch `loadRouterDirectory` (`loader.ts:136,184-211`) and the `validate.ts:740` network check; move `client-a.preview.yaml` → `routers/preview/client-a.yaml`.
- [ ] OpenAPI/Swagger generated from a route table: refactor the `Route` union + dispatch (`src/api/server.ts:57-80`) into a metadata table (method/path/params/summary + response schema via zod-to-openapi or TypeBox) that drives routing, the spec, and optional output validation; serve `/api/v1/openapi.json` and Swagger UI/Redoc at `/docs` from bundled assets (offline).
- [ ] Multi-client batch settle in the CLI: `settle` is single-client today (`settle.ts:50,132` rejects manifest length ≠ 1) but the coordinator settles N receivers (`coordinator_logic.ak:18-34`). Add repeatable `--client-state` (or `--manifest`), build the N-receiver `SettleManifest`, `collectFrom` all receivers + the hook in one tx, drop the exactly-1 preflight. Amortizes coordinator + hook cost across clients.
- [ ] Per-client deviation+heartbeat push policy (fewer tx, lower fees): the gate is `time_threshold || price_deviation` (`policy.ts:12-25`) and the cron re-submits every `time_threshold` regardless of price change (`types.ts:261`), so a flat price still pushes every few minutes. Add a per-client mode that pushes only on price deviation OR a much-longer max-staleness/heartbeat; disable the short time-based push (gate + cron) for those clients. Document the consumer trade-off (can't tell skipped-vs-feeder-down → mitigate via the heartbeat bound + `/health` liveness + `OraclePairStale`). Default OFF.

## Pending — Mainnet

- [ ] Validate the Mainnet config against the current code; ensure the on-chain Config points at the DIA Mainnet domain before the run.
- [ ] Generate + fund the Mainnet operator wallet (store the address only).
- [ ] Bootstrap on Mainnet (config → protocol → reference scripts → client → receiver → first pair); record tx hashes.
- [ ] Run the feeder on Mainnet and capture verified update tx logs.

## Deferred — M3 / M4

- [ ] Indexer: per-pair latest price/timestamp/nonce/signer/intent-hash; client query surface (Receiver balance, subscribed pairs, accrued fees); dApp integration examples.
- [ ] HA / replica failover: `replica.*` typed but not wired (no leader election / heartbeat / failover handler).
- [ ] Per-router retry policy (retry is global today).
- [ ] Distributed cron lock (single-instance safe only).
- [ ] Per-destination cron schedules.
- [ ] Developer documentation published on DIA's dev site.
- [ ] QA validation report + anomaly-detection evidence.
- [ ] Final closeout report + video.
- [ ] Off-chain Lucid emulator adversarial negative-case matrix (happy path done).

Excluded by design (not pending): EVM gas semantics; EVM method ABIs; router `transformations` (rejected — would break EIP-712); `validation_enabled: false`; `datasource: processed`.

## Open — DIA decisions

- [ ] Confirm the authorized signer set is complete.
- [ ] Define how DIA communicates changes to chain ids / registry / signer set.
- [ ] Decide daemon key custody (the updater seed is read from `.env` today).
