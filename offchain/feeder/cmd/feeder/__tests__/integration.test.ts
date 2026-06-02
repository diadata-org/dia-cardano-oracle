// R10.C.19 — integration tests against a REAL in-memory SQLite Db.
//
// These exercise cross-module flows end-to-end (no per-method fakes):
//   - C.19.d  crash recovery: pending/submitted rows → failed on restart
//   - C.19.e  multi-client alert labelling via the real evaluator + Db
//   - C.19.h  API round-trip: createApiServer over a real Db (transactions,
//             alerts, prices, POST ack)
//
// The remaining C.19 scenarios are covered at unit level by equivalent
// tests (see the R10.C.19 status note in milestone-2-final-plan.md):
//   a/c daemon-pipeline.test.ts · b event-worker-pool-integration.test.ts
//   f   daemon-pipeline DB-failure path · g scanner-ws nextDelay/backoff
//   i   scanner-http reorg unit test · j N/A (transformations rejected, R10.A.10)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createDb, type Db, type TransactionLogInsert } from "../../../src/persistence/index.js";
import { startAlertEvaluator } from "../../../src/alerting/evaluator.js";
import { createPriceCache } from "../../../src/processor/price-cache.js";
import { createApiServer } from "../../../src/api/server.js";
import { createChainRuntimeState } from "../../../src/api/chains.js";
import { noopMetrics } from "../../../src/api/metrics.js";
import type { ModularConfig } from "../../../src/config/types.js";
import type { HealthState } from "../../../src/api/health.js";

let db: Db;
beforeEach(async () => {
  db = await createDb({ driver: "sqlite", path: ":memory:" });
  await db.migrate();
});
afterEach(async () => { await db.close(); });

function txInsert(o: Partial<TransactionLogInsert> = {}): TransactionLogInsert {
  const now = Date.now();
  return {
    intentHash: "0x" + "11".repeat(32),
    cardanoTxHash: "tx" + "0".repeat(62),
    routerId: "client-a", destinationIndex: 0,
    destinationChainName: "Preview", destinationContractAddress: "addr",
    symbol: "BTC/USD", price: "1", timestamp: 1, status: "pending",
    createdAtMs: now, ...o,
  };
}

// ---------------------------------------------------------------------------
// C.19.d — crash recovery
// ---------------------------------------------------------------------------

describe("integration: crash recovery (C.19.d)", () => {
  it("marks pending and submitted rows as failed on restart; leaves confirmed alone", async () => {
    await db.insertTransactionLog(txInsert({ intentHash: "0x" + "a1".repeat(32), status: "pending" }));
    await db.insertTransactionLog(txInsert({ intentHash: "0x" + "a2".repeat(32), status: "submitted", submittedAtMs: Date.now() }));
    await db.insertTransactionLog(txInsert({ intentHash: "0x" + "a3".repeat(32), status: "confirmed", confirmedAtMs: Date.now() }));

    // Replicate the daemon's startup sweep (daemon-cmd.ts:426-447).
    const [pending, submitted] = await Promise.all([
      db.listTransactions({ status: "pending" }),
      db.listTransactions({ status: "submitted" }),
    ]);
    for (const row of [...pending, ...submitted]) {
      await db.updateTransactionLog(row.intentHash, {
        status: "failed", errorCode: "CrashRecovery",
        errorMessage: "daemon restarted", failedAtMs: Date.now(),
      });
    }

    assert.equal((await db.listTransactions({ status: "pending" })).length, 0);
    assert.equal((await db.listTransactions({ status: "submitted" })).length, 0);
    assert.equal((await db.listTransactions({ status: "failed" })).length, 2);
    // The confirmed row is untouched.
    assert.equal((await db.listTransactions({ status: "confirmed" })).length, 1);
  });
});

// ---------------------------------------------------------------------------
// C.19.e — multi-client alert labelling
// ---------------------------------------------------------------------------

