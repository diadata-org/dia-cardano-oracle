// Prometheus metrics registry.
//
// The feeder exports a Spectra-aligned metric surface under the
// `dia_bridge_*` prefix by default. Every series carries constant
// labels injected at registry creation time so dashboards can separate
// Cardano-destination feeders from other bridge deployments.

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
  scanToProcessingSeconds: FeedHistogram;
  processingToSubmissionSeconds: FeedHistogram;
  submissionToConfirmationSeconds: FeedHistogram;
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
  cardanoPairIsCreate: noopGauge,
  cronResubmissions: noopCounter,
  httpRequests: noopCounter,
  httpRequestDurationSeconds: noopHistogram,
  getMetricsText: async () => "",
};

export type MetricsOptions = {
  namespace?: string;
  defaultLabels?: Record<string, string>;
};

const LATENCY_BUCKETS = [0.5, 1, 5, 15, 30, 60, 120, 300, 600];
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

  const namespace = options.namespace ?? "dia_bridge";
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

  function gauge(name: string, help: string, labelNames: string[] = []): FeedGauge {
    const metric = new Gauge({ name: `${namespace}_${name}`, help, labelNames, registers: [registry] });
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
    scanToProcessingSeconds: histogram(
      "scan_to_processing_seconds",
      "Seconds from scanner delivery to per-intent processing start",
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
      "Receiver UTxO `balanceLovelace` — ADA available to pay oracle update fees. Below the configured `alerting.receiver_balance_low_lovelace` threshold the feeder also increments `cardano_receiver_topup_warnings_total`.",
      ["client_id"],
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
    ),
    cardanoAdminWalletLovelace: gauge(
      "cardano_admin_wallet_lovelace",
      "Total lovelace held by the admin/signer wallet that pays Cardano tx fees. Below `alerting.admin_wallet_low_lovelace` the operator must refill the wallet or oracle updates will stall.",
      [],
    ),
    cardanoReceiverTopupWarnings: counter(
      "cardano_receiver_topup_warnings_total",
      "Number of times the feeder observed a Receiver `balanceLovelace` below `alerting.receiver_balance_low_lovelace` after a confirmed tx.",
      ["client_id"],
    ),
    cardanoPairIsCreate: gauge(
      "cardano_pair_is_create",
      "Whether the last confirmed submission for a symbol minted the pair (1) or updated it (0)",
      ["symbol", "client_id"],
    ),
    cronResubmissions: counter(
      "cron_resubmissions_total",
      "Cron-service resubmission decisions, partitioned by outcome (Spectra-parity counterpart of `internal/cron`).",
      ["router_id", "symbol", "client_id", "outcome"],
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
