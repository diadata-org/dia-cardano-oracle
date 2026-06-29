// Code-level constants and defaults — the single home for the feeder's
// scattered magic numbers, fallback defaults, fixed namespaces, and limits.
//
// CONVENTION
// ----------
// This file holds ONLY code-level constants: the literal a module falls back
// to when a config/env value is absent (`?? DEFAULT`), fixed retry/backoff
// parameters, in-memory cache sizes, polling/tick fallbacks, API pagination
// caps, the metrics namespace, and reused fixed strings.
//
// It deliberately does NOT duplicate config-sourced values. Anything read from
//   - `infrastructure.<network>.yaml`,
//   - `.env`, or
//   - `state/<network>/config-bootstrap.json::configState`
// stays sourced from there. When a YAML knob has a built-in fallback (e.g.
// `infra.block_scanner.scan_interval ?? DEFAULT_SCAN_INTERVAL_MS`), the YAML
// value is still authoritative — only the FALLBACK literal lives here.
//
// Trivial structural literals (0/1/-1, array indices, "" initialisers,
// discriminated-union tags, log/error strings, one-off locals, SQL column
// names, HTTP status codes, per-metric histogram bucket arrays) intentionally
// stay inline; centralising them hurts readability.
//
// Grouped by domain below. The feeder README's "Configuration" section points
// here for the code-level defaults table.

// ---------------------------------------------------------------------------
// Block scanner / source defaults
//
// Fallbacks for the `infrastructure.<network>.yaml::block_scanner`,
// `source`, and `event_monitor` knobs. The YAML value is authoritative;
// these apply only when the key is absent.
// ---------------------------------------------------------------------------

/** Polling cadence between HTTP scan passes (ms). YAML: `block_scanner.scan_interval`. */
export const DEFAULT_SCAN_INTERVAL_MS = 10_000;
/** Max blocks pulled per scan pass. YAML: `block_scanner.block_range`. */
export const DEFAULT_BLOCK_RANGE = 500n;
/** First block to scan from. YAML: `source.start_block`. */
export const DEFAULT_START_BLOCK = 0n;
/** Source-chain confirmations required before an event is processed. YAML: `block_scanner.confirmations`. */
export const DEFAULT_CONFIRMATIONS = 6n;
/** Gap beyond which backward-sync re-syncs in chunks. YAML: `block_scanner.max_block_gap`. */
export const DEFAULT_MAX_BLOCK_GAP = 5000n;
/** Chunk size used by the gap-recovery loop (Spectra parity: block_scanner_enhanced.go uses 5000). */
export const BACKFILL_CHUNK_BLOCKS = 5000n;
/** Cap on the scanner's per-error retry backoff (exponential from the scan
 *  interval). A transient RPC error is retried, never fatal — see scanner-http. */
export const SCANNER_RPC_RETRY_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Event processor / dedup-cache defaults
//
// Fallbacks for `infrastructure.<network>.yaml::event_processor`.
// ---------------------------------------------------------------------------

/** Dedup-cache capacity (entries). YAML: `event_processor.dedup_cache_size`. */
export const DEFAULT_DEDUP_CACHE_SIZE = 4096;
/** Dedup-cache TTL (ms). 1 hour. YAML: `event_processor.dedup_cache_ttl`. */
export const DEFAULT_DEDUP_CACHE_TTL_MS = 60 * 60_000;
/** Coalesce-window before a lane batch flushes (ms). YAML: `event_processor.coalesce_window`. */
export const DEFAULT_COALESCE_WINDOW_MS = 2_000;
/** Worker count when parallel event processing is enabled. YAML: `event_processor.parallel_worker_count`. */
export const DEFAULT_PARALLEL_WORKER_COUNT = 4;
/** Task-queue size for the parallel event pool. YAML: `event_processor.parallel_queue_size`. */
export const DEFAULT_PARALLEL_QUEUE_SIZE = 256;
/** Per-task timeout for the parallel event pool (ms). YAML: `event_processor.parallel_timeout`. */
export const DEFAULT_PARALLEL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Update worker-pool defaults
//
// Fallbacks for `infrastructure.<network>.yaml::worker_pool`. (`max_retries`,
// `retry_delay`, and `inflight_timeout_ms` are REQUIRED in YAML — no fallback
// here on purpose; they fail loud.)
// ---------------------------------------------------------------------------

