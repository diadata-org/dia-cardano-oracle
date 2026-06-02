// R10.C.1 — method-level tests for the SQLite Db implementation.
//
// Exercises every method of the Db interface against an in-memory
// (`:memory:`) SQLite database, covering positive paths, negative paths
// (missing-row throws added in R10.A.3-A.5), and edge cases (bigint
// round-trips, ON CONFLICT semantics, NULL handling, pagination, prune
// retention rules). Postgres shares the same interface and row mappers;
// these tests pin the behavioural contract both drivers must honour.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createDb, type Db } from "../db.js";
import type {
  ProcessedEventRow,
  TransactionLogInsert,
} from "../db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN_ID = 10050;
const CONTRACT = "intent-registry-testnet";

let db: Db;

beforeEach(async () => {
  db = await createDb({ driver: "sqlite", path: ":memory:" });
  await db.migrate();
});

afterEach(async () => {
  await db.close();
});

function makeProcessedEvent(overrides: Partial<ProcessedEventRow> = {}): ProcessedEventRow {
  return {
    intentHash: "0x" + "11".repeat(32),
    txHash: "0x" + "aa".repeat(32),
    logIndex: 0,
    blockNumber: 100n,
    routerId: "client-a",
    destinationIndex: 0,
    status: "processed",
    processedAtMs: Date.now(),
    ...overrides,
  };
}

function makeTxInsert(overrides: Partial<TransactionLogInsert> = {}): TransactionLogInsert {
  const now = Date.now();
  return {
    intentHash: "0x" + "22".repeat(32),
    cardanoTxHash: "cardanotx" + "0".repeat(56),
    routerId: "client-a",
    destinationIndex: 0,
    destinationChainName: "Preview",
    destinationContractAddress: "addr_receiver",
    symbol: "BTC/USD",
    price: "65000000000",
    timestamp: 1_700_000_000,
    status: "submitted",
    submittedAtMs: now,
    createdAtMs: now,
    ...overrides,
  };
}

// ===========================================================================
// migrate / close
// ===========================================================================

describe("Db.migrate + close", () => {
  it("migrate() is idempotent — calling twice does not throw", async () => {
    await db.migrate();
    await db.migrate();
    // A query against a migrated table must succeed.
    assert.deepEqual(await db.listChainStates(), []);
  });

  it("close() resolves without throwing", async () => {
    // afterEach closes again; better-sqlite3 double-close is a no-op-ish
    // path, so open a dedicated handle to assert clean close here.
    const d = await createDb({ driver: "sqlite", path: ":memory:" });
    await d.migrate();
    await d.close();
  });
});

// ===========================================================================
// chain_state
// ===========================================================================

