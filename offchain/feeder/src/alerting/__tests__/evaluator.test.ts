import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startAlertEvaluator } from "../evaluator.js";
import { createPriceCache } from "../../processor/price-cache.js";
import type { AlertLogRow, Db } from "../../persistence/index.js";

function makeDb(overrides: {
  recordAlert?: (args: { name: string; severity: string; message: string; labels?: Record<string, string> }) => Promise<number>;
  resolveAlert?: (id: number, resolvedAtMs: number) => Promise<void>;
} = {}): Db {
  const alerts: AlertLogRow[] = [];
  let nextId = 1;

  return {
    async migrate() {},
    async close() {},
    async initialiseChainState() {},
    async setLastProcessedBlock() {},
    async setLastScanBlock() {},
    async setChainHealth() {},
    async getChainState() { return null; },
    async listChainStates() { return []; },
    async upsertProcessedEvent() {},
    async hasProcessedEvent() { return false; },
    async getProcessedEvent() { return null; },
    async listProcessedEvents() { return []; },
    async insertTransactionLog() {},
    async updateTransactionLog() {},
    async getTransactionLog() { return []; },
    async getTransactionsByHash() { return []; },
    async listTransactions() { return []; },
    async listSymbolUpdates() { return []; },
    async upsertContractSymbolUpdate() {},
    async getContractSymbolUpdate() { return null; },
    async listContractSymbolUpdates() { return []; },
    async recordPerformanceMetric() {},
    async queryPerformanceMetrics() { return []; },
    async recordAlert(args) {
      if (overrides.recordAlert) return overrides.recordAlert(args);
      const id = nextId++;
      alerts.push({
        id,
        alertName: args.name,
        severity: args.severity as AlertLogRow["severity"],
        message: args.message,
        labelsJson: JSON.stringify(args.labels ?? {}),
        firedAtMs: Date.now(),
        acknowledged: false,
      });
      return id;
    },
    async resolveAlert(id, resolvedAtMs) {
      if (overrides.resolveAlert) return overrides.resolveAlert(id, resolvedAtMs);
      const alert = alerts.find((a) => a.id === id);
      if (alert) alert.resolvedAtMs = resolvedAtMs;
    },
    async acknowledgeAlert() {},
    async listAlerts() { return alerts; },
    async getAlertById(id) { return alerts.find((a) => a.id === id) ?? null; },
    async pruneOldRows() { return { processedEvents: 0, transactionLog: 0, alertLog: 0, performanceMetrics: 0 }; },
    async getLastProcessedBlock() { return null; },
  };
}

describe("startAlertEvaluator", () => {
  it("fires OraclePairStale when a price entry is older than the threshold", async () => {
    const firedAlerts: { name: string; labels?: Record<string, string> }[] = [];
    const db = makeDb({
      recordAlert: async (args) => {
        firedAlerts.push({ name: args.name, labels: args.labels });
        return firedAlerts.length;
      },
    });

    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      {
        symbol: "BTC/USD",
        price: 100_000n,
        timestamp: 1_700_000_000n,
        intentHash: "0xabc",
        updatedAtMs: 1_000,
      },
    );

    const controller = new AbortController();
    const handle = startAlertEvaluator({
      db,
      priceCache: cache,
      evaluationIntervalMs: 1,
      pairStalenessThresholdMs: 0, // Threshold of 0 means any entry is stale.
      signal: controller.signal,
    });

    // Give the evaluator one tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await handle.done;

    assert.ok(firedAlerts.some((a) => a.name === "OraclePairStale" && a.labels?.symbol === "BTC/USD"),
      "Expected OraclePairStale to fire for BTC/USD");
  });

  it("resolves OraclePairStale when the condition clears", async () => {
    const resolvedIds: number[] = [];
    let alertId = 0;

    const db = makeDb({
      recordAlert: async () => {
        alertId = 42;
        return alertId;
      },
      resolveAlert: async (id) => {
        resolvedIds.push(id);
      },
    });

    // Use a controlled clock so we can advance time.
    let fakeNow = 1_000;
    const cache = createPriceCache({ now: () => fakeNow });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ETH/USD" },
      {
        symbol: "ETH/USD",
        price: 2_000n,
        timestamp: 1_700_000_000n,
        intentHash: "0xdef",
        updatedAtMs: fakeNow,
      },
    );

    // First, advance time so the entry is stale.
    fakeNow = 1_000 + 400_000; // 400 s > 300 s threshold

    const controller = new AbortController();
    const handle = startAlertEvaluator({
      db,
      priceCache: cache,
      evaluationIntervalMs: 5,
      pairStalenessThresholdMs: 300_000,
      signal: controller.signal,
    });

    // Wait for the first evaluation to fire the alert.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alertId, 42, "Alert should have been recorded");

    // Now update the cache entry to clear the staleness.
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ETH/USD" },
      {
        symbol: "ETH/USD",
        price: 2_100n,
        timestamp: 1_700_000_001n,
        intentHash: "0xdef2",
        updatedAtMs: fakeNow, // fresh
      },
    );
    // Reset fakeNow so the entry is fresh relative to the threshold.
    fakeNow = Date.now();
    // Re-set the entry with the real fresh time.
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ETH/USD" },
      {
        symbol: "ETH/USD",
        price: 2_100n,
        timestamp: 1_700_000_001n,
        intentHash: "0xdef2",
        updatedAtMs: fakeNow,
      },
    );

    // Wait for the second evaluation to resolve the alert.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await handle.done;

    assert.ok(resolvedIds.includes(42), "Expected alert 42 to be resolved");
  });

  it("does not re-fire the same alert if condition persists", async () => {
    let fireCount = 0;
    const db = makeDb({
      recordAlert: async () => {
        fireCount++;
        return fireCount;
      },
    });

    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ADA/USD" },
      {
        symbol: "ADA/USD",
        price: 1n,
        timestamp: 1_700_000_000n,
        intentHash: "0x999",
        updatedAtMs: 1_000,
      },
    );

    const controller = new AbortController();
    const handle = startAlertEvaluator({
      db,
      priceCache: cache,
      evaluationIntervalMs: 5,
      pairStalenessThresholdMs: 0,
      signal: controller.signal,
    });

    // Let it run multiple evaluation cycles.
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await handle.done;

    // Should only fire once despite multiple cycles.
    assert.equal(fireCount, 1, "Alert should only be fired once while condition persists");
  });
});