/** Update-pool worker count. YAML: `worker_pool.max_workers`. */
export const DEFAULT_UPDATE_WORKER_MAX_WORKERS = 4;
/** Update-pool task-queue size. YAML: `worker_pool.task_queue_size`. */
export const DEFAULT_UPDATE_WORKER_QUEUE_SIZE = 128;
/** Update-pool per-task timeout (ms). YAML: `worker_pool.task_timeout`. */
export const DEFAULT_UPDATE_WORKER_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// WebSocket reconnect backoff
//
// `reconnect_interval` / `max_reconnect_attempts` come from
// `event_monitor` in YAML; the backoff curve bounds are code-level.
// ---------------------------------------------------------------------------

/** Initial WS reconnect delay (ms). YAML fallback: `event_monitor.reconnect_interval`. */
export const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;
/** Reconnect-attempt warning threshold. YAML fallback: `event_monitor.max_reconnect_attempts`. */
export const DEFAULT_MAX_RECONNECTS = 60;
/** Exponential-backoff base delay (ms) for WS reconnects. */
export const WS_BASE_RECONNECT_MS = 1_000;
/** Exponential-backoff cap (ms) for WS reconnects (5 minutes). */
export const WS_MAX_RECONNECT_MS = 300_000;

// ---------------------------------------------------------------------------
// Intent injection (file-source fault drill)
//
// The daemon watches a drop directory inside the active run-state tree and
// feeds any CLI-signed intent file dropped there through the same routing and
// submission path the scanner uses, then archives the file. This lets an
// operator stage a stale / drifted / out-of-order intent on demand while the
// live DIA feed keeps flowing. See `src/source/intent-injector.ts`, the feeder
// README ("Fault-drill intent injection"), and docs/architecture/feeder.md §3.
// ---------------------------------------------------------------------------

/** Drop directory for signed intent files, relative to the active run-state
 *  dir (`state/<network>_run_<id>/<dirname>`). */
export const INTENT_INJECT_DIRNAME = "inject";
/** Archive subdirectory under the drop directory where processed files land. */
export const INTENT_INJECT_PROCESSED_DIRNAME = "processed";
/** Poll cadence for the drop directory (ms). Env override: `INTENT_INJECT_POLL_MS`. */
export const DEFAULT_INTENT_INJECT_POLL_MS = 2_000;

// ---------------------------------------------------------------------------
// Confirmation / finality
// ---------------------------------------------------------------------------

/** Cardano confirmation depth at which an update tx is treated as confirmed.
 *  Depth 1 = confirmed once observed in any block. YAML fallback:
 *  `cardano.confirmation_depth`; also the lib-bridge and API defaults. */
export const DEFAULT_CONFIRMATION_DEPTH = 1;

// ---------------------------------------------------------------------------
// Stale-input reconcile (auto re-fetch + rebuild on BadInputsUTxO)
//
// After a restart / RPC turbulence the provider's indexer can lag the real
// chain and report a UTxO the previous batch already spent. Building against it
// makes the node reject the tx with BadInputsUTxO / TranslationLogicMissingInput.
// The submit path then re-fetches the UTxO view and rebuilds, up to ATTEMPTS
// times, waiting DELAY_MS between tries for the indexer to catch up. See
// lib-bridge/reconcile-retry.ts.
// ---------------------------------------------------------------------------

/** Total build attempts (initial + reconcile retries) on a stale-input rejection. */
export const STALE_INPUT_RECONCILE_ATTEMPTS = 3;
/** Wait before each reconcile rebuild (ms) so the provider's indexer catches up. */
export const STALE_INPUT_RECONCILE_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Cron service / health check
// ---------------------------------------------------------------------------

/** Cron + balance-refresh tick interval (ms). YAML fallback: `cron_service.tick_interval`. */
export const DEFAULT_CRON_TICK_INTERVAL_MS = 30_000;
/** Whether the cron heartbeat fires on a shared wall-clock boundary (all pairs
 *  due together → one batch) instead of each pair's own last-confirm time.
 *  YAML fallback: `cron_service.aligned_heartbeat`. */
export const DEFAULT_ALIGNED_HEARTBEAT = false;
/** Health-check sampling interval (ms). YAML fallback: `health_check.check_interval`. */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;
/** Per-call timeout for the secondary Cardano provider liveness probe (ms). The
 *  probe runs on the balance-refresh tick; it must finish well within that tick.
 *  Drives the SecondaryProviderDown signal — see `provider-health.ts`. */
export const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 8_000;
/** Max processing-lag staleness before /health/ready degrades (ms). 5 minutes.
 *  YAML fallback: `health_check.max_processing_lag`; also the readiness default. */