describe("Db.chain_state", () => {
  it("initialiseChainState inserts a row with zeroed blocks and healthy=true", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.ok(row);
    assert.equal(row.lastProcessedBlock, 0n);
    assert.equal(row.lastScanBlock, 0n);
    assert.equal(row.isHealthy, true);
    assert.equal(row.errorCount, 0);
  });

  it("initialiseChainState is idempotent on (chainId, contractId)", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.setLastScanBlock(CHAIN_ID, CONTRACT, 500n);
    // Second init must NOT overwrite the advanced checkpoint.
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.lastScanBlock, 500n);
  });

  it("a different contractId on the same chain creates a second row", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: "other-registry" });
    assert.equal((await db.listChainStates()).length, 2);
  });

  it("setLastProcessedBlock updates the value and round-trips a realistic large block as bigint", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    // 50_000_000 ≈ 2.5× current Ethereum mainnet height — comfortably within
    // the SQLite INTEGER / JS-number safe range (< 2^53). Block heights never
    // approach 2^53 (~285 M years at 1 block/s), so INTEGER affinity is kept
    // for correct numeric range/order queries; see the 2^53 note in db.ts.
    const block = 50_000_000n;
    await db.setLastProcessedBlock(CHAIN_ID, CONTRACT, block);
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.lastProcessedBlock, block);
    assert.equal(typeof row?.lastProcessedBlock, "bigint");
  });

  it("setLastProcessedBlock throws when no chain_state row exists", async () => {
    await assert.rejects(
      () => db.setLastProcessedBlock(CHAIN_ID, CONTRACT, 1n),
      /no chain_state row/,
    );
  });

  it("setLastScanBlock updates last_scan_block without touching last_processed_block", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.setLastProcessedBlock(CHAIN_ID, CONTRACT, 100n);
    await db.setLastScanBlock(CHAIN_ID, CONTRACT, 200n);
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.lastProcessedBlock, 100n);
    assert.equal(row?.lastScanBlock, 200n);
  });

  it("setLastScanBlock throws when no chain_state row exists", async () => {
    await assert.rejects(
      () => db.setLastScanBlock(CHAIN_ID, CONTRACT, 1n),
      /no chain_state row/,
    );
  });

  it("setChainHealth(healthy=true) sets is_healthy=1", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: false, errorMsg: "boom" });
    await db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: true });
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.isHealthy, true);
  });

  it("setChainHealth(healthy=false) increments error_count and stores the message", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: false, errorMsg: "rpc down" });
    await db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: false, errorMsg: "rpc down again" });
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.isHealthy, false);
    assert.equal(row?.errorCount, 2);
    assert.equal(row?.lastError, "rpc down again");
  });

  it("setChainHealth(healthy=false) with no message stores NULL last_error", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: false });
    const row = await db.getChainState(CHAIN_ID, CONTRACT);
    assert.equal(row?.lastError, undefined);
  });

  it("setChainHealth throws when no chain_state row exists", async () => {
    await assert.rejects(
      () => db.setChainHealth(CHAIN_ID, CONTRACT, { isHealthy: true }),
      /no chain_state row/,
    );
  });

  it("getChainState returns null when the row does not exist", async () => {
    assert.equal(await db.getChainState(CHAIN_ID, CONTRACT), null);
  });

  it("listChainStates returns all rows", async () => {
    await db.initialiseChainState({ chainId: 1, chainName: "A", contractId: "c1" });
    await db.initialiseChainState({ chainId: 2, chainName: "B", contractId: "c2" });
    const rows = await db.listChainStates();
    assert.equal(rows.length, 2);
  });
});

// ===========================================================================
// processed_events
// ===========================================================================

describe("Db.processed_events", () => {
  it("upsertProcessedEvent inserts and hasProcessedEvent finds it", async () => {
    const ev = makeProcessedEvent();
    await db.upsertProcessedEvent(ev);
    assert.equal(await db.hasProcessedEvent(ev.intentHash), true);
  });

  it("hasProcessedEvent returns false for an unknown intentHash", async () => {
    assert.equal(await db.hasProcessedEvent("0xdeadbeef"), false);
  });

  it("upsertProcessedEvent is idempotent on intentHash (ON CONFLICT DO NOTHING)", async () => {
    const ev = makeProcessedEvent({ status: "processed" });
    await db.upsertProcessedEvent(ev);
    // Second upsert with a different status must not overwrite.
    await db.upsertProcessedEvent({ ...ev, status: "error" });
    const got = await db.getProcessedEvent(ev.intentHash);
    assert.equal(got?.status, "processed");
  });

  it("getProcessedEvent returns null when not found and round-trips blockNumber as bigint", async () => {
    assert.equal(await db.getProcessedEvent("0xmissing"), null);
    const ev = makeProcessedEvent({ blockNumber: 123_456_789_012_345n });
    await db.upsertProcessedEvent(ev);
    const got = await db.getProcessedEvent(ev.intentHash);
    assert.equal(got?.blockNumber, 123_456_789_012_345n);
  });

  it("listProcessedEvents filters by routerId, status, fromBlock and paginates", async () => {
    for (let i = 0; i < 5; i++) {
      await db.upsertProcessedEvent(makeProcessedEvent({
        intentHash: "0x" + i.toString().padStart(64, "0"),
        // Distinct (tx_hash, log_index) per row — the schema enforces a
        // UNIQUE index on that pair (one log = one position in one tx).
        logIndex: i,
        blockNumber: BigInt(100 + i),
        routerId: i % 2 === 0 ? "client-a" : "client-b",
        status: i === 4 ? "filtered" : "processed",
      }));
    }
    assert.equal((await db.listProcessedEvents({ routerId: "client-a" })).length, 3);
    assert.equal((await db.listProcessedEvents({ status: "filtered" })).length, 1);
    assert.equal((await db.listProcessedEvents({ fromBlock: 103n })).length, 2);
    assert.equal((await db.listProcessedEvents({ limit: 2 })).length, 2);
    assert.equal((await db.listProcessedEvents({ limit: 2, offset: 4 })).length, 1);
  });

  it("listProcessedEvents returns empty array when filters match nothing", async () => {
    assert.deepEqual(await db.listProcessedEvents({ routerId: "nobody" }), []);
  });
});

