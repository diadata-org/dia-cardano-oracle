// Prometheus metrics registry.
//
// The feeder exports a Spectra-aligned metric surface under the
// `dia_bridge_*` prefix by default. Every series carries constant
// labels injected at registry creation time so dashboards can separate
// Cardano-destination feeders from other bridge deployments.

import { METRICS_NAMESPACE, METRICS_WARN_THROTTLE_MS } from "../config/constants.js";

export type FeedCounter = {
  inc(labels?: Record<string, string>, value?: number): void;
};

export type FeedGauge = {
  set(labels: Record<string, string>, value: number): void;
};

export type FeedHistogram = {
  observe(labels: Record<string, string>, value: number): void;
};

export type FeederMetrics = {
  eventsDetected: FeedCounter;
  eventsDuplicate: FeedCounter;
  eventsInvalid: FeedCounter;
  intentsScanned: FeedCounter;
  intentsRouted: FeedCounter;
  intentsFiltered: FeedCounter;
  transactionsSubmitted: FeedCounter;
  transactionsConfirmed: FeedCounter;
  transactionsFailed: FeedCounter;
  transactionsReorg: FeedCounter;
  /** One increment per Cardano TRANSACTION (not per symbol), partitioned by
   *  `outcome` (confirmed|failed). A batch of N pairs is a single tx → a single
   *  increment, unlike `transactionsConfirmed`/`transactionsFailed` which count
   *  per symbol. Condemned/superseded intents the feeder declined to submit
   *  (no tx broadcast, no fee) are excluded — see `isNoTransactionFailure`. */
  transactionsTotal: FeedCounter;
  /** Distribution of pairs-per-transaction (batch size), one observation per
   *  tx, partitioned by `outcome`. Answers "how big are our batches". */
  transactionPairs: FeedHistogram;
  /** One increment per (transaction, symbol): which pairs each tx touched,
   *  partitioned by `outcome`. Lets a dashboard filtered by symbol surface the
   *  transactions that included that pair without inflating the pure tx counts
   *  in `transactionsTotal` (a 5-pair tx adds 5 here, 1 there). */
  txPairMembership: FeedCounter;
  /** Tx-level seconds from processing start to submission, one observation per
   *  confirmed tx (the per-symbol counterpart is `processingToSubmissionSeconds`). */
  txProcessingToSubmissionSeconds: FeedHistogram;
  /** Tx-level seconds from submission to confirmation, one observation per
   *  confirmed tx (per-symbol counterpart: `submissionToConfirmationSeconds`). */
  txSubmissionToConfirmationSeconds: FeedHistogram;
  /** Tx-level end-to-end seconds (processing start → confirmation), one
   *  observation per confirmed tx (per-symbol counterpart: `endToEndLatencySeconds`). */
  txEndToEndSeconds: FeedHistogram;
  /** Spectra phase 1: seconds from oracle intent creation (price timestamp) to
   *  on-chain registration (block timestamp). Requires `blockTimestamp` in
   *  `ExtractedEvent`. Zero-valued when blockTimestamp is unavailable. */
  intentToRegistrationSeconds: FeedHistogram;
  /** Spectra phase 2: seconds from on-chain registration (block timestamp) to
   *  scanner delivery. Measures transport + polling latency. */
  registrationToScanSeconds: FeedHistogram;
  /** Spectra phase 3: seconds from scanner delivery to per-intent processing start. */
  scanToProcessingSeconds: FeedHistogram;
  /** Spectra phase 4: seconds from per-intent processing start to Cardano submission. */
  processingToSubmissionSeconds: FeedHistogram;
  /** Spectra phase 5: seconds from Cardano submission to confirmation. */
  submissionToConfirmationSeconds: FeedHistogram;
  /** Spectra phase 6: feeder-side end-to-end latency (processing start → confirmation). */
  endToEndLatencySeconds: FeedHistogram;
  priceDeviationPercent: FeedHistogram;
  priceAgeSeconds: FeedHistogram;
  scannerLastBlock: FeedGauge;
  scannerBlockLag: FeedGauge;
  scannerRpcErrors: FeedCounter;
  /** Total source blocks fast-backfilled when the scanner detected a gap
   *  larger than `block_scanner.max_block_gap`. Counts blocks (not chunks).
   *  Stays at 0 during normal catch-up via `block_scanner.block_range`. */
  scannerBackfillBlocks: FeedCounter;
  /** Number of backfill chunks executed (one per `eth_getLogs` call inside
   *  the gap-recovery loop). Useful to size the chunk constant against
   *  provider rate limits. */
  scannerBackfillChunks: FeedCounter;
  cardanoOracleLastConfirmedTimestampSeconds: FeedGauge;
  cardanoReceiverBalanceLovelace: FeedGauge;
  /** Fees accumulated in the Receiver UTxO (`accruedToHookLovelace`) that
   *  are pending transfer to the PaymentHook via a `settle` tx. High
   *  values mean settle is overdue. Per client. */
  cardanoReceiverAccruedLovelace: FeedGauge;
  /** Fees accumulated in the PaymentHook UTxO (`accruedFeesLovelace`)
   *  available for DIA to withdraw via `payment-hook:withdraw`. Singleton
   *  across the protocol — no labels. */
  cardanoPaymentHookAccruedLovelace: FeedGauge;
  /** Total lovelace held by the admin (signer) wallet that pays Cardano
   *  tx fees. Singleton — no labels. */
  cardanoAdminWalletLovelace: FeedGauge;
  cardanoReceiverTopupWarnings: FeedCounter;
  /** Sum of clean, un-merged ADA deposits waiting at the client's side-deposit
   *  address (`receiver.depositValidatorAddress`). A `deposit:merge` folds
   *  these into the Receiver balance. Per client + deposit address. Above
   *  `alerting.deposit_pending_merge_lovelace` the daemon auto-merges (and the
   *  ReceiverDepositsPending alert fires). */
  cardanoDepositPendingLovelace: FeedGauge;
  cardanoPairIsCreate: FeedGauge;
  /** Cron service resubmissions — Spectra parity. One increment per
   *  cron tick decision, partitioned by `outcome`:
   *    - "submitted"             — cron pushed the cached intent on chain
   *    - "skipped_already_fresh" — cache matches the on-chain intent
   *    - "skipped_no_intent"     — no cached intent for this symbol
   *    - "skipped_uninitialised" — no confirmed update has ever happened
   *      (the event-driven flow has to mint the pair first).
   */
  cronResubmissions: FeedCounter;
  httpRequests: FeedCounter;
  httpRequestDurationSeconds: FeedHistogram;
  /** Current number of active (executing) workers, partitioned by pool type. */
  activeWorkers: FeedGauge;              // dia_bridge_active_workers{pool_type}
  /** Configured concurrency limit per pool type. */
  workerPoolSize: FeedGauge;             // dia_bridge_worker_pool_size{pool_type}
  /** Tasks/events currently waiting in the pool queue, partitioned by pool type. */
  workerQueueSize: FeedGauge;            // dia_bridge_worker_queue_size{pool_type}
  /** Total tasks/events successfully processed across all pools. */
  workerTasksCompleted: FeedCounter;     // dia_bridge_worker_tasks_completed_total
  /** Total tasks/events that failed or timed out across all pools. */
  workerTasksFailed: FeedCounter;        // dia_bridge_worker_tasks_failed_total
  /** Total tasks/events dropped because the pool queue was full, partitioned by pool type. */
  workerTasksDropped: FeedCounter;       // dia_bridge_worker_tasks_dropped_total{pool_type}
  /** Total task-level retries attempted across all worker pools. */
  workerTaskRetries: FeedCounter;        // dia_bridge_worker_task_retries_total
  /** Spectra bridge_intents_scanned_total lifecycle alias. */
  bridgeIntentsScanned: FeedCounter;
  /** Spectra bridge_intents_processed_total lifecycle alias. */
  bridgeIntentsProcessed: FeedCounter;
  /** Spectra bridge_intents_submitted_total lifecycle alias. */
  bridgeIntentsSubmitted: FeedCounter;
  /** Spectra bridge_intents_confirmed_total lifecycle alias. */
  bridgeIntentsConfirmed: FeedCounter;
  /** Spectra bridge_intents_failed_total lifecycle alias. */
  bridgeIntentsFailed: FeedCounter;
  /** Cardano equivalent of EVM gas cost — lovelace paid per Cardano oracle tx. */
  bridgeTransactionFeeLovelace: FeedHistogram;
  /** bridge_db_operations_total — DB operation count by table and operation. */
  bridgeDbOperations: FeedCounter;
  /** bridge_db_operation_duration_seconds — latency histogram for DB ops. */
  bridgeDbOperationDuration: FeedHistogram;
  /** bridge_component_health{component} — 1 = healthy, 0 = unhealthy. */
  bridgeComponentHealth: FeedGauge;
  /** bridge_recovery_attempts_total — number of recovery attempts after transient errors. */
  bridgeRecoveryAttempts: FeedCounter;
  getMetricsText(): Promise<string>;
};

