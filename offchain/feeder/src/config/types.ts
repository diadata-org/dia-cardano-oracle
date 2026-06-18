// Modular configuration types — TypeScript mirror of
// `diadata-org/Spectra-interoperability/services/bridge/config/{modular_types,event_definitions,types}.go`.
//
// The shape is intentionally faithful to the upstream Go types so DIA's
// existing router YAMLs can be loaded by this feeder with only the
// destination block adapted: Spectra ships an EVM `method:` block per
// destination, and this feeder adds a parallel `cardano:` block (see
// `CardanoDestinationConfig` below).
//
// Fields the Cardano feeder does not consume today (cron service,
// replica failover, parts of the worker pool, recovery, etc.) are
// still typed here so a Spectra-shaped YAML loads without
// unknown-property errors. They become live when their consumers are
// wired in.

/**
 * Top-level shape of the entire feeder configuration, produced by the
 * modular loader. Each sub-section comes from a separate YAML file
 * (see `loader.ts` for the exact mapping).
 */
export type ModularConfig = {
  /** From `infrastructure.<network>.yaml`. Optional only because validation
   * surfaces the missing-file error itself with a clearer message. */
  infrastructure?: InfrastructureConfig;
  /** From `chains.yaml`. Keyed by a stable string id (e.g. `dia-testnet`). */
  chains: Record<string, ChainConfig>;
  /** From `contracts.yaml`. Keyed by a stable string id (e.g. `intent-registry-testnet`). */
  contracts: Record<string, ContractConfig>;
  /** From `events.yaml`, under the top-level `event_definitions:` key. */
  event_definitions: Record<string, EventDefinition>;
  /** Collected from every `routers/*.yaml`. Keyed by `router.id`. */
  routers: Record<string, RouterConfig>;
  /**
   * ABIs declared as strings in the YAML, parsed at load time and
   * attached here so downstream code (extractor, enricher,
   * registry-client) never re-parses. Populated by the loader; missing
   * only when the config dir does not declare events or contracts
   * (validator surfaces that).
   */
  parsedAbis: import("./abi-parser.js").ParsedAbis;
};

// ---------------------------------------------------------------------------
// infrastructure.<network>.yaml
// ---------------------------------------------------------------------------

/**
 * Everything that defines "how the daemon runs": the source chain it
 * scans, the database it persists to, the API surface it exposes,
 * timeouts and worker tuning. The bulk of these fields are 1:1 with
 * Spectra's `InfrastructureConfig`.
 */
export type InfrastructureConfig = {
  database: DatabaseConfig;
  source: SourceConfig;
  /** Optional fallback signing key embedded in the YAML. Strongly
   * discouraged — routers should reference an env var via
   * `private_key_env`. Kept for Spectra parity. */
  private_key?: string;
  private_key_env?: string;
  event_monitor?: EventMonitorConfig;
  block_scanner?: BlockScannerConfig;
  event_processor?: EventProcessorConfig;
  worker_pool?: WorkerPoolConfig;
  health_check?: HealthCheckConfig;
  api?: APIConfig;
  metrics?: MetricsConfig;
  cardano?: CardanoRuntimeConfig;
  alerting?: AlertingConfig;
  /** Not consumed yet (replica failover). Kept typed for Spectra parity. */
  replica?: ReplicaConfig;
  dry_run?: boolean;
  /** Not consumed yet (periodic mandatory updates). Kept typed for Spectra parity. */
  cron_service?: CronServiceConfig;
  /** Per-feed sanity check (on-chain value vs DIA source). Its OWN clock and
   *  config, deliberately separate from cron_service / the balance refresh so
   *  the cadence and naming never get conflated with those. */
  feed_sanity?: FeedSanityConfig;
  /** Alertmanager delivery channels (Telegram / email). Off by default; the
   *  monitoring generator writes these into `monitoring/alertmanager.yml`. */
  notifications?: NotificationsConfig;
};