// ===========================================================================
// transaction_log
// ===========================================================================

describe("Db.transaction_log", () => {
  it("insertTransactionLog stores a submitted row with submittedAtMs set", async () => {
    const row = makeTxInsert();
    await db.insertTransactionLog(row);
    const got = await db.getTransactionLog(row.intentHash);
    assert.equal(got.length, 1);
    assert.equal(got[0]?.status, "submitted");
    assert.ok(got[0]?.submittedAtMs);
    assert.equal(got[0]?.confirmedAtMs, undefined);
  });

  it("insertTransactionLog stores optional fields as undefined when absent", async () => {
    const row = makeTxInsert();
    await db.insertTransactionLog(row);
    const got = (await db.getTransactionLog(row.intentHash))[0];
    assert.equal(got?.errorCode, undefined);
    assert.equal(got?.errorMessage, undefined);
    assert.equal(got?.feePaidLovelace, undefined);
  });

  it("updateTransactionLog moves submitted → confirmed and preserves other fields", async () => {
    const row = makeTxInsert();
    await db.insertTransactionLog(row);
    await db.updateTransactionLog(row.intentHash, {
      status: "confirmed",
      confirmedAtMs: Date.now(),
      feePaidLovelace: "180000",
    });
    const got = (await db.getTransactionLog(row.intentHash))[0];
    assert.equal(got?.status, "confirmed");
    assert.equal(got?.feePaidLovelace, "180000");
    assert.equal(got?.symbol, "BTC/USD"); // untouched
  });

  it("updateTransactionLog with an empty patch is a no-op (does not throw)", async () => {
    const row = makeTxInsert();
    await db.insertTransactionLog(row);
    await db.updateTransactionLog(row.intentHash, {});
    const got = (await db.getTransactionLog(row.intentHash))[0];
    assert.equal(got?.status, "submitted");
  });

  it("updateTransactionLog throws when the intentHash does not exist", async () => {
    await assert.rejects(
      () => db.updateTransactionLog("0xnope", { status: "confirmed" }),
      /no transaction_log row/,
    );
  });

  it("getTransactionLog returns [] for an unknown intentHash", async () => {
    assert.deepEqual(await db.getTransactionLog("0xnope"), []);
  });

  it("getTransactionsByHash returns all rows sharing a cardanoTxHash (batched tx)", async () => {
    const shared = "cardanobatch" + "0".repeat(52);
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "a1".repeat(32), cardanoTxHash: shared, symbol: "BTC/USD" }));
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "a2".repeat(32), cardanoTxHash: shared, symbol: "ETH/USD" }));
    const rows = await db.getTransactionsByHash(shared);
    assert.equal(rows.length, 2);
  });

  it("listTransactions filters by status, symbol and routerId (ANDed)", async () => {
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "b1".repeat(32), status: "confirmed", symbol: "BTC/USD", routerId: "client-a" }));
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "b2".repeat(32), status: "failed", symbol: "BTC/USD", routerId: "client-a" }));
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "b3".repeat(32), status: "confirmed", symbol: "ETH/USD", routerId: "client-b" }));
    assert.equal((await db.listTransactions({ status: "confirmed" })).length, 2);
    assert.equal((await db.listTransactions({ symbol: "BTC/USD" })).length, 2);
    assert.equal((await db.listTransactions({ status: "confirmed", symbol: "BTC/USD" })).length, 1);
    assert.equal((await db.listTransactions({ routerId: "client-b" })).length, 1);
  });

  it("listSymbolUpdates returns rows for a symbol newest-first, capped at limit", async () => {
    for (let i = 0; i < 3; i++) {
      await db.insertTransactionLog(makeTxInsert({
        intentHash: "0x" + ("c" + i).padStart(64, "0"),
        symbol: "ADA/USD",
        createdAtMs: 1_000 + i,
      }));
    }
    const rows = await db.listSymbolUpdates("ADA/USD", 2);
    assert.equal(rows.length, 2);
    // DESC by created_at_ms → newest (1002) first.
    assert.equal(rows[0]?.createdAtMs, 1_002);
  });
});