const noopCounter: FeedCounter = {
  inc: () => {},
};

const noopGauge: FeedGauge = {
  set: () => {},
};

const noopHistogram: FeedHistogram = {
  observe: () => {},
};

export const noopMetrics: FeederMetrics = {
  eventsDetected: noopCounter,
  eventsDuplicate: noopCounter,
  eventsInvalid: noopCounter,
  intentsScanned: noopCounter,
  intentsRouted: noopCounter,
  intentsFiltered: noopCounter,
  transactionsSubmitted: noopCounter,
  transactionsConfirmed: noopCounter,
  transactionsFailed: noopCounter,
  transactionsReorg: noopCounter,
  transactionsTotal: noopCounter,
  transactionPairs: noopHistogram,
  txPairMembership: noopCounter,
  txProcessingToSubmissionSeconds: noopHistogram,
  txSubmissionToConfirmationSeconds: noopHistogram,
  txEndToEndSeconds: noopHistogram,
  intentToRegistrationSeconds: noopHistogram,
  registrationToScanSeconds: noopHistogram,
  scanToProcessingSeconds: noopHistogram,
  processingToSubmissionSeconds: noopHistogram,
  submissionToConfirmationSeconds: noopHistogram,
  endToEndLatencySeconds: noopHistogram,
  priceDeviationPercent: noopHistogram,
  priceAgeSeconds: noopHistogram,
  scannerLastBlock: noopGauge,
  scannerBlockLag: noopGauge,
  scannerRpcErrors: noopCounter,
  scannerBackfillBlocks: noopCounter,
  scannerBackfillChunks: noopCounter,
  cardanoOracleLastConfirmedTimestampSeconds: noopGauge,
  cardanoReceiverBalanceLovelace: noopGauge,
  cardanoReceiverAccruedLovelace: noopGauge,
  cardanoPaymentHookAccruedLovelace: noopGauge,
  cardanoAdminWalletLovelace: noopGauge,
  cardanoReceiverTopupWarnings: noopCounter,
  cardanoDepositPendingLovelace: noopGauge,
  cardanoPairIsCreate: noopGauge,
  cronResubmissions: noopCounter,
  httpRequests: noopCounter,
  httpRequestDurationSeconds: noopHistogram,
  activeWorkers: noopGauge,
  workerPoolSize: noopGauge,
  workerQueueSize: noopGauge,
  workerTasksCompleted: noopCounter,
  workerTasksFailed: noopCounter,
  workerTasksDropped: noopCounter,
  workerTaskRetries: noopCounter,
  bridgeIntentsScanned: noopCounter,
  bridgeIntentsProcessed: noopCounter,
  bridgeIntentsSubmitted: noopCounter,
  bridgeIntentsConfirmed: noopCounter,
  bridgeIntentsFailed: noopCounter,
  bridgeTransactionFeeLovelace: noopHistogram,
  bridgeDbOperations: noopCounter,
  bridgeDbOperationDuration: noopHistogram,
  bridgeComponentHealth: noopGauge,
  bridgeRecoveryAttempts: noopCounter,
  getMetricsText: async () => "",
};

