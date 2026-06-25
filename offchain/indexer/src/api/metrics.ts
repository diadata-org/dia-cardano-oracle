// Prometheus metrics — the indexer's scrape surface.
//
// Mirrors the feeder's `src/api/metrics.ts` pattern: prom-client is an OPTIONAL
// dependency loaded with a dynamic `import()` and a noop fallback, the registry
// namespaces every series with `dia_bridge_*`, and `getMetricsText()` renders
// the exposition format. The single counter here is the SAME
// `dia_bridge_provider_requests_total{provider,method,outcome}` the feeder
// exposes, so Prometheus scrapes both under their own `job` label and a
// `sum by (provider)` query reports the combined Blockfrost/Koios usage on the
// shared key.

import type { ProviderCallEvent } from "@diadata-org/dia-cardano-oracle-cli/core/provider-retry";

import { METRICS_NAMESPACE } from "../constants.js";

export interface IndexerMetrics {
  /** Count one Cardano provider request — fed directly by the retrying
   *  provider's `onCall` observer (see chain-reader-providers.ts). */
  recordProviderCall(event: ProviderCallEvent): void;
  /** Prometheus exposition text for the `/metrics` scrape. */
  getMetricsText(): Promise<string>;
}

// Identical help to the feeder's counter so the merged series reads the same.
const PROVIDER_REQUESTS_HELP =
  "Cardano API provider requests by provider, method, and outcome. Each retry attempt is one request — this tracks the provider's actual quota consumption. outcome: ok | rate_limited (429 throttle) | quota_exceeded (Blockfrost 402 daily-quota wall) | error.";

/** Used when prom-client is absent: the indexer still serves queries and
 *  `/metrics` returns empty. */
export const noopMetrics: IndexerMetrics = {
  recordProviderCall: () => {},
  getMetricsText: async () => "",
};

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
  };
  collectDefaultMetrics(opts: { register: unknown }): void;
};

export type IndexerMetricsOptions = {
  /** Labels stamped on EVERY series (prom-client `setDefaultLabels`). The indexer
   *  passes `network` (+ `destination_chain`) so its series carry the SAME
   *  identifying labels the feeder's do — otherwise a `$network`-filtered query
   *  would silently drop the indexer's contribution to the shared metric. */
  defaultLabels?: Record<string, string>;
};

export async function createIndexerMetrics(options: IndexerMetricsOptions = {}): Promise<IndexerMetrics> {
  const specifier = "prom-client";
  let prom: PromClientLike;
  try {
    prom = (await import(specifier)) as unknown as PromClientLike;
  } catch {
    return noopMetrics;
  }
  const { Registry, Counter, collectDefaultMetrics } = prom;

  const registry = new Registry();
  if (options.defaultLabels) {
    registry.setDefaultLabels(options.defaultLabels);
  }
  collectDefaultMetrics({ register: registry });

  const providerRequests = new Counter({
    name: `${METRICS_NAMESPACE}_provider_requests_total`,
    help: PROVIDER_REQUESTS_HELP,
    labelNames: ["provider", "method", "outcome"],
    registers: [registry],
  });

  return {
    recordProviderCall: (event) =>
      providerRequests.inc({ provider: event.provider, method: event.method, outcome: event.outcome }),
    getMetricsText: () => registry.metrics(),
  };
}