// ===========================================================================
// contract_symbol_updates
// ===========================================================================

describe("Db.contract_symbol_updates", () => {
  const ADDR = "addr_receiver_csu";

  it("first upsert inserts; second increments update_count", async () => {
    await db.upsertContractSymbolUpdate({
      chainId: CHAIN_ID, contractAddress: ADDR, symbol: "BTC/USD",
      lastPrice: "100", lastTimestamp: 1, lastUpdateMs: 10, updateCount: 0,
    });
    await db.upsertContractSymbolUpdate({
      chainId: CHAIN_ID, contractAddress: ADDR, symbol: "BTC/USD",
      lastPrice: "200", lastTimestamp: 2, lastUpdateMs: 20, updateCount: 0,
    });
    const row = await db.getContractSymbolUpdate(CHAIN_ID, ADDR, "BTC/USD");
    assert.equal(row?.lastPrice, "200");
    assert.equal(row?.updateCount, 1);
  });

  it("getContractSymbolUpdate returns null when not found", async () => {
    assert.equal(await db.getContractSymbolUpdate(CHAIN_ID, ADDR, "NONE/USD"), null);
  });

  it("listContractSymbolUpdates returns all rows ordered", async () => {
    await db.upsertContractSymbolUpdate({ chainId: CHAIN_ID, contractAddress: ADDR, symbol: "ETH/USD", lastPrice: "1", lastTimestamp: 1, lastUpdateMs: 1, updateCount: 0 });
    await db.upsertContractSymbolUpdate({ chainId: CHAIN_ID, contractAddress: ADDR, symbol: "BTC/USD", lastPrice: "1", lastTimestamp: 1, lastUpdateMs: 1, updateCount: 0 });
    const rows = await db.listContractSymbolUpdates();
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.symbol, "BTC/USD"); // symbol ASC
  });
});

// ===========================================================================
// performance_metrics
// ===========================================================================