export const DEFAULT_MAX_STALENESS_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Feed sanity-check defaults
//
// Fallbacks for the `feed_sanity` block of `infrastructure.<network>.yaml`; the
// YAML carries the operative values, these apply only when a key is absent.
// ---------------------------------------------------------------------------

/** How often the per-feed sanity check runs (ms). YAML: `feed_sanity.interval`. */
export const DEFAULT_FEED_SANITY_INTERVAL_MS = 300_000; // 5 min
/** Grace added to a feed's freshness ceiling (confirmation + clock skew), in
 *  seconds. YAML: `feed_sanity.freshness_grace_seconds`. */
export const DEFAULT_FEED_SANITY_GRACE_SECONDS = 120; // 2 min

// ---------------------------------------------------------------------------
// Metrics namespace
// ---------------------------------------------------------------------------

/** Prometheus series prefix (`<namespace>_<metric>`). Override: metrics
 *  factory `options.namespace`. */
export const METRICS_NAMESPACE = "dia_bridge";
/** Throttle window for the metrics-persistence-failure warning (ms). 1 minute. */
export const METRICS_WARN_THROTTLE_MS = 60_000;

// ---------------------------------------------------------------------------
// HTTP / API defaults
// ---------------------------------------------------------------------------

/** API listen host fallback. YAML: `api.host` / `api.listen_addr`; env: `API_LISTEN_ADDR`. */
export const DEFAULT_API_HOST = "127.0.0.1";
/** API listen host when `listen_addr` begins with ":" (all interfaces). */
export const API_WILDCARD_HOST = "0.0.0.0";
/** API listen port fallback. YAML: `api.port` / `api.listen_addr`; env: `API_LISTEN_ADDR`. */
export const DEFAULT_API_PORT = 8080;
/** Per-remote-address request budget per window. */
export const API_RATE_LIMIT_MAX = 60;
/** Rate-limit window (ms). 1 minute. */
export const API_RATE_LIMIT_WINDOW_MS = 60_000;
/** Sweep expired rate-limit buckets every N calls (bounds the bucket Map). */
export const API_RATE_LIMIT_SWEEP_EVERY = 1_000;

// ---------------------------------------------------------------------------
// Persistence query pagination
//
// Defaults/caps applied to API-driven list queries in the DB layer.
// ---------------------------------------------------------------------------

/** Default page size when a list query omits `limit`. */
export const DEFAULT_QUERY_LIMIT = 100;
/** Hard cap on `limit` for paginated list queries. */
export const MAX_QUERY_LIMIT = 1000;
/** Default `limit` for the unpaginated bulk-filter queries (intents/metrics). */
export const DEFAULT_BULK_QUERY_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Prune command
// ---------------------------------------------------------------------------

/** Default `--max-age` cutoff for `feeder prune` (ms). 1 hour. */
export const DEFAULT_PRUNE_MAX_AGE_MS = 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Persistent lucid WASM-build failure → self-exit
//
// @lucid-evolution/lucid (^0.4.29) intermittently throws a transient WASM
// build error from inside `.complete()`:
//     TypeError: Cannot perform %TypedArray%.prototype.set on a detached
//     ArrayBuffer
// when its WASM linear memory grows mid-build and detaches a held TypedArray
// view. The COMMON glitch is cleared two ways already: the CLI tx-build's
// `completeWithRetry` rebuilds-and-retries in-process (the feeder's update
// builds inherit this), and the feeder's worker pool retries the lane task
// (`worker_pool.max_retries`). The RARE case is a genuinely corrupted WASM
// module that an in-process rebuild can NOT clear — the daemon is
// long-running, so only a FRESH PROCESS gets a fresh WASM module.
//
// The daemon therefore tracks CONSECUTIVE WASM-signature failures (counted
// only AFTER the worker-pool retries are exhausted; reset to 0 on any
// successful submission) and, once they reach this threshold, logs FATAL and
// `process.exit(WASM_FATAL_EXIT_CODE)` so the supervisor (Docker
// `restart: unless-stopped`, or scripts/run-feeder-supervised.sh) restarts
// the process with a fresh WASM module. State persists in the DB and resumes.
// ---------------------------------------------------------------------------

/** Consecutive lucid WASM-build failures (after worker-pool retries are
 *  exhausted) that trigger the daemon self-exit. Env override:
 *  `WASM_FATAL_CONSECUTIVE_FAILURES`. */
export const DEFAULT_WASM_FATAL_CONSECUTIVE_FAILURES = 5;
/** Distinct process exit code used for the persistent-WASM-corruption self-exit
 *  so a supervisor can recognise it. Non-zero so Docker `restart:
 *  unless-stopped` (and the npm supervisor) restart the process. */