/**
 * Persistence backend. Spectra is Postgres-only; the Cardano feeder extends
 * with a SQLite driver for low-friction local and CI deployments. For sqlite
 * the database file lives in the active per-run state dir
 * (`<run>/feeder.sqlite`); the daemon derives that path at startup and carries
 * it on `path`. `DATABASE_PATH_<network>` env overrides it.
 */
export type DatabaseConfig = {
  driver: "sqlite" | "postgres";
  dsn?: string;
  dsn_env?: string;
  /** Resolved sqlite file path. Set by the daemon (run-scoped default or the
   *  `DATABASE_PATH_<network>` env override), not read from the YAML. */
  path?: string;
};

/** The source chain the feeder scans (always DIA Lasernet). */
export type SourceConfig = {
  chain_id: number;
  name: string;
  rpc_urls: string[];
  ws_url?: string;
  /** Block to start scanning from on a cold start. Once the feeder has
   * persisted a checkpoint in `chain_state`, that value wins. */
  start_block?: number;
};

export type EventMonitorConfig = {
  enabled: boolean;
  reconnect_interval?: string;
  max_reconnect_attempts?: number;
};

export type BlockScannerConfig = {
  enabled: boolean;
  scan_interval?: string;
  block_range?: number;
  confirmations?: number;
  max_block_gap?: number;
  backward_sync?: boolean;
  head_tracker_interval?: string;
  gap_detection_interval?: string;
  /** Number of blocks per chunk during backfill scans. Controls how many
   *  blocks are requested in a single RPC call when catching up from a
   *  historic start block. Maps to `block_scanner.backfill_chunk_blocks`
   *  in `infrastructure.<network>.yaml`. */
  backfill_chunk_blocks?: number;
};

export type EventProcessorConfig = {
  dedup_cache_size?: number;
  dedup_cache_ttl?: string;
  /** Parallel event processing (parallel enrichment + gas-estimation in
   *  Spectra). Declared so Spectra-shaped YAMLs load cleanly; not yet
   *  active in this feeder. TODO: activate together with
   *  `parallel_worker_count`, `parallel_queue_size`, `parallel_timeout`
   *  for high-throughput scenarios. */
  enable_parallel_mode?: boolean;
  /** NOTE: parallel enrichment worker count — see `enable_parallel_mode`. */
  parallel_worker_count?: number;
  /** NOTE: parallel enrichment queue depth — see `enable_parallel_mode`. */
  parallel_queue_size?: number;
  /** NOTE: per-task timeout for parallel enrichment — see `enable_parallel_mode`. */
  parallel_timeout?: string;
  /** Accumulation window on the idle→accumulating lane edge.
   *  Accepts duration strings ("2s", "500ms"). Default: "2s". */
  coalesce_window?: string;
  /** Drop buffered intents older than this at flush time.
   *  Accepts duration strings ("60s", "5m"). Default: no limit. */
  max_intent_age?: string;
  /** Maximum number of intents included in a single Cardano batch update.
   *  When omitted the coalescer flushes the full lane buffer in one go. */
  max_batch_size?: number;
  /** When true, a batch-size failure is retried by splitting the batch into
   *  progressively smaller chunks until it succeeds or reaches size 1. */
  size_fallback_enabled?: boolean;
};

export type WorkerPoolConfig = {
  /** Spectra field — maximum parallel workers in the pool. Not used by the
   * Cardano feeder (per-receiver serialisation comes from the lane model,
   * not worker count); typed here so Spectra-shaped YAMLs load cleanly. */
  max_workers?: number;
  /** Spectra field — task queue depth. Not used by the Cardano feeder;
   * typed here so Spectra-shaped YAMLs load cleanly. */
  task_queue_size?: number;
  task_timeout?: string;
  retry_delay?: string;
  max_retries?: number;
  /** Inflight-lock timeout in milliseconds. How long a submitted Cardano
   *  tx is treated as still in-flight (blocking new submissions on the
   *  same receiver UTxO) before the lock is considered stuck and released.
   *  Source of truth — there is no hardcoded default; the loader requires
   *  this value to be set. Documented in
   *  `infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms`. */
  inflight_timeout_ms?: number;
};

