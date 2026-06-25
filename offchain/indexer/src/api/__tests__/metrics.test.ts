// Indexer metrics — mirrors the feeder's prom-client registry pattern, exposing
// the SAME `dia_bridge_provider_requests_total` counter so a Prometheus
// `sum by (provider)` folds the indexer's Blockfrost/Koios usage in with the
// feeder's.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createIndexerMetrics } from "../metrics.js";

describe("createIndexerMetrics", () => {
  it("exposes dia_bridge_provider_requests_total with provider/method/outcome labels", async () => {
    const metrics = await createIndexerMetrics();

    metrics.recordProviderCall({ provider: "Blockfrost", method: "getUtxos", outcome: "ok" });
    metrics.recordProviderCall({ provider: "Blockfrost", method: "getUtxos", outcome: "ok" });
    metrics.recordProviderCall({ provider: "Blockfrost", method: "tip", outcome: "error" });

    const text = await metrics.getMetricsText();

    assert.match(text, /# TYPE dia_bridge_provider_requests_total counter/);
    assert.match(
      text,
      /dia_bridge_provider_requests_total\{provider="Blockfrost",method="getUtxos",outcome="ok"\} 2/,
    );
    assert.match(
      text,
      /dia_bridge_provider_requests_total\{provider="Blockfrost",method="tip",outcome="error"\} 1/,
    );
  });

  it("returns parseable Prometheus text even before any call is recorded", async () => {
    const metrics = await createIndexerMetrics();
    const text = await metrics.getMetricsText();
    // collectDefaultMetrics is registered, so the process metrics are present.
    assert.match(text, /process_cpu_seconds_total/);
  });

  it("stamps the default labels (network) on every series, like the feeder", async () => {
    const metrics = await createIndexerMetrics({
      defaultLabels: { destination_chain: "cardano", network: "Preview" },
    });
    metrics.recordProviderCall({ provider: "Blockfrost", method: "getUtxos", outcome: "ok" });
    const text = await metrics.getMetricsText();

    // The counter line now carries network — so a $network-filtered query matches it.
    assert.match(text, /dia_bridge_provider_requests_total\{[^}]*network="Preview"[^}]*\} 1/);
    assert.match(text, /provider="Blockfrost"/);
  });
});
