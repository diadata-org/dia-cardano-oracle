import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAlertmanagerWebhook,
  ingestNormalizedAlerts,
  type NormalizedAlert,
} from "../webhook.js";

describe("normalizeAlertmanagerWebhook", () => {
  it("normalizes a firing alert, using the summary as the message", () => {
    const out = normalizeAlertmanagerWebhook({
      alerts: [
        {
          status: "firing",
          fingerprint: "abc",
          labels: { alertname: "OraclePairStale", severity: "warning", symbol: "BTC/USD" },
          annotations: { summary: "BTC/USD stale", description: "long text" },
        },
      ],
    });

    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      fingerprint: "abc",
      name: "OraclePairStale",
      severity: "warning",
      message: "BTC/USD stale",
      labels: { alertname: "OraclePairStale", severity: "warning", symbol: "BTC/USD" },
      status: "firing",
    });
  });

  it("marks resolved alerts, defaults severity to warning, falls back to the name as message", () => {
    const out = normalizeAlertmanagerWebhook({
      alerts: [
        { status: "resolved", fingerprint: "x", labels: { alertname: "FeedAccuracyFail" }, annotations: {} },
      ],
    });

    assert.equal(out[0].status, "resolved");
    assert.equal(out[0].severity, "warning");
    assert.equal(out[0].message, "FeedAccuracyFail");
  });

  it("returns an empty list for a payload with no alerts", () => {
    assert.deepEqual(normalizeAlertmanagerWebhook({}), []);
  });
});

describe("ingestNormalizedAlerts", () => {
  it("records new firing alerts, skips already-active ones, resolves active ones", async () => {
    const recorded: NormalizedAlert[] = [];
    const resolved: number[] = [];
    const deps = {
      listActiveFingerprints: async () => [{ id: 7, fingerprint: "active-fp" }],
      record: async (a: NormalizedAlert) => {
        recorded.push(a);
        return 99;
      },
      resolve: async (id: number) => {
        resolved.push(id);
      },
      nowMs: 1000,
    };
    const alerts: NormalizedAlert[] = [
      { fingerprint: "new-fp", name: "A", severity: "warning", message: "m", labels: {}, status: "firing" },
      { fingerprint: "active-fp", name: "B", severity: "warning", message: "m", labels: {}, status: "firing" },
      { fingerprint: "active-fp", name: "B", severity: "warning", message: "m", labels: {}, status: "resolved" },
      { fingerprint: "unknown-fp", name: "C", severity: "warning", message: "m", labels: {}, status: "resolved" },
    ];

    const summary = await ingestNormalizedAlerts(alerts, deps);

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.fingerprint, "new-fp");
    assert.deepEqual(resolved, [7]);
    assert.deepEqual(summary, { recorded: 1, resolved: 1, skipped: 2 });
  });
});