export type MetricsOptions = {
  namespace?: string;
  defaultLabels?: Record<string, string>;
};

const LATENCY_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 600];
const BATCH_SIZE_BUCKETS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20];
const PRICE_DEVIATION_BUCKETS = [0.01, 0.1, 0.5, 1, 5, 10];
const PRICE_AGE_BUCKETS = [1, 5, 30, 60, 300, 1800];
const HTTP_LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];

export async function createMetrics(options: MetricsOptions = {}): Promise<FeederMetrics> {
  const specifier = "prom-client";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prom = (await import(specifier)) as any;
  const { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } = prom as PromClientLike;

  const registry = new Registry();
  if (options.defaultLabels) {
    registry.setDefaultLabels(options.defaultLabels);
  }

  const namespace = options.namespace ?? METRICS_NAMESPACE;
  collectDefaultMetrics({ register: registry });

  function counter(name: string, help: string, labelNames: string[] = []): FeedCounter {
    const metric = new Counter({ name: `${namespace}_${name}`, help, labelNames, registers: [registry] });
    return {
      inc: (labels, value) => {
        if (labels && value !== undefined) {
          metric.inc(labels, value);
          return;
        }
        if (labels) {
          metric.inc(labels);
          return;
        }
        if (value !== undefined) {
          metric.inc(value);
          return;
        }
        metric.inc();
      },
    };
  }

  // `lazy` is for label-less balance gauges (admin wallet, payment-hook
  // accrued). prom-client initialises a label-less gauge to 0 at creation, so
  // a "< threshold" alert (e.g. AdminWalletLow) would fire spuriously on every
  // restart until the first confirmed tx reports the real balance. Removing the
  // default series leaves the metric ABSENT until set() reports a real value,
  // so the alert only evaluates against real data. Labelled gauges don't need
  // this — prom-client emits no series for them until a label set is written.
  function gauge(
    name: string,
    help: string,
    labelNames: string[] = [],
    lazy = false,
  ): FeedGauge {
    const metric = new Gauge({ name: `${namespace}_${name}`, help, labelNames, registers: [registry] });
    if (lazy && labelNames.length === 0) {
      metric.remove();
    }
    return {
      set: (labels, value) => metric.set(labels, value),
    };
  }

  function histogram(
    name: string,
    help: string,
    labelNames: string[],
    buckets: number[],
  ): FeedHistogram {
    const metric = new Histogram({ name: `${namespace}_${name}`, help, labelNames, buckets, registers: [registry] });
    return {
      observe: (labels, value) => metric.observe(labels, value),
    };
  }

  return {
    eventsDetected: counter(
      "events_detected_total",
      "Raw DIA source events detected by the scanner",
      ["scanner_type"],
    ),
    eventsDuplicate: counter(
      "events_duplicate_total",
      "Events rejected by the dedup cache",
    ),
    eventsInvalid: counter(
      "events_invalid_total",
      "Source events rejected during decode or enrichment",
      ["reason"],
    ),
    intentsScanned: counter(
      "intents_scanned_total",
      "Enriched intents entering the routing pipeline",
      ["symbol", "scanner_type"],
    ),
    intentsRouted: counter(
      "intents_routed_total",
      "Intents accepted by a router destination",
      ["symbol", "router_id"],
    ),
    intentsFiltered: counter(
      "intents_filtered_total",
      "Intents suppressed by conditions, policy, or preflight checks",
      ["symbol", "router_id", "reason"],
    ),
    transactionsSubmitted: counter(
      "transactions_submitted_total",
      "Cardano submission attempts broadcast to the chain",
      ["symbol", "client_id"],
    ),
    transactionsConfirmed: counter(
      "transactions_confirmed_total",
      "Cardano submission attempts confirmed on-chain",
      ["symbol", "client_id"],
    ),
    transactionsFailed: counter(
      "transactions_failed_total",
      "Cardano submission attempts that failed",
      ["symbol", "client_id", "error_code"],
    ),
    transactionsReorg: counter(
      "transactions_reorg_total",
      "Cardano transactions dropped by a rollback after submission",
      ["symbol", "client_id"],
    ),
    transactionsTotal: counter(
      "transactions_total",
      "Cardano transactions, counted once per tx (not per symbol), by outcome",
      ["client_id", "customer", "outcome"],
    ),
    transactionPairs: histogram(
      "transaction_pairs",
      "Pairs per Cardano transaction (batch size), one observation per tx",
      ["client_id", "customer", "outcome"],
      BATCH_SIZE_BUCKETS,
    ),
    txPairMembership: counter(
      "tx_pair_membership_total",
      "One increment per (transaction, symbol) — which pairs each tx touched, by outcome",
      ["client_id", "customer", "symbol", "outcome"],
    ),
    txProcessingToSubmissionSeconds: histogram(
      "tx_processing_to_submission_seconds",
      "Tx-level seconds from processing start to submission, one observation per confirmed tx",
      ["client_id", "customer"],
      LATENCY_BUCKETS,
    ),
    txSubmissionToConfirmationSeconds: histogram(
      "tx_submission_to_confirmation_seconds",
      "Tx-level seconds from submission to confirmation, one observation per confirmed tx",
      ["client_id", "customer"],
      LATENCY_BUCKETS,
    ),
    txEndToEndSeconds: histogram(
      "tx_end_to_end_seconds",
      "Tx-level end-to-end seconds (processing start to confirmation), one observation per confirmed tx",
      ["client_id", "customer"],
      LATENCY_BUCKETS,
    ),
    intentToRegistrationSeconds: histogram(
      "intent_to_registration_seconds",
      "Seconds from oracle intent creation (price timestamp) to on-chain registration (block timestamp) — Spectra latency phase 1",
      ["symbol"],
      LATENCY_BUCKETS,
    ),
    registrationToScanSeconds: histogram(
      "registration_to_scan_seconds",
      "Seconds from on-chain registration (block timestamp) to scanner delivery — Spectra latency phase 2",
      ["symbol"],
      LATENCY_BUCKETS,
    ),
    scanToProcessingSeconds: histogram(
      "scan_to_processing_seconds",
      "Seconds from scanner delivery to per-intent processing start — Spectra latency phase 3",
      ["symbol"],
      LATENCY_BUCKETS,
    ),
    processingToSubmissionSeconds: histogram(
      "processing_to_submission_seconds",
      "Seconds from per-intent processing start to Cardano submission",
      ["symbol", "client_id"],
      LATENCY_BUCKETS,
    ),
    submissionToConfirmationSeconds: histogram(
      "submission_to_confirmation_seconds",
      "Seconds from Cardano submission to confirmation",
      ["symbol", "client_id"],
      LATENCY_BUCKETS,
    ),
    endToEndLatencySeconds: histogram(
      "end_to_end_latency_seconds",
      "Seconds from feeder processing start to Cardano confirmation",
      ["symbol", "client_id"],
      LATENCY_BUCKETS,
    ),
    priceDeviationPercent: histogram(
      "price_deviation_percent",
      "Observed price deviation at policy-gating time",
      ["symbol"],
      PRICE_DEVIATION_BUCKETS,
    ),
    priceAgeSeconds: histogram(
      "price_age_seconds",
      "Age of the incoming intent price at processing time",
      ["symbol"],
      PRICE_AGE_BUCKETS,
    ),
    scannerLastBlock: gauge(
      "scanner_last_block",
      "Last block observed by the source scanner",
      ["chain_id", "scanner_type"],
    ),
    scannerBlockLag: gauge(
      "scanner_block_lag",
      "Difference between source head and last persisted block",
      ["chain_id"],
    ),
    scannerRpcErrors: counter(
      "scanner_rpc_errors_total",
      "RPC errors surfaced by the source scanner",
      ["chain_id", "error_type"],
    ),
    scannerBackfillBlocks: counter(
      "scanner_backfill_blocks_total",
      "Source blocks fast-backfilled when the scanner detected a gap larger than `block_scanner.max_block_gap`.",
      ["chain_id"],
    ),
    scannerBackfillChunks: counter(
      "scanner_backfill_chunks_total",
      "Number of backfill chunks executed during gap recovery (one per `eth_getLogs` call inside the gap-recovery loop).",
      ["chain_id"],
    ),
    cardanoOracleLastConfirmedTimestampSeconds: gauge(
      "cardano_oracle_last_confirmed_timestamp_seconds",
      "Latest confirmed oracle timestamp per symbol and client",
      ["symbol", "client_id"],
    ),
    cardanoReceiverBalanceLovelace: gauge(
      "cardano_receiver_balance_lovelace",
      "Receiver UTxO `balanceLovelace` — ADA available to pay oracle update fees. Below the configured `alerting.receiver_balance_low_lovelace` threshold the feeder also increments `cardano_receiver_topup_warnings_total`. The `receiver_address` label carries the client's on-chain Receiver script address; `deposit_address` carries the side-deposit address operators should fund.",
      ["client_id", "receiver_address", "deposit_address"],
    ),
    cardanoReceiverAccruedLovelace: gauge(
      "cardano_receiver_accrued_lovelace",
      "Receiver UTxO `accruedToHookLovelace` — fees accumulated since the last `settle` tx. When this exceeds `alerting.settle_overdue_lovelace` a settle run is overdue.",
      ["client_id"],
    ),
    cardanoPaymentHookAccruedLovelace: gauge(
      "cardano_payment_hook_accrued_lovelace",
      "PaymentHook UTxO `accruedFeesLovelace` — fees collected from receivers and pending DIA withdrawal. When this exceeds `alerting.payment_hook_withdraw_ready_lovelace` DIA can run `payment-hook:withdraw`.",
      [],
      true,
    ),
    cardanoAdminWalletLovelace: gauge(
      "cardano_admin_wallet_lovelace",
      "Total lovelace held by the admin/signer wallet that pays Cardano tx fees. Below `alerting.admin_wallet_low_lovelace` the operator must refill the wallet or oracle updates will stall. Absent until the first confirmed tx reports a real balance (avoids a spurious low-balance alert on restart).",
      [],
      true,
    ),
    cardanoReceiverTopupWarnings: counter(
      "cardano_receiver_topup_warnings_total",
      "Number of times the feeder observed a Receiver `balanceLovelace` below `alerting.receiver_balance_low_lovelace` after a confirmed tx.",
      ["client_id"],
    ),
    cardanoDepositPendingLovelace: gauge(
      "cardano_deposit_pending_lovelace",
      "Sum of clean, un-merged ADA deposits (>= 1 ADA, no native tokens / datum / dust) waiting at the client's side-deposit address. A `deposit:merge` folds these into the Receiver `balanceLovelace`. Above `alerting.deposit_pending_merge_lovelace` the daemon auto-merges and the ReceiverDepositsPending alert fires. The `deposit_address` label carries the per-client deposit script address (also logged once at startup) so operators can hand it out. Labelled — prom-client emits no series until a real value is written, so no spurious 0 on restart.",
      ["client_id", "deposit_address"],
    ),
    cardanoPairIsCreate: gauge(
      "cardano_pair_is_create",
      "Whether the last confirmed submission for a symbol minted the pair (1) or updated it (0)",
      ["symbol", "client_id"],
    ),
    cronResubmissions: counter(
      "cron_resubmissions_total",
      "Cron-service resubmission decisions, partitioned by outcome (Spectra-parity counterpart of `internal/cron`).",
      ["router_id", "symbol", "client_id", "customer", "outcome"],
    ),
    httpRequests: counter(
      "http_requests_total",
      "HTTP requests served by the feeder API",
      ["method", "endpoint", "status"],
    ),
    httpRequestDurationSeconds: histogram(
      "http_request_duration_seconds",
      "HTTP request latency for the feeder API",
      ["method", "endpoint"],
      HTTP_LATENCY_BUCKETS,
    ),
    activeWorkers: gauge(
      "active_workers",
      "Number of workers currently executing a task, partitioned by pool type",
      ["pool_type"],
    ),
    workerPoolSize: gauge(
      "worker_pool_size",
      "Configured concurrency limit for the worker pool, partitioned by pool type",
      ["pool_type"],
    ),
    workerQueueSize: gauge(
      "worker_queue_size",
      "Tasks currently waiting in the pool queue, partitioned by pool type",
      ["pool_type"],
    ),
    workerTasksCompleted: counter(
      "worker_tasks_completed_total",
      "Total tasks successfully completed across all worker pools",
    ),
    workerTasksFailed: counter(
      "worker_tasks_failed_total",
      "Total tasks that failed or timed out across all worker pools",
    ),
    workerTasksDropped: counter(
      "worker_tasks_dropped_total",
      "Total tasks dropped because the pool queue was full, partitioned by pool type",
      ["pool_type"],
    ),
    workerTaskRetries: counter(
      "worker_task_retries_total",
      "Total task-level retries attempted across all worker pools",
    ),
    bridgeIntentsScanned: counter(
      "intents_scanned_lifecycle_total",
      "Intents scanned — Spectra bridge_intents_scanned_total lifecycle alias",
      ["symbol", "scanner_type"],
    ),
    bridgeIntentsProcessed: counter(
      "intents_processed_lifecycle_total",
      "Intents processed — Spectra bridge_intents_processed_total lifecycle alias",
      ["symbol", "customer"],
    ),
    bridgeIntentsSubmitted: counter(
      "intents_submitted_lifecycle_total",
      "Intents submitted to Cardano — Spectra bridge_intents_submitted_total lifecycle alias",
      ["symbol", "client_id", "customer"],
    ),
    bridgeIntentsConfirmed: counter(
      "intents_confirmed_lifecycle_total",
      "Intents confirmed on Cardano — Spectra bridge_intents_confirmed_total lifecycle alias",
      ["symbol", "client_id", "customer"],
    ),
    bridgeIntentsFailed: counter(
      "intents_failed_lifecycle_total",
      "Intents failed — Spectra bridge_intents_failed_total lifecycle alias",
      ["symbol", "client_id", "customer", "reason"],
    ),
    bridgeTransactionFeeLovelace: histogram(
      "transaction_fee_lovelace",
      "Lovelace paid per Cardano oracle update transaction (Cardano equivalent of EVM gas cost)",
      ["symbol", "client_id", "customer"],
      [10_000, 50_000, 100_000, 200_000, 500_000, 1_000_000, 2_000_000],
    ),
    bridgeDbOperations: counter(
      "db_operations_total",
      "Database operations by table and operation type",
      ["table", "operation"],
    ),
    bridgeDbOperationDuration: histogram(
      "db_operation_duration_seconds",
      "Database operation latency",
      ["table", "operation"],
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    ),
    bridgeComponentHealth: gauge(
      "component_health",
      "Component health status: 1 = healthy, 0 = unhealthy",
      ["component"],
    ),
    bridgeRecoveryAttempts: counter(
      "recovery_attempts_total",
      "Number of recovery attempts after transient errors",
      ["component", "reason"],
    ),
    getMetricsText: () => registry.metrics(),
  };
}