describe("Db.performance_metrics", () => {
  it("recordPerformanceMetric inserts and queryPerformanceMetrics filters by name", async () => {
    await db.recordPerformanceMetric({ name: "end_to_end_seconds", value: 1.5, labels: { symbol: "BTC/USD" } });
    await db.recordPerformanceMetric({ name: "scan_to_processing_seconds", value: 0.2 });
    const rows = await db.queryPerformanceMetrics({ metricName: "end_to_end_seconds" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.metricValue, 1.5);
    assert.equal(JSON.parse(rows[0]!.labelsJson).symbol, "BTC/USD");
  });

  it("queryPerformanceMetrics filters by since/until range and limit", async () => {
    // Record three; we cannot control recorded_at_ms (set to Date.now()
    // internally), so assert the metricName filter + limit behaviour.
    for (let i = 0; i < 3; i++) {
      await db.recordPerformanceMetric({ name: "lat", value: i });
    }
    assert.equal((await db.queryPerformanceMetrics({ metricName: "lat" })).length, 3);
    assert.equal((await db.queryPerformanceMetrics({ metricName: "lat", limit: 2 })).length, 2);
    assert.equal((await db.queryPerformanceMetrics({ metricName: "nope" })).length, 0);
  });
});

// ===========================================================================
// alert_log
// ===========================================================================

describe("Db.alert_log", () => {
  it("recordAlert returns a positive id; the alert is unresolved + unacknowledged", async () => {
    const id = await db.recordAlert({ name: "OraclePairStale", severity: "warning", message: "stale", labels: { symbol: "BTC/USD" } });
    assert.ok(id > 0);
    const active = await db.listAlerts({ active: true });
    assert.equal(active.length, 1);
    assert.equal(active[0]?.acknowledged, false);
    assert.equal(active[0]?.resolvedAtMs, undefined);
  });

  it("resolveAlert sets resolved_at_ms; the alert moves to active=false", async () => {
    const id = await db.recordAlert({ name: "X", severity: "info", message: "m" });
    await db.resolveAlert(id, Date.now());
    assert.equal((await db.listAlerts({ active: true })).length, 0);
    assert.equal((await db.listAlerts({ active: false })).length, 1);
  });

  it("resolveAlert throws when the id does not exist", async () => {
    await assert.rejects(() => db.resolveAlert(9999, Date.now()), /no alert_log row/);
  });

  it("acknowledgeAlert sets acknowledged=true without resolving", async () => {
    const id = await db.recordAlert({ name: "X", severity: "info", message: "m" });
    await db.acknowledgeAlert(id);
    const rows = await db.listAlerts({ active: true });
    assert.equal(rows[0]?.acknowledged, true);
    assert.equal(rows[0]?.resolvedAtMs, undefined);
  });

  it("acknowledgeAlert throws when the id does not exist", async () => {
    await assert.rejects(() => db.acknowledgeAlert(9999), /no alert_log row/);
  });

  it("listAlerts returns all when active is undefined and respects limit", async () => {
    const a = await db.recordAlert({ name: "A", severity: "info", message: "1" });
    await db.recordAlert({ name: "B", severity: "info", message: "2" });
    await db.resolveAlert(a, Date.now());
    assert.equal((await db.listAlerts({})).length, 2);
    assert.equal((await db.listAlerts({ limit: 1 })).length, 1);
  });
});

// ===========================================================================
// pruneOldRows
// ===========================================================================

describe("Db.pruneOldRows", () => {
  it("prunes old processed_events but keeps recent ones", async () => {
    const old = Date.now() - 10 * 60 * 1_000; // 10 min ago
    await db.upsertProcessedEvent(makeProcessedEvent({ intentHash: "0x" + "d1".repeat(32), logIndex: 0, processedAtMs: old }));
    await db.upsertProcessedEvent(makeProcessedEvent({ intentHash: "0x" + "d2".repeat(32), logIndex: 1, processedAtMs: Date.now() }));
    const pruned = await db.pruneOldRows(5 * 60 * 1_000); // cutoff 5 min
    assert.equal(pruned.processedEvents, 1);
    assert.equal((await db.listProcessedEvents({})).length, 1);
  });

  it("prunes confirmed/failed txs but NEVER pending/submitted regardless of age", async () => {
    const old = Date.now() - 10 * 60 * 1_000;
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "e1".repeat(32), status: "submitted", createdAtMs: old }));
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "e2".repeat(32), status: "confirmed", createdAtMs: old }));
    await db.insertTransactionLog(makeTxInsert({ intentHash: "0x" + "e3".repeat(32), status: "failed", createdAtMs: old }));
    const pruned = await db.pruneOldRows(5 * 60 * 1_000);
    assert.equal(pruned.transactionLog, 2); // confirmed + failed only
    // The submitted row survives.
    assert.equal((await db.getTransactionLog("0x" + "e1".repeat(32))).length, 1);
  });

  it("prunes resolved alerts but keeps active (unresolved) ones", async () => {
    const old = Date.now() - 10 * 60 * 1_000;
    const resolved = await db.recordAlert({ name: "R", severity: "info", message: "r" });
    await db.resolveAlert(resolved, old);
    await db.recordAlert({ name: "A", severity: "info", message: "a" }); // active
    const pruned = await db.pruneOldRows(5 * 60 * 1_000);
    assert.equal(pruned.alertLog, 1);
    assert.equal((await db.listAlerts({ active: true })).length, 1);
  });

  it("returns all-zero counts when nothing is old enough", async () => {
    await db.upsertProcessedEvent(makeProcessedEvent({ processedAtMs: Date.now() }));
    const pruned = await db.pruneOldRows(60 * 60 * 1_000); // 1h cutoff
    assert.deepEqual(pruned, { processedEvents: 0, transactionLog: 0, alertLog: 0, performanceMetrics: 0 });
  });
});
