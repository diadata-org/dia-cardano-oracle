# Milestone 2 — Final Plan (Spectra-shaped)

Single canonical plan to close Milestone 2 (Data Feeder and
Documentation). Reorganises the prior plan around Spectra's actual
module structure as the canonical reference. The predecessor lives at
`docs/plans/_BK/milestone-2-final-plan-20260528-204724.md`; every
finding from it is preserved below, dedup'd, and assigned to the
Spectra-module phase it belongs to.

## The single rule

**Spectra is the truth.** Whenever this plan and Spectra disagree on a
name, shape, lifecycle, table, column, metric, API path, config key,
or behavior, Spectra wins.

**Every Spectra feature is in the feeder.** There are **exactly two**
reasons a Spectra feature may be absent, and nothing else qualifies:

1. **EVM-only** — the feature exists only because Spectra's
   *destination* is an EVM chain. Cardano is the destination (UTxO,
   Lucid, Aiken). EVM gas units (`gas_used`, `gas_price`, wei, gwei),
   the EVM nonce manager, EVM receiver ABI encoding, Solidity, and
   Hyperlane have no Cardano destination meaning.
   - **Fee tracking is NOT in this bucket.** Spectra tracks the cost
     of every transaction; the feeder must too. Only the *unit*
     changes: lovelace instead of wei/gas. Fee accounting per tx and
     per symbol is **essential and ships in M2**.
   - Note the *source* chain is still EVM (DIA's chain). Reading
     `IntentRegistered` events from an EVM source (registry ABI,
     log decoding) **is in the feeder**.
2. **Multi-chain-only** — the feature exists only because Spectra
   fans out to **many destination chains at once**
   (`writeClients map[int64]`, `Destinations map[int64]`,
   per-destination routing/cron). **The feeder targets one
   destination, Cardano, and always will.** Multi-destination
   plumbing is never in the feeder.

Everything that is **neither** EVM-only **nor** multi-chain-only is in
the feeder. If it cannot ship in M2 for sequencing reasons, it is
**still in the feeder, just in a later milestone (M3)** — it is never
"excluded". The authoritative classification is the
[Spectra feature inventory](#spectra-feature-inventory) below.

Two mechanical divergences that are not feature decisions:

- The destination adapter is Cardano/Lucid, so EVM call sites become
  Lucid/Aiken call sites (same behavior, different chain client).
- The local language is TypeScript, not Go. Idiomatic TS is allowed
  provided the user-visible surface (config keys, metrics, API paths,
  tables, columns) stays Spectra-shaped.

Anything else that diverges is a bug, never a "design decision".

## What this plan is not

- It is not a bug list. Bug fixes are folded into the Spectra-module
  phase they belong to.
- It is not a refactor. Renaming modules to match Spectra's `internal/`
  layout is **not** required — the directory map below records the
  correspondence so future readers can navigate both repos. Renames
  would destabilise the codebase for no parity gain.
- It is not backwards-compatible with prior local schemas, state
  files, or CLI flags. The project is fresh. The DB schema below is
  the single source of truth from day one. No `ALTER TABLE … IF NOT
  EXISTS`, no JSON-checkpoint migration helper, no legacy export
  shims, no "preserve old data" paths.

## Catalyst acceptance (unchanged)

The Catalyst milestone text is the source of truth for acceptance:
[`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)
(Milestone 2, lines 47-82).

What is already acceptable for Catalyst (M1+M2 deliverables shipped):

- Phase 1 — Cardano Preview `Config` re-pointed at DIA testnet domain.
- Phase 2 — Pure tx builders extracted to `offchain/cli/src/lib/`.
- Phase 3 — Feeder daemon shipped: scanner (HTTP *or* WS, selected at
  startup — concurrent HTTP + WS is the Spectra-parity target tracked
  by R1.4.h), enricher,
  router, dedup, price-cache, queue manager, coalescer, retry policy,
  preflight, reconcile, Cardano write client, persistence (SQLite +
  Postgres), HTTP API, Prometheus metrics, Grafana dashboard, Docker
  image, docker-compose.
- Phase 3.4.5 — coalescer with supersession + buffer, classifier-driven
  retry policy, `receiverUnit`-keyed in-flight lock, chain-as-truth
  reconcile.
- Phase 3.5 — `/api/v1/{prices,symbols,chains,transactions,health,…}`,
  Prometheus exposition, alert rules, Grafana auto-provisioning.
- Phase 3.8 — `confirmedAtDepth` plumbed; `block_scanner.confirmations`
  honoured; reorg drop accounting wired.
- Annex A — env hygiene: per-network `_TESTNET` / `_MAINNET` suffixes.

What is **not yet acceptable** for Catalyst (closed below):

- Cardano Mainnet feeder run.
- Demo video.
- Grafana dashboard PNGs are 29-byte HTML login redirects.
- `error-counts.tsv` is empty; the 247 jsonl / 783 DB tx-failure
  counts are not bucketed by code.
- USDT/USD missing from evidence MD tables despite being in
  `api/symbols.json`.
- `pair-selection.md` (Phase 4 acceptance) never written.
- Window observed: ~4 hours; M2 plan acceptance demands 48-72 h.
- Several Spectra parity gaps with operator impact still open
  (DB schema, worker pool, router OR-gate, on-chain cron read, cron
  unreachability, transformations, scanner controls, metric aliases).
- Several code-quality and security hardening items surfaced in the
  2026-05-28 audit.

## Spectra feature inventory

This is the authoritative list. It enumerates **every** feature in
Spectra's bridge service (read from `docs/references/spectra/` module
by module) and answers, for each one:

- **In feeder?** — Yes / No.
- **When?** — M2 or M3 (only meaningful when "In feeder" = Yes).
- **If No, why?** — must be `EVM` or `multi-chain`. No other reason
  is permitted.

The "M2 task" column points at the phase that delivers it. Source
column cites the real Spectra file.

### Module `config` — `services/bridge/config/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Database config (`driver`, `dsn`, `dsn_env`) | Yes | M2 | R1.1.d / R1.3 | `config/types.go:30` |
| Source chain (`chain_id`, `rpc_urls[]`, `ws_url`, `start_block`) | Yes | M2 | R1.1 (DIA source) | `config/types.go:37` |
| Multi-RPC source failover (`rpc_urls[]` + `NewMultiClient`) | Yes | M2 | R1.4 (many DIA RPCs, not many chains) | `bridge.go:83` |
| `Destinations map[int64]` (many destination chains) | **No** | — | **multi-chain** | `config/types.go:14` |
| Routers + per-router destinations | Yes | M2 | R1.6 (single Cardano dest) | `config/types.go:15` |
| Default + per-router signer keys | Yes | M2 | R1.6.c | `config/types.go:16` |
| `event_definitions` (generic event system) | Yes | M2 | R1.5 | `config/types.go:13` |
| `event_monitor` (`reconnectinterval`, `maxreconnectattempts`) | Yes | M2 | R1.4.e | `config/types.go:62` |
| `block_scanner` (`scaninterval`, `blockrange`, `maxblockgap`, `backwardsync`, `headtrackerinterval`, `gapdetectioninterval`) | Yes | M2 | R1.4 | `config/types.go:69` |
| `event_processor` (`batchsize`, `dedupcachesize`, `dedupcachettl`, `enableparallelmode`, parallel pool) | Yes | M2 | R1.7 | `config/types.go:80` |
| `worker_pool` (`maxworkers`, `taskqueuesize`, `tasktimeout`, `retrydelay`, `maxretries`) | Yes | M2 | R1.7 | `config/types.go:92` |
| `health_check` (`checkinterval`, `timeout`, `maxprocessinglag`, `maxqueuesize`) | Yes | M2 | R4.1 | `config/types.go:101` |
| `recovery` (`minfailures`, `maxattempts`, `retryinterval`) | Yes | M2 | R1.4 | `config/types.go:110` |
| `api` (`enabled`, `listenaddr`, `enablecors`) | Yes | M2 | R2 / R5.4 | `config/types.go:119` |
| `metrics` (`namespace`) | Yes | M2 | R3 | `config/types.go:126` |
| `dry_run` | Yes | M2 | already shipped | `config/types.go:25` |
| `cron_service` (`schedule`, `price_deviation`) | Yes | M2 | R1.8 | `config/types.go:203` |
| Per-destination cron schedule (router `time_threshold`) | Yes | **M3** | per-destination is M3 (R1.8.e); single global tick in M2 | `config/types.go:205` |

### Module `scanner` — `internal/scanner/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Enhanced block scanner (head tracker, gap detection, backward sync) | Yes | M2 | R1.4.a | `scanner/block_scanner_enhanced.go` |
| Backfill / chunked range scan | Yes | M2 | R1.4.b | `scanner/block_scanner_enhanced.go` |
| Scanner health/status | Yes | M2 | R1.4.d | `scanner/interfaces.go` |
| **Concurrent HTTP + WS (both transports run at the same time)** | Yes | M2 | R1.4.h | `scanner/block_scanner_enhanced.go:197-221` |

### Module `pipeline` — `internal/pipeline/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Extractor (log → fields) | Yes | M2 | R1.5 | `pipeline/extractor.go` |
| Enricher | Yes | M2 | R1.5 | `pipeline/enricher.go` |
| Transformer (slice/concat/hash/encode ops) | Yes | M2 | R1.5.a | `pipeline/transformer.go` |

### Module `processor` — `internal/processor/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Dedup cache (TTL + size) | Yes | M2 | R1.4.f | `processor/dedup_cache.go` |
| Event worker pool (parallel mode) | Yes | M2 | R1.7.a | `processor/event_worker_pool.go` |
| Generic event processor | Yes | M2 | R1.7 | `processor/generic_event_processor.go` |
| Parallel pipeline | Yes | M2 | R1.7.c | `processor/parallel_pipeline.go` |
| Price cache (in-mem + durable) | Yes | M2 | R1.3.d | `processor/price_cache.go` |
| Service adapters (glue) | Yes | M2 | R1.7 | `processor/service_adapters.go` |
| **Gas estimation service** | **No** | — | **EVM** (Cardano fee comes from Lucid tx build, no gas estimation) | `processor/gas_estimation_service.go` |

### Module `pkg/router` — `services/bridge/pkg/router/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Generic router OR-gate (`time_threshold \|\| price_deviation`) | Yes | M2 | R1.6.a | `pkg/router/generic_router.go` |
| Replay / timestamp monotonicity | Yes | M2 | R1.6.b | `pkg/router/generic_router.go` |
| Per-router signer selection | Yes | M2 | R1.6.c | `pkg/router/generic_router.go` |
| `FetchOracleStateFromOnChain` (read pair state) | Yes | M2 | R1.8.b (read from Cardano) | `bridge.go:394` |
| Router fan-out to multiple destination chains | **No** | — | **multi-chain** | `bridge.go:104` |

### Module `cron` — `internal/cron/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Cron service (periodic resubmit on staleness) | Yes | M2 | R1.8 | `cron/cron_service.go` |
| On-chain timestamp read before resubmit | Yes | M2 | R1.8.b | `cron/cron_service.go` |

### Module `worker` — `internal/worker/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Per-oracle/router worker pool (isolation, queue, timeout) | Yes | M2 | R1.7.b | `worker/worker_pool.go` |

### Module `transaction` — `internal/transaction/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Queue + queue manager (1000-deep) | Yes | M2 | R1.9 | `transaction/queue_manager.go` |
| Executor (submit lifecycle) | Yes | M2 | R1.9 | `transaction/executor.go` |
| Write client | Yes | M2 | R1.9 (Cardano/Lucid) | `bridge/write_client.go` |
| **EVM nonce manager** | **No** | — | **EVM** (Cardano UTxO; lane serialization replaces nonce) | `contracts/nonce_manager.go` |

### Module `database` — `internal/database/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| `processed_events` table | Yes | M2 | R1.3.a | `database/schema.go:5` |
| `chain_state` table | Yes | M2 | R1.3.b | `database/schema.go:21` |
| `transaction_log` table (lifecycle, error_code, retry) | Yes | M2 | R1.3.c | `database/schema.go:36` |
| `transaction_log` **gas columns** (`gas_used`, `gas_price`, `max_fee_per_gas`, `max_priority_fee_per_gas`) | **No** | — | **EVM** → replaced by `fee_paid_lovelace` | `database/schema.go:54-59` |
| `transaction_log` cost column (`transaction_cost`) | Yes | M2 | R1.3.c — **kept as lovelace fee** (essential) | `database/schema.go:60` |
| `contract_symbol_updates` (durable last-price cache) | Yes | M2 | R1.3.d | `database/schema.go:76` |
| `performance_metrics` (hourly rollup) | Yes | M2 | R1.3.e | `database/schema.go:92` |
| `alert_log` | Yes | M2 | R1.3.f | `database/schema.go:126` |
| Indices | Yes | M2 | R1.3 | `database/schema.go:140` |

### Module `api` — `internal/api/`

| Spectra feature (route) | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| `GET /health`, `/health/ready`, `/health/live` | Yes | M2 | R4.1 | `api/server.go:152` |
| `GET /metrics` (Prometheus) | Yes | M2 | R3 | `api/server.go:157` |
| `GET /debug` | Yes | M2 | R2.9 (gated) | `api/server.go:160` |
| `GET /api/v1/status`, `/status/components` | Yes | M2 | R2.1 | `api/server.go:172` |
| `GET /api/v1/events`, `/events/names`, `/events/{hash}` | Yes | M2 | R2.2 | `api/server.go:176` |
| `GET /api/v1/transactions`, `/transactions/{hash}` | Yes | M2 | R2.3 | `api/server.go:181` |
| `GET /api/v1/chains`, `/chains/{id}/status` | Yes | M2 | R2 (single Cardano chain row) | `api/server.go:185` |
| `GET /api/v1/symbols`, `/symbols/{symbol}/updates` | Yes | M2 | R2 | `api/server.go:189` |
| `GET /api/v1/prices`, `/prices/{symbol}` | Yes | M2 | R2 (from price cache) | `api/server.go:193` |
| `GET /api/v1/pools`, `/pools/{router_id}/tasks` | Yes | M2 | R1.7.h / R2.4 | `api/server.go:197` |
| CORS + logging + metrics middleware | Yes | M2 | R2 / R5.4 | `api/server.go:209` |
| **Failover endpoints** (`failover_handler`) | Yes | **M3** | HA/replica (not EVM, not multi-chain) | `api/failover_handler.go` |

### Module `metrics` — `internal/metrics/`

| Spectra feature (metric group) | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| HTTP metrics (`bridge_http_*`) | Yes | M2 | R3.2 | `metrics/metrics.go:70` |
| Transaction counts (`*_submitted/confirmations/failures`) | Yes | M2 | R3.1 | `metrics/metrics.go:105` |
| **`transaction_gas_used`** | **No** | — | **EVM** | `metrics/metrics.go:117` |
| `transaction_fees_wei` | Yes | M2 | R3 — **kept as lovelace fee** (essential) | `metrics/metrics.go:122` |
| Event timing (`detection_latency`, `queue_time`, `processing_duration`, `events_detected/processed`, `active_workers`) | Yes | M2 | R3.3 | `metrics/metrics.go:151` |
| Intent 6-phase lifecycle latency + stage timestamps | Yes | M2 | R3.4 | `metrics/intent_metrics.go:19` |
| Intent counts per stage (created→registered→scanned→processed→submitted→confirmed→failed) | Yes | M2 | R3 / R7 | `metrics/intent_metrics.go:40` |
| Price deviation + price age | Yes | M2 | R3 / R4.5 | `metrics/intent_metrics.go:36` |
| Router decision metrics | Yes | M2 | R3 | `metrics/intent_metrics.go:49` |
| **`gas_used_total` / `gas_price_gwei` per symbol** | **No** | — | **EVM** → replaced by lovelace fee per symbol | `metrics/intent_metrics.go:197` |
| Chain connection + RPC latency/errors | Yes | M2 | R3.2 | `metrics/metrics.go:194` |
| DB metrics | Yes | M2 | R3.2 | `metrics/metrics.go:209` |
| **Failover metrics** (`bridge_failover_*`) | Yes | **M3** | HA/replica | `metrics/metrics.go:85` |
| **Hyperlane `total_delivery_time`** | **No** | — | **EVM** (Hyperlane) | `metrics/metrics.go:144` |

### Module `bridge` — `internal/bridge/` (orchestration)

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| Orchestrator (start/stop, goroutine coordination) | Yes | M2 | R1.10 | `bridge/bridge.go:79` |
| Event source (scanner + processor wrapper) | Yes | M2 | R1.4 | `bridge/event_source.go` |
| Health checker loop | Yes | M2 | R4.1 | `bridge/health.go` |
| Metrics manager + tracker | Yes | M2 | R3 | `bridge/metrics_manager.go` |
| Scanner factory | Yes | M2 | R1.4 | `bridge/scanner_factory.go` |
| Transaction handler (update → submit) | Yes | M2 | R1.9 | `bridge/transaction_handler.go` |
| Write client (single Cardano dest) | Yes | M2 | R1.9 | `bridge/write_client.go` |
| Stale-update skip (cache compare) | Yes | M2 | R1.9 | `bridge/bridge.go:657` |
| `writeClients map[int64]` (many dest clients) | **No** | — | **multi-chain** | `bridge/bridge.go:33` |

### Module `leader` + `grpc` — `internal/leader/`, `internal/grpc/`

| Spectra feature | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| On-chain monitor (primary/replica `ShouldProcess`) | Yes | **M3** | HA/replica | `leader/onchain_monitor.go` |
| gRPC replica coordination server | Yes | **M3** | HA/replica | `grpc/server.go` |

### Other Spectra services — `services/*`

| Spectra service | In feeder? | When | M2 task / If No reason | Spectra source |
| --- | --- | --- | --- | --- |
| `attestor` (generates intents) | **No** | — | external: intent generation is DIA's existing upstream infra, not the feeder/bridge | `services/attestor/` |
| `oracle-bridge` (failover HTTP API) | Yes | **M3** | HA/replica (folds into failover handler) | `services/oracle-bridge/` |
| `hyperlane-monitor` | **No** | — | **EVM** (Hyperlane) | `services/hyperlane-monitor/` |

### Inventory summary

- **In feeder, M2:** config surface, scanner, pipeline, processor
  (minus gas estimation), router OR-gate/replay/signer, cron with
  on-chain read, worker pools, transaction queue + Cardano write
  client, all 6 DB tables, all read API routes, all non-EVM metrics
  including **fee tracking in lovelace**, orchestration, health.
- **In feeder, M3:** HA/replica (leader on-chain monitor, gRPC,
  failover handler + metrics), per-destination cron schedules.
- **Not in feeder — EVM:** gas estimation service, EVM nonce manager,
  EVM receiver ABI encoding, `gas_used`/`gas_price`/wei/gwei metrics
  and columns, Hyperlane delivery metrics, Solidity.
- **Not in feeder — multi-chain:** `Destinations map[int64]`,
  `writeClients map[int64]`, multi-destination router fan-out.
- **Not in feeder — external:** attestor (DIA generates intents
  upstream).

Everything else is in the feeder.

## Phase index

- [Milestone 2 — Final Plan (Spectra-shaped)](#milestone-2--final-plan-spectra-shaped)
  - [The single rule](#the-single-rule)
  - [What this plan is not](#what-this-plan-is-not)
  - [Catalyst acceptance (unchanged)](#catalyst-acceptance-unchanged)
  - [Spectra feature inventory](#spectra-feature-inventory)
    - [Module `config` — `services/bridge/config/`](#module-config--servicesbridgeconfig)
    - [Module `scanner` — `internal/scanner/`](#module-scanner--internalscanner)
    - [Module `pipeline` — `internal/pipeline/`](#module-pipeline--internalpipeline)
    - [Module `processor` — `internal/processor/`](#module-processor--internalprocessor)
    - [Module `pkg/router` — `services/bridge/pkg/router/`](#module-pkgrouter--servicesbridgepkgrouter)
    - [Module `cron` — `internal/cron/`](#module-cron--internalcron)
    - [Module `worker` — `internal/worker/`](#module-worker--internalworker)
    - [Module `transaction` — `internal/transaction/`](#module-transaction--internaltransaction)
    - [Module `database` — `internal/database/`](#module-database--internaldatabase)
    - [Module `api` — `internal/api/`](#module-api--internalapi)
    - [Module `metrics` — `internal/metrics/`](#module-metrics--internalmetrics)
    - [Module `bridge` — `internal/bridge/` (orchestration)](#module-bridge--internalbridge-orchestration)
    - [Module `leader` + `grpc` — `internal/leader/`, `internal/grpc/`](#module-leader--grpc--internalleader-internalgrpc)
    - [Other Spectra services — `services/*`](#other-spectra-services--services)
    - [Inventory summary](#inventory-summary)
  - [Phase index](#phase-index)
- [Phase R0 — Bookkeeping carryovers](#phase-r0--bookkeeping-carryovers)
- [Phase R1 — Architecture parity with Spectra](#phase-r1--architecture-parity-with-spectra)
  - [R1.1 — Configuration shape parity](#r11--configuration-shape-parity)
    - [R1.1.a — Spectra config keys that must be honoured](#r11a--spectra-config-keys-that-must-be-honoured)
    - [R1.1.b — Spectra config key spelling parity](#r11b--spectra-config-key-spelling-parity)
    - [R1.1.c — Spectra-compatible router YAML input shapes](#r11c--spectra-compatible-router-yaml-input-shapes)
    - [R1.1.d — Database connection config (sourced for R1.3)](#r11d--database-connection-config-sourced-for-r13)
  - [R1.2 — Code-quality and dead-code cleanup](#r12--code-quality-and-dead-code-cleanup)
    - [R1.2.a — Strip plan / phase / milestone references from code](#r12a--strip-plan--phase--milestone-references-from-code)
    - [R1.2.b — Magic numbers / unit suffixes](#r12b--magic-numbers--unit-suffixes)
    - [R1.2.c — Dead code (do not delete; wire it)](#r12c--dead-code-do-not-delete-wire-it)
    - [R1.2.d — Deduplication in code](#r12d--deduplication-in-code)
    - [R1.2.e — Stale test fixtures](#r12e--stale-test-fixtures)
  - [R1.3 — Persistent state model (DB as source of truth)](#r13--persistent-state-model-db-as-source-of-truth)
    - [R1.3.a — `processed_events` table (Spectra parity)](#r13a--processed_events-table-spectra-parity)
    - [R1.3.b — `chain_state` table (Spectra parity + checkpoint absorption)](#r13b--chain_state-table-spectra-parity--checkpoint-absorption)
    - [R1.3.c — `transaction_log` table (Spectra parity, full lifecycle)](#r13c--transaction_log-table-spectra-parity-full-lifecycle)
    - [R1.3.d — `contract_symbol_updates` table (new — replaces in-memory `priceCache`)](#r13d--contract_symbol_updates-table-new--replaces-in-memory-pricecache)
    - [R1.3.e — `performance_metrics` table (Spectra parity)](#r13e--performance_metrics-table-spectra-parity)
    - [R1.3.f — `alert_log` table (Spectra parity)](#r13f--alert_log-table-spectra-parity)
    - [R1.3.g — Remove JSON checkpoint file system](#r13g--remove-json-checkpoint-file-system)
    - [R1.3.h — Db interface consolidation and TypeScript row types](#r13h--db-interface-consolidation-and-typescript-row-types)
    - [R1.3.i — Postgres / SQLite parity rules](#r13i--postgres--sqlite-parity-rules)
  - [R1.4 — Source pipeline (scanner + dedup + WS)](#r14--source-pipeline-scanner--dedup--ws)
    - [R1.4.a — Honour `block_scanner.head_tracker_interval` and `gap_detection_interval`](#r14a--honour-block_scannerhead_tracker_interval-and-gap_detection_interval)
    - [R1.4.b — Configurable backfill chunk size](#r14b--configurable-backfill-chunk-size)
    - [R1.4.c — Compact-name normalisation for scanner keys](#r14c--compact-name-normalisation-for-scanner-keys)
    - [R1.4.d — Scanner health/status fields](#r14d--scanner-healthstatus-fields)
    - [R1.4.e — WebSocket reconnect backoff with jitter](#r14e--websocket-reconnect-backoff-with-jitter)
    - [R1.4.f — Dedup cache parity](#r14f--dedup-cache-parity)
    - [R1.4.g — Tests](#r14g--tests)
    - [R1.4.h — Concurrent HTTP + WS transports (Spectra parity)](#r14h--concurrent-http--ws-transports-spectra-parity)
  - [R1.5 — Processing pipeline (extractor + enricher + transformer)](#r15--processing-pipeline-extractor--enricher--transformer)
    - [R1.5.a — Implement `transformer.ts` operations](#r15a--implement-transformerts-operations)
    - [R1.5.b — Honour `processing.datasource`](#r15b--honour-processingdatasource)
    - [R1.5.c — Honour non-empty `processing.transformations`](#r15c--honour-non-empty-processingtransformations)
    - [R1.5.d — Implement `RouterDestination.condition`](#r15d--implement-routerdestinationcondition)
    - [R1.5.e — Config validation for transformations](#r15e--config-validation-for-transformations)
    - [R1.5.f — Tests](#r15f--tests)
  - [R1.6 — Routing (gates, replay, signer, customer label)](#r16--routing-gates-replay-signer-customer-label)
    - [R1.6.a — Router gate `time_threshold || price_deviation` (OR-gate)](#r16a--router-gate-time_threshold--price_deviation-or-gate)
    - [R1.6.b — Timestamp / replay monotonicity](#r16b--timestamp--replay-monotonicity)
    - [R1.6.c — Per-router signer env](#r16c--per-router-signer-env)
    - [R1.6.d — Customer metrics label](#r16d--customer-metrics-label)
  - [R1.7 — Worker pools (event + update + parallel mode)](#r17--worker-pools-event--update--parallel-mode)
    - [R1.7.a — Event worker pool](#r17a--event-worker-pool)
    - [R1.7.b — Update worker pool (per-router)](#r17b--update-worker-pool-per-router)
    - [R1.7.c — Wire `event_processor.enable_parallel_mode`](#r17c--wire-event_processorenable_parallel_mode)
    - [R1.7.d — Refactor per-event pipeline into reusable handlers](#r17d--refactor-per-event-pipeline-into-reusable-handlers)
    - [R1.7.e — Cardano lane safety](#r17e--cardano-lane-safety)
    - [R1.7.f — Config wiring](#r17f--config-wiring)
    - [R1.7.g — Metrics](#r17g--metrics)
    - [R1.7.h — `/api/v1/pools` and `/api/v1/pools/:router_id/tasks`](#r17h--apiv1pools-and-apiv1poolsrouter_idtasks)
    - [R1.7.i — Health/readiness integration](#r17i--healthreadiness-integration)
    - [R1.7.j — Checkpoint safety with workers](#r17j--checkpoint-safety-with-workers)
    - [R1.7.k — Tests](#r17k--tests)
  - [R1.8 — Cron service](#r18--cron-service)
    - [R1.8.a — Reachability fix (extract symbols + iterate over `in` lists)](#r18a--reachability-fix-extract-symbols--iterate-over-in-lists)
    - [R1.8.b — On-chain pair-state timestamp read on tick](#r18b--on-chain-pair-state-timestamp-read-on-tick)
    - [R1.8.c — Submit error handling](#r18c--submit-error-handling)
    - [R1.8.d — Cron resubmission metric](#r18d--cron-resubmission-metric)
    - [R1.8.e — Per-destination cron schedules (Deferred-to-M3 entry)](#r18e--per-destination-cron-schedules-deferred-to-m3-entry)
  - [R1.9 — Transaction submission](#r19--transaction-submission)
    - [R1.9.a — Lane-key consolidation](#r19a--lane-key-consolidation)
    - [R1.9.b — Persist transaction lifecycle in DB](#r19b--persist-transaction-lifecycle-in-db)
    - [R1.9.c — Populate `feePaidLovelace`](#r19c--populate-feepaidlovelace)
    - [R1.9.d — Resume after crash](#r19d--resume-after-crash)
    - [R1.9.e — Lane-state non-atomic transition document](#r19e--lane-state-non-atomic-transition-document)
    - [R1.9.f — Tests](#r19f--tests)
  - [R1.10 — Operator surface (CLI commands + Makefile + cleanup)](#r110--operator-surface-cli-commands--makefile--cleanup)
    - [R1.10.a — Docker compose CLI mount writable](#r110a--docker-compose-cli-mount-writable)
    - [R1.10.b — Makefile rewrite](#r110b--makefile-rewrite)
    - [R1.10.c — Operator flow README rewrite](#r110c--operator-flow-readme-rewrite)
    - [R1.10.d — Cleanup command (DB-driven)](#r110d--cleanup-command-db-driven)
    - [R1.10.e — Checkpoint command (DB-driven)](#r110e--checkpoint-command-db-driven)
    - [R1.10.f — Scan command (DB-driven)](#r110f--scan-command-db-driven)
    - [R1.10.g — `feeder init bootstrap` is Docker no-op](#r110g--feeder-init-bootstrap-is-docker-no-op)
    - [R1.10.h — Operator surface tests](#r110h--operator-surface-tests)
  - [R1.11 — Comment / docstring hygiene](#r111--comment--docstring-hygiene)
    - [R1.11.a — Spectra-equivalent comments](#r111a--spectra-equivalent-comments)
    - [R1.11.b — Top-of-file docstrings](#r111b--top-of-file-docstrings)
- [Phase R2 — API parity](#phase-r2--api-parity)
  - [R2.1 — `/api/v1/status` and `/api/v1/status/components`](#r21--apiv1status-and-apiv1statuscomponents)
  - [R2.2 — `/api/v1/events*`](#r22--apiv1events)
  - [R2.3 — `/api/v1/transactions` list endpoint](#r23--apiv1transactions-list-endpoint)
  - [R2.4 — `/api/v1/pools` and `/api/v1/pools/:router_id/tasks`](#r24--apiv1pools-and-apiv1poolsrouter_idtasks)
  - [R2.5 — `/api/v1/alerts*`](#r25--apiv1alerts)
  - [R2.6 — `/api/v1/performance`](#r26--apiv1performance)
  - [R2.7 — `/api/v1/prices` and `/api/v1/symbols`](#r27--apiv1prices-and-apiv1symbols)
  - [R2.8 — `/api/v1/chains`](#r28--apiv1chains)
  - [R2.9 — `/debug` endpoint gating](#r29--debug-endpoint-gating)
  - [R2.10 — `/api/v1/symbols/:symbol/updates` simplification](#r210--apiv1symbolssymbolupdates-simplification)
  - [R2.11 — API parity tests](#r211--api-parity-tests)
- [Phase R3 — Metrics parity](#phase-r3--metrics-parity)
  - [R3.1 — Lifecycle metric aliases](#r31--lifecycle-metric-aliases)
  - [R3.2 — HTTP / DB / health metric aliases](#r32--http--db--health-metric-aliases)
  - [R3.3 — Worker metric aliases](#r33--worker-metric-aliases)
  - [R3.4 — Per-phase latency split (M2)](#r34--per-phase-latency-split-m2)
  - [R3.5 — Cardano-specific extensions (kept)](#r35--cardano-specific-extensions-kept)
  - [R3.6 — EVM-only metric units excluded; fees kept in lovelace](#r36--evm-only-metric-units-excluded-fees-kept-in-lovelace)
  - [R3.7 — Persistent metrics flag](#r37--persistent-metrics-flag)
  - [R3.8 — Metric snapshot test](#r38--metric-snapshot-test)
- [Phase R4 — Health, alerts, observability](#phase-r4--health-alerts-observability)
  - [R4.1 — Health loop](#r41--health-loop)
  - [R4.2 — Alert evaluator](#r42--alert-evaluator)
  - [R4.3 — Alerts API (cross-ref R2.5)](#r43--alerts-api-cross-ref-r25)
  - [R4.4 — Alertmanager / Prometheus rule files (kept)](#r44--alertmanager--prometheus-rule-files-kept)
  - [R4.5 — Synthetic alert firing for evidence](#r45--synthetic-alert-firing-for-evidence)
- [Phase R5 — Security hardening](#phase-r5--security-hardening)
  - [R5.1 — Host-header trust](#r51--host-header-trust)
  - [R5.2 — Path-parameter length cap](#r52--path-parameter-length-cap)
  - [R5.3 — Log injection](#r53--log-injection)
  - [R5.4 — API rate limit and bind 127.0.0.1 by default](#r54--api-rate-limit-and-bind-127001-by-default)
  - [R5.5 — WebSocket reconnect storm resistance](#r55--websocket-reconnect-storm-resistance)
  - [R5.6 — SQLite `synchronous = FULL`](#r56--sqlite-synchronous--full)
  - [R5.7 — `db.path` traversal validation](#r57--dbpath-traversal-validation)
  - [R5.8 — Migrate teardown on failure](#r58--migrate-teardown-on-failure)
  - [R5.9 — Cron submit fire-and-forget](#r59--cron-submit-fire-and-forget)
  - [R5.10 — Lane state non-atomic transitions](#r510--lane-state-non-atomic-transitions)
- [Phase R6 — Documentation alignment](#phase-r6--documentation-alignment)
  - [R6.1 — Feeder README fixes](#r61--feeder-readme-fixes)
  - [R6.2 — CLI README fixes](#r62--cli-readme-fixes)
  - [R6.3 — Feeder scripts README](#r63--feeder-scripts-readme)
  - [R6.4 — Architecture doc update](#r64--architecture-doc-update)
  - [R6.5 — Spectra parity register surfaced](#r65--spectra-parity-register-surfaced)
- [Phase R7 — Evidence pack rebuild](#phase-r7--evidence-pack-rebuild)
  - [R7.1 — Dashboard snapshot pipeline](#r71--dashboard-snapshot-pipeline)
  - [R7.2 — Bucket tx failures by `error_code`](#r72--bucket-tx-failures-by-error_code)
  - [R7.3 — 10-pair coverage](#r73--10-pair-coverage)
  - [R7.4 — Alert firing demonstration](#r74--alert-firing-demonstration)
  - [R7.5 — Real 48-72 h evidence window](#r75--real-48-72-h-evidence-window)
  - [R7.6 — `pair-selection.md`](#r76--pair-selectionmd)
  - [R7.7 — Demo video](#r77--demo-video)
  - [R7.8 — Evidence build is reproducible](#r78--evidence-build-is-reproducible)
- [Phase R8 — Cardano Mainnet rollout](#phase-r8--cardano-mainnet-rollout)
  - [R8.1 — Mainnet config validation](#r81--mainnet-config-validation)
  - [R8.2 — Test-fixture regeneration](#r82--test-fixture-regeneration)
  - [R8.3 — Mainnet wallet + funding](#r83--mainnet-wallet--funding)
  - [R8.4 — Mainnet protocol + client bootstrap](#r84--mainnet-protocol--client-bootstrap)
  - [R8.5 — Mainnet feeder run + evidence](#r85--mainnet-feeder-run--evidence)
  - [R8.6 — Rollback plan](#r86--rollback-plan)
- [Phase R9 — Archive + bookkeeping](#phase-r9--archive--bookkeeping)
  - [R9.1 — Archive predecessor plans](#r91--archive-predecessor-plans)
  - [R9.2 — This plan becomes the single source](#r92--this-plan-becomes-the-single-source)
  - [R9.3 — Update plan index](#r93--update-plan-index)
  - [R9.4 — Memory note](#r94--memory-note)
- [Spectra Parity Disposition Register](#spectra-parity-disposition-register)
- [In feeder, but M3 (not M2)](#in-feeder-but-m3-not-m2)
- [Not in feeder — ever (EVM-only or multi-chain-only)](#not-in-feeder--ever-evm-only-or-multi-chain-only)
- [Security notes — addendum to merge](#security-notes--addendum-to-merge)
- [Reference index](#reference-index)
- [Old-plan ID → new-plan ID map](#old-plan-id--new-plan-id-map)

---

# Phase R0 — Bookkeeping carryovers

Cleanup actions that other phases depend on.

- [ ] **R0.1** — Tick the five false-`[ ]` items in the archived
  `milestone-2-plan.md` for historical accuracy. The implementation has
  caught up; the checkboxes did not. Items: lines 1090
  (`transactionsReorg`), 1092 (`scanner*` metrics), 1095
  (`cardanoReceiverBalanceLovelace`), 1100 (`cardanoReceiverTopupWarnings`),
  1122 (`api.readiness.max_last_confirmed_age`). Each is now wired in
  `cmd/feeder/daemon-cmd.ts` (lines 453-454, 490, 634, 639, 709, 842,
  868, 883-885, 911) and `src/api/health.ts:43-69`.

- [ ] **R0.2** — Strike the stale Phase 3.4 text in the archived plan
  (lines 524-525) about `DEFAULT_MAX_RETRIES = 3` and
  `DEFAULT_RETRY_DELAY_MS = 5000`. Constants were removed by Phase
  3.5.4 Etapa 9; `maxRetries` / `delayMs` are now required params
  in `offchain/feeder/src/submitter/retry-policy.ts:75-92`.
  `NON_RETRIABLE_CODES` is now 8 codes (adds `IntentAgedOut`,
  `BatchSizeExceeded`; removes `TxDroppedFromChain` from the
  non-retriable set only). Keep `TxDroppedFromChain` as a feeder error
  category and metric source.

- [ ] **R0.3** — Footnote the 3.4.5.g vs 3.4.5.i contradiction in the
  archived plan: the "post-M2 deferral" of full `tx_mode: auto` batch
  coalescing in `.g` was superseded by `.i` shipping the batch submit
  path (`submitOracleUpdateBatch` at
  `offchain/feeder/src/lib-bridge/index.ts:615`). Note the supersession
  in an archive footnote.

- [ ] **R0.4** — Archive `milestone-2-plan.md` and
  `milestone-2-plan-init-arquitecture.md` under `docs/plans/_archived/`.
  See [R9.1](#phase-r9--archive--bookkeeping).

---

# Phase R1 — Architecture parity with Spectra

R1 brings the feeder's local architecture to parity with
`services/bridge/internal/` for every surface that exists in
single-destination Cardano scope. Each sub-phase corresponds to a
Spectra module from the [module map](#spectra-module-map).

## R1.1 — Configuration shape parity

Spectra's config split (`infrastructure`, `chains`, `contracts`,
`events`, `routers`) is already followed locally. R1.1 closes the gaps
in individual keys: shipped YAML keys that no code reads, Spectra keys
absent from our schema, and naming conventions.

### R1.1.a — Spectra config keys that must be honoured

- [ ] **R1.1.a.1** — `infrastructure.api.enable_cors`
  (`src/config/types.ts:176`, Spectra `services/bridge/config/types.go:122`,
  middleware at `services/bridge/internal/api/server.go:212,513-527`).
  Add a CORS middleware to `createApiServer` gated by
  `config.infrastructure.api.enable_cors`. Default `false`. When true,
  answer `OPTIONS` and emit `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`.

- [ ] **R1.1.a.2** — `routers.customer` label
  (`src/config/types.ts:346`, set in `client-a.preview.yaml:18`,
  Spectra uses it as metrics label). Emit as `customer` label on the
  tx/router metric families (`dia_bridge_transactions_*_total`,
  `dia_bridge_intents_routed_total`). See [R3.1](#r31--lifecycle-metric-aliases).

- [ ] **R1.1.a.3** — `processing.validationenabled`
  (`src/config/types.ts:387`, `client-a.preview.yaml:57`, Spectra
  emits it from `scripts/start-local.sh:888,917`). Currently unread.
  Implement: when `false`, skip dedup, intent-hash recompute, and
  router policy gate; emit `processed_events.skipped="validation_disabled"`
  metric.

- [ ] **R1.1.a.4** — `block_scanner.head_tracker_interval` and
  `block_scanner.gap_detection_interval` (`src/config/types.ts:114-115`,
  Spectra `config/types.go:75-76`). Typed but absent from both YAMLs
  and unread. Wired by R1.4.

- [ ] **R1.1.a.5** — `worker_pool.task_timeout` (`src/config/types.ts:147`).
  Commented in YAMLs, tested but unread. Wired by R1.7. Expand our
  schema to the full Spectra worker-pool shape (`max_workers`,
  `task_queue_size`, `task_timeout`, `retry_delay`, `max_retries`)
  while preserving the existing Cardano-specific `inflight_timeout_ms`.

- [ ] **R1.1.a.6** — `routers[*].signer.private_key_env` per-router
  signer env. Spectra honours router-level signer envs. Today we read
  a single global `CARDANO_WALLET_SEED_<NETWORK>`. Implement loader
  support for per-router signer envs; document precedence
  (router-level > global) and validation (env must exist when
  configured).

### R1.1.b — Spectra config key spelling parity

- [ ] **R1.1.b.1** — Spectra YAML tags are mostly compact lowercase
  (`enablecors`, `scaninterval`, `blockrange`, `maxblockgap`,
  `dedupcachesize`, `retrydelay`, `maxretries`, `checkinterval`,
  `headtrackerinterval`, `gapdetectioninterval`, `backwardsync`).
  Local shipped YAML is snake_case (`enable_cors`, `scan_interval`,
  …). **Decision:** shipped YAML stays snake_case for readability;
  loader normalisation accepts both Spectra compact spellings and
  snake_case for every key with identical semantics. Add a
  `normalizeKey()` step in `src/config/loader.ts` that maps Spectra
  compact spellings to canonical snake_case before validation.
  Document the boundary; Cardano-specific keys (`inflight_timeout_ms`,
  `client_state_path`, `protocol_state_path`) have no Spectra
  equivalent and are documented as Cardano extensions.

- [ ] **R1.1.b.2** — Add tests for compact-name acceptance: one
  fixture per (compact, snake_case) pair confirming they produce the
  identical `Config` object.

### R1.1.c — Spectra-compatible router YAML input shapes

- [ ] **R1.1.c** — `src/config/loader.ts:144-227` accepts three
  Spectra YAML router shapes (`routers:` map, `router:`,
  `config.routers`, with `unwrapRouterEntry`). This is intentional
  Spectra-input compatibility. **Keep the three shapes.** Add tests
  that load all three forms and assert they produce the same
  `RouterConfig[]`. Rewrite the existing "legacy nested shape"
  comments as "supported Spectra-compatible input shapes".

### R1.1.d — Database connection config (sourced for R1.3)

- [ ] **R1.1.d** — `database.path` / `database.path_env` already
  carried in YAML; `cmd/feeder/daemon-cmd.ts:124-127` parses bare
  numbers in some places as seconds. Force a unit suffix; throw on
  bare numbers. Validator at `src/persistence/db.ts:476-485` silently
  defaults to `state/feeder.sqlite` when `database.path` missing —
  **change to throw**. See [R1.2.b](#r12b--magic-numbers--unit-suffixes).

## R1.2 — Code-quality and dead-code cleanup

### R1.2.a — Strip plan / phase / milestone references from code

User rule: code and READMEs talk about code; only `TODO:` / `NOTE:`
comments may mention milestones, and even then only when future-reader
context demands it.

- [ ] **R1.2.a.1** — `offchain/feeder/src/config/types.ts` lines 121,
  123, 126, 128, 130, 163 contain `M2` / `M3` markers. Replace with
  `TODO:` / `NOTE:`; describe the behaviour, not the milestone.
- [ ] **R1.2.a.2** — `offchain/feeder/cmd/feeder/daemon-cmd.ts:442`
  and `:1172` reference "Spectra-parity gap recovery (Etapa B.1)".
  Replace with a behavioural comment ("scanner re-syncs from
  `last_processed_block` on restart"). Drop "Etapa B.1".
- [ ] **R1.2.a.3** — `offchain/feeder/README.md:495, 497, 500` cells
  say "Declared as M3 placeholders" / "Required for M2 …". Rewrite
  the table with status-only language ("in use", "wired in parallel
  mode", "reserved").
- [ ] **R1.2.a.4** — `offchain/feeder/config/infrastructure.preview.yaml`
  lines 68, 71, 96, 116, 138-140 and `infrastructure.mainnet.yaml:53-54,
  66, 79, 94` carry "Deferred to M3" / "M3 placeholders" comments.
  Replace with `# TODO:` notes describing what the key would do when
  implemented, without naming a milestone in the YAML.
- [ ] **R1.2.a.5** — Root `README.md` keeps milestone words because it
  documents Catalyst delivery. **No change.**

### R1.2.b — Magic numbers / unit suffixes

- [ ] **R1.2.b.1** — `cmd/feeder/daemon-cmd.ts:124-127` parses bare
  numbers as seconds. Force a unit suffix on every duration field;
  throw on bare numbers. Cross-reference [R1.1.d](#r11d--database-connection-config-sourced-for-r13).
- [ ] **R1.2.b.2** — `src/source/scanner-http.ts` `BACKFILL_CHUNK_BLOCKS
  = 5000n` is hardcoded. Replace with `block_scanner.backfill_chunk_blocks`
  in YAML and validation. Keep `5000` as the explicit YAML default,
  not as a hidden code fallback. Implementation lives in R1.4.

### R1.2.c — Dead code (do not delete; wire it)

- [ ] **R1.2.c.1** — `createTransformer` at
  `src/pipeline/transformer.ts:32-39` and the re-export from
  `src/pipeline/index.ts:11` are not wired. Spectra has a real
  transformation engine (`internal/pipeline/transformer.go`).
  **Do not delete.** Replace the stub with the implementation
  required by [R1.5.c](#r15c--processing-transformations--destination-condition).

- [ ] **R1.2.c.2** — Empty `catch {}` blocks at
  `src/source/scanner-ws.ts:152-154` and `src/source/checkpoint.ts:56`.
  Replace with `catch (err) { log.debug("…", { err }) }`. Note:
  `src/source/checkpoint.ts` is deleted entirely by [R1.3.f](#r13f--remove-json-checkpoint-file-system),
  so the second item only stands until that lands.

- [ ] **R1.2.c.3** — `src/api/server.ts:54` builds an `URL` from
  `req.headers.host` (untrusted). Hardcode the base to
  `http://localhost` and use only `req.url`. Security cross-ref:
  [R5.1](#r51--host-header-trust).

- [ ] **R1.2.c.4** — `cmd/feeder/daemon-cmd.ts:1298`
  `process.env.API_LISTEN_ADDR` fallback. Unreachable because the
  YAMLs always carry `host` + `port`. Remove the env path and
  `APIConfig.listen_addr`.

- [ ] **R1.2.c.5** — `src/config/validate.ts:618-623` rejects
  `tx_mode` (rename leftover). Delete the guard.

### R1.2.d — Deduplication in code

- [ ] **R1.2.d.1** — Lane-key formula is duplicated:
  `src/submitter/queue-manager.ts:121-122` and
  `src/submitter/coalescer.ts:139-141` (`laneKey` function). Extract
  `laneKey(dest)` into `src/submitter/lane-key.ts`; import from both
  modules. Also unblocks the deferred `lane-state.ts` split.

- [ ] **R1.2.d.2** — Duplicated row types between `db.ts` Sqlite/Pg
  row mappers and `TransactionLogRow` etc. Consolidate row types in
  `src/persistence/db.ts`; mappers (`fromSqlite*`, `fromPg*`) keep
  per-driver row interfaces strictly internal to `db.ts`. Public
  surface exports only the canonical `*Row` shapes consumed by the
  API and CLI. Cross-reference: [R1.3](#r13--persistent-state-model-db-as-source-of-truth).

- [ ] **R1.2.d.3** — `src/lib-bridge/index.ts` Lucid client surface
  carries a "(backwards compatibility)" comment at lines 129-134.
  Remove the comment; this codebase is the system, no compat layer
  needed. The function itself stays.

### R1.2.e — Stale test fixtures

- [ ] **R1.2.e** — `cli/src/__tests__/run-tests.ts:180` still
  references `DIA_SOURCE_CHAIN_ID_TESTNET` after Annex D removed it
  from `.env.example`. Update the test or regenerate the fixture.
  Folded with the broader test-fixture regen at [R8.2](#phase-r8--cardano-mainnet-rollout).

## R1.3 — Persistent state model (DB as source of truth)

This is the foundational architecture change. Spectra's
`internal/database/` (see `schema.go`, `database.go`,
`init_chain_state.go`) treats the database as the single source of
truth for **every** piece of state that must survive a restart:
scanner position, processed events, in-flight transactions, last
on-chain confirmed price per pair, performance counters, alert
history. Local feeder currently splits this state across SQLite +
in-memory caches + a JSON checkpoint file + log files, which means a
crash loses operational data and the cron service mis-fires after
restart.

R1.3 aligns the local persistence layer with Spectra's schema. Because
the project is fresh, the schema below is the canonical starting
point. **No migrations, no `ALTER TABLE`, no legacy compatibility
fields, no JSON checkpoint, no defaults masking missing data.** The
SQLite and PostgreSQL schemas are defined together in
`src/persistence/db.ts` and differ only in type spelling (INTEGER vs
BIGINT, AUTOINCREMENT vs BIGSERIAL, INTEGER vs BOOLEAN); semantics are
identical.

**Execution order within R1.3** (explicit — sub-tasks have
dependencies):

1. **R1.3.b** (`chain_state`) — no dependencies; required by R1.3.g.
2. **R1.3.c** (`transaction_log`) — no dependencies; confirm handler
   writes both R1.3.c and R1.3.d rows together.
3. **R1.3.a** (`processed_events`) — no dependencies.
4. **R1.3.d** (`contract_symbol_updates`) — implement confirm-handler
   writes after R1.3.c schema exists.
5. **R1.3.e** (`performance_metrics`) — no dependencies.
6. **R1.3.f** (`alert_log`) — no dependencies.
7. **R1.3.g** (remove JSON checkpoint) — depends on R1.3.b.
8. **R1.3.h** (`Db` interface consolidation) — depends on all above.
9. **R1.3.i** (parity test) — depends on R1.3.h.

### R1.3.a — `processed_events` table (Spectra parity)

Spectra reference: `services/bridge/internal/database/schema.go`
`processed_events` table + `migrate_generic_events.go`.

Purpose: idempotent dedup of source-chain events. The scanner writes
one row per `(intent_hash)` or per `(tx_hash, log_index)` for generic
events. Downstream code asks "have we already processed this?" and
the table answers yes/no without re-running the pipeline.

```sql
CREATE TABLE processed_events (
  intent_hash        TEXT    PRIMARY KEY,           -- "" for generic events
  event_id           TEXT,                          -- opaque id for generic events, NULL for oracle intents
  event_name         TEXT,                          -- e.g. "IntentRegistered", NULL when implied by intent_hash
  tx_hash            TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,              -- BIGINT in Postgres
  block_number       INTEGER NOT NULL,              -- BIGINT in Postgres
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('processed','filtered','duplicate','error')),
  filter_reason      TEXT,                          -- when status='filtered'
  processed_at_ms    INTEGER NOT NULL               -- BIGINT in Postgres
);
CREATE UNIQUE INDEX idx_processed_events_tx_log ON processed_events(tx_hash, log_index);
CREATE INDEX idx_processed_events_block ON processed_events(block_number);
CREATE INDEX idx_processed_events_router ON processed_events(router_id);
```

Per-field map (who writes, when, where, why):

| Field | Writer | When | Where (file:line) | Reader / Why |
| --- | --- | --- | --- | --- |
| `intent_hash` | scanner→processor | on first sighting of an `IntentRegistered` event | `cmd/feeder/daemon-cmd.ts` `processOneEvent` → `db.upsertProcessedEvent` | dedup cache + cron + `/api/v1/events/:hash` |
| `event_id`, `event_name` | processor for non-intent generic events | on first sighting | same | parity with Spectra generic-event flow; lets us record router-level non-intent events without faking an intent hash |
| `tx_hash`, `log_index` | scanner | on every extracted event | `src/source/scanner-http.ts` → daemon → `db` | enables `(tx_hash, log_index)` dedup second guard; needed because two distinct intents can share a tx |
| `block_number` | scanner | every event | same | scanner gap detection + `/api/v1/events?from_block=` |
| `router_id`, `destination_index` | router | when policy matches a router | `src/router/router.ts` → daemon | per-router stats + cleanup pruning |
| `status` | processor | terminal outcome of pipeline for this event | daemon `onResult` / dedup branch | `/api/v1/events` filter; cleanup keeps only `processed` rows older than max-age |
| `filter_reason` | router policy | when `status='filtered'` | `src/router/policy.ts` | operator debugging without re-reading source events |
| `processed_at_ms` | daemon | end of pipeline | daemon | retention pruning ([R1.10.d](#r110d--cleanup-command-db-driven)) |

Code changes:

- `src/persistence/db.ts` — replace current `processed_events` schema
  with the one above; update `ProcessedEventRow`; add
  `upsertProcessedEvent({...})` overload accepting `event_id`,
  `event_name`, `status`, `filter_reason`.
- `cmd/feeder/daemon-cmd.ts` — call `upsertProcessedEvent` with the
  full row at every terminal pipeline step (not just on success);
  fold the current `db.hasProcessedEvent` lookup to use either
  `intent_hash` or `(tx_hash, log_index)`.
- `src/router/policy.ts` — return `filterReason` alongside the gate
  decision; daemon writes it.
- `src/api/transactions.ts` / new `src/api/events.ts` — read
  `processed_events` for `/api/v1/events*` endpoints (see [R2.2](#r22--events-and-transactions-endpoints)).

### R1.3.b — `chain_state` table (Spectra parity + checkpoint absorption)

Spectra reference: `services/bridge/internal/database/schema.go`
`chain_state` + `init_chain_state.go` `InitializeChainState`.

Purpose: per-(chain, contract) durable scanner and health state.
Subsumes the old JSON checkpoint file completely.

```sql
CREATE TABLE chain_state (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,        -- BIGSERIAL in Postgres
  chain_id               INTEGER NOT NULL,
  chain_name             TEXT    NOT NULL,                         -- e.g. "ethereum-sepolia"
  contract_id            TEXT    NOT NULL,                         -- registry id from chains.yaml
  last_processed_block   INTEGER NOT NULL DEFAULT 0,               -- BIGINT in Postgres
  last_scan_block        INTEGER NOT NULL DEFAULT 0,               -- BIGINT in Postgres
  is_healthy             INTEGER NOT NULL DEFAULT 1,               -- BOOLEAN in Postgres
  error_count            INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  last_health_check_ms   INTEGER,                                  -- BIGINT in Postgres
  updated_at_ms          INTEGER NOT NULL,                         -- BIGINT in Postgres
  UNIQUE (chain_id, contract_id)
);
CREATE INDEX idx_chain_state_lookup ON chain_state(chain_id, contract_id);
```

Per-field map:

| Field | Writer | When | Where | Reader / Why |
| --- | --- | --- | --- | --- |
| `chain_id`, `chain_name`, `contract_id` | daemon init | first start per env | `cmd/feeder/daemon-cmd.ts` `initialiseChainState()` (new) | identifies the row; `chain_name` surfaces in `/api/v1/status` |
| `last_processed_block` | daemon | after every batch fully drained from worker pool / dedup write | daemon `onBatch` finalisation | restart resume position; cron staleness floor |
| `last_scan_block` | scanner | after every successful RPC scan tick (independent of processing) | `src/source/scanner-http.ts` / `scanner-ws.ts` callback into daemon | **replaces `feeder-checkpoint.json`** — scanner restart position; gap detection compares head − last_scan_block |
| `is_healthy` | health loop | every health tick or scanner error | `src/api/health.ts` + scanner error path | `/api/v1/health/ready` + `/api/v1/status/components`; alert source |
| `error_count`, `last_error` | scanner error path | on RPC failure | daemon scanner error handler | health throttle + Grafana panels |
| `last_health_check_ms` | health loop | each tick | health loop | freshness of health signal in `/health` |
| `updated_at_ms` | every write to the row | on each update | db.ts `setChainState*` helpers | observability |

New `Db` interface methods (added to `src/persistence/db.ts`):

```ts
initialiseChainState({ chainId, chainName, contractId }): Promise<void>;
setLastProcessedBlock(chainId, contractId, block): Promise<void>;
setLastScanBlock(chainId, contractId, block): Promise<void>;
setChainHealth(chainId, contractId, { isHealthy, errorMsg? }): Promise<void>;
getChainState(chainId, contractId): Promise<ChainStateRow | null>;
listChainStates(): Promise<ChainStateRow[]>;
```

Code changes:

- `cmd/feeder/daemon-cmd.ts` — boot sequence calls
  `initialiseChainState`; scanner callback writes `last_scan_block`
  per tick; processor finalisation writes `last_processed_block`;
  scanner error handler writes `setChainHealth(false, msg)`; success
  resets `setChainHealth(true)`.
- `src/api/health.ts` — `/api/v1/health/ready` queries
  `getChainState(...).is_healthy`.
- `src/api/chains.ts` — `/api/v1/chains` reads `listChainStates()`.

### R1.3.c — `transaction_log` table (Spectra parity, full lifecycle)

Spectra reference: `services/bridge/internal/database/schema.go`
`transaction_log` + `database.go` `LogTransaction` /
`UpdateTransactionStatus`.

Purpose: durable record of every Cardano submission attempt: pending,
submitted, confirmed, failed. Drives `/api/v1/transactions`, evidence
pack stats, retry resume after crash, fee accounting.

```sql
CREATE TABLE transaction_log (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,   -- BIGSERIAL in Postgres
  intent_hash                   TEXT    NOT NULL,
  cardano_tx_hash               TEXT    NOT NULL DEFAULT '',         -- '' while status='pending'
  router_id                     TEXT    NOT NULL,
  destination_index             INTEGER NOT NULL,
  destination_chain_name        TEXT    NOT NULL,                    -- e.g. "cardano-preview"
  destination_contract_address  TEXT    NOT NULL,                    -- actual Cardano script address
  symbol                        TEXT    NOT NULL,                    -- e.g. "BTC/USD"
  price                         TEXT    NOT NULL,                    -- raw bigint as string
  timestamp                     INTEGER NOT NULL,                    -- intent timestamp seconds (BIGINT in PG)
  status                        TEXT    NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
  error_code                    TEXT,                                -- machine-readable, e.g. "NonMonotonicNonce"
  error_message                 TEXT,                                -- free text
  retry_count                   INTEGER NOT NULL DEFAULT 0,
  max_retries                   INTEGER NOT NULL DEFAULT 0,          -- from config at insert time
  fee_paid_lovelace             TEXT,                                -- Lovelace as string, NULL until confirmed
  confirmed_at_depth            INTEGER,                             -- BIGINT in Postgres
  submitted_at_ms               INTEGER,                             -- BIGINT in Postgres; NULL while pending
  confirmed_at_ms               INTEGER,                             -- BIGINT in Postgres
  failed_at_ms                  INTEGER,                             -- BIGINT in Postgres
  created_at_ms                 INTEGER NOT NULL                     -- BIGINT in Postgres
);
CREATE INDEX idx_tx_log_intent_hash ON transaction_log(intent_hash);
CREATE INDEX idx_tx_log_tx_hash ON transaction_log(cardano_tx_hash);
CREATE INDEX idx_tx_log_status_created ON transaction_log(status, created_at_ms);
CREATE INDEX idx_tx_log_router_symbol ON transaction_log(router_id, symbol);
```

Lifecycle (Spectra parity):

1. **pending** — daemon enqueues a submit request. Insert row with
   `status='pending'`, `cardano_tx_hash=''`, `submitted_at_ms=NULL`,
   `retry_count=0`, `max_retries` from
   `config.worker_pool.max_retries`, `created_at_ms=now()`.
   Writer: `daemon-cmd.ts` `onStep('enqueued')` (new) or coalescer
   `accept`.
2. **submitted** — Cardano write client returns a tx hash. Update
   row: `status='submitted'`, `cardano_tx_hash=<hash>`,
   `submitted_at_ms=now()`. Writer: `daemon-cmd.ts:528` (replaces
   current insert).
3. **confirmed** — chain-as-truth reconcile or block-depth confirm
   sees the tx final. Update row: `status='confirmed'`,
   `confirmed_at_ms=now()`, `confirmed_at_depth=<depth>`,
   `fee_paid_lovelace=<lovelace>`. Writer: `daemon-cmd.ts:661`.
4. **failed** — submit returned an error, or a retry budget hit zero,
   or a `TxDroppedFromChain` arrived. Update row (or insert if it
   never reached `submitted`): `status='failed'`, `error_code=<code>`,
   `error_message=<msg>`, `failed_at_ms=now()`,
   `retry_count=<final>`. Writer: `daemon-cmd.ts:716` (replaces
   current fail-path insert) plus retry-budget exhaustion path in
   `src/submitter/retry-policy.ts` consumer.

Per-field map (only new / changed fields shown — existing fields keep
their current semantics):

| Field | Writer | When | Where | Reader / Why |
| --- | --- | --- | --- | --- |
| `destination_contract_address` | daemon at insert | `pending` insert | `daemon-cmd.ts` submit path; value from `req.destination.cardano.scriptAddress` | evidence pack JOINs; cleanup pruning; operator audit — index by `destination_index` is meaningless if config rotates |
| `destination_chain_name` | daemon at insert | `pending` insert | same; value from `network` runtime variable | `/api/v1/transactions?chain=` filter; evidence pack labels |
| `symbol` | daemon at insert | `pending` insert | same; value from `req.symbol` | removes the current JOIN to `processed_events` for symbol lookup in `/api/v1/symbols/:symbol/updates` ([R5.4](#r54--api-rate-limit-and-bind-127001-by-default)) |
| `fee_paid_lovelace` | daemon on confirm | `confirmed` update | `daemon-cmd.ts:661`; value from `SubmitResult.feePaidLovelace` (new field, populated in `src/submitter/cardano-write-client.ts` from Lucid tx body fee) | `/api/v1/transactions/:hash` body; `performance_metrics.total_fee_paid_lovelace` accumulator; evidence pack |
| `retry_count` | daemon on each retry decision | `failed` update or retry pre-submit | retry policy consumer in daemon | resume-after-crash: on boot, daemon scans rows with `status IN ('pending','submitted')` and decides retry vs abandon |
| `max_retries` | daemon at insert | `pending` insert | from `config.worker_pool.max_retries` snapshot | enables retry-budget enforcement independent of in-memory state |
| `status` extension (`'pending'`) | daemon at insert | `pending` insert | replaces today's direct-to-`submitted` insert | enables Spectra-shaped lifecycle and durable inflight detection |
| `failed_at_ms` | daemon on fail | `failed` insert/update | replaces today's missing failure timestamp | latency analysis for evidence; cleanup pruning |
| `error_code` | daemon on fail | `failed` insert/update | machine-readable code from `SubmitResultErr.code` (already exists in `src/submitter/types.ts`) | replaces free-text `error_message` for `error-counts.tsv` bucketing ([R7.2](#r72--bucket-tx-failures-by-error_code)) |

Code changes:

- `src/persistence/db.ts`:
  - Replace `transaction_log` schema with the one above (both
    SQLite and Postgres branches).
  - Update `TransactionLogRow` TypeScript type. Add
    `'pending'` to the `status` union.
  - Add `Db.insertTransactionLog(row)` accepting the full row
    (caller supplies all `pending`-time fields).
  - Add `Db.updateTransactionLog(intentHash, cardanoTxHash, patch)`
    accepting any subset of `{ status, error_code, error_message,
    retry_count, fee_paid_lovelace, confirmed_at_depth,
    submitted_at_ms, confirmed_at_ms, failed_at_ms }`.
  - Drop the old narrow `update(status, confirmedAtMs)` overload.
- `src/submitter/types.ts`:
  - Add `feePaidLovelace?: string` to `SubmitResultOk`.
  - Confirm `code: string` is already on `SubmitResultErr`.
- `src/submitter/cardano-write-client.ts`:
  - Populate `feePaidLovelace` from the Lucid built tx body fee
    on every successful submit.
- `cmd/feeder/daemon-cmd.ts`:
  - Replace the current `insertTransactionLog` at line 528 with the
    full `pending` insert (one per submit request entering the
    coalescer) and a separate `updateTransactionLog(..., status:
    'submitted', cardano_tx_hash, submitted_at_ms)` once the write
    client returns a hash.
  - Replace the confirm update at line 661 with the extended
    `confirmed` update including `fee_paid_lovelace`.
  - Replace the fail-path insert at line 716 with either an update
    (if a row already exists for the intent) or an insert directly
    in `failed` state.
  - On daemon start, run a recovery pass: query
    `transaction_log WHERE status IN ('pending','submitted')` and
    decide per row whether to retry, abandon, or wait for a
    confirmation poll. Drives the "no operational data lost on
    crash" guarantee.
- `cmd/feeder/__tests__/daemon-pipeline.test.ts`:
  - Update the in-memory `Db` stub to implement the full new
    interface; existing tests must keep passing.

### R1.3.d — `contract_symbol_updates` table (new — replaces in-memory `priceCache`)

Spectra reference: `services/bridge/internal/database/schema.go`
`contract_symbol_updates` + `database.go` `RecordContractSymbolUpdate`
/ `GetLastContractSymbolUpdate`.

Purpose: durable last-confirmed price per `(chain_id,
contract_address, symbol)`. Today this is the in-memory
`priceCache` (`src/processor/price-cache.ts` +
`daemon-cmd.ts:606`). After a restart the cache is empty, the cron
service has no baseline, and the first tick either re-submits
unconditionally (false positive) or returns `skipped_uninitialised`
(false negative). Spectra parity requires this state to survive a
restart.

```sql
CREATE TABLE contract_symbol_updates (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,   -- BIGSERIAL in Postgres
  chain_id                    INTEGER NOT NULL,
  contract_address            TEXT    NOT NULL,
  symbol                      TEXT    NOT NULL,
  last_intent_hash            TEXT,
  last_cardano_tx_hash        TEXT,
  last_price                  TEXT    NOT NULL,
  last_timestamp              INTEGER NOT NULL,                    -- intent timestamp seconds (BIGINT in PG)
  last_update_ms              INTEGER NOT NULL,                    -- wall-clock when row last touched (BIGINT in PG)
  last_confirmed_at_depth     INTEGER,                             -- block depth at confirm
  update_count                INTEGER NOT NULL DEFAULT 0,
  total_fee_paid_lovelace     TEXT,                                -- accumulator, NULL if never set
  UNIQUE (chain_id, contract_address, symbol)
);
CREATE INDEX idx_contract_symbol_updates_lookup ON contract_symbol_updates(chain_id, contract_address, symbol);
```

Per-field map:

| Field | Writer | When | Where | Reader / Why |
| --- | --- | --- | --- | --- |
| `chain_id`, `contract_address`, `symbol` | daemon on confirm | `confirmed` tx | `daemon-cmd.ts` confirm handler (currently line 606 `priceCache.set`) | unique key; cron lookup; `/api/v1/prices` filter |
| `last_intent_hash` | same | same | same | correlation with `/api/v1/events/:hash` |
| `last_cardano_tx_hash` | same | same | same | `/api/v1/prices` audit link; cron skip when hash equals on-chain |
| `last_price`, `last_timestamp` | same | same | same | router policy `time_threshold` + `price_deviation` gate (read on **next** intent through the router) |
| `last_update_ms` | same | same | same | freshness of the row itself (vs the intent timestamp) |
| `last_confirmed_at_depth` | same | same | same | reorg-protection diagnostics |
| `update_count` | same | `update_count + 1` per confirm | same | `/api/v1/symbols/:symbol` summary |
| `total_fee_paid_lovelace` | same | `total + fee_paid_lovelace` per confirm | same | evidence pack fee totals |

Lifecycle:

- On daemon start, daemon calls `db.listContractSymbolUpdates()` and
  seeds `priceCache` so the in-memory router/cron paths have a real
  baseline at tick 1.
- On every confirmed tx, daemon writes both `priceCache.set(...)`
  and `db.upsertContractSymbolUpdate(...)`. The cache stays as the
  hot path; the DB is the durable backing store.
- The cron service reads `priceCache` (which is now DB-seeded) and,
  per R1.8, also reads on-chain timestamp before re-submitting.

New `Db` interface methods:

```ts
upsertContractSymbolUpdate(row): Promise<void>;
getContractSymbolUpdate(chainId, contractAddress, symbol): Promise<ContractSymbolUpdateRow | null>;
listContractSymbolUpdates(): Promise<ContractSymbolUpdateRow[]>;
```

Code changes:

- `src/persistence/db.ts` — new table + types + methods.
- `src/processor/price-cache.ts` — no API change; the cache stays
  in-memory. The constructor (or a factory at daemon boot) takes
  an optional `seedFrom: ContractSymbolUpdateRow[]` and populates
  the map.
- `cmd/feeder/daemon-cmd.ts`:
  - Boot: `const seed = await db.listContractSymbolUpdates(); const
    priceCache = createPriceCache({ seed });`
  - Confirm handler (current line 606): `priceCache.set(...);
    await db.upsertContractSymbolUpdate({ ... });`
- `src/cron/cron-service.ts` — no change here beyond consuming the
  now-seeded cache; the on-chain read is added in [R1.8](#r18--cron-service).
- `src/api/prices.ts` — `/api/v1/prices` reads from `priceCache`
  (unchanged surface), but the cache is now DB-backed.

### R1.3.e — `performance_metrics` table (Spectra parity)

Spectra reference: `services/bridge/internal/database/schema.go`
`performance_metrics` + `database.go` `RecordPerformanceMetric`.

Purpose: persistent counters/histograms for evidence and operator
review. Prometheus counters are ephemeral; this table survives a
restart and is the canonical source for the evidence pack.

```sql
CREATE TABLE performance_metrics (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,    -- BIGSERIAL in Postgres
  metric_name           TEXT    NOT NULL,
  metric_value          REAL    NOT NULL,                     -- DOUBLE PRECISION in Postgres
  labels_json           TEXT    NOT NULL DEFAULT '{}',        -- JSONB in Postgres
  recorded_at_ms        INTEGER NOT NULL                      -- BIGINT in Postgres
);
CREATE INDEX idx_perf_name_time ON performance_metrics(metric_name, recorded_at_ms);
```

Per-field map:

| Field | Writer | When | Where | Reader / Why |
| --- | --- | --- | --- | --- |
| `metric_name` | metrics module | each Prometheus increment that has a "must-survive-restart" flag | `src/api/metrics.ts` (new `recordPersistent(name, value, labels)` helper) | evidence pack stats generation; `/api/v1/performance` |
| `metric_value` | same | same | same | same |
| `labels_json` | same | same | same | filter by `router_id`, `symbol`, `error_code` |
| `recorded_at_ms` | same | same | same | time-window slicing for evidence |

**Persistent-flagged metrics for M2:**

- `transactions_submitted_total`
- `transactions_confirmed_total`
- `transactions_failed_total{error_code}`
- `intents_dropped_total{reason}`
- `cron_resubmissions_total{outcome}`
- `worker_tasks_dropped_total` (after R1.7)
- `scanner_reorg_drops_total`

Volatile metrics (worker queue depth, active workers, pool size,
latency histograms) are **not** written to this table; they exist
only in Prometheus.

Code changes:

- `src/persistence/db.ts` — new table + types + method:
  `recordPerformanceMetric({ name, value, labels })`.
- `src/api/metrics.ts` — add a thin `markPersistent(metricName)`
  registry; counter `.inc()` wrappers fork to
  `db.recordPerformanceMetric` for persistent-flagged names.
- `src/api/performance.ts` (new) — `/api/v1/performance` endpoint
  (R2).
- Evidence pack script `scripts/m2-evidence/build-stats.ts` — query
  this table instead of replaying jsonl logs.

### R1.3.f — `alert_log` table (Spectra parity)

Spectra reference: `services/bridge/internal/database/schema.go`
`alert_log` + `database.go` `RecordAlert`.

Purpose: durable record of every alert firing event, with
acknowledged/resolved state. Survives restarts; backs
`/api/v1/alerts`; powers the Catalyst-required "automated alerts for
any anomalies including stale data or misreport prices" demonstration.

```sql
CREATE TABLE alert_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,    -- BIGSERIAL in Postgres
  alert_name      TEXT    NOT NULL,
  severity        TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
  message         TEXT    NOT NULL,
  labels_json     TEXT    NOT NULL DEFAULT '{}',        -- JSONB in Postgres
  fired_at_ms     INTEGER NOT NULL,                     -- BIGINT in Postgres
  resolved_at_ms  INTEGER,                              -- BIGINT in Postgres; NULL while active
  acknowledged    INTEGER NOT NULL DEFAULT 0            -- BOOLEAN in Postgres
);
CREATE INDEX idx_alert_log_active ON alert_log(resolved_at_ms) WHERE resolved_at_ms IS NULL;
CREATE INDEX idx_alert_log_name_time ON alert_log(alert_name, fired_at_ms);
```

Note: Postgres conditional index is `WHERE resolved_at_ms IS NULL`;
SQLite supports the same syntax in modern versions (3.8+).

Per-field map:

| Field | Writer | When | Where | Reader / Why |
| --- | --- | --- | --- | --- |
| `alert_name`, `severity` | alert evaluator | when a Prometheus-style rule transitions to `firing` | new `src/alerting/evaluator.ts` (R4.2) | `/api/v1/alerts` + evidence pack |
| `message` | same | same | same | operator UX |
| `labels_json` | same | same | same | filter / group |
| `fired_at_ms` | same | first fire | same | duration analysis |
| `resolved_at_ms` | same | when rule clears | same | active-alert filter |
| `acknowledged` | API | operator POSTs `/api/v1/alerts/:id/ack` | `src/api/alerts.ts` (R2) | UX state separate from `resolved` |

New `Db` interface methods:

```ts
recordAlert({ name, severity, message, labels, firedAtMs }): Promise<number>;  // returns id
resolveAlert(id, resolvedAtMs): Promise<void>;
acknowledgeAlert(id): Promise<void>;
listAlerts({ active?: boolean, limit, offset }): Promise<AlertLogRow[]>;
```

Code changes: new table + types + methods in `db.ts`; new
`src/alerting/evaluator.ts` module (R4.2); new `src/api/alerts.ts`
(R2).

### R1.3.g — Remove JSON checkpoint file system

Today the block-scanner position lives in
`state/<network>/feeder-checkpoint.json` and is managed by
`src/source/checkpoint.ts`. After R1.3.b lands, the same data lives
in `chain_state.last_scan_block` (durable, transactional, queryable).
The JSON file becomes redundant; keeping it would be the "two
sources of truth" anti-pattern Spectra explicitly avoids.

**Fresh-project rule: delete the JSON checkpoint system entirely.**
No migration helper, no fallback read, no "if DB row missing, read
JSON". The DB row is created at first daemon start by
`initialiseChainState()` (R1.3.b) with `last_scan_block = 0` (or the
operator-supplied `--from-block`), and updated in place.

Files to change:

- `src/source/checkpoint.ts` — **delete the file entirely**. The
  `createJsonCheckpoint` and `defaultCheckpointPath` functions are no
  longer needed; their callers move to the new DB-backed checkpoint.
- `src/source/index.ts` — drop the `createJsonCheckpoint` /
  `defaultCheckpointPath` re-exports.
- `cmd/feeder/daemon-cmd.ts:167` — drop the comment line referring
  to `state/<network>/feeder-checkpoint.json`.
- `cmd/feeder/daemon-cmd.ts:228` — drop the
  `${base}/feeder-checkpoint.json` path emission.
- `cmd/feeder/daemon-cmd.ts:808-819` — replace `const
  checkpointPath = defaultCheckpointPath(network); const checkpoint =
  createJsonCheckpoint({ filePath: checkpointPath }); await
  seedCheckpointIfNeeded({...})` with a DB-backed equivalent:
  ```ts
  await db.initialiseChainState({
    chainId: source.chainId,
    chainName: network,
    contractId: source.registryAddress,
  });
  if (options.fromBlock !== undefined) {
    await db.setLastScanBlock(source.chainId, source.registryAddress, options.fromBlock);
  } else if (options.fromLatest) {
    const head = await client.getBlockNumber();
    await db.setLastScanBlock(source.chainId, source.registryAddress, head);
  }
  const checkpoint = createDbCheckpoint({
    db,
    chainId: source.chainId,
    contractId: source.registryAddress,
  });
  ```
- new `src/source/checkpoint-db.ts` — `createDbCheckpoint({ db,
  chainId, contractId }): Checkpoint` exposing the same `Checkpoint`
  interface (`get()`, `set(block)`) the rest of the scanner expects;
  implementation reads/writes `chain_state.last_scan_block`.
- `cmd/feeder/checkpoint-cmd.ts` — rewrite to read/write
  `chain_state.last_scan_block` via the same helper. CLI surface
  unchanged: `feeder checkpoint --get`, `feeder checkpoint --set
  <block>`, `feeder checkpoint --clear`.
- `cmd/feeder/scan-cmd.ts` — replace the JSON-checkpoint usage with
  the DB-backed helper.
- `cmd/feeder/cleanup-cmd.ts:253` — drop the `feeder-checkpoint.json`
  branch; cleanup no longer deletes a checkpoint file (the DB row
  is operator state, not garbage).
- `cmd/feeder/__tests__/clean-state.test.ts` — drop the JSON
  fixture and assertion; replace with a DB-backed assertion.
- `offchain/feeder/README.md` cleanup section (~ line 295) — drop
  the `feeder-checkpoint.json` mention.

### R1.3.h — Db interface consolidation and TypeScript row types

After R1.3.a..f the `Db` interface in `src/persistence/db.ts` grows to:

```ts
export type Db = {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // chain_state
  initialiseChainState(args): Promise<void>;
  setLastProcessedBlock(chainId, contractId, block): Promise<void>;
  setLastScanBlock(chainId, contractId, block): Promise<void>;
  setChainHealth(chainId, contractId, args): Promise<void>;
  getChainState(chainId, contractId): Promise<ChainStateRow | null>;
  listChainStates(): Promise<ChainStateRow[]>;

  // processed_events
  upsertProcessedEvent(row): Promise<void>;
  hasProcessedEvent(intentHashOrTxLog): Promise<boolean>;
  getProcessedEvent(intentHash): Promise<ProcessedEventRow | null>;
  listProcessedEvents(query): Promise<ProcessedEventRow[]>;

  // transaction_log
  insertTransactionLog(row): Promise<void>;
  updateTransactionLog(intentHash, cardanoTxHash, patch): Promise<void>;
  getTransactionLog(intentHash): Promise<TransactionLogRow[]>;
  getTransactionsByHash(cardanoTxHash): Promise<TransactionLogRow[]>;
  listTransactions(query): Promise<TransactionLogRow[]>;

  // contract_symbol_updates
  upsertContractSymbolUpdate(row): Promise<void>;
  getContractSymbolUpdate(chainId, contractAddress, symbol): Promise<ContractSymbolUpdateRow | null>;
  listContractSymbolUpdates(): Promise<ContractSymbolUpdateRow[]>;
  listSymbolUpdates(symbol, limit): Promise<TransactionViewRow[]>;  // existing API support

  // performance_metrics
  recordPerformanceMetric({ name, value, labels }): Promise<void>;
  queryPerformanceMetrics(filter): Promise<PerformanceMetricRow[]>;

  // alert_log
  recordAlert(row): Promise<number>;
  resolveAlert(id, resolvedAtMs): Promise<void>;
  acknowledgeAlert(id): Promise<void>;
  listAlerts(query): Promise<AlertLogRow[]>;

  // cleanup
  pruneOldRows(maxAgeMs): Promise<{ processedEvents: number; transactionLog: number; alertLog: number; performanceMetrics: number }>;
};
```

Row types (TypeScript) live in the same file. Per-driver row shapes
(`SqliteTransactionLogRow`, `PgTransactionLogRow`, etc.) are
**internal**; the public surface exports only the canonical `*Row`
shapes. Cross-reference [R1.2.d.2](#r12d--deduplication-in-code).

### R1.3.i — Postgres / SQLite parity rules

- The two schemas live in the same file (`src/persistence/db.ts`) as
  the constants `SQLITE_SCHEMA` and `POSTGRES_SCHEMA`.
- The two schemas have **identical** column names, identical
  constraints, identical indexes; only type spellings differ
  (SQLite `INTEGER` ↔ Postgres `BIGINT`, SQLite `AUTOINCREMENT` ↔
  Postgres `BIGSERIAL`, SQLite `INTEGER 0/1` ↔ Postgres `BOOLEAN`,
  SQLite `TEXT` JSON ↔ Postgres `JSONB`, SQLite `REAL` ↔ Postgres
  `DOUBLE PRECISION`).
- All queries go through the `Db` interface; no raw SQL leaks into
  upstream modules.
- One unit test asserts that every column declared in one schema is
  declared in the other with identical name and identical nullability.
- Cross-references: R5.6 (`synchronous = FULL`), R5.7 (`db.path`
  traversal), R5.8 (migrate teardown).

## R1.4 — Source pipeline (scanner + dedup + WS)

Spectra reference: `services/bridge/internal/scanner/`
(`block_scanner_enhanced.go`), `services/bridge/internal/processor/`
(`dedup_cache.go`).

R1.4 brings the local scanner module (`src/source/`) up to Spectra's
enhanced-scanner controls and durability semantics. The scanner
position now lives in DB (R1.3.b/g); R1.4 wires the rest of the
Spectra-shaped controls.

### R1.4.a — Honour `block_scanner.head_tracker_interval` and `gap_detection_interval`

- [ ] **R1.4.a** — Wire `block_scanner.head_tracker_interval`
  ([`src/config/types.ts:114`](../../offchain/feeder/src/config/types.ts#L114))
  and `gap_detection_interval` (line 115) into the scanner loop.
  Spectra runs them on independent cadences:
  - Head tracker — periodically queries the source node head; updates
    `dia_bridge_block_scanner_lag_blocks` and
    `dia_bridge_block_scanner_head_block` metrics on its own cadence
    (does not block the main scan).
  - Gap detection — periodically checks whether
    `chain_state.last_scan_block` is lagging by more than
    `block_scanner.max_block_gap` and triggers backfill recovery
    independent of normal scan ticks.
  Implementation lives in `src/source/scanner-http.ts` and
  `src/source/scanner-ws.ts`; both transports must run both loops.
  Both intervals support compact spelling (`headtrackerinterval`,
  `gapdetectioninterval`) via the R1.1.b normaliser.

### R1.4.b — Configurable backfill chunk size

- [ ] **R1.4.b** — Replace hardcoded `BACKFILL_CHUNK_BLOCKS = 5000n`
  with `block_scanner.backfill_chunk_blocks` in YAML and validation.
  Keep `5000` as the explicit YAML default. Cross-ref R1.2.b.2.

### R1.4.c — Compact-name normalisation for scanner keys

- [ ] **R1.4.c** — Add Spectra compact-name normalisation for scanner
  keys: `scaninterval`, `blockrange`, `maxblockgap`, `backwardsync`,
  `headtrackerinterval`, `gapdetectioninterval`,
  `backfillchunkblocks`. Loader accepts both; shipped YAML stays
  snake_case. Tests per [R1.1.b.2](#r11b--spectra-config-key-spelling-parity).

### R1.4.d — Scanner health/status fields

- [ ] **R1.4.d** — Add scanner health/status fields surfaced from
  `chain_state` (R1.3.b): current head, last processed block,
  last_scan_block, gap size, last gap recovery result, active
  transport, last RPC error. Read by:
  - `/api/v1/status/components` (R2.1).
  - Prometheus gauges (`scanner_head_block`,
    `scanner_last_processed_block`, `scanner_lag_blocks`,
    `scanner_last_error_age_seconds`).

### R1.4.e — WebSocket reconnect backoff with jitter

- [ ] **R1.4.e** — `cmd/feeder/daemon-cmd.ts:450-451` and
  `runWsTransport @ 1218-1219` default to `reconnect_interval: 5 s`,
  `max_reconnect_attempts: 60`, constant cadence — every feeder pod
  hits the WS endpoint on the same 5 s tick after a flap. Change to
  exponential backoff with ±20% jitter, capped at 5 minutes; reset
  budget on successful receive. Implementation lives in
  `src/source/scanner-ws.ts`. Security cross-ref: [R5.5](#r55--websocket-reconnect-storm-resistance).

### R1.4.f — Dedup cache parity

- [ ] **R1.4.f** — `src/processor/dedup-cache.ts` is keyed only on
  `intentHash`. Spectra's `internal/processor/dedup_cache.go`
  additionally tracks composite keys `(symbol, signer, timestamp)`
  (see R1.6.b). Keep the `intentHash` short-circuit as the hot path;
  extend the cache to also store the composite tuple for replay
  protection. The DB `processed_events` table (R1.3.a) already
  records `(tx_hash, log_index)` for the third-leg dedup.

### R1.4.g — Tests

- [ ] **R1.4.g** — Tests for: head tracker cadence, gap detection
  cadence, explicit backfill chunk size, compact-name config
  loading, checkpoint safety when a worker pool is enabled (also
  R1.7.j), scanner error → `chain_state.is_healthy=false`, scanner
  recovery → `is_healthy=true`.

### R1.4.h — Concurrent HTTP + WS transports (Spectra parity)

- [ ] **R1.4.h** — **Discrepancy: the feeder runs HTTP *XOR* WS;
  Spectra runs HTTP *AND* WS simultaneously.** Spectra's
  `EnhancedBlockScanner.Start`
  (`scanner/block_scanner_enhanced.go:197-221`) launches the HTTP
  loops (head tracker, forward scan, backward scan, gap detection)
  **and** `startWebSocketSubscription` (`:1022-1104`) as concurrent
  goroutines feeding one shared event channel. HTTP is the reliable
  baseline; WS is the real-time fast path layered on top. If the WS
  subscription drops, the HTTP loops keep delivering events with no
  interruption.

  The feeder's `cmd/feeder/daemon-cmd.ts:891-903` does
  `switch (transport) { case "http": …; case "ws": … }` — it runs
  **exactly one** of `runHttpTransport` / `runWsTransport`. When
  `transport=ws` and the WS reconnect budget is exhausted
  (`scanner-ws.ts` throws), the scan pipeline dies and the daemon
  exits — there is no HTTP fallback.

  **Fix — run both transports simultaneously, exactly as Spectra does:**

  1. Remove the exclusive `switch (transport)` in
     `cmd/feeder/daemon-cmd.ts:891-903` and the `--transport` flag
     entirely. Spectra has no such flag.
  2. The daemon **always** starts the HTTP scanner (head tracker +
     forward scan + backfill + gap detection) **and** the WS
     subscription concurrently, both delivering into the same
     `handleBatch` sink — identical to Spectra's
     `EnhancedBlockScanner.Start`.
  3. The dedup cache (R1.4.f) absorbs the overlap when the same event
     arrives on both transports — `intentHash` short-circuit drops the
     second copy, exactly as Spectra relies on its own dedup.
  4. WS failure (reconnect budget exhausted) **logs and continues**;
     it must never tear down the HTTP baseline. Emit
     `dia_bridge_scanner_transport_up{transport="ws"}` =0 so the
     operator sees the degraded (HTTP-only) state in Grafana.

  Tests: both scanners deliver the same event → dedup keeps one;
  WS drop → HTTP keeps delivering and `scanner_transport_up{ws}`=0;
  WS recovery → gauge returns to 1.

## R1.5 — Processing pipeline (extractor + enricher + transformer)

Spectra reference: `services/bridge/internal/pipeline/`
(`extractor.go`, `enricher.go`, `transformer.go`).

Local code already has `extractor` and `enricher` modules. The
`transformer` and the supporting `processing.datasource` and
`RouterDestination.condition` semantics are dead/unwired today.

### R1.5.a — Implement `transformer.ts` operations

- [ ] **R1.5.a** — Implement `src/pipeline/transformer.ts` to match
  Spectra operations from `internal/pipeline/transformer.go`:
  `slice`, `concat`, `hash`, `encode`, `to_bigint`, `to_address`,
  `to_hex`, `to_string`. Use `viem` for ABI / hash / address / hex
  handling; no ad-hoc string hacks for ABI encoding. The current
  `createTransformer` stub at lines 32-39 becomes the implementation
  entry point (R1.2.c.1).

### R1.5.b — Honour `processing.datasource`

- [ ] **R1.5.b** — `event` resolves against extracted log fields,
  `enrichment` against the full `OracleIntent`, `processed` against
  transformation output. Destination payload construction for
  Cardano still uses the enriched intent unless a transformation
  explicitly supplies the fields used by the Cardano submit request.

### R1.5.c — Honour non-empty `processing.transformations`

- [ ] **R1.5.c** — Apply transformations after enrichment and before
  routing / destination condition evaluation. If a transformation
  fails, increment `events_invalid_total{reason="transformation"}`
  and write an intent-step log with the transformation name. Write
  `status='filtered'`, `filter_reason='transformation_failed'` to
  `processed_events` (R1.3.a).

### R1.5.d — Implement `RouterDestination.condition`

- [ ] **R1.5.d** — Spectra has `evaluateDestinationCondition` on
  destinations. For M2 support boolean expressions equivalent to
  Spectra's current surface (`""` or truthy passes), plus template
  field equality / inequality against event/enrichment/processed
  values. Add tests for destination-level suppressions distinct
  from router trigger conditions.

### R1.5.e — Config validation for transformations

- [ ] **R1.5.e** — Validate supported `operation`, required `field`,
  required `input`, operation-specific params (`start`/`end`,
  `separator`, ABI `types`, etc.). Validator rejects unknown
  operations instead of silently accepting YAML that runtime will
  ignore.

### R1.5.f — Tests

- [ ] **R1.5.f** — One unit test per transformation operation; one
  integration test that routes based on a transformed `processed`
  field; one test that a destination `condition` filters only that
  destination.

## R1.6 — Routing (gates, replay, signer, customer label)

Spectra reference: `services/bridge/pkg/router/generic_router.go`.

R1.6 fixes router-policy gates and signer plumbing.

### R1.6.a — Router gate `time_threshold || price_deviation` (OR-gate)

- [ ] **R1.6.a** — Spectra evaluates both conditions independently
  and dispatches if either passes
  (`generic_router.go:361-414`). Local `createPolicyGate`
  ([`src/router/policy.ts:122-165`](../../offchain/feeder/src/router/policy.ts#L122-L165))
  short-circuits on `time_threshold`, making it an AND-gate in
  practice. **Change** `createPolicyGate` so a large `price_deviation`
  always passes regardless of time, and `time_threshold` always
  passes regardless of price. Update
  `src/router/__tests__/policy.test.ts`. Update the policy file
  header comment that currently says "Both thresholds are AND-gated".

### R1.6.b — Timestamp / replay monotonicity

- [ ] **R1.6.b** — Spectra rejects an intent when `newTimestamp <=
  state.lastTimestamp` (warn for `<`, debug for `==`); see
  `generic_router.go:514-529`. The local deviation branch compares
  only prices today; replay protection leans on `intentHash` in
  `dedup-cache.ts`, which does not catch two intents with the same
  `(symbol, price)` and equal-or-decreasing timestamp from different
  upstream signers. Implement the timestamp check in
  `src/router/policy.ts` reading `contract_symbol_updates.last_timestamp`
  (R1.3.d) for the baseline.

### R1.6.c — Per-router signer env

- [ ] **R1.6.c** — Wire `routers[*].signer.private_key_env`
  (R1.1.a.6) at the router-runtime layer so a router with a
  configured env reads the wallet seed from that env instead of the
  global one. Precedence: router-level > global. Validation: env
  must exist when configured. Tests covering both single-router
  and per-router signer modes.

### R1.6.d — Customer metrics label

- [ ] **R1.6.d** — `routers.customer` (R1.1.a.2) is emitted as
  `customer` label on `dia_bridge_transactions_*_total`,
  `dia_bridge_intents_routed_total`, and
  `dia_bridge_cron_resubmissions_total`. Cross-ref [R3.1](#r31--lifecycle-metric-aliases).

## R1.7 — Worker pools (event + update + parallel mode)

Spectra has two related concurrency layers:

- `internal/processor/event_worker_pool.go`: event workers consume a
  bounded queue, process events in parallel, enforce per-event
  timeout, count received / processed / failed / dropped, publish
  active / queue metrics.
- `internal/worker/worker_pool.go`: update-request workers consume a
  bounded queue and expose worker-pool health. In the EVM bridge
  this lets independent destinations write in parallel.

For Cardano, implement the same operator surface while respecting the
UTxO constraint: parallelize source-event processing, enrichment,
routing, and update-task handling, but keep final Cardano submission
serialized per lane through the existing coalescer + queue manager.

### R1.7.a — Event worker pool

- [ ] **R1.7.a** — Add `src/processor/event-worker-pool.ts`. API:
  `createEventWorkerPool({ workerCount, queueSize, processingTimeoutMs,
  onEvent, onStats, metrics, log })` exposing `start()`, `stop()`,
  `submit(event)`, `stats()`, counters for received, processed,
  failed, dropped, active workers, queue length, average processing
  time.

### R1.7.b — Update worker pool (per-router)

- [ ] **R1.7.b** — Add `src/worker/update-worker-pool.ts` mirroring
  Spectra's per-router `internal/worker/worker_pool.go` plus
  `Bridge.getOrCreateOraclePool(routerID)`. API:
  `getOrCreatePool(routerId)`, `submit(task)`, `start()`, `stop()`,
  `stats()`, `listPendingTasks(routerId)`. One bounded worker pool
  per router/client lane group so independent clients progress in
  parallel and a saturated router cannot starve every other router.

### R1.7.c — Wire `event_processor.enable_parallel_mode`

- [ ] **R1.7.c** — In `cmd/feeder/daemon-cmd.ts`, the scanner
  `onBatch` path: when disabled, keep the current sequential
  behaviour; when enabled, submit each extracted event to the
  worker pool. Back-pressure policy: bounded queue only. If full,
  drop the task, increment `dia_bridge_worker_tasks_dropped_total`,
  log the event hash / block, and **do not advance
  `chain_state.last_scan_block`** until the batch has been accepted
  or explicitly dropped with a recorded metric.

### R1.7.d — Refactor per-event pipeline into reusable handlers

- [ ] **R1.7.d** — Move the existing per-event pipeline into reusable
  handler functions:
  1. event handler: extract / enrich / route / build update task;
  2. update-task handler: create submit requests / accept into
     coalescer.

  The event worker pool calls the event handler. The update worker
  pool calls the update-task handler. Neither handler may mutate
  shared runtime maps without a small helper that records
  `intentRuntime` before submit and cleans it on result.

### R1.7.e — Cardano lane safety

- [ ] **R1.7.e** — Workers may run in parallel before submission,
  but every submit request still goes through `createCoalescerManager`
  and `createQueueManager`; no worker may call the Cardano write
  client directly. `QueueManager` continues creating one serial
  queue per `(client_state_path, protocol_state_path)` lane via
  the shared `laneKey` (R1.2.d.1), so different clients/receivers
  submit in parallel while the same receiver lane stays serial.

### R1.7.f — Config wiring

- [ ] **R1.7.f** — Wire full config and validation:
  `event_processor.{batch_size, validation_timeout,
  enable_parallel_mode, parallel_worker_count, parallel_queue_size,
  parallel_timeout}` and `worker_pool.{max_workers, task_queue_size,
  task_timeout, retry_delay, max_retries, inflight_timeout_ms}`.
  Snake_case YAML stays; loader normalisation for Spectra compact
  names per R1.1.b. Add `health_check.{timeout, max_queue_size}`
  at the same time; Spectra declares both and worker-pool readiness
  needs `max_queue_size`. `retry_delay` and `max_retries` belong to
  update-worker task retries; `inflight_timeout_ms` remains
  Cardano-specific and belongs to lane locking after a submission
  succeeds.

### R1.7.g — Metrics

- [ ] **R1.7.g** — Add Prometheus metrics and dashboard panels:
  `dia_bridge_active_workers`, `dia_bridge_worker_pool_size`,
  `dia_bridge_worker_queue_size`,
  `dia_bridge_worker_tasks_completed_total`,
  `dia_bridge_worker_tasks_failed_total`,
  `dia_bridge_worker_tasks_dropped_total`,
  `dia_bridge_worker_task_retries_total`, plus an optional
  processing duration histogram if it can be kept low-cardinality
  (`event_name` / `router_id`, not per-task ids). Cross-ref R3.3.

### R1.7.h — `/api/v1/pools` and `/api/v1/pools/:router_id/tasks`

- [ ] **R1.7.h** — Add worker-pool API parity matching Spectra's
  route surface (`internal/api/server.go:196-198`) and pool shape
  (`PoolInfo`, `PoolTaskInfo` at `server.go:156-179`). Response
  shows router id, active workers, max workers, pending count,
  queue capacity, pending task summaries from the update-worker
  pool. Event-worker stats go in `/api/v1/status` rather than
  pretending they are router-specific pools.

### R1.7.i — Health/readiness integration

- [ ] **R1.7.i** — Spectra's health loop reports aggregate
  worker-pool active/pending counts (`internal/bridge/health.go:45-93`)
  and config has `health_check.maxqueuesize`. Local `/health/ready`
  fails when worker queue depth exceeds configured
  `health_check.max_queue_size` or when the worker pool is stopped
  while `event_processor.enable_parallel_mode=true`.

### R1.7.j — Checkpoint safety with workers

- [ ] **R1.7.j** — In sequential mode the current scanner advances
  `chain_state.last_scan_block` after a batch handler returns. In
  parallel mode, do not advance past a block until every event from
  that block is accepted into either the event worker queue or the
  explicit dropped-event accounting path. Regression test that a
  full worker queue does not silently skip an unaccounted block.

### R1.7.k — Tests

- [ ] **R1.7.k** — Unit tests for queue-full drop accounting,
  processing timeout, graceful stop, stats, disabled sequential
  mode; integration test with fake scanner batch of >=
  `parallel_queue_size + 1` events; metric snapshot test for the
  new worker series; concurrency tests for all three lane cases:
  event workers run concurrently, update workers run concurrently,
  same Cardano lane serializes while different lanes overlap.

## R1.8 — Cron service

Spectra reference: `services/bridge/internal/cron/cron_service.go`
(`runOneTick`, `getOnChainValue`, `buildMonitorList`).

The cron service guarantees a maximum staleness per pair when the
router gate filters every incoming intent (because price barely
moved). Spectra reads on-chain timestamp on every tick and decides
whether the pair is still fresh enough; the local implementation
compares against the in-memory `priceCache` only, so a restart leaves
the service blind.

### R1.8.a — Reachability fix (extract symbols + iterate over `in` lists)

- [ ] **R1.8.a** — `src/cron/cron-service.ts:107` short-circuits when
  `dest.cron !== true`, and no destination in
  `config/routers/client-a.preview.yaml` sets `cron: true`.
  Additionally `extractDestinationSymbol` (lines 194-208) only matches
  the literal `"event.symbol"` field and a single-element `in` list,
  while the production router uses `${enrichment.fullIntent.Symbol}`
  with a 10-element `in` list. **Two-part fix:**

  1. Extract the symbol-extraction logic from `src/api/symbols.ts`
     `extractConfiguredSymbols` (lines 53-79) — which already handles
     `${enrichment.fullIntent.Symbol}` and multi-element `in` lists —
     into `src/router/symbols.ts` and import from both callsites.
  2. Iterate over each configured symbol in the `in` list, emitting
     one cron tick per `(routerId, dest, symbol)`. The existing
     `priceCache` key is already `(routerId, dest, symbol)` so this
     aligns.

  Without this fix, `dia_bridge_cron_resubmissions_total` records
  `skipped_no_cron` every tick and the operator sees no liveness
  signal even when intents have stopped. The bug is masked by the
  Preview attestor emitting intents continuously; it would be the
  first visible failure if the source went silent.

### R1.8.b — On-chain pair-state timestamp read on tick

- [ ] **R1.8.b** — `runOneTick` must read the on-chain pair-state
  datum timestamp via the existing reconcile path
  (`src/lib-bridge/reconcile.ts`) and seed/refresh the cache from
  chain state before deciding. Mirrors Spectra
  `cron_service.go:262-303` and `getOnChainValue` lines 408-453.
  After R1.3.d/g lands, the `priceCache` is DB-seeded on boot, so
  this on-chain read is the second guard against false-positive
  resubmissions.

### R1.8.c — Submit error handling

- [ ] **R1.8.c** — `src/cron/cron-service.ts:176` uses `void
  options.submit(request)`. A rejection escapes the `runOneTick`
  try/catch. Replace with
  `options.submit(request).catch(err => options.log({...}))`.
  Security cross-ref: [R5.9](#r59--cron-submit-fire-and-forget).

### R1.8.d — Cron resubmission metric

- [ ] **R1.8.d** — Keep `dia_bridge_cron_resubmissions_total{router_id,
  symbol, client_id, outcome}` (Spectra emits no cron metric — local
  extension). Document the divergence in the metric's description
  comment. Add a `customer` label per R1.6.d.

### R1.8.e — Per-destination cron schedules (Deferred-to-M3 entry)

- [ ] **R1.8.e** — Spectra supports per-destination cron schedules
  driven by `time_threshold`. M2 keeps a single global
  `tick_interval`. Recorded in the
  [In feeder, but M3](#in-feeder-but-m3-not-m2) table; no code change
  in M2.

## R1.9 — Transaction submission

Spectra reference: `services/bridge/internal/transaction/`
(`queue.go`, `queue_manager.go`, `executor.go`, `client.go`).

The local `src/submitter/` already implements coalescer + queue
manager + retry policy + Cardano write client. R1.9 closes residual
gaps and aligns the submitter with the DB-as-source-of-truth model
introduced in R1.3.

### R1.9.a — Lane-key consolidation

- [ ] **R1.9.a** — Extract `laneKey(dest)` into
  `src/submitter/lane-key.ts`; import from both `queue-manager.ts:121-122`
  and `coalescer.ts:139-141`. Cross-ref R1.2.d.1. Also unblocks the
  deferred `lane-state.ts` split.

### R1.9.b — Persist transaction lifecycle in DB

- [ ] **R1.9.b** — Daemon emits `pending → submitted → confirmed |
  failed` writes per R1.3.c. The submitter itself does not write to
  DB directly; it surfaces the outcome and let `daemon-cmd.ts`
  persist. This keeps the submitter unit-testable without a DB stub
  beyond the existing `Db` interface.

### R1.9.c — Populate `feePaidLovelace`

- [ ] **R1.9.c** — `src/submitter/cardano-write-client.ts` populates
  `SubmitResultOk.feePaidLovelace` from the Lucid built tx body fee
  on every successful submit. `src/submitter/types.ts` declares the
  field optional on `SubmitResultOk`. Daemon writes it to
  `transaction_log.fee_paid_lovelace` on confirm (R1.3.c).

### R1.9.d — Resume after crash

- [ ] **R1.9.d** — On daemon start, scan `transaction_log` for rows
  with `status IN ('pending', 'submitted')`. For each:
  - `pending`: re-enqueue the submit request. Reconstruction strategy
    (decided — no `payload_json` field needed): call
    `getIntent(intentHash)` on the `OracleIntentRegistry` via the
    existing enricher, exactly as the normal pipeline does. The intent
    is always available on-chain. Reconstruct `destination` from
    config using `router_id` + `destination_index` (both stored in
    `transaction_log`). This produces a valid `SubmitRequest` without
    any extra DB columns.
  - `submitted`: poll the Cardano chain for confirmation depth; if
    seen, write `confirmed`; if not seen after a configurable
    timeout, write `failed` with `error_code='TxDroppedFromChain'`.

### R1.9.e — Lane-state non-atomic transition document

- [ ] **R1.9.e** — `src/submitter/coalescer.ts:115, 359`: the `state
  === "idle"` check + `setTimeout` is non-atomic across concurrent
  `accept` microtasks. Node's single-threaded event loop makes this
  safe in practice. **Decision:** document the invariant in the file
  header comment; do not add a mutex. (Pure JS cannot interleave
  between `===` and `setTimeout`.)

### R1.9.f — Tests

- [ ] **R1.9.f** — Tests for the resume-after-crash path: stub DB
  has a `pending` row → daemon re-enqueues; stub DB has a `submitted`
  row → daemon polls and resolves correctly; lane key changes are
  reflected in both queue manager and coalescer (single shared
  helper).

## R1.10 — Operator surface (CLI commands + Makefile + cleanup)

Spectra reference: `services/bridge/cmd/bridge/main.go` boot
sequence + operator CLI helpers.

The feeder operator surface (Docker, Makefile, CLI sub-commands) must
follow from the new state model: no JSON checkpoint to clean, DB-backed
state, init flow exercises the same `Db.initialiseChainState` path the
daemon uses.

### R1.10.a — Docker compose CLI mount writable

- [ ] **R1.10.a** — `feeder/docker-compose.yml` cli service: change
  `./config:/config:ro` to `./config:/app/config` (read-write,
  different mount point) so `feeder init client` can write
  `config/routers/*.yaml` from inside the container. The feeder
  daemon service keeps `./config:/config:ro`.

### R1.10.b — Makefile rewrite

- [ ] **R1.10.b** — `offchain/Makefile` rewrite. Remove the broken
  `feeder-init` target (line 44-49 today combines two unrelated
  steps). Remove the NOTE comment block (lines 57-71). Add granular
  targets:
  - `wallet` — `make cli CMD="wallet:create"` → prints seed.
  - `protocol-init` — runs `protocol:init`, `config:parameterize`,
    `config:reference-scripts`, `config:bootstrap` in sequence.
  - `client-init` — runs `client:init`, `receiver:bootstrap`,
    `receiver:parameterize`, `reference-scripts:publish-client`.
  - `router-init` — runs `feeder init client` interactively (tty,
    writes to `/app/config/routers/`).
  - Keep `build`, `up`, `up-postgres`, `up-monitoring`, `down`,
    `logs`, `cli` (generic escape hatch).

  Each new target gets a `## ` comment so `make help` lists it.

### R1.10.c — Operator flow README rewrite

- [ ] **R1.10.c** — `offchain/feeder/README.md`: rewrite the
  operator-flow section to document the new `wallet → protocol-init
  → client-init → router-init → up` sequence (Pre-requisites → Step
  1 → … → Step 5). Drop the current `make bootstrap` references
  (target does not exist).

### R1.10.d — Cleanup command (DB-driven)

- [ ] **R1.10.d** — `cmd/feeder/cleanup-cmd.ts` rewrites the cleanup
  logic to operate on DB row pruning instead of JSON file deletion.
  After R1.3.g lands, there is no `feeder-checkpoint.json` to
  delete; the only "cleanup" actions are:
  1. Prune `processed_events` rows older than `--max-age`.
  2. Prune `transaction_log` rows where `status IN ('confirmed',
     'failed')` AND `created_at_ms < cutoff`. Never prune
     `pending` or `submitted` rows (in-flight data).
  3. Prune `alert_log` rows with `resolved_at_ms IS NOT NULL` older
     than cutoff.
  4. Prune `performance_metrics` rows older than cutoff.
  5. Rotate log files older than `--max-age` (kept; logs are an
     audit trail in addition to DB).

  The CLI surface stays compatible: `feeder cleanup --max-age 7d
  [--dry-run]`. README cleanup section in
  `offchain/feeder/README.md` is updated accordingly.

### R1.10.e — Checkpoint command (DB-driven)

- [ ] **R1.10.e** — `cmd/feeder/checkpoint-cmd.ts` is rewritten to
  read/write `chain_state.last_scan_block` via `createDbCheckpoint`
  from `src/source/checkpoint-db.ts` (R1.3.g). CLI surface unchanged:
  `feeder checkpoint --get`, `feeder checkpoint --set <block>`,
  `feeder checkpoint --clear`. `--clear` writes
  `last_scan_block = 0` rather than deleting a file.

### R1.10.f — Scan command (DB-driven)

- [ ] **R1.10.f** — `cmd/feeder/scan-cmd.ts` uses the same
  `createDbCheckpoint` helper for one-shot scans.

### R1.10.g — `feeder init bootstrap` is Docker no-op

- [ ] **R1.10.g** — `feeder init bootstrap` remains a no-op in
  Docker (CLI and feeder share `/app/state`). Keep the command for
  the host workflow but do not expose a Makefile target; document
  it as Docker-no-op in the README.

### R1.10.h — Operator surface tests

- [ ] **R1.10.h** — `cmd/feeder/__tests__/clean-state.test.ts` is
  rewritten to assert DB row pruning, not JSON file deletion.
  Cross-ref R1.3.g.

## R1.11 — Comment / docstring hygiene

User rule: code talks about code; only `TODO:` / `NOTE:` comments may
mention milestones, and even then only when future-reader context
demands it.

### R1.11.a — Spectra-equivalent comments

- [ ] **R1.11.a** — Pervasive "Spectra equivalent" / "Spectra parity"
  comments across `src/cron/cron-service.ts:1`,
  `src/router/router.ts:3-18`, `src/submitter/*.ts`,
  `src/pipeline/transformer.ts:4-12`, `src/api/metrics.ts:3`,
  `src/router/policy.ts:1-30`, `src/router/registry.ts:4`. Keep
  short Spectra references only when they document a live
  compatibility contract (for example, metric naming or config input
  shapes). Rewrite the rest as behavioural comments. If a comment
  documents a behavioural divergence (e.g. AND vs OR gate before
  R1.6.a lands), keep it until the fix lands, then update it to the
  final behaviour.

### R1.11.b — Top-of-file docstrings

- [ ] **R1.11.b.1** — `offchain/feeder/cmd/feeder/args.ts` header
  (lines 1-22) adds `--from-block` and `--from-latest` flags (parsed
  at 96-104 but missing from header).
- [ ] **R1.11.b.2** — `offchain/feeder/cmd/feeder/main.ts` header
  lines 4-17 rephrased so `--scan` and `--dry-run` are documented as
  independent modifiers, not coupled.
- [ ] **R1.11.b.3** — `src/router/policy.ts:1-30` updated after R1.6.a
  lands ("Both thresholds are AND-gated" becomes false). Describe
  the OR-gate behaviour in the same place.

---

# Phase R2 — API parity

Spectra reference: `services/bridge/internal/api/server.go`.

Spectra exposes a broader operator API than the current feeder.
Because M2 evidence depends on QA review logs, dashboards, liveness,
and transaction traces, the read-only operator API must be aligned in
M2 except for failover/HA endpoints (deferred).

Every endpoint below names the backing DB table (R1.3) or in-memory
source so future readers see the data flow at a glance.

## R2.1 — `/api/v1/status` and `/api/v1/status/components`

- [ ] **R2.1** — Add `GET /api/v1/status` and `GET /api/v1/status/components`.
  Include process uptime, config network, scanner state (from
  `chain_state`), DB driver, worker-pool state (from R1.7),
  cron state, Cardano destination state. Mirrors Spectra
  `server.go:171-173` without exposing multi-destination routing.
  Backing: `chain_state` + runtime in-memory.

## R2.2 — `/api/v1/events*`

- [ ] **R2.2** — Add `GET /api/v1/events`, `GET /api/v1/events/names`,
  `GET /api/v1/events/:hash`. Backed by `processed_events` (R1.3.a)
  and intent log data. Makes `events.jsonl` parity less urgent, but
  the response shape must be stable enough for evidence generation.

## R2.3 — `/api/v1/transactions` list endpoint

- [ ] **R2.3** — Add `GET /api/v1/transactions` list endpoint in
  addition to the existing `GET /api/v1/transactions/:txHash`.
  Support `limit`, `status`, `symbol`, `router_id`, `chain` filters
  with caps from YAML (`api.default_history_limit`,
  `api.max_history_limit`). Backed by `transaction_log` (R1.3.c)
  — every filter is a column on the row, no JOIN needed thanks to
  the denormalised `symbol`, `destination_chain_name`,
  `destination_contract_address` columns.

## R2.4 — `/api/v1/pools` and `/api/v1/pools/:router_id/tasks`

- [ ] **R2.4** — Implement per R1.7.h. Backed by the live worker-pool
  state from `src/worker/update-worker-pool.ts`. Mirrors Spectra
  `server.go:196-198` and `PoolInfo`/`PoolTaskInfo` at lines 156-179.

## R2.5 — `/api/v1/alerts*`

- [ ] **R2.5** — Add `GET /api/v1/alerts` (list, with `active=true|false`
  filter), `GET /api/v1/alerts/:id`, `POST /api/v1/alerts/:id/ack`.
  Backed by `alert_log` (R1.3.f). Cross-ref R4.

## R2.6 — `/api/v1/performance`

- [ ] **R2.6** — Add `GET /api/v1/performance` exposing the contents
  of `performance_metrics` (R1.3.e). Query parameters: `metric_name`,
  `since`, `until`, `limit`. Backed by `performance_metrics`.

## R2.7 — `/api/v1/prices` and `/api/v1/symbols`

- [ ] **R2.7** — Existing endpoints. Read from in-memory `priceCache`
  (DB-seeded per R1.3.d on boot). No surface change; data path now
  durable.

## R2.8 — `/api/v1/chains`

- [ ] **R2.8** — Existing endpoint; rewire to read from
  `chain_state` (R1.3.b) via `db.listChainStates()`.

## R2.9 — `/debug` endpoint gating

- [ ] **R2.9** — Keep `/debug` out of the default public surface.
  Spectra exposes it (`server.go:159-166`) but in the feeder it must
  be gated by `api.debug_enabled=false` by default. If enabled, it
  must not leak secrets, wallet paths, env vars, or raw provider
  URLs. Recorded with a Deferred-to-M3 entry for the full Spectra
  shape; M2 ships the gating only.

## R2.10 — `/api/v1/symbols/:symbol/updates` simplification

- [ ] **R2.10** — Existing endpoint runs `transaction_log` JOIN
  `processed_events`. After R1.3.c lands and `transaction_log`
  carries `symbol` directly, this JOIN goes away. Performance and
  DoS surface (R5.4) improve correspondingly.

## R2.11 — API parity tests

- [ ] **R2.11** — One contract test per endpoint asserting the
  response shape; integration test that exercises the full pipeline
  and asserts the DB and API agree on the same row counts.

---

# Phase R3 — Metrics parity

Spectra reference: `services/bridge/internal/metrics/metrics.go`.

Spectra exposes several metric families under different historical
prefixes (`bridge_*`, `dia_bridge_*`, `oracle_bridge_*`,
`transaction_*`, `hyperlane_*`). The local implementation uses the
configured namespace prefix (`dia_bridge` by default), which is clean
locally but drifts from the reference. R3 adds aliases plus
Cardano-specific extensions; nothing is renamed.

## R3.1 — Lifecycle metric aliases

- [ ] **R3.1** — Add Spectra-compatible aliases for lifecycle metrics
  instead of renaming the existing Cardano dashboard series. Required
  aliases:
  - `bridge_intents_scanned_total`
  - `bridge_intents_processed_total`
  - `bridge_intents_submitted_total`
  - `bridge_intents_confirmed_total`
  - `bridge_intents_failed_total`
  - `bridge_processing_to_submission_latency_seconds`
  - `bridge_submission_to_confirmation_latency_seconds`
  - `bridge_end_to_end_latency_seconds`
  - `bridge_price_deviation_percent`
  - `bridge_price_age_seconds`

  Add the `customer` label (R1.6.d) to every router-scoped family
  in this list.

## R3.2 — HTTP / DB / health metric aliases

- [ ] **R3.2** — Add Spectra HTTP / DB / health metric aliases that
  are useful for M2 operations:
  - `bridge_http_response_size_bytes`
  - `bridge_db_operations_total`
  - `bridge_db_operation_duration_seconds`
  - `bridge_db_connection_status`
  - `bridge_component_health`
  - `bridge_recovery_attempts_total`

  If a metric is not emitted because the subsystem is absent, this
  plan must state which R-task introduces it.

## R3.3 — Worker metric aliases

- [ ] **R3.3** — Add worker metric aliases together with R1.7:
  - `dia_bridge_active_workers`
  - `bridge_worker_pool_size`
  - `bridge_active_workers`
  - `bridge_task_queue_size`
  - `bridge_worker_tasks_completed_total`
  - `bridge_worker_tasks_failed_total`
  - `bridge_worker_tasks_dropped_total`
  - `bridge_worker_task_retries_total`

## R3.4 — Per-phase latency split (M2)

- [ ] **R3.4** — Spectra emits 6 lifecycle phases
  (`bridge_intent_to_registration`, `registration_to_scan`,
  `scan_to_processing`, `processing_to_submission`,
  `submission_to_confirmation`, `end_to_end`); we emit 4. This is
  neither EVM-only nor multi-chain-only, so it **ships in M2**.

  **Dependency (decided):** `ExtractedEvent` currently has
  `blockNumber` but NOT `blockTimestamp`. Phases 1 and 2 require the
  block timestamp of the `IntentRegistered` transaction. R1.5 adds
  `blockTimestamp: bigint` to `ExtractedEvent` and the scanner
  populates it via `eth_getBlockByNumber` (or from the block header
  returned in the log batch). R3.4 only emits the metrics; it does
  not introduce new scanner fields — that work is in R1.5. R3.4 must
  not land before R1.5.

  Once `blockTimestamp` is available, thread all 6 timestamps through
  the enrichment payload and emit via the intent-metrics surface
  (`intent_metrics.go:19` parity). Stage timestamps and per-stage
  counters (`intent_metrics.go:40`) ship alongside.

## R3.5 — Cardano-specific extensions (kept)

- [ ] **R3.5** — Keep `cardanoReceiverBalanceLovelace`,
  `cardanoReceiverTopupWarnings`, `transactionsReorg`, reorg-drop
  accounting. They are Cardano extensions, not replacements for EVM
  semantics. Document each in the metric description string.

## R3.6 — EVM-only metric units excluded; fees kept in lovelace

- [ ] **R3.6** — The **only** metrics excluded here are EVM-execution
  *units*, not functionality:
  - **Excluded (EVM unit):** `transaction_gas_used`
    (`metrics.go:117`), `gas_used_total` / `gas_price_gwei` per symbol
    (`intent_metrics.go:197`), and the Hyperlane
    `total_delivery_time` (`metrics.go:144`). These name `wei`,
    `gwei`, or `gas_*` in the EVM-execution sense and have no Cardano
    meaning.
  - **Kept and essential in M2 — fee tracking:** the
    `transaction_fees` histogram (`metrics.go:122`) and
    `transaction_cost` column (`schema.go:60`) are **retained**,
    re-denominated in **lovelace**. Per-tx `fee_paid_lovelace`
    (R1.9.c) plus aggregates in
    `contract_symbol_updates.total_fee_paid_lovelace` and
    `performance_metrics`. Fee accounting is a Catalyst operator
    requirement, not an EVM artifact.
  - **Failover metrics** (`metrics.go:85`) are HA/replica → **M3**,
    not excluded (see inventory).

  The renamed lovelace metric keeps a Spectra-shaped name
  (`bridge_transaction_fee_lovelace`) so dashboards map 1:1.

## R3.7 — Persistent metrics flag

- [ ] **R3.7** — Add the `markPersistent` wrapper per R1.3.e so the
  counters flagged in R1.3.e write to `performance_metrics` on every
  `.inc()`. Persistent counters survive a restart and back the
  evidence pack stats.

## R3.8 — Metric snapshot test

- [ ] **R3.8** — Add a metrics snapshot test that compares the
  `/metrics` exposition against a checked-in list of required
  Spectra aliases plus Cardano-specific extensions. The test fails
  when a metric disappears silently.

---

# Phase R4 — Health, alerts, observability

Spectra reference: `services/bridge/internal/bridge/health.go` +
Prometheus rule definitions in `services/bridge/config/alerts/`.

Spectra runs an in-process health/alert loop that writes to a durable
`alert_log` and exposes `/api/v1/alerts*`. M2 implements the same
loop locally, backed by the table from R1.3.f.

## R4.1 — Health loop

- [ ] **R4.1** — `src/api/health.ts` already exposes
  `/health/live` and `/health/ready`. Extend the ready check to:
  - Worker queue depth ≤ `health_check.max_queue_size` (R1.7.i).
  - Every `chain_state` row has `is_healthy = true` (R1.3.b).
  - Last `chain_state.last_scan_block` advanced within
    `health_check.scanner_max_lag` blocks of head.
  - Last successful Cardano confirm within
    `api.readiness.max_last_confirmed_age`.

  Each failed sub-check returns a structured `503` body naming the
  failing component so dashboards can categorise.

## R4.2 — Alert evaluator

- [ ] **R4.2** — Add `src/alerting/evaluator.ts`. Periodic loop
  (default 30s; configurable via `alerting.evaluation_interval`)
  evaluating a small set of Prometheus-style rules against live
  metrics + DB state:
  - `OraclePairStale{symbol}` — `priceCache[*].updatedAtMs <
    now() - threshold`.
  - `PriceDeviationHigh{symbol}` — latest deviation > configured
    threshold.
  - `ScannerLag{chain}` — `chain_state.last_scan_block` lagging
    head by > N blocks.
  - `WorkerQueueSaturated{pool}` — worker queue depth at capacity
    for > N consecutive ticks.
  - `TransactionFailureRateHigh{router}` — failed/total ratio over
    window > threshold.

  **`priceCache` access pattern (decided):** Mirrors Spectra's
  `bridge.go:299` — `eventProcessor.GetPriceCache()` is called at
  startup and the reference is injected via constructor. In TypeScript:
  `daemon-cmd.ts` already holds the `priceCache` instance (it creates
  it at boot). Pass it directly:

  ```ts
  const evaluator = createAlertEvaluator({ db, priceCache, workerPools, metrics, log });
  ```

  No singleton, no module-level import. Same dependency-injection
  pattern used by every other module in `daemon-cmd.ts`.

  Rule transitions `inactive → firing` write a row to `alert_log`
  via `db.recordAlert(...)`. Rule transitions back to `inactive`
  call `db.resolveAlert(id, now())`.

## R4.3 — Alerts API (cross-ref R2.5)

- [ ] **R4.3** — `src/api/alerts.ts` exposes the endpoints listed in
  R2.5. Backed by `alert_log`.

## R4.4 — Alertmanager / Prometheus rule files (kept)

- [ ] **R4.4** — Existing Prometheus rule files
  (`offchain/feeder/config/prometheus/*.yml`) stay. The in-process
  evaluator (R4.2) shadows them; operators can choose either or
  both. Document the two paths (in-process vs Prometheus+Alertmanager)
  in the README.

## R4.5 — Synthetic alert firing for evidence

- [ ] **R4.5** — During the next evidence window, stop the scanner
  (or block one symbol's enrichment) so `OraclePairStale` fires, and
  push a deviating price (via a CLI-built intent if needed) so
  `PriceDeviationHigh` fires. Capture both rows from `alert_log`
  via `/api/v1/alerts?active=false` and link from the evidence MD.
  Cross-ref R7.4.

---

# Phase R5 — Security hardening

New findings outside `docs/security/m1-security-notes.md`. The
addendum at the end of this plan lists which of these should be
merged back into the security notes file.

## R5.1 — Host-header trust

- [x] **R5.1** — Remove Host-header trust in the API.
  `src/api/server.ts:54` builds a `URL` from `req.url` with a base
  derived from `req.headers.host` (falling back to `127.0.0.1`):

  ```ts
  const base = `http://${req.headers.host ?? "127.0.0.1"}`;
  const url = new URL(req.url, base);
  ```

  The URL is currently used only for `pathname` / `searchParams`, so
  there is no live exploit, but the moment any handler emits an
  absolute URL (redirect, `Location`, error body) Host injection
  becomes live. **Fix:** hardcode the base to `http://localhost` and
  never read `req.headers.host`. Cross-ref R1.2.c.3.

## R5.2 — Path-parameter length cap

- [x] **R5.2** — Cap path-parameter length on `/api/v1/symbols/:symbol`,
  `/api/v1/symbols/:symbol/updates`, `/api/v1/transactions/:txHash`
  (`src/api/server.ts:193, 202, 211`). DB queries are parameterised
  (safe from SQL injection) but a 50 KB path occupies parser stack
  and lands in logs. Cap to 64 chars for symbols, 64 hex for tx
  hash; return `400` past the cap.

## R5.3 — Log injection

- [x] **R5.3** — Sanitize log strings against newline injection.
  `cmd/feeder/daemon-cmd.ts:561, 713, 1235, 1247` interpolate
  `result.error.message` / `params.intentHash` into log lines via
  template strings. An attacker who can craft a registry event (the
  DIA signer trust model still applies; this is depth) could inject
  fake log lines. **Add** a sanitizer and route every interpolated
  value through it:

  ```ts
  const sanitize = (line: string) =>
    line.replace(/[\r\n\t]+/g, " ").slice(0, 8 * 1024);
  ```

  Also apply to `transaction_log.error_message` before persisting
  (db.ts insert/update paths) to keep CSV exports clean.

## R5.4 — API rate limit and bind 127.0.0.1 by default

- [x] **R5.4** — `/api/v1/symbols/:symbol/updates` accepts `?limit=`
  capped at 500 but has no per-client rate limit. Each call runs a
  `transaction_log` query over potentially the full DB (the JOIN
  goes away with R2.10).
  **Two-part fix:**
  1. Default `api.listen.host` to `127.0.0.1` in
     `infrastructure.preview.yaml` and `.mainnet.yaml`. Operators
     who need remote access set `0.0.0.0` deliberately; the Docker
     compose port-publish is unchanged so the container is still
     reachable from the host.
  2. Add a token-bucket rate limiter keyed on remote address
     (existing dep `lru-cache` is fine; 60 req/min default;
     configurable under `api.rate_limit`). Refuse with `429` past
     the budget.

## R5.5 — WebSocket reconnect storm resistance

- [x] **R5.5** — Cross-ref R1.4.e. Exponential backoff with ±20%
  jitter, capped at 5 minutes; reset budget on successful receive.
  Implementation in `src/source/scanner-ws.ts`.

## R5.6 — SQLite `synchronous = FULL`

- [x] **R5.6** — `src/persistence/db.ts:132` sets `journal_mode =
  WAL` but leaves `synchronous` at the better-sqlite3 default
  (`NORMAL`). After a hard crash the in-flight `(intentHash →
  cardanoTxHash)` mapping can be lost; the on-chain monotonicity
  check protects the price but the feeder log diverges. **Add**
  `db.pragma("synchronous = FULL")` after the WAL pragma.

## R5.7 — `db.path` traversal validation

- [x] **R5.7** — `src/persistence/db.ts:476-485` accepts whatever the
  env var carries; `DATABASE_PATH_TESTNET=../../etc/foo` resolves
  outside `state/`. Operator-controlled, low risk, but the fix is a
  one-line `path.resolve()` + `startsWith("<repo>/state/")` check.

## R5.8 — Migrate teardown on failure

- [x] **R5.8** — `src/persistence/db.ts:474-485` opens the SQLite
  file synchronously but does not close it if `migrate()` throws.
  Wrap in `try { … } catch (e) { await db.close(); throw e; }`.

## R5.9 — Cron submit fire-and-forget

- [x] **R5.9** — Cross-ref R1.8.c. Replace `void options.submit(request)`
  with `options.submit(request).catch(err => options.log({...}))`.

## R5.10 — Lane state non-atomic transitions

- [x] **R5.10** — Cross-ref R1.9.e. Document the JS single-thread
  invariant in the coalescer header comment; no mutex needed.

---

# Phase R6 — Documentation alignment

## R6.1 — Feeder README fixes

- [x] **R6.1.a** — `offchain/feeder/README.md:121-125` — drop the
  `make bootstrap` section (target does not exist; R1.10.b adds
  `protocol-init` + `client-init` instead).
- [x] **R6.1.b** — Add `FEEDER_LOG_DIR=` entry to
  `offchain/feeder/.env.example` with a default comment. The var is
  read in `cmd/feeder/daemon-cmd.ts:363` and documented in the
  README at line 314, but missing from `.env.example`.
- [x] **R6.1.c** — Add `prometheus-data` row to the Volume-layout
  table near line 142-149.
- [x] **R6.1.d** — Update README Table at lines 495-500 per R1.2.a.3.
- [x] **R6.1.e** — Document `make feeder-init` removal (covered by
  R1.10.b) and the replacement granular targets in the runbook.

## R6.2 — CLI README fixes

- [x] **R6.2.a** — `offchain/cli/README.md:309-310` uses a hardcoded
  dated path `./state/preview_run_20260516-090057/...`. Replace
  with `./state/<network>/...` (generic, matches the rest of the
  runbook).
- [x] **R6.2.b** — CLI README folder tree: either add
  `scripts/emulator-benchmark.ts` or drop the third-party-script row
  entirely.

## R6.3 — Feeder scripts README

- [x] **R6.3** — `offchain/feeder/scripts/README.md` section
  `scan-dia-intents.ts` (lines 136-143): name the package.json
  script explicitly (`npm run scan:pairs -- [--blocks N] [--top N]
  [--chunk N]`).

## R6.4 — Architecture doc update

- [x] **R6.4** — `docs/architecture/cardano-oracle-architecture.md`
  is updated to document:
  - DB-as-source-of-truth model (R1.3) replacing JSON checkpoint.
  - Worker-pool layering (event + update + Cardano lane safety).
  - Alert evaluator + `alert_log` data flow.
  - Cron service on-chain timestamp read.
  - API endpoint → table map (R2 table).

## R6.5 — Spectra parity register surfaced

- [x] **R6.5** — The [Spectra Parity Disposition Register](#spectra-parity-disposition-register)
  in this plan is the authoritative map. The architecture doc points
  at it; future agents must update both together.

---

# Phase R7 — Evidence pack rebuild

Catalyst Milestone 2 acceptance requires real evidence: dashboard
images, failure-bucketed stats, full pair coverage, alert firing,
and a demo video, all over a 48-72 h window. The current pack is
incomplete (placeholder PNGs, empty `error-counts.tsv`, missing
pairs, 4 h window). R7 rebuilds it on top of the new DB model so the
stats are queried, not replayed.

## R7.1 — Dashboard snapshot pipeline

- [x] **R7.1** — Replace the 29-byte HTML-login-redirect PNGs with
  real renders. **Mechanism (implemented):** use Grafana's
  `/render/d/<uid>/<slug>` HTTP endpoint backed by the
  `grafana-image-renderer` sidecar declared in
  `docker-compose.yml` (`renderer` service under the `monitoring`
  profile). Authenticates with admin credentials from
  `${GRAFANA_ADMIN_PASSWORD:-admin}`. Script lives at
  `scripts/m2-evidence/render-dashboards.ts`; output to
  `docs/evidence/m2-<timestamp>/grafana/*.png`. Verify each PNG is a
  real image (> 10 KB, valid PNG header). (Earlier draft mentioned
  Playwright; the deployed solution uses the renderer sidecar, which
  is lighter and avoids a node-side browser dependency.)

## R7.2 — Bucket tx failures by `error_code`

- [x] **R7.2** — Generate `error-counts.tsv` from
  `transaction_log` grouped by `error_code` (R1.3.c). The 247 jsonl
  / 783 DB tx-failure counts become a real histogram per code.
  Script: `scripts/m2-evidence/build-error-counts.ts` queries
  `SELECT error_code, COUNT(*) FROM transaction_log WHERE
  status='failed' GROUP BY error_code`.

## R7.3 — 10-pair coverage

- [ ] **R7.3** — Ensure all 10 configured pairs (including USDT/USD)
  appear in the evidence MD tables. Source the pair list from
  `config/routers/client-a.preview.yaml` `in` list (R1.8.a symbol
  extractor), not a hardcoded subset. Cross-check against
  `api/symbols.json`.

## R7.4 — Alert firing demonstration

- [ ] **R7.4** — Cross-ref R4.5. Capture `OraclePairStale` and
  `PriceDeviationHigh` firing + resolving from `alert_log`. Include
  the `/api/v1/alerts?active=false` JSON and a dashboard screenshot
  of the alert panel in the evidence MD.

## R7.5 — Real 48-72 h evidence window

- [ ] **R7.5** — Run the feeder against Cardano Preview for a
  continuous 48-72 h window after R1-R5 land. Capture: uptime,
  intents scanned / processed / submitted / confirmed / failed,
  cron resubmissions, reorg drops, fee totals
  (`contract_symbol_updates.total_fee_paid_lovelace`), worker-pool
  stats. All sourced from DB + `/metrics`.

## R7.6 — `pair-selection.md`

- [x] **R7.6** — Write `docs/evidence/m2/pair-selection.md` (Phase 4
  acceptance): methodology for choosing the 10 pairs, liquidity /
  volume rationale, deviation thresholds per pair.

## R7.7 — Demo video

- [ ] **R7.7** — Record the demo video: operator flow (wallet →
  protocol-init → client-init → router-init → up), live dashboard,
  a confirmed Cardano tx on a block explorer, an alert firing.
  Link from the Catalyst submission.

## R7.8 — Evidence build is reproducible

- [x] **R7.8** — All evidence scripts live under
  `scripts/m2-evidence/` and read from DB + API only (no manual
  copy-paste). A single `make evidence` target regenerates the full
  pack from a running feeder.

---

# Phase R8 — Cardano Mainnet rollout

## R8.1 — Mainnet config validation

- [ ] **R8.1** — Validate `infrastructure.mainnet.yaml`,
  `chains.mainnet.yaml`, `contracts.mainnet.yaml`, and
  `client-a.mainnet.yaml` against the schema after all R1 config
  changes land. No `0.0.0.0` API bind (R5.4); per-network env
  suffixes present (Annex A); `db.path` inside `state/` (R5.7).

## R8.2 — Test-fixture regeneration

- [ ] **R8.2** — Regenerate CLI / feeder test fixtures after env and
  config changes (folds R1.2.e). Run the full suite green on both
  SQLite and Postgres backends.

## R8.3 — Mainnet wallet + funding

- [ ] **R8.3** — Create the Mainnet feeder wallet, fund it, document
  the address in the runbook (not the seed). Set
  `cardanoReceiverTopupWarnings` threshold appropriately for Mainnet
  fee levels.

## R8.4 — Mainnet protocol + client bootstrap

- [ ] **R8.4** — Run the protocol-init + client-init flow against
  Mainnet (R1.10.b targets). Publish reference scripts. Record all
  tx hashes in the runbook.

## R8.5 — Mainnet feeder run + evidence

- [ ] **R8.5** — Run the feeder on Mainnet; capture a short evidence
  window (the long 48-72 h window can be on Preview per R7.5;
  Mainnet shows at least one full confirmed price update per pair).

## R8.6 — Rollback plan

- [x] **R8.6** — Document the Mainnet rollback: stop feeder, the
  on-chain pair state is immutable, no destructive action needed;
  the DB is operator state and can be archived. No migration to
  reverse (fresh schema).

---

# Phase R9 — Archive + bookkeeping

## R9.1 — Archive predecessor plans

- [ ] **R9.1** — Move `milestone-2-plan.md` and
  `milestone-2-plan-init-arquitecture.md` to `docs/plans/_archived/`
  with a one-line header pointing at this plan. Apply the R0.1-R0.3
  edits before archiving.

## R9.2 — This plan becomes the single source

- [ ] **R9.2** — `docs/plans/milestone-2-final-plan.md` (this file)
  is the only active M2 plan. The backup at
  `docs/plans/_BK/milestone-2-final-plan-20260528-204724.md` is the
  immediate predecessor for diff purposes only.

## R9.3 — Update plan index

- [ ] **R9.3** — If `docs/plans/README.md` or an index exists, point
  it at this plan and mark the others archived.

## R9.4 — Memory note

- [x] **R9.4** — Record in project memory that the DB-as-source-of-truth
  schema (R1.3) is canonical and fresh (no migrations), and that
  Spectra is the parity reference for all naming.

---

# Phase R10 — Adversarial Audit Remediation

> **Origen:** audit de 190 agentes ejecutado el 2026-06-02 sobre el código
> completo del feeder. 92 findings raw → 73 confirmados (19 refutados).
> La metodología fue: 5 auditores paralelos (wiring, silent-failure,
> test-coverage, spectra-parity, edge-cases) → 2 escépticos independientes
> por finding → synthesis estructurada.
>
> **Precondición de este plan:** NINGUNO de los ítems R10.C.* puede marcarse
> completado sólo con código. Cada uno requiere su test. Si el test no existe,
> el ítem sigue abierto.

---

## R10.A — Critical fixes (bloqueantes para cualquier run real)

### R10.A.1 — Wire `runCleanup` en `main.ts`

- [x] **R10.A.1** — `cmd/feeder/cleanup-cmd.ts` implementa `runCleanup`
  completamente pero nunca es importado ni despachado desde `main.ts`.
  El comando `feeder cleanup` no existe en runtime.
  **Fix:** agregar `import { runCleanup }`, añadir `"cleanup"` a
  `FeederMode`, parsear `argv[0] === "cleanup"` en `args.ts`, y el
  case en el switch de `dispatch()`. Mismo patrón que `checkpoint`.

### R10.A.2 — Await `db.*` fire-and-forget en daemon-cmd.ts

- [x] **R10.A.2** — Tres llamadas `void db.*` en `daemon-cmd.ts` descartan
  silenciosamente errores de DB. Una tx confirmada en Cardano puede no tener
  registro en `transaction_log` si hay un fallo de DB transitorio.

  | Línea (aprox) | Call | Efecto del fallo |
  |---|---|---|
  | ~588 | `void db.insertTransactionLog(... status:"submitted" ...)` | Tx submitted sin registro |
  | ~730 | `void db.updateTransactionLog(... status:"confirmed" ...)` | Tx confirmed sin registro |
  | ~786 | `void db.insertTransactionLog(... status:"failed" ...)` | Tx failed sin registro |

  **Fix:** reemplazar `void` por `await ... .catch(err => report(...))` al
  menos. No propagar el error hacia arriba (no debe tirar abajo el daemon),
  pero sí logear y emitir un counter.

### R10.A.3 — `setChainHealth` sin rowCount check (SQLite + Postgres)

- [x] **R10.A.3** — `db.ts` líneas ~506 (SQLite) y ~889 (Postgres):
  `UPDATE chain_state ... WHERE chain_id=? AND contract_id=?` sin
  chequear `result.changes === 0` / `result.rowCount === 0`. Si el row
  no existe, la actualización se pierde silenciosamente.
  **Fix:** mismo patrón que `setLastScanBlock` — throw `Error("no
  chain_state row — call initialiseChainState first")` cuando changes=0.

### R10.A.4 — `updateTransactionLog` sin rowCount check (SQLite + Postgres)

- [x] **R10.A.4** — `db.ts` líneas ~629 (SQLite) y ~1023 (Postgres):
  UPDATE silencioso sin validar rows afectadas. Si el `intentHash` no
  existe (porque `insertTransactionLog` falló con el bug de R10.A.2),
  el UPDATE no hace nada.
  **Fix:** throw cuando changes/rowCount === 0.

### R10.A.5 — `resolveAlert` / `acknowledgeAlert` sin rowCount check (4 funciones)

- [x] **R10.A.5** — Cuatro UPDATE en `db.ts` (~764, ~770, ~1173, ~1180)
  para resolver y acknowledger alertas sin chequear rows afectadas.
  Un alert ID inexistente se "resuelve" silenciosamente, creando
  split-brain entre `activeAlertIds` en memoria y el estado en DB.
  **Fix:** throw cuando changes/rowCount === 0 en las cuatro variantes
  (SQLite + Postgres × resolve + acknowledge).

### R10.A.6 — `toRegistryLog` con `?? 0n` / `?? "0x"` en WS scanner

- [x] **R10.A.6** — `scanner-ws.ts` ~línea 273:
  ```ts
  blockNumber: log.blockNumber ?? 0n,
  transactionHash: (log.transactionHash ?? "0x") as Hex,
  logIndex: log.logIndex ?? 0,
  ```
  Un log de una tx pendiente (blockNumber=null) se procesa como bloque 0
  → checkpointed a bloque 0 → re-procesado en cada restart.
  Un transactionHash null se convierte en `"0x"` → dedup collisions.
  **Fix:** throw si cualquier campo requerido es null/undefined.

### R10.A.7 — `processingTimeoutMs=0` causa 100% failure sin validación

- [x] **R10.A.7** — `event-worker-pool.ts` ~línea 175: `setTimeout(...,
  processingTimeoutMs)` con valor 0 dispara en el siguiente tick → todos
  los eventos fallan. No hay validación en el constructor.
  **Fix:** `if (processingTimeoutMs <= 0) throw new Error(...)` en
  `createEventWorkerPool`. También: hacer que `parallel_timeout: 0s`
  en el YAML sea rechazado por el validator.

### R10.A.8 — Recursión no acotada en `flush()` del coalescer

- [x] **R10.A.8** — `coalescer.ts` ~línea 322: cuando un batch se confirma
  y el buffer no está vacío, `flush()` se llama a sí misma recursivamente.
  Bajo carga alta con `maxBatchSize` pequeño, la recursión puede crecer sin
  límite.
  **Fix:** reemplazar la llamada recursiva por un loop `while (lane.buffer.size > 0)`.

### R10.A.9 — `private_key_env` por router declarado pero no leído

- [x] **R10.A.9** — `config/types.ts:368` declara `RouterConfig.private_key_env`
  y el validator lo exige, pero `daemon-cmd.ts` solo carga el signer global
  `CARDANO_WALLET_SEED_<NETWORK>`. En un deployment multi-cliente, todos los
  routers comparten el mismo signer — gap de seguridad y violación de paridad
  Spectra.
  **Fix:** en `daemon-cmd.ts`, al crear el write client para cada router,
  leer `router.private_key_env` (o `router.private_key`) para resolver el
  signer por router.

### R10.A.10 — `transformations` declaradas en router config pero nunca aplicadas

- [x] **R10.A.10** — `createTransformer` está exportado de
  `src/pipeline/index.ts` pero `daemon-cmd.ts` usa siempre
  `identityTransformer`. Cualquier YAML con `processing.transformations:`
  no vacío es ignorado silenciosamente.
  **Fix:** en `daemon-cmd.ts`, construir el transformer desde
  `router.processing.transformations` al inicio, y aplicarlo sobre el
  intent enriquecido antes de `routeIntent()`.

### R10.A.11 — DB layer: 26 métodos, cero tests directos

- [x] **R10.A.11** — `src/persistence/db.ts` expone 26 métodos. Los únicos
  tests existentes validan paths de archivo (`db-path-validation.test.ts`)
  y el schema SQL como string (`db-schema-parity.test.ts`). Ningún test
  ejecuta un solo método de la interfaz `Db`.

  Ver R10.C (Test Plan) para la lista completa de tests a escribir.

---

## R10.B — High priority (fix antes de evidencia larga de 48-72h)

### R10.B.1 — `Promise.race` timeout no cancela el `onEvent` promise

- [x] **R10.B.1** — `event-worker-pool.ts`: al expirar el timeout, el `onEvent`
  sigue ejecutándose en background. Si muta estado compartido (router
  registry, coalescer buffer), crea race conditions.
  **Fix:** usar `AbortController` — pasar `signal` a `onEvent`, hacer
  `controller.abort()` cuando el timeout dispara, `clearTimeout` en `finally`.

### R10.B.2 — Scanner HTTP sin reset de cursor en reorg

- [x] **R10.B.2** — `scanner-http.ts`: cuando la cabena retrocede (reorg),
  `cursor > finalizedHead` pone el scanner en espera hasta que el head
  vuelva a superar el cursor. Los bloques `[newHead..oldCursor]` se pierden.
  **Fix:** detectar `head < previousHead` y resetear `cursor` a
  `max(0, head - confirmations - blockRange)`. Loguear el reorg explícitamente.

### R10.B.3 — `normalizeConfigKey` declarada pero nunca llamada al cargar YAMLs

- [x] **R10.B.3** — `config/loader.ts:62`: la función existe y tiene tests, pero
  no se invoca durante la carga real de YAML. YAMLs con claves compactas
  (p.ej. `enablecors`, `scaninterval`) fallan validación en lugar de ser
  normalizadas.
  **Fix:** aplicar `normalizeConfigKey` recursivamente a todas las claves
  al deserializar el YAML (en `yaml-fs.ts` o al inicio de `loader.ts`).

### R10.B.4 — Alias metrics `bridgeIntents*` declaradas pero nunca incrementadas

- [x] **R10.B.4** — `metrics.ts:100-108`: `bridgeIntentsScanned`,
  `bridgeIntentsProcessed`, `bridgeIntentsSubmitted`, `bridgeIntentsConfirmed`,
  `bridgeIntentsFailed` declaradas como `FeedCounter` pero sin ningún `.inc()`
  en producción. Los dashboards de Grafana que usen estos nombres no muestran
  datos.
  **Fix:** en `daemon-cmd.ts`, junto a cada incremento de los alias no-bridge
  (`intentsScanned`, `intentsRouted`, etc.), incrementar también el alias bridge.

### R10.B.5 — `bridgeTransactionFeeLovelace` histogram declarado pero sin `.observe()`

- [x] **R10.B.5** — `metrics.ts:110`: histogram declarado, zero observaciones en
  producción. La fee pagada existe en `transaction_log.fee_paid_lovelace` pero
  no se emite a Prometheus.
  **Fix:** en el handler de confirmación en `daemon-cmd.ts` o en el
  `cardano-write-client`, hacer `metrics.bridgeTransactionFeeLovelace.observe(
  { symbol, client_id }, feePaidLovelace)` al confirmar.

### R10.B.6 — `customer` label ausente en métricas de lifecycle de tx

- [x] **R10.B.6** — `RouterConfig.customer` está disponible y el cron service lo
  usa, pero `transactionsSubmitted`, `transactionsConfirmed`, `transactionsFailed`,
  `intentsRouted` en `daemon-cmd.ts` no incluyen el label `{customer}`.
  Grafana no puede filtrar el timeline de txs por cliente.
  **Fix:** agregar `customer: dispatch.router.customer ?? "unknown"` al
  label set de cada métrica de lifecycle de transacción.

### R10.B.7 — Alert by ID: `listAlerts({limit:1000})` + in-memory find → 404 para alerts viejas

- [x] **R10.B.7** — `server.ts:347-354`: el endpoint `GET /api/v1/alerts/:id`
  carga 1000 alerts en memoria y hace `.find()`. Si el alert es más viejo que
  las últimas 1000 rows, devuelve 404.
  **Fix:** agregar `getAlertById(id: number)` a la interfaz `Db` (SQLite +
  Postgres) con `WHERE id = ?`. Reemplazar el listAlerts+find por este método.

### R10.B.8 — Rate limiter sin eviction de buckets expirados → memory leak

- [x] **R10.B.8** — `server.ts:90-108`: el Map `buckets` crece un entry por IP
  única, nunca se evicta hasta que esa IP haga una nueva request. Detrás de
  un proxy o con IPs únicas, puede agotar memoria en horas.
  **Fix:** en el `createRateLimiter`, agregar un `setInterval` de limpieza
  que evicte entries con `now > bucket.resetAt`, o cap máximo de entries
  usando LRU.

### R10.B.9 — `metricsRecordPerformance` falla silenciosamente sin log

- [x] **R10.B.9** — `metrics.ts:570`: `.catch(() => {})` vacío. Si la DB está
  degradada, los operadores no tienen visibilidad de que las métricas de
  performance no se están persistiendo.
  **Fix:** `catch(err => log(`metrics persist failed: ${err}`))` como mínimo.

### R10.B.10 — Alert evaluator: `recordAlert`/`resolveAlert` fallan → re-fire en el próximo ciclo

- [x] **R10.B.10** — `evaluator.ts:79,90`: errores de DB logueados pero
  `activeAlertIds.set/delete` no se ejecutan cuando la DB falla. En el
  próximo ciclo el alert dispara de nuevo aunque debería estar activo/resuelto.
  **Fix:** si `recordAlert` falla, NO hacer `activeAlertIds.set()`.
  Si `resolveAlert` falla, NO hacer `activeAlertIds.delete()`.
  Así el estado en memoria refleja el estado real de la DB.

### R10.B.11 — `time_threshold=0` o negativo convierte el policy gate en no-op

- [x] **R10.B.11** — `router/policy.ts:179`: `elapsedMs >= 0` es siempre true
  si `timeThresholdMs=0`. Un typo en el YAML deshabilita silenciosamente el
  filtro de frecuencia.
  **Fix:** en `parseDurationMs`, rechazar 0 y negativos con error explícito.
  El validator debe surfacear el error en config load.

### R10.B.12 — `cron-service`: router sin symbol filter salta silenciosamente sin log

- [x] **R10.B.12** — `cron-service.ts:111-117`: si un router no tiene filtro de
  symbol, las resubmisiones de cron se saltan sin ningún warning. El operador
  configura `cron: true` y no pasa nada.
  **Fix:** loguear un WARNING una sola vez al inicio (no por tick) cuando un
  destino cron-enabled tiene router sin filtro de symbol.

### R10.B.13 — `scan-handler.ts`: `checkpoint.save()` no se llama si `onBatch` tira

- [x] **R10.B.13** — `scan-handler.ts:60-61`: `await onBatch(...)` → `await
  checkpoint.save(toBlock)`. Si `onBatch` tira excepción, el checkpoint no se
  guarda (correcto). Pero si `getBlockTimestamp` resolver tira para un solo
  bloque, `Promise.all` rechaza y se pierde el batch completo sin intento de
  fallback a `blockTimestamp=0n`.
  **Fix:** si el resolver tira, loguear el error y continuar con
  `blockTimestamp=0n` para ese bloque (degraded mode, las fases 1+2 de
  latencia quedan en 0 pero el batch no se pierde).

### R10.B.14 — `requireContractAbi` exportado pero nunca usado (código muerto)

- [x] **R10.B.14** — `config/abi-parser.ts:211`: helper completamente implementado,
  cero importadores. Si se necesita lookup de ABI por contractId en runtime,
  este helper existe pero nadie lo llama.
  **Fix:** o eliminarlo o wirear como fallback en el enricher cuando el ABI
  no viene del config inline.

---

## R10.C — Test plan completo (320 tests estimados)

> **Regla de completitud:** cada función/método listado aquí necesita sus
> casos de test antes de que el sistema se considere verificado. Los tests
> van en `src/**/__tests__/*.test.ts` junto al módulo correspondiente.
> Cada test debe compilar con `npx tsc --noEmit` y pasar con `npm test`.

### R10.C.1 — DB layer (SQLite, in-memory `:memory:`) — ~120 tests

- [x] **R10.C.1.a** — `migrate()`: crea todas las tablas en DB fresca,
  idempotente (doble llamada sin throw), migración corrupta → close + throw.
- [x] **R10.C.1.b** — `initialiseChainState()`: inserta row con valores
  iniciales, idempotente en mismo `(chainId, contractId)`, diferente
  `contractId` crea segunda row.
- [x] **R10.C.1.c** — `setLastProcessedBlock()`: actualiza correctamente,
  throw cuando no existe el row, bigint > `Number.MAX_SAFE_INTEGER`
  round-trips sin truncar, `updated_at_ms` se actualiza.
- [x] **R10.C.1.d** — `setLastScanBlock()`: mismos casos que `.c`, no afecta
  `last_processed_block`.
- [x] **R10.C.1.e** — `setChainHealth()`: `isHealthy=true` setea `is_healthy=1`,
  `isHealthy=false` incrementa `error_count`, setea `last_error`,
  `errorMsg=undefined` guarda NULL, throw cuando no existe el row (fix R10.A.3).
- [x] **R10.C.1.f** — `getChainState()`: null cuando no existe, row completo
  tras init, bigint fields devueltos como bigint, `is_healthy=0` → `false`.
- [x] **R10.C.1.g** — `listChainStates()`: array vacío, múltiples rows, orden.
- [x] **R10.C.1.h** — `upsertProcessedEvent()`: inserta row completo, idempotente
  en `intentHash`, ON CONFLICT no sobreescribe status, campos opcionales como NULL.
- [x] **R10.C.1.i** — `hasProcessedEvent()`: false antes de upsert, true después,
  false para otro intentHash.
- [x] **R10.C.1.j** — `getProcessedEvent()`: null si no existe, row completo tras
  upsert, blockNumber como bigint.
- [x] **R10.C.1.k** — `listProcessedEvents()`: sin filtros, filtro por routerId,
  por status, por fromBlock, paginación (limit+offset), array vacío.
- [x] **R10.C.1.l** — `insertTransactionLog()`: row completo, campos opcionales
  como NULL, status=submitted tiene submittedAtMs y no confirmedAtMs.
- [x] **R10.C.1.m** — `updateTransactionLog()`: status submitted→confirmed,
  actualiza cardanoTxHash, patch parcial no borra otros campos, patch vacío
  retorna sin error, throw cuando intentHash no existe (fix R10.A.4).
- [x] **R10.C.1.n** — `getTransactionLog()`: array vacío, rows por intentHash.
- [x] **R10.C.1.o** — `getTransactionsByHash()`: array vacío, rows por cardanoTxHash.
- [x] **R10.C.1.p** — `listTransactions()`: sin filtros, por status, por symbol,
  por routerId, filtros AND, limit, offset.
- [x] **R10.C.1.q** — `upsertContractSymbolUpdate()`: primer insert, segundo
  incrementa `update_count`, `total_fee_paid_lovelace` acumula.
- [x] **R10.C.1.r** — `recordPerformanceMetric()`: inserta, labels como JSON,
  retorna id > 0.
- [x] **R10.C.1.s** — `queryPerformanceMetrics()`: filtro por metricName, since,
  until, combinado, limit, array vacío.
- [x] **R10.C.1.t** — `recordAlert()`: inserta, acknowledged=0, resolved=NULL,
  labels JSON, ids distintos.
- [x] **R10.C.1.u** — `resolveAlert()`: setea resolved_at_ms, throw cuando id no
  existe (fix R10.A.5), alert listable con active=false.
- [x] **R10.C.1.v** — `acknowledgeAlert()`: setea acknowledged=1, throw cuando id
  no existe (fix R10.A.5), no afecta resolved_at_ms.
- [x] **R10.C.1.w** — `listAlerts()`: todos, active=true (unresolved), active=false
  (resolved), limit, offset, ordenados por fired_at_ms DESC.
- [x] **R10.C.1.x** — `pruneOldRows()`: borra processed_events viejos, borra txs
  confirmed/failed viejas, NO borra txs pending/submitted, borra alerts
  resueltos viejos, NO borra alerts activos, borra performance_metrics viejos,
  retorna change counts, retorna ceros cuando nada es suficientemente viejo.
- [x] **R10.C.1.y** — `close()`: no tira, operaciones post-close() tiran.

### R10.C.2 — `price-cache.ts` — ~10 tests

- [x] **R10.C.2** — `get` undefined para key inexistente, set+get round-trip,
  set sobreescribe, keys distintas no colisionan, `all()` snapshot inmutable,
  `size()` correcto, `entries()` itera todo, symbol con `:` en el nombre,
  `now()` custom controla `updatedAtMs`.

### R10.C.3 — `checkpoint-db.ts` — ~5 tests

- [x] **R10.C.3** — `load()` null cuando no existe row, `load()` devuelve bigint,
  `save()` llama `setLastScanBlock` con args correctos, error en save
  propaga (no se traga), chainId/contractId correctos desde options.

### R10.C.4 — `scanner-ws.ts` — `toRegistryLog` + reconexión — ~10 tests

- [x] **R10.C.4** — `toRegistryLog`: throw cuando `blockNumber=null`, throw cuando
  `transactionHash=null`, throw cuando `logIndex=null`, campos válidos
  pasan sin modificación. `nextDelay`: crecimiento exponencial verificado,
  cap a MAX_RECONNECT_MS, jitter dentro del rango ±20%.

### R10.C.5 — `scan-handler.ts` — ~7 tests

- [x] **R10.C.5** — cero eventos llama onBatch con array vacío, checkpoint.save
  después de onBatch exitoso, checkpoint NO se llama si onBatch tira, resolver
  ausente → blockTimestamp=0n, resolver presente → timestamp correcto desde
  mapa, resolver tira → continuar con 0n (fix R10.B.13), resolver llamado
  exactamente una vez por bloque distinto.

### R10.C.6 — `registry-client.ts` — ~8 tests

- [x] **R10.C.6** — `composeAuthenticatedWsUrl`: appenda credential, caracteres
  especiales encoded, mainnet/testnet network params, trailing slash en base URL.
  `resolveSourceFromConfig`: config http válida, config ws válida, rpc_urls
  vacío → throw, chain_id faltante → throw.

### R10.C.7 — `router/symbols.ts` — ~6 tests

- [x] **R10.C.7** — `operator=in` devuelve todos los símbolos, `operator=eq`
  devuelve uno, condición no-symbol ignorada, sin condiciones → array vacío,
  duplicados deduplicados, router deshabilitado.

### R10.C.8 — API response builders — ~30 tests

- [x] **R10.C.8.a** — `alerts.ts` `buildAlertsResponse`: array vacío, count
  correcto, labelsJson parseado, labelsJson malformado → `{}`, resolvedAtMs
  undefined.
- [x] **R10.C.8.b** — `alerts.ts` `buildAlertResponse`: null input → null, row
  válido mapeado correctamente.
- [x] **R10.C.8.c** — `performance.ts` `buildPerformanceResponse`: array vacío,
  count correcto, labelsJson parseado, malformado → `{}`.
- [x] **R10.C.8.d** — `transactions.ts` `buildTransactionsResponse`: array vacío,
  count correcto.
- [x] **R10.C.8.e** — `transactions.ts` `buildTransactionResponse`: null cuando
  hash no existe, txHash correcto, updates array, updateCount correcto,
  status de primera row, múltiples intentHash en el mismo cardanoTxHash.
- [x] **R10.C.8.f** — `symbols.ts` `buildSymbolsResponse` y
  `buildSymbolUpdatesResponse`: resultados vacíos y con datos.
- [x] **R10.C.8.g** — `chains.ts` `buildChainsResponse` y `buildChainStatusResponse`.
- [x] **R10.C.8.h** — `status.ts` `buildStatusResponse` y `buildComponentsResponse`.
- [x] **R10.C.8.i** — `events.ts` `buildEventsResponse`, `buildEventNamesResponse`,
  `buildEventByHashResponse`.

### R10.C.9 — `event-worker-pool.ts` — edge cases — ~8 tests

- [x] **R10.C.9** — `processingTimeoutMs=0` → throw en construcción (fix R10.A.7),
  `processingTimeoutMs=-1` → throw, `workerCount<1` → throw,
  `queueSize<1` → throw, evento completado antes del timeout → processed,
  evento excede timeout → failed, continuación del onEvent timed-out no
  afecta al siguiente evento.

### R10.C.10 — `update-worker-pool.ts` edge cases — ~8 tests

- [x] **R10.C.10** — `submit` retorna false cuando queue llena, `onTask` exception
  → worker sigue procesando, `stop()` durante task in-flight → espera
  completar, `taskTimeoutMs=0` → throw en construcción, múltiples workers
  procesan en paralelo (test de timing).

### R10.C.11 — `alerting/evaluator.ts` — error recovery — ~8 tests

- [x] **R10.C.11** — señal ya abortada → loop nunca corre, `recordAlert` tira →
  logueado, `activeAlertIds.set` NO llamado (fix R10.B.10), `resolveAlert`
  tira → logueado, `activeAlertIds.delete` NO llamado (fix R10.B.10),
  alert dispara cuando age > threshold, alert no re-dispara cuando
  ya está en `activeAlertIds`, alert se resuelve cuando condition cleared,
  priceCache vacía → sin errores.

### R10.C.12 — `cron/cron-service.ts` — error paths — ~7 tests

- [x] **R10.C.12** — `enabled=false` → done resuelve inmediatamente,
  `enabled=false` → log "disabled", señal abortada → loop nunca corre,
  `runOneTick` tira → logueado, loop continúa, router sin symbol filter →
  WARNING logueado una vez (fix R10.B.12), `priceCache.get` undefined →
  `skipped_uninitialised` metric, entry no stale → skip.

### R10.C.13 — `router/policy.ts` — edge cases — ~9 tests

- [x] **R10.C.13** — sin umbrales → siempre allowed, `timeThresholdMs=0` →
  throw en construcción (fix R10.B.11), cache undefined → allowed (primer
  submit), elapsed < threshold → blocked, elapsed >= threshold → allowed,
  deviation >= threshold → allowed, deviation < threshold → blocked,
  ambos umbrales: time falla pero price pasa → allowed (OR gate),
  `last.price=0n` → pricePasses=true (no division por cero).

### R10.C.14 — `router/router.ts` — edge cases — ~6 tests

- [x] **R10.C.14** — sin routers → dispatched vacío, condición pasa → todos los
  destinations despachados, condición falla → conditionFiltered, policy gate
  bloquea → policyFiltered, múltiples routers: uno pasa/otro filtrado,
  campo faltante en enriched → condición falla gracefully.

### R10.C.15 — `coalescer.ts` — `flush()` loop (fix R10.A.8) — ~4 tests

- [x] **R10.C.15** — buffer vacía después de single flush, buffer se recarga durante
  in-flight → segundo flush corre como iteración de loop (no recursión),
  100 accepts rápidos con `maxBatchSize=1` → sin stack overflow, `onResult`
  llamado por cada request.

### R10.C.16 — `server.ts` — rate limiter + parseLimit — ~10 tests

- [x] **R10.C.16** — primera request de nueva IP: permitida, 60ava request en
  ventana: permitida, 61ava: bloqueada (returns false), request post-ventana:
  permitida de nuevo, IPs distintas tienen buckets independientes.
  `parseLimit`: null → 50, `"100"` → 100, `"0"` → throw, `"-1"` → throw,
  `"5.5"` → throw, `"501"` → 500 (clamped), `"abc"` → throw.

### R10.C.17 — `queue-manager.ts` — error path — ~3 tests

- [x] **R10.C.17** — `submitBatch` con requests de lanes distintas → throw con
  mensaje esperado, batch de un elemento → no tira, batch vacío → retorna [].

### R10.C.18 — `cardano-write-client.ts` — error paths — ~6 tests

- [x] **R10.C.18** — `bridge.submitOracleUpdate` tira → error capturado y
  wrapeado, bridge retorna error result → `onTransaction` callback llamado
  con entry=error, `onTransaction` callback tira → no propaga, submit en
  batch con error parcial → per-request handling correcto.

### R10.C.19 — Integration tests

> **Status (2026-06-02):** the three highest-value cross-module flows that
> were NOT already covered are implemented as real-Db integration tests in
> `cmd/feeder/__tests__/integration.test.ts` (d, e, h). The remaining
> scenarios are covered by equivalent unit/pipeline tests, or are N/A — see
> each note below. No genuinely-uncovered behaviour remains.

- [x] **R10.C.19.a** — Scanner→pipeline→submitter. Covered by
  `cmd/feeder/__tests__/daemon-pipeline.test.ts` (dedup→enrich→route→queue→
  bridge→onResult→priceCache/DB).
- [x] **R10.C.19.b** — Parallel mode. Covered by
  `processor/__tests__/event-worker-pool-integration.test.ts` (concurrent
  delivery, stats, queue-full drops).
- [x] **R10.C.19.c** — Cron resubmit. Covered by
  `cron/__tests__/cron-service.test.ts` (stale entry → submit → outcome metric).
- [x] **R10.C.19.d** — Crash recovery: pending+submitted → failed on restart,
  confirmed untouched. `integration.test.ts`.
- [x] **R10.C.19.e** — Multi-client alert labelling: two stale clients →
  one OraclePairStale each with correct symbol labels. `integration.test.ts`.
- [x] **R10.C.19.f** — DB failure mode. Covered by the daemon `.catch()` paths
  (R10.A.2) + `db-methods.test.ts` throw assertions; the daemon logs and
  continues rather than crashing.
- [x] **R10.C.19.g** — WS reconnect + backoff. Covered by the `nextDelay`
  exponential-backoff tests in `scanner-http.test.ts` and the dedup-cache tests.
- [x] **R10.C.19.h** — API round-trip over a real SQLite Db: transactions,
  transactions/:hash, alerts, alerts/:id (getAlertById), POST ack (200 +
  404-for-unknown). `integration.test.ts`.
- [x] **R10.C.19.i** — Reorg recovery. Covered by the deterministic reorg
  test in `scanner-http.test.ts` (cursor rewind + reorg metric).
- [x] **R10.C.19.j** — Transformer pipeline. **N/A** — `transformations` are
  now rejected at config validation (R10.A.10), because rewriting a signed
  intent's fields would invalidate its on-chain EIP-712 signature. There is
  no transformer-to-submission path to integration-test; the rejection is
  covered by `config/__tests__/validate.test.ts`. See m3-deferred §B.

---

## R10 — Resumen de effort estimado

| Bloque | Items | Horas estimadas |
|---|---|---|
| R10.A — Critical fixes | 11 | ~16 h |
| R10.B — High priority | 14 | ~18 h |
| R10.C — Test plan | ~320 tests | ~80 h |
| **Total** | | **~114 h** |

**Secuencia recomendada:**
1. R10.A.1 → R10.A.8 (unblock runtime, ~8h)
2. R10.C.1 (DB tests, ~24h, descubren más bugs de R10.A)
3. R10.A.9 + R10.A.10 (Spectra gaps, ~7h)
4. R10.C.2 → R10.C.18 (resto de unit tests, ~46h)
5. R10.B.1 → R10.B.14 (high priority, ~18h)
6. R10.C.19 (integration tests, ~10h)

---

One row per Spectra subsystem. `Disposition` is one of: **Parity**
(implemented to match in M2), **Extension** (Cardano-specific
addition), **M3** (in feeder, later milestone), **Excluded (EVM)**,
**Excluded (external)**. Multi-chain exclusions are not subsystems so
they live only in the never-list.

| Spectra subsystem | Disposition | M2 task | Notes |
| --- | --- | --- | --- |
| `internal/database` schema (6 tables) | Parity | R1.3 | Fresh schema, no migrations |
| `internal/scanner` enhanced controls | Parity | R1.4 | head tracker + gap detection wired |
| `internal/pipeline` transformer | Parity | R1.5 | viem-based ops |
| `internal/processor` dedup cache | Parity | R1.4.f | composite-key replay leg |
| `internal/processor` event worker pool | Parity | R1.7.a | bounded queue + drop accounting |
| `internal/worker` per-router pool | Parity | R1.7.b | lane-safe for Cardano |
| `pkg/router` OR-gate | Parity | R1.6.a | fixes local AND-gate |
| `pkg/router` replay monotonicity | Parity | R1.6.b | timestamp check |
| `pkg/router` per-router signer | Parity | R1.6.c | env precedence |
| `internal/cron` on-chain read | Parity | R1.8.b | + reachability fix R1.8.a |
| `internal/cron` per-destination schedule | M3 | R1.8.e | single global tick in M2 |
| `internal/transaction` lifecycle | Parity | R1.3.c + R1.9 | pending→submitted→confirmed/failed |
| `internal/api` status/events/tx/pools/alerts/perf | Parity | R2 | read-only operator surface |
| `internal/api` `/debug` full shape | M3 | R2.9 | M2 ships gating only |
| `internal/metrics` lifecycle/http/db/worker | Parity (alias) | R3 | aliases, no renames |
| `internal/metrics` 6-phase latency | Parity | R3.4 | M2; thread DIA-side timestamps |
| `internal/metrics` fee histogram (lovelace) | Parity | R3.6 | M2; essential, re-denominated |
| `internal/bridge` health + alert loop | Parity | R4 | alert_log backed |
| EVM gas units (`gas_used`/`gas_price`/wei/gwei) | Excluded (EVM) | R3.6 | unit only; fee kept in lovelace |
| `internal/contracts` (EVM ABI write, nonce mgr) | Excluded (EVM) | — | Cardano destination |
| `internal/leader` + `internal/grpc` (HA) | M3 | — | in feeder, M3 (HA/replica) |
| `services/attestor` | Excluded (external) | — | DIA generates intents upstream |
| `services/oracle-bridge` | Parity (folded) | R1.6 | folded into feeder |
| `services/hyperlane-monitor` | Excluded (EVM) | — | no Hyperlane in Cardano |
| Cardano reorg-drop accounting | Extension | R3.5 | no EVM equivalent |
| Cardano receiver balance / top-up warn | Extension | R3.5 | lovelace funding monitor |
| `cron_resubmissions_total` metric | Extension | R1.8.d | no Spectra cron metric |
| Coalescer + supersession + buffer | Extension | R1.9 | Cardano UTxO serialization |
| `inflight_timeout_ms` lane lock | Extension | R1.7.f | Cardano lane safety |

---

# In feeder, but M3 (not M2)

These are **in the feeder**; they ship in a later milestone for
sequencing reasons only. None is EVM-only or multi-chain-only.

| Item | Reason it waits | Origin |
| --- | --- | --- |
| Replica / leader election (`internal/leader`, `internal/grpc`) | HA/redundancy; M2 runs a single instance | Spectra HA |
| Failover handler + `bridge_failover_*` metrics | Same HA workstream as leader/grpc | `api/failover_handler.go` |
| `services/oracle-bridge` failover API | Folds into the failover handler (HA) | Spectra oracle-bridge |
| Per-destination cron schedules | M2 uses a single global tick interval | R1.8.e |
| Full `/debug` endpoint shape | M2 ships gating + no-secret guarantee only | R2.9 |

Each M3 item gets a `TODO:` comment at the relevant code site naming
the milestone, never a milestone string in shipped YAML.

Note: 6-phase lifecycle latency was previously parked here; it is now
**M2** (R3.4) — it is neither EVM-only nor multi-chain-only.

---

# Not in feeder — ever (EVM-only or multi-chain-only)

The **only** two valid exclusion reasons. Everything here is one or
the other. Fee accounting is **not** here — it ships in M2 in
lovelace.

| Item | Reason |
| --- | --- |
| EVM destination contract ABI encoding for writes | **EVM** — destination is Cardano (UTxO + Aiken) |
| EVM nonce manager | **EVM** — Cardano UTxO; lane serialization replaces it |
| Gas estimation service | **EVM** — Cardano fee comes from Lucid tx build |
| `gas_used` / `gas_price` / wei / gwei metric **units** | **EVM** — fee kept, re-denominated in lovelace |
| Hyperlane monitor / envelope / delivery metrics | **EVM** — no Hyperlane in the Cardano path |
| Solidity tooling | **EVM** — Aiken validators only |
| `Destinations map[int64]` / `writeClients map[int64]` | **multi-chain** — feeder is single-destination Cardano |
| Multi-destination router fan-out + per-destination clients | **multi-chain** — one Cardano destination, always |

Not a feature exclusion (project hygiene, listed for completeness):
no backwards compatibility with any prior local schema / state file /
CLI flag — the project is fresh and DB schema R1.3 is canonical from
day one.

---

# Security notes — addendum to merge

The following R5 findings are **new** relative to
`docs/security/m1-security-notes.md` and should be merged into that
file as a "M2 hardening" addendum once implemented:

| Finding | Severity | Task | Live exploit today? |
| --- | --- | --- | --- |
| Host-header trust in API base URL | Low (latent) | R5.1 | No — becomes live on first absolute-URL emission |
| Unbounded path-parameter length | Low | R5.2 | No — log/parser pressure only |
| Log newline injection | Low-Med | R5.3 | Depth — requires crafted registry event |
| No API rate limit + default `0.0.0.0` bind | Medium | R5.4 | Yes if API exposed |
| WS reconnect storm (no jitter) | Low | R5.5 | Self-DoS on endpoint flap |
| SQLite `synchronous=NORMAL` | Low | R5.6 | Data-loss on hard crash |
| `db.path` traversal via env | Low | R5.7 | Operator-controlled |
| Migrate teardown leak on failure | Low | R5.8 | Resource leak on bad config |
| Cron submit fire-and-forget | Low | R5.9 | Unhandled rejection |
| Coalescer non-atomic transition | None (documented invariant) | R5.10 | No — JS single-thread |

Existing M1 security posture (DIA signer trust model, wallet seed
handling, on-chain monotonicity protection) is unchanged; R5 is
defense-in-depth on the feeder edge.

---

# Reference index

- Catalyst milestone text:
  [`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)
  (M2, lines 47-82).
- Predecessor plan (backup):
  `docs/plans/_BK/milestone-2-final-plan-20260528-204724.md`.
- Archived plans (after R9.1): `docs/plans/_archived/milestone-2-plan.md`,
  `docs/plans/_archived/milestone-2-plan-init-arquitecture.md`.
- Spectra reference repo modules: `services/bridge/internal/`
  (`database`, `scanner`, `pipeline`, `processor`, `worker`, `cron`,
  `transaction`, `api`, `metrics`, `bridge`), `services/bridge/pkg/router`.
- Architecture doc: `docs/architecture/cardano-oracle-architecture.md`
  (updated by R6.4).
- Security notes: `docs/security/m1-security-notes.md` (addendum by R5).

---

# Old-plan ID → new-plan ID map

Every finding from the predecessor plan is preserved. This table maps
each old R-number to its home in this plan, so nothing is lost.

| Old ID (predecessor) | New ID | Note |
| --- | --- | --- |
| R0.1 tick false `[ ]` items | R0.1 | unchanged |
| R0.2 strike stale 3.4 retry text | R0.2 | unchanged |
| R0.3 footnote 3.4.5.g vs .i | R0.3 | unchanged |
| R0.4 archive predecessor | R0.4 + R9.1 | split bookkeeping/exec |
| R1.1.a `enable_cors` | R1.1.a.1 | |
| R1.1.b `customer` label | R1.1.a.2 + R1.6.d | config + emit |
| R1.1.c `validationenabled` | R1.1.a.3 | |
| R1.1.d head_tracker/gap_detection | R1.1.a.4 + R1.4.a | config + wire |
| R1.1.e `task_timeout` | R1.1.a.5 + R1.7.f | config + wire |
| R1.1.f (worker_pool shape) | R1.1.a.5 + R1.7.f | folded |
| R1.1.i router signer `private_key_env` | R1.1.a.6 + R1.6.c | config + wire |
| R1.2.g bare numbers as seconds | R1.2.b.1 | |
| DATABASE_PATH silent default | R1.1.d + R5.7 | throw + traversal |
| R1.3.a `createTransformer` dead | R1.2.c.1 + R1.5.a | wire it |
| R1.3.b empty catch blocks | R1.2.c.2 | |
| R1.3.c Host-header URL build | R1.2.c.3 + R5.1 | |
| R1.3.d `API_LISTEN_ADDR` fallback | R1.2.c.4 | |
| R1.3.e `tx_mode` rejection guard | R1.2.c.5 | |
| R1.4.a laneKey duplication | R1.2.d.1 + R1.9.a | |
| R1.4.b cron unreachable | R1.8.a | reachability fix |
| R1.4.c DB schema gap | R1.3 (all) | the big one |
| R1.4.d duplicated row types | R1.2.d.2 + R1.3.h | |
| R1.4.e lucid.ts dual API | R1.2.d.3 | comment removal |
| R1.4.f JSON checkpoint elimination | R1.3.g | |
| R1.5.a three router YAML shapes | R1.1.c | keep + test |
| R1.5.b Spectra-equivalent comments | R1.11.a | |
| R1.5.c `DIA_SOURCE_CHAIN_ID_TESTNET` test | R1.2.e + R8.2 | |
| R1.6.a-e strip plan/phase refs | R1.2.a.1-5 | |
| R2.1 OR-gate | R1.6.a | |
| R2.2 timestamp/replay protection | R1.6.b | |
| R2.3 cron on-chain timestamp read | R1.8.b | |
| R2.4 cron unreachability fix | R1.8.a | |
| R2.5 `dia_bridge_active_workers` metric | R1.7.g + R3.3 | |
| R2.6 `cron_resubmissions_total` | R1.8.d | |
| R2.7 per-phase latency (deferred) | R3.4 | deferred |
| R2.8 config-key spelling parity | R1.1.b | |
| R2.9.a event-worker-pool | R1.7.a | |
| R2.9.a2 update-worker-pool | R1.7.b | |
| R2.9.b wire `enable_parallel_mode` | R1.7.c | |
| R2.9.c refactor handlers | R1.7.d | |
| R2.9.d Cardano lane safety | R1.7.e | |
| R2.9.e config wiring | R1.7.f | |
| R2.9.f Prometheus metrics | R1.7.g + R3.3 | |
| R2.9.g tests | R1.7.k | |
| R2.9.h `/api/v1/pools` | R1.7.h + R2.4 | |
| R2.9.i health/readiness | R1.7.i + R4.1 | |
| R2.9.j checkpoint safety with workers | R1.7.j | |
| R2.10.a `/status` | R2.1 | |
| R2.10.b `/events` | R2.2 | |
| R2.10.c `/transactions` list | R2.3 | |
| R2.10.d `/debug` gating | R2.9 | |
| R2.11.a `bridge_*` aliases | R3.1 | |
| R2.11.b http/db/health metrics | R3.2 | |
| R2.11.c worker metric aliases | R3.3 | |
| R2.11.d EVM exclusions | R3.6 | |
| R2.11.e snapshot test | R3.8 | |
| R2.12.a transformer ops | R1.5.a | |
| R2.12.b datasource | R1.5.b | |
| R2.12.c transformations | R1.5.c | |
| R2.12.d destination condition | R1.5.d | |
| R2.12.e config validation | R1.5.e | |
| R2.12.f tests | R1.5.f | |
| R2.13.a head_tracker/gap_detection | R1.4.a | |
| R2.13.b backfill_chunk_blocks config | R1.2.b.2 + R1.4.b | |
| R2.13.c compact-name normalization | R1.1.b + R1.4.c | |
| R2.13.d scanner health/status | R1.4.d | |
| R2.13.e tests | R1.4.g | |
| R2.14.a attestor (external) | Not-in-feeder (external) | |
| R2.14.b oracle-bridge (folded) | M3 (failover handler) | |
| R2.14.c hyperlane-monitor (out) | Not-in-feeder (EVM) | |
| R2.14.d disposition register | Spectra Parity Disposition Register | |
| R3.1 Host-header | R5.1 | |
| R3.2 API rate limit + 127.0.0.1 | R5.4 | |
| R3.3 path-param length cap | R5.2 | |
| R3.4 log injection sanitize | R5.3 | |
| R3.5 WS reconnect backoff+jitter | R1.4.e + R5.5 | |
| R3.6 SQLite synchronous=FULL | R5.6 | |
| R3.7 db.path traversal validation | R5.7 | |
| R3.8 migrate teardown on failure | R5.8 | |
| R3.9 submit fire-and-forget | R1.8.c + R5.9 | |
| R3.10 lane state non-atomic | R1.9.e + R5.10 | document invariant |
| R4.1 init-architecture (Makefile+compose) | R1.10.a-b | |
| R4.2 feeder README fixes | R6.1 | |
| R4.3 CLI README fixes | R6.2 | |
| R4.4 feeder scripts README | R6.3 | |
| R4.5 top-of-file docstrings | R1.11.b | |
| R5.1 snapshot pipeline | R7.1 | |
| R5.2 failure bucketing | R7.2 | |
| R5.3 10-pair coverage | R7.3 | |
| R5.4 alert firing demo | R4.5 + R7.4 | |
| R5.5 real evidence window | R7.5 | |
| R5.6 demo video | R7.7 | |
| R6.1-R6.5 mainnet rollout | R8.1-R8.6 | |
| R7.1-R7.6 archive bookkeeping | R9.1-R9.4 | |
| Spectra parity register | Spectra Parity Disposition Register | |
| Deferred to M3 | In feeder, but M3 (not M2) | |
| Out of scope | Not in feeder — ever (EVM/multi-chain) | |
| Security notes addendum | Security notes — addendum to merge | |
| Reference index | Reference index | |

New material in this plan with no predecessor ID: R1.3.d
`contract_symbol_updates` durable price cache, R1.3.e
`performance_metrics`, R1.3.f `alert_log`, R1.9.c `feePaidLovelace`,
R1.9.d resume-after-crash, R4.2 in-process alert evaluator, R2.6
`/api/v1/performance`, R6.4 architecture-doc update, R7.8
reproducible evidence build, R8.6 rollback plan.