type PromClientLike = {
  Registry: new () => {
    setDefaultLabels(labels: Record<string, string>): void;
    metrics(): Promise<string>;
  };
  Counter: new (opts: {
    name: string;
    help: string;
    labelNames: string[];
    registers: unknown[];
  }) => {
    inc(labels?: Record<string, string>, value?: number): void;
    inc(value: number): void;
  };
  Gauge: new (opts: {
    name: string;
    help: string;
    labelNames: string[];
    registers: unknown[];
  }) => {
    set(labels: Record<string, string>, value: number): void;
    // Drop a series so the metric stays absent until the next set(). Used to
    // suppress the default 0 that label-less gauges report at creation.
    remove(...values: string[]): void;
  };
  Histogram: new (opts: {
    name: string;
    help: string;
    labelNames: string[];
    buckets: number[];
    registers: unknown[];
  }) => {
    observe(labels: Record<string, string>, value: number): void;
  };
  collectDefaultMetrics(opts: { register: unknown }): void;
};

// ---------------------------------------------------------------------------
// R3.7 — Persistent metrics wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap specific counters so their `inc()` calls ALSO write to the
 * `performance_metrics` table. Counters wrapped are those whose values
 * survive a restart and are useful for historical trend queries:
 * transactionsSubmitted, transactionsConfirmed, transactionsFailed,
 * intentsFiltered, cronResubmissions.
 *
 * Wrapping is transparent — callers use the same FeederMetrics interface.
 * Persistence failures are non-fatal (Prometheus metrics still work) but are
 * now surfaced via a throttled log line so operators can see when the
 * DB-backed `/performance` endpoint is returning stale data, instead of the
 * failures vanishing into an empty catch.
 */