export type HealthCheckConfig = {
  enabled: boolean;
  /** Cadence of the periodic health probe loop. */
  check_interval?: string;
  /** Cardano-feeder extension. If no IntentRegistered event has been
   *  processed within this window, `/health/ready` returns 503. */
  max_processing_lag?: string;
  /** Worker queue depth above which `/health/ready` returns 503.
   *  Maps to Spectra `health_check.maxqueuesize`. Omit to disable
   *  the check. */
  max_queue_size?: number;
};

export type APIConfig = {
  enabled: boolean;
  listen_addr?: string;
  host?: string;
  port?: number;
  enable_cors?: boolean;
  /** When true, GET /debug returns a minimal debug acknowledgement.
   *  When false or absent, /debug returns 404. Never expose env vars,
   *  paths, or secrets in the debug response. Default: false. */
  debug_enabled?: boolean;
  readiness?: {
    max_last_confirmed_age?: string;
  };
};

export type MetricsConfig = {
  enabled: boolean;
  namespace?: string;
};

export type CardanoRuntimeConfig = {
  /** Number of Cardano blocks the feeder waits before it records a
   *  submission as confirmed. The feeder waits this many blocks past the
   *  block that included the tx before emitting `tx_confirmed` and
   *  updating the price cache. Default 1 — practically final for oracle
   *  feeds. Operators needing stricter guarantees set it higher. */
  confirmation_depth?: number;
};

/**
 * Operational alert thresholds. Canonical source for every numeric
 * threshold used either by the feeder code (e.g. low-balance warnings)
 * or by the Prometheus alerting rules in `monitoring/alerts.yml`.
 *
 * Units convention:
 *   - `*_lovelace` fields are lovelace (1 ADA = 1_000_000 lovelace).
 *   - `*_seconds` fields are seconds.
 *   - `*_percent` fields are percent (0–100).
 *
 * Any value here MUST also be mirrored in `monitoring/alerts.yml` (each
 * alert rule carries an inline comment pointing back at the YAML key).
 */
