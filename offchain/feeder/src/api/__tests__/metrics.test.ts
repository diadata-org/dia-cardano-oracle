import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMetrics } from "../metrics.js";

describe("createMetrics", () => {
  it("uses the dia_bridge namespace and applies default labels", async () => {
    const metrics = await createMetrics({
      defaultLabels: {
        destination_chain: "cardano",
        network: "Preview",
        source_chain_id: "10050",
      },
    });

    metrics.eventsDetected.inc({ scanner_type: "http" });

    const text = await metrics.getMetricsText();
    assert.match(text, /dia_bridge_events_detected_total/);
    assert.match(text, /destination_chain="cardano"/);
    assert.match(text, /network="Preview"/);
    assert.match(text, /source_chain_id="10050"/);
    assert.match(text, /scanner_type="http"/);
  });

  it("honours a custom namespace override", async () => {
    const metrics = await createMetrics({ namespace: "custom_bridge" });
    metrics.eventsDuplicate.inc();

    const text = await metrics.getMetricsText();
    assert.match(text, /custom_bridge_events_duplicate_total/);
  });
});