export function wrapWithPersistence(
  db: import("../persistence/db.js").Db,
  metrics: FeederMetrics,
  log?: (line: string) => void,
): FeederMetrics {
  // Throttle the persistence-failure warning to at most once per minute so a
  // sustained DB outage does not flood the log on every counter increment.
  let lastWarnMs = 0;
  function warnPersistFailure(name: string, err: unknown): void {
    if (!log) return;
    const now = Date.now();
    if (now - lastWarnMs < METRICS_WARN_THROTTLE_MS) return;
    lastWarnMs = now;
    log(`[warn] metrics: performance_metrics persistence failing (latest: ${name} — ${String(err)}); /performance may be stale`);
  }

  function persistentCounter(original: FeedCounter, name: string): FeedCounter {
    return {
      inc(labels, value) {
        original.inc(labels, value);
        db.recordPerformanceMetric({ name, value: value ?? 1, labels }).catch((err: unknown) => {
          // Persistence failures are non-fatal — Prometheus metrics still
          // work — but are surfaced (throttled) rather than swallowed.
          warnPersistFailure(name, err);
        });
      },
    };
  }

  return {
    ...metrics,
    transactionsSubmitted: persistentCounter(metrics.transactionsSubmitted, "transactions_submitted_total"),
    transactionsConfirmed: persistentCounter(metrics.transactionsConfirmed, "transactions_confirmed_total"),
    transactionsFailed: persistentCounter(metrics.transactionsFailed, "transactions_failed_total"),
    intentsFiltered: persistentCounter(metrics.intentsFiltered, "intents_filtered_total"),
    cronResubmissions: persistentCounter(metrics.cronResubmissions, "cron_resubmissions_total"),
  };
}