export type AlertingConfig = {
  /** Receiver balance below this lovelace value warns the operator that
   *  a `receiver:top-up` is needed. Emits `cardanoReceiverTopupWarnings`. */
  receiver_balance_low_lovelace?: number;
  /** Receiver `accruedToHookLovelace` above this value means a `settle`
   *  is overdue (fees pending transfer to the PaymentHook). */
  settle_overdue_lovelace?: number;
  /** PaymentHook `accruedFeesLovelace` above this value means DIA can run
   *  `payment-hook:withdraw` to collect accumulated fees. */
  payment_hook_withdraw_ready_lovelace?: number;
  /** Admin wallet balance below this lovelace value warns the operator
   *  that the signer wallet needs a refill. */
  admin_wallet_low_lovelace?: number;
  /** Pair last-confirmed timestamp older than this many seconds triggers
   *  the OraclePairStale alert. */
  oracle_pair_stale_seconds?: number;
  /** Price-deviation p95 (in percent) above this value triggers the
   *  PriceDeviationHigh alert (possible misreported price). */
  price_deviation_high_percent?: number;
  /** Incoming price-data age p95 (in seconds) above this value triggers
   *  the PriceAgeHigh alert (DIA source publishing stale prices). */
  price_age_high_seconds?: number;
  /** Confirmed-tx reorgs in the last hour above this count triggers the
   *  ReorgRateHigh alert. Prometheus-only (the feeder code does not consume
   *  it); kept here so every alert threshold has one canonical home and the
   *  threshold-drift test can enforce it against `monitoring/`. */
  reorg_rate_high_per_hour?: number;
  /** Sum of un-merged client deposits waiting at a per-client deposit address
   *  (side-deposit funding) above this lovelace value triggers the
   *  ReceiverDepositsPending alert. A `deposit:merge` folds those deposits into
   *  the client's Receiver balance. Prometheus-only (the feeder code does not
   *  consume it); kept here so every alert threshold has one canonical home and
   *  the threshold-drift test can enforce it against `monitoring/`. */
  deposit_pending_merge_lovelace?: number;
  /** Admin (signer) wallet LARGEST pure-ADA UTxO below this lovelace value
   *  triggers the AdminWalletFragmented alert (critical). A script tx needs a
   *  collateral UTxO distinct from its fee inputs; once the wallet shatters into
   *  sub-collateral dust the total can still look healthy while every build
   *  traps. The daemon auto-consolidates below `auto_consolidate_below_lovelace`
   *  (which must be < this, so the alert fires first). */
  admin_wallet_min_collateral_lovelace?: number;
  /** Seconds the PRIMARY Cardano API provider (the lucid build/submit provider,
   *  selected by `CARDANO_PROVIDER`) may go without a successful call before the
   *  PrimaryProviderDown alert (critical) fires. A primary outage freezes every
   *  build (e.g. a Blockfrost 402 quota wall) → all pairs go stale together.
   *  Measured passively from the balance-refresh calls via
   *  `dia_bridge_provider_last_ok_timestamp_seconds{role="primary"}`.
   *  Prometheus-only (the feeder code emits the gauge, the rule owns the
   *  threshold); kept here so every alert threshold has one canonical home and
   *  the threshold-drift test can enforce it against `monitoring/`. */
  provider_primary_unhealthy_seconds?: number;
  /** Seconds the SECONDARY Cardano API provider (confirmation/reorg redundancy)
   *  may go without a successful liveness probe before the SecondaryProviderDown
   *  alert (warning) fires. Losing it degrades redundancy but not core
   *  operation, so it is a warning, not critical. Measured by an active probe
   *  via `dia_bridge_provider_last_ok_timestamp_seconds{role="secondary"}`.
   *  Prometheus-only; same single-source rationale as the primary key. */
  provider_secondary_unhealthy_seconds?: number;

  // --- Automatic remediation thresholds -------------------------------------
  // The feeder ACTS on these itself, on the balance-refresh tick, as a lane task
  // (serialized with updates). Each MUST sit BEYOND its paired alert so the ALERT
  // fires FIRST and the automatic step only follows — the threshold-drift test
  // enforces the ordering. There is no Prometheus alert for these keys
  // themselves; they drive feeder behaviour, not a rule.

  /** Receiver `accruedToHookLovelace` above this value → the daemon auto-runs
   *  `settle` (Receiver accrued → PaymentHook). MUST be > `settle_overdue_lovelace`
   *  so the SettleOverdue alert fires first. Set high enough that settle moves a
   *  worthwhile chunk (a tiny auto-settle would waste fees and delay updates). */
  auto_settle_lovelace?: number;
  /** PaymentHook `accruedFeesLovelace` above this value → the daemon auto-runs
   *  `payment-hook:withdraw` (PaymentHook → admin wallet, refilling the wallet
   *  that pays Cardano fees). MUST be > `payment_hook_withdraw_ready_lovelace`
   *  so the PaymentHookWithdrawReady alert fires first. */
  auto_withdraw_lovelace?: number;
  /** Admin (signer) wallet LARGEST pure-ADA UTxO below this value → the daemon
   *  auto-runs `wallet:consolidate` (fold dust into a dedicated collateral UTxO
   *  + working balance). MUST be < `admin_wallet_min_collateral_lovelace` so the
   *  AdminWalletFragmented alert fires first. */
  auto_consolidate_below_lovelace?: number;
};

export type ReplicaConfig = {
  enabled: boolean;
  role?: "primary" | "secondary";
  monitor_chain_id?: number;
};

/**
 * Cron-service config — Spectra parity (`internal/cron/cron_service.go`).
 * When enabled, the feeder runs a periodic resubmission loop that
 * guarantees each cron-enabled destination is updated at least every
 * `time_threshold` regardless of whether new DIA events arrived. See
 * `src/cron/cron-service.ts`.
 */