export const WASM_FATAL_EXIT_CODE = 17;

// ---------------------------------------------------------------------------
// Init command
// ---------------------------------------------------------------------------

/** Seed pair list offered when a router YAML has no existing pairs. */
export const DEFAULT_INIT_PAIRS = [
  "BTC/USD", "ETH/USD", "USDC/USD", "USDT/USD",
  "DOGE/USD", "LTC/USD", "ARB/USD", "SHIB/USD",
  "NEIRO/USD", "XVG/USD",
] as const;

// ---------------------------------------------------------------------------
// Cardano network magic — the canonical numeric identifier of a Cardano
// network (protocol constant, not a tunable). Used as the `chain_id` key of
// `contract_symbol_updates` (the Cardano analogue of a Spectra destination
// chain id), so the per-(client, symbol) rollup is namespaced per network.
// ---------------------------------------------------------------------------

/** Cardano network magic by network. Preview testnet = 2, Mainnet = 764824073. */
export const CARDANO_NETWORK_MAGIC: Record<"Preview" | "Mainnet", number> = {
  Preview: 2,
  Mainnet: 764824073,
};

// ---------------------------------------------------------------------------
// Metrics histogram buckets
//
// Per-metric Prometheus histogram bucket boundaries (used by api/metrics.ts).
// The unit is in each name so a reader knows what the boundaries mean.
// ---------------------------------------------------------------------------

/** End-to-end / per-stage latency histogram, in seconds. */
export const LATENCY_SECONDS_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 600];
/** HTTP request latency histogram, in seconds. */
export const HTTP_LATENCY_SECONDS_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];
/** Price-data-age histogram, in seconds. */
export const PRICE_AGE_SECONDS_BUCKETS = [1, 5, 30, 60, 300, 1800];
/** Price-deviation histogram, in percent. */
export const PRICE_DEVIATION_PERCENT_BUCKETS = [0.01, 0.1, 0.5, 1, 5, 10];
/** Pairs-per-transaction (batch size) histogram. */
export const PAIRS_PER_TX_BUCKETS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];

// ---------------------------------------------------------------------------
// Submission / coalescer state codes
//
// Numeric phase codes published by the per-client `submission_state` and
// `coalescer_state` gauges. Kept separate because both can be active at once
// (a lane accumulates the next batch while the current one is on-chain). The
// event→code mapping lives in metrics/submission-state.ts.
// ---------------------------------------------------------------------------

/** Submit-pipeline phase codes, in order. Driven by onStep (+ lane idle/flush). */
export const SUBMISSION_STATE = {
  idle: 0,
  building: 1,
  submitting: 2,
  awaiting: 3,
} as const;
/** Coalescer lane lifecycle codes, in order. Driven by onLaneEvent. */
export const COALESCER_STATE = {
  idle: 0,
  accumulating: 1,
  in_flight: 2,
} as const;

// ---------------------------------------------------------------------------
// Config validation allow-lists
//
// Fixed value sets the config validator (config/validate.ts) checks against.
// ---------------------------------------------------------------------------

/** Database drivers the feeder supports. YAML: `infrastructure.database.driver`. */
export const VALID_DATABASE_DRIVERS = ["sqlite", "postgres"] as const;
/** Cardano networks the feeder supports. Env: `CARDANO_NETWORK`. */
export const VALID_CARDANO_NETWORKS = ["Preview", "Mainnet"] as const;
/** Roles a `wallets[]` entry may declare. YAML: `infrastructure.<net>.yaml::wallets[].role`. */
export const VALID_WALLET_ROLES = ["main", "pool"] as const;
/** Keys allowed on a router object in a `config/routers/<net>/*.yaml`. */
export const ROUTER_ALLOWED_FIELDS = new Set([
  "id",
  "name",
  "customer_id",
  "type",
  "enabled",
  "private_key",
  "private_key_env",
  "triggers",
  "processing",
  "destinations",
]);

// ---------------------------------------------------------------------------
// Signer-wallet pool
//
// Fallbacks for the `infrastructure.<network>.yaml::wallet_pool` knobs (the
// main→pool funding band) plus structural tunables that stay constant-only to
// keep the YAML lean. The YAML value is authoritative where a key exists.
// ---------------------------------------------------------------------------

/** A pool wallet below this spendable lovelace is topped up from the main.
 *  Number (matches the YAML field); widened to bigint at the funding math.
 *  YAML: `wallet_pool.pool_wallet_low_lovelace`. */