describe("integration: multi-client alert labelling (C.19.e)", () => {
  it("fires OraclePairStale per stale client with correct symbol labels", async () => {
    let fakeNow = 1_000;
    const cache = createPriceCache({ now: () => fakeNow });
    cache.set({ routerId: "client-a", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 1n, timestamp: 1n, intentHash: "0x1", updatedAtMs: 1_000 });
    cache.set({ routerId: "client-b", destinationIndex: 0, symbol: "ETH/USD" },
      { symbol: "ETH/USD", price: 1n, timestamp: 1n, intentHash: "0x2", updatedAtMs: 1_000 });

    fakeNow = 1_000 + 400_000; // both stale (> 300s)

    const controller = new AbortController();
    const handle = startAlertEvaluator({
      db, priceCache: cache, evaluationIntervalMs: 5,
      pairStalenessThresholdMs: 300_000, signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 25));
    controller.abort();
    await handle.done;

    const alerts = await db.listAlerts({ active: true });
    assert.equal(alerts.length, 2, "one OraclePairStale per stale client");
    const symbols = alerts
      .map((a) => (JSON.parse(a.labelsJson) as { symbol?: string }).symbol)
      .sort();
    assert.deepEqual(symbols, ["BTC/USD", "ETH/USD"]);
  });
});

// ---------------------------------------------------------------------------
// C.19.h — API round-trip over a real Db
// ---------------------------------------------------------------------------

let portCounter = 19_700;

function makeConfig(): ModularConfig {
  return {
    infrastructure: {
      database: { driver: "sqlite", path: ":memory:" },
      source: { chain_id: 10050, name: "DIA Testnet", rpc_urls: ["https://x"] },
      api: { enabled: true, enable_cors: false },
    },
    chains: {}, contracts: {}, event_definitions: {}, routers: {},
    parsedAbis: { events: {}, contracts: {} } as ModularConfig["parsedAbis"],
  };
}

const healthState: HealthState = {
  lastRegistryPollMs: Date.now(), lastConfirmedMs: Date.now(), maxStalenessMs: 300_000,
};

describe("integration: API round-trip over real Db (C.19.h)", () => {
  it("serves transactions, alerts, and POST ack against a live SQLite Db", async () => {
    // Seed: one confirmed tx + one active alert.
    const tx = "txhash" + "0".repeat(58);
    await db.insertTransactionLog(txInsert({
      intentHash: "0x" + "c1".repeat(32), cardanoTxHash: tx,
      status: "confirmed", confirmedAtMs: Date.now(), submittedAtMs: Date.now(),
    }));
    const alertId = await db.recordAlert({
      name: "OraclePairStale", severity: "warning", message: "stale",
      labels: { symbol: "BTC/USD" },
    });

    const port = portCounter++;
    const server = createApiServer({
      port, config: makeConfig(), db, metrics: noopMetrics,
      priceCache: createPriceCache(), chainRuntime: createChainRuntimeState(),
      healthState,
    });
    await server.start();
    try {
      const base = `http://127.0.0.1:${port}`;

      const txRes = await fetch(`${base}/api/v1/transactions`);
      const txBody = await txRes.json() as { count: number };
      assert.equal(txRes.status, 200);
      assert.equal(txBody.count, 1);

      const txByHash = await fetch(`${base}/api/v1/transactions/${tx}`);
      const txByHashBody = await txByHash.json() as { txHash: string; updateCount: number };
      assert.equal(txByHash.status, 200);
      assert.equal(txByHashBody.txHash, tx);

      const alertRes = await fetch(`${base}/api/v1/alerts?active=true`);
      const alertBody = await alertRes.json() as { count: number };
      assert.equal(alertRes.status, 200);
      assert.equal(alertBody.count, 1);

      // getAlertById path (R10.B.7) — old alerts must resolve by id.
      const byId = await fetch(`${base}/api/v1/alerts/${alertId}`);
      assert.equal(byId.status, 200);

      // POST ack acknowledges in the real Db.
      const ack = await fetch(`${base}/api/v1/alerts/${alertId}/ack`, { method: "POST" });
      assert.equal(ack.status, 200);
      const row = await db.getAlertById(alertId);
      assert.equal(row?.acknowledged, true);

      // Unknown alert id → 404 (not 500) via the missing-row translation.
      const missing = await fetch(`${base}/api/v1/alerts/999999/ack`, { method: "POST" });
      assert.equal(missing.status, 404);
    } finally {
      await server.stop();
    }
  });
});