export type CronServiceConfig = {
  /** Master switch — when false, the cron service does not start. */
  enabled: boolean;
  /** How often the cron service inspects every cron-enabled destination
   *  (duration string, e.g. "30s"). Applied uniformly across destinations;
   *  per-destination cadence is gated by each destination's own
   *  `time_threshold`. */
  tick_interval?: string;
  /** When true, the heartbeat fires on a shared wall-clock boundary
   *  (`floor(now / time_threshold) * time_threshold`) instead of each pair's
   *  own last-confirm time. All pairs then become due in the same tick and
   *  coalesce into one batch — fewer, fuller transactions. Only affects
   *  destinations with `time_threshold > 0` (the heartbeat modes); ignored in
   *  deviation-only mode, where `max_staleness` is the ceiling. Default false
   *  (per-pair cadence). */
  aligned_heartbeat?: boolean;
};

/**
 * Per-feed sanity-check loop — compares each feed's live on-chain value against
 * the latest DIA source value and emits `feed_sanity_status`. Its OWN clock and
 * config block, deliberately independent of `cron_service` and the balance
 * refresh so the cadence/naming are never conflated with those.
 */
export type FeedSanityConfig = {
  /** Master switch — when false, the in-feeder periodic sanity check does not run. */
  enabled?: boolean;
  /** How often the feeder runs the sanity check (duration string, e.g. "5m"). */
  interval?: string;
  /** Grace added to a feed's freshness ceiling (confirmation + clock skew) so a
   *  value read just before its heartbeat is not flagged stale. */
  freshness_grace_seconds?: number;
};

/**
 * Alertmanager delivery channels. Off by default — alerts reach only the logs +
 * database (via the feeder webhook). Recipients / on-off live here; the SECRETS
 * (Telegram bot token, SMTP password) live in `.env`, never in this file. The
 * monitoring generator writes these into `monitoring/alertmanager.yml`.
 */
export type NotificationsConfig = {
  telegram?: {
    enabled?: boolean;
    /** Numeric chat/group id; the bot token comes from `.env`. */
    chat_id?: string | number;
  };
  email?: {
    enabled?: boolean;
    to?: string[];
    from?: string;
    /** SMTP `host:port`; the username/password come from `.env`. */
    smarthost?: string;
  };
};

// ---------------------------------------------------------------------------
// chains.yaml
// ---------------------------------------------------------------------------

/**
 * A chain known to the feeder. In the Cardano feeder this is informational
 * (we don't dispatch EVM txs); destinations resolve their target chain by
 * `chain_id` against this map for documentation and metric labelling.
 */
export type ChainConfig = {
  chain_id: number;
  name: string;
  rpc_urls: string[];
  enabled: boolean;
  default_gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
};

// ---------------------------------------------------------------------------
// contracts.yaml
// ---------------------------------------------------------------------------

/**
 * A contract on a known chain. The feeder reads this for the source
 * `OracleIntentRegistry`; destination receivers do not appear here because
 * Cardano scripts are addressed by NFT+address, not by EVM-style ABI.
 */
export type ContractConfig = {
  name?: string;
  chain_id: number;
  address: string;
  type: string;
  enabled: boolean;
  abi: string;
  gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
  methods?: Record<string, MethodConfig>;
};

export type MethodConfig = {
  method_name: string;
  fields_mapping?: Record<string, string>;
  gas_limit?: number;
};

// ---------------------------------------------------------------------------
// events.yaml
// ---------------------------------------------------------------------------

/**
 * Definition of a source-chain event the feeder listens for. The pipeline
 * decodes logs against `abi`, projects them through `data_extraction`,
 * and optionally enriches via a view-call described by `enrichment`.
 *
 * Today there is exactly one event definition: `IntentRegistered`
 * with an enrichment that calls
 * `OracleIntentRegistry.getIntent(intentHash)`.
 */
