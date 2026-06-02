// R10.C.8 — API response builder unit tests (alerts, performance, transactions).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { buildAlertsResponse, buildAlertResponse } from "../alerts.js";
import { buildPerformanceResponse } from "../performance.js";
import { buildTransactionsResponse, buildTransactionResponse } from "../transactions.js";
import { createDb, type Db, type AlertLogRow, type PerformanceMetricRow, type TransactionLogRow } from "../../persistence/index.js";

function alertRow(overrides: Partial<AlertLogRow> = {}): AlertLogRow {
  return {
    id: 1,
    alertName: "OraclePairStale",
    severity: "warning",
    message: "stale",
    labelsJson: '{"symbol":"BTC/USD"}',
    firedAtMs: 1000,
    acknowledged: false,
    ...overrides,
  };
}

function perfRow(overrides: Partial<PerformanceMetricRow> = {}): PerformanceMetricRow {
  return {
    id: 1,
    metricName: "end_to_end_seconds",
    metricValue: 1.5,
    labelsJson: '{"phase":"submission"}',
    recordedAtMs: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

describe("buildAlertsResponse", () => {
  it("empty array returns {count:0, alerts:[]}", () => {
    assert.deepEqual(buildAlertsResponse([]), { count: 0, alerts: [] });
  });

  it("count matches array length and labelsJson is parsed", () => {
    const res = buildAlertsResponse([alertRow(), alertRow({ id: 2 })]);
    assert.equal(res.count, 2);
    assert.deepEqual(res.alerts[0]?.labels, { symbol: "BTC/USD" });
  });

  it("malformed labelsJson falls back to {} without throwing", () => {
    const res = buildAlertsResponse([alertRow({ labelsJson: "{not json" })]);
    assert.deepEqual(res.alerts[0]?.labels, {});
  });

  it("preserves acknowledged and undefined resolvedAtMs", () => {
    const res = buildAlertsResponse([alertRow({ acknowledged: true })]);
    assert.equal(res.alerts[0]?.acknowledged, true);
    assert.equal(res.alerts[0]?.resolvedAtMs, undefined);
  });
});

describe("buildAlertResponse", () => {
  it("returns null for a null row", () => {
    assert.equal(buildAlertResponse(null), null);
  });

  it("maps a valid row to an AlertEntry", () => {
    const e = buildAlertResponse(alertRow({ id: 7, resolvedAtMs: 2000 }));
    assert.equal(e?.id, 7);
    assert.equal(e?.resolvedAtMs, 2000);
    assert.deepEqual(e?.labels, { symbol: "BTC/USD" });
  });

  it("malformed labelsJson falls back to {} (no throw)", () => {
    const e = buildAlertResponse(alertRow({ labelsJson: "oops" }));
    assert.deepEqual(e?.labels, {});
  });
});

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

describe("buildPerformanceResponse", () => {
  it("empty array returns {count:0, metrics:[]}", () => {
    assert.deepEqual(buildPerformanceResponse([]), { count: 0, metrics: [] });
  });

  it("count matches length, labels parsed, metricValue stays numeric", () => {
    const res = buildPerformanceResponse([perfRow(), perfRow({ id: 2 })]);
    assert.equal(res.count, 2);
    assert.deepEqual(res.metrics[0]?.labels, { phase: "submission" });
    assert.equal(typeof res.metrics[0]?.metricValue, "number");
  });

  it("malformed labelsJson falls back to {}", () => {
    const res = buildPerformanceResponse([perfRow({ labelsJson: "x" })]);
    assert.deepEqual(res.metrics[0]?.labels, {});
  });
});

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

describe("buildTransactionsResponse", () => {
  it("empty array returns {count:0, transactions:[]}", () => {
    assert.deepEqual(buildTransactionsResponse([]), { count: 0, transactions: [] });
  });

  it("count matches array length and rows pass through", () => {
    const rows = [{ intentHash: "0x1" }, { intentHash: "0x2" }] as unknown as TransactionLogRow[];
    const res = buildTransactionsResponse(rows);
    assert.equal(res.count, 2);
    assert.equal(res.transactions, rows);
  });
});

describe("buildTransactionResponse (against in-memory DB)", () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb({ driver: "sqlite", path: ":memory:" });
    await db.migrate();
  });
  afterEach(async () => { await db.close(); });

  it("returns null when no rows share the cardanoTxHash", async () => {
    assert.equal(await buildTransactionResponse(db, "0xmissing"), null);
  });

  it("aggregates rows sharing a cardanoTxHash, sorted by symbol then intentHash", async () => {
    const shared = "cardanotx" + "0".repeat(56);
    const now = Date.now();
    const base = {
      cardanoTxHash: shared, routerId: "client-a", destinationIndex: 0,
      destinationChainName: "Preview", destinationContractAddress: "addr",
      price: "1", timestamp: 1, status: "confirmed" as const,
      submittedAtMs: now, confirmedAtMs: now + 1, createdAtMs: now,
    };
    await db.insertTransactionLog({ ...base, intentHash: "0x" + "b2".repeat(32), symbol: "ETH/USD" });
    await db.insertTransactionLog({ ...base, intentHash: "0x" + "b1".repeat(32), symbol: "BTC/USD" });
    const res = await buildTransactionResponse(db, shared);
    assert.ok(res);
    assert.equal(res.txHash, shared);
    assert.equal(res.status, "confirmed");
    assert.equal(res.updateCount, 2);
    // Sorted by symbol → BTC/USD first.
    assert.equal(res.updates[0]?.symbol, "BTC/USD");
    assert.equal(res.updates[1]?.symbol, "ETH/USD");
  });
});