export const DEFAULT_POOL_WALLET_LOW_LOVELACE = 150_000_000;
/** Funding fills a pool wallet up to this spendable lovelace — the full
 *  `wallet_shape` (5 working × 100 ADA + 5 collateral × 10 ADA = 550 ADA), paid
 *  as the missing pieces in one tx so the pool is usable immediately.
 *  YAML: `wallet_pool.pool_wallet_target_lovelace`. */
export const DEFAULT_POOL_WALLET_TARGET_LOVELACE = 550_000_000;
/** The main wallet never funds the pool below this spendable lovelace reserve.
 *  YAML: `wallet_pool.main_wallet_reserve_lovelace`. */
export const DEFAULT_MAIN_WALLET_RESERVE_LOVELACE = 100_000_000;
/** Headroom added to a main→pool funding amount when reserving the main's UTxOs,
 *  so the reserved set also covers the tx fee + the change min-UTxO. Constant-only
 *  — a structural tx-build margin, not an operator knob. */
export const POOL_FUND_FEE_BUFFER_LOVELACE = 3_000_000n;
/** Most dust UTxOs a single consolidate tx merges, so the tx never exceeds the
 *  chain's max size (mirrors the CLI's `--max-inputs` default). Structural. */
export const DEFAULT_CONSOLIDATE_MAX_INPUTS = 60;
/** A wallet is only auto-consolidated when its dust sums to at least the target
 *  collateral UTxO plus this headroom for the change UTxO + fee. Structural. */
export const CONSOLIDATE_MIN_HEADROOM_LOVELACE = 3_000_000n;
/** Per-wallet cooldown between main→pool funding txs (ms).
 *  YAML: `wallet_pool.pool_fund_min_interval_ms`. */
export const DEFAULT_POOL_FUND_MIN_INTERVAL_MS = 5 * 60_000;

/** Pure-ADA wallet UTxOs the arbiter reserves per build: one fee input plus one
 *  collateral-capable input. Constant-only — structural, not an operator knob. */
export const RESERVED_UTXOS_PER_TX = 2;
/** Smallest pure-ADA UTxO eligible to back a script tx's collateral (lovelace).
 *  Constant-only — mirrors the protocol collateral floor. */
export const MIN_COLLATERAL_UTXO_LOVELACE = 5_000_000n;

// ---------------------------------------------------------------------------
// Wallet UTxO shape
//
// Fallbacks for `infrastructure.<network>.yaml::wallet_shape` — the target UTxO
// profile each wallet is shaped toward so even a single wallet can back many
// parallel lanes (the arbiter hands each lane a disjoint UTxO subset). Both the
// main→pool funding and the auto-split carve a wallet toward this profile,
// working-first. The YAML value is authoritative where a key exists.
// ---------------------------------------------------------------------------

/** Working (lane) UTxOs the shape fills a wallet up to. With the collateral
 *  count this gives 10 usable UTxOs, well above the `min_usable_utxos` trigger
 *  (5), so a shaped wallet does not re-split every tick (hysteresis).
 *  YAML: `wallet_shape.working_utxo_count`. */
export const DEFAULT_WORKING_UTXO_COUNT = 5;
/** Target size of each working UTxO. YAML: `wallet_shape.working_utxo_lovelace`. */
export const DEFAULT_WORKING_UTXO_LOVELACE = 100_000_000n;
/** Collateral UTxOs the shape fills a wallet up to, minted only once the working
 *  lanes are full. Collateral is returned on a successful tx (it does not drain),
 *  so it stays at the base count. YAML: `wallet_shape.collateral_utxo_count`. */
export const DEFAULT_COLLATERAL_UTXO_COUNT = 5;
/** Target size of each collateral UTxO. YAML: `wallet_shape.collateral_utxo_lovelace`. */
export const DEFAULT_COLLATERAL_UTXO_LOVELACE = 10_000_000n;
/** Split TRIGGER: auto-split fires when usable pure-ADA UTxOs fall below this
 *  count, regardless of balance — concentration is about UTxO COUNT, not size.
 *  The planner then no-ops if the wallet cannot be carved further.
 *  YAML: `wallet_shape.min_usable_utxos`. */
export const DEFAULT_MIN_USABLE_UTXOS = 5;
/** Headroom kept on a split tx's consumed inputs for fee + change min-UTxO.
 *  Constant-only — a structural tx-build margin, not an operator knob. */
export const SPLIT_FEE_BUFFER_LOVELACE = 2_000_000n;