export type EventDefinition = {
  contract: string;
  abi: string;
  data_extraction: Record<string, string>;
  enrichment?: EnrichmentConfig;
};

export type EnrichmentConfig = {
  contract?: string;
  method: string;
  abi?: string;
  params: string[];
  returns: Record<string, string>;
};

// ---------------------------------------------------------------------------
// routers/*.yaml
// ---------------------------------------------------------------------------

/**
 * A router binds a source-event subscription (with optional filters) to
 * one or more Cardano destinations for exactly one on-chain client
 * deployment. A customer can own multiple clients, and each client can
 * have multiple routers/policies.
 */
export type RouterConfig = {
  id: string;
  name: string;
  /** Business/operator grouping above the on-chain client deployment. */
  customer_id: string;
  type: string;
  enabled: boolean;
  private_key?: string;
  private_key_env?: string;
  triggers: RouterTriggers;
  processing: ProcessingConfig;
  destinations: RouterDestination[];
};

export type RouterTriggers = {
  events: string[];
  conditions?: TriggerCondition[];
};

/** One condition in a router's filter chain. ALL conditions must pass
 *  (logical AND) for the router to dispatch — matches Spectra's semantics. */
export type TriggerCondition = {
  field: string;
  operator: TriggerConditionOperator;
  value: unknown;
};

export type TriggerConditionOperator =
  | "in"
  | "not_in"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains";

export type ProcessingConfig = {
  /** Which pipeline stage feeds the destination payload templating.
   *  `enrichment` is the default for IntentRegistered (we want the full
   *  intent, not just the log's intentHash). */
  datasource: "event" | "enrichment" | "processed";
  transformations?: Transformation[];
  /** Spectra naming preserved verbatim (single-word, no underscore). */
  validationenabled?: boolean;
};

export type Transformation = {
  field: string;
  operation: string;
  input: string;
  params?: Record<string, unknown>;
};

/**
 * A single destination. Spectra-native destinations carry a `method:`
 * block (EVM ABI call). This feeder routes Cardano destinations
 * through a parallel `cardano:` block. Validation rejects both-or-neither.
 */
export type RouterDestination = {
  chain_id?: number;
  contract?: string;
  contract_ref?: string;
  method?: DestinationMethodConfig;
  cardano?: CardanoDestinationConfig;
  condition?: string;
  time_threshold?: string;
  price_deviation?: string;
  /**
   * Per-destination upper bound on on-chain staleness (duration string,
   * e.g. "1h"). Opt-in / default OFF. Only meaningful in the
   * deviation-only push mode, i.e. when `time_threshold` is "0s"/absent
   * (no short periodic heartbeat). In that mode the policy gate passes an
   * update when the price deviates OR when the last confirmed on-chain
   * update is older than `max_staleness`, and the cron service uses
   * `max_staleness` (instead of the short `time_threshold`) as the
   * resubmission ceiling — fewer Cardano txs and lower fees for clients
   * who do not need a tight time cadence.
   *
   * When `time_threshold` > 0 this field is ignored: the existing
   * `time_threshold || price_deviation` behaviour is preserved unchanged.
   *
   * Parsed with `parseDurationMs` (see `src/router/policy.ts`). Consumer
   * trade-off and mitigations are documented in the policy.ts module
   * header.
   */
  max_staleness?: string;
  cron?: boolean;
  gas_limit?: number;
  gas_multiplier?: number;
  max_gas_price?: string;
};

export type DestinationMethodConfig = {
  name: string;
  abi: string;
  params: Record<string, string>;
  value?: string;
  gas_limit?: number;
  gas_multiplier?: number;
};

/**
 * Feeder extension over Spectra: a Cardano destination is addressed by
 * the (network, client_state, protocol_state) tuple instead of by an
 * EVM `(chain_id, contract, method_abi)` triple.
 */
export type CardanoDestinationConfig = {
  network: "Preview" | "Mainnet";
  client_state_path: string;
  protocol_state_path: string;
};
