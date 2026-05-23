// Prometheus metrics registry.
//
// All counters and histograms that the feeder exports are defined here.
// The API server serves them on GET /metrics.
//
// Uses `prom-client` (optional dep). If the package is absent and
// METRICS_ENABLED != "true", the module exports no-op stubs so the
// rest of the feeder always has something to call.

// ---------------------------------------------------------------------------
// Interface — used everywhere so callers never import prom-client directly.
// ---------------------------------------------------------------------------

export type FeedCounter = { inc(labels?: Record<string, string>): void };
export type FeedHistogram = { observe(labels: Record<string, string>, value: number): void };

export type FeederMetrics = {
  eventsScanned: FeedCounter;
  eventsDedupHit: FeedCounter;
  intentsRouted: FeedCounter;
  intentsFiltered: FeedCounter;
  cardanoTxSubmitted: FeedCounter;
  cardanoTxConfirmed: FeedCounter;
  cardanoTxFailed: FeedCounter;
  /** Seconds from IntentRegistered event to Cardano tx confirmation. */
  intentToConfirmSeconds: FeedHistogram;
  /** Returns the full Prometheus text format. */
  getMetricsText(): Promise<string>;
};

// ---------------------------------------------------------------------------
// No-op implementation — used when metrics are disabled.
// ---------------------------------------------------------------------------

const noop: FeedCounter = { inc: () => {} };
const noopHist: FeedHistogram = { observe: () => {} };

export const noopMetrics: FeederMetrics = {
  eventsScanned: noop,
  eventsDedupHit: noop,
  intentsRouted: noop,
  intentsFiltered: noop,
  cardanoTxSubmitted: noop,
  cardanoTxConfirmed: noop,
  cardanoTxFailed: noop,
  intentToConfirmSeconds: noopHist,
  getMetricsText: async () => "",
};

// ---------------------------------------------------------------------------
// Real implementation using prom-client.
// ---------------------------------------------------------------------------

export type MetricsOptions = {
  namespace?: string;
  /** Default labels added to every metric (e.g. { network: "Preview" }). */
  defaultLabels?: Record<string, string>;
};

export async function createMetrics(options: MetricsOptions = {}): Promise<FeederMetrics> {
  const specifier = "prom-client";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prom = (await import(specifier)) as any;

  const { Registry, Counter, Histogram, collectDefaultMetrics } = prom as PromClientLike;
  const registry = new Registry();

  if (options.defaultLabels) {
    registry.setDefaultLabels(options.defaultLabels);
  }

  const ns = options.namespace ?? "dia_feeder";

  collectDefaultMetrics({ register: registry });

  function counter(name: string, help: string, labelNames: string[] = []): FeedCounter {
    const c = new Counter({ name: `${ns}_${name}`, help, labelNames, registers: [registry] });
    return { inc: (labels) => (labels ? c.inc(labels) : c.inc()) };
  }

  function histogram(name: string, help: string, labelNames: string[], buckets: number[]): FeedHistogram {
    const h = new Histogram({ name: `${ns}_${name}`, help, labelNames, buckets, registers: [registry] });
    return { observe: (labels, value) => h.observe(labels, value) };
  }

  return {
    eventsScanned:     counter("events_scanned_total",      "EVM IntentRegistered events decoded",        ["chain_id"]),
    eventsDedupHit:    counter("events_dedup_hit_total",    "Events rejected by the dedup cache",         ["chain_id"]),
    intentsRouted:     counter("intents_routed_total",      "Intents dispatched to at least one router",  ["router_id"]),
    intentsFiltered:   counter("intents_filtered_total",    "Intents filtered by conditions or policy",   ["router_id", "reason"]),
    cardanoTxSubmitted:counter("cardano_tx_submitted_total","Cardano oracle-update txs submitted",        ["network"]),
    cardanoTxConfirmed:counter("cardano_tx_confirmed_total","Cardano oracle-update txs confirmed",        ["network"]),
    cardanoTxFailed:   counter("cardano_tx_failed_total",   "Cardano oracle-update txs failed",           ["network"]),
    intentToConfirmSeconds: histogram(
      "intent_to_confirm_seconds",
      "Seconds from IntentRegistered to Cardano tx confirmation",
      ["router_id", "network"],
      [1, 5, 15, 30, 60, 120, 300, 600],
    ),
    getMetricsText: () => registry.metrics(),
  };
}

// ---------------------------------------------------------------------------
// Minimal structural types for the prom-client dynamic import.
// ---------------------------------------------------------------------------

type PromClientLike = {
  Registry: new () => {
    setDefaultLabels(labels: Record<string, string>): void;
    metrics(): Promise<string>;
  };
  Counter: new (opts: {
    name: string; help: string; labelNames: string[]; registers: unknown[];
  }) => { inc(labels?: Record<string, string>): void };
  Histogram: new (opts: {
    name: string; help: string; labelNames: string[]; buckets: number[]; registers: unknown[];
  }) => { observe(labels: Record<string, string>, value: number): void };
  collectDefaultMetrics(opts: { register: unknown }): void;
};
