import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEventWorkerPool } from "../event-worker-pool.js";
import type { ExtractedEvent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(hash: string): ExtractedEvent {
  return {
    intentHash: hash as `0x${string}`,
    symbolHash: "0x0000" as `0x${string}`,
    price: 0n,
    timestamp: 0n,
    signer: "0x0000" as `0x${string}`,
    blockNumber: 0n,
    txHash: "0x0000" as `0x${string}`,
    logIndex: 0,
    blockTimestamp: 0n,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEventWorkerPool", () => {
  it("submit returns false and increments dropped when queue is full", async () => {
    const pool = createEventWorkerPool({
      workerCount: 1,
      queueSize: 1,
      processingTimeoutMs: 5_000,
      // Worker never resolves so the queue slot stays occupied.
      onEvent: () => new Promise(() => {}),
    });
    pool.start();

    // Fill the active worker + one queue slot.
    pool.submit(makeEvent("0x01")); // goes to worker (active)
    await sleep(5); // allow worker to pick it up
    pool.submit(makeEvent("0x02")); // fills queue slot

    const result = pool.submit(makeEvent("0x03")); // queue full
    assert.equal(result, false);

    const stats = pool.stats();
    assert.equal(stats.dropped, 1);

    // Cleanup: stop without draining (workers are blocked, that's ok for this test).
    // We call stop() but it may hang on the blocked worker; just let it go.
  });

  it("processing timeout increments failed counter", async () => {
    let resolved = false;
    const pool = createEventWorkerPool({
      workerCount: 1,
      queueSize: 10,
      processingTimeoutMs: 20, // very short
      onEvent: async () => {
        await sleep(200); // longer than timeout
        resolved = true;
      },
    });
    pool.start();

    pool.submit(makeEvent("0xabc"));
    await sleep(100); // wait for timeout to fire

    const stats = pool.stats();
    assert.equal(stats.failed, 1);
    assert.equal(stats.processed, 0);
    // The onEvent fn may still resolve in background; resolved flag is irrelevant.

    await pool.stop();
    // suppress unused variable warning
    void resolved;
  });

  it("graceful stop drains the queue", async () => {
    let processedCount = 0;
    const pool = createEventWorkerPool({
      workerCount: 2,
      queueSize: 20,
      processingTimeoutMs: 1_000,
      onEvent: async () => {
        await sleep(5);
        processedCount++;
      },
    });
    pool.start();

    for (let i = 0; i < 10; i++) {
      pool.submit(makeEvent(`0x${i.toString(16).padStart(64, "0")}`));
    }

    await pool.stop();

    assert.equal(processedCount, 10);
    const stats = pool.stats();
    assert.equal(stats.processed, 10);
    assert.equal(stats.queueLength, 0);
  });

  it("received/processed/failed/dropped counts are accurate", async () => {
    const pool = createEventWorkerPool({
      workerCount: 2,
      queueSize: 3,
      processingTimeoutMs: 50,
      onEvent: async (event) => {
        // Simulate failure for a specific hash.
        if (event.intentHash === "0xfail") {
          throw new Error("deliberate failure");
        }
        await sleep(5);
      },
    });
    pool.start();

    pool.submit(makeEvent("0x01")); // succeeds
    pool.submit(makeEvent("0xfail")); // fails
    pool.submit(makeEvent("0x02")); // succeeds
    pool.submit(makeEvent("0x03")); // succeeds
    // Queue is now full (queueSize=3, workers may have taken some)

    await pool.stop();

    const stats = pool.stats();
    // received = submitted events (excluding any that were dropped)
    assert.ok(stats.received >= 4, `expected received >= 4, got ${stats.received}`);
    assert.equal(stats.failed, 1);
    assert.ok(stats.processed >= 3, `expected processed >= 3, got ${stats.processed}`);
    assert.equal(stats.dropped, 0);
  });

  it("activeWorkers decrements to zero after all tasks complete", async () => {
    const pool = createEventWorkerPool({
      workerCount: 3,
      queueSize: 10,
      processingTimeoutMs: 1_000,
      onEvent: async () => {
        await sleep(10);
      },
    });
    pool.start();

    for (let i = 0; i < 6; i++) {
      pool.submit(makeEvent(`0x${i.toString(16).padStart(64, "0")}`));
    }

    await pool.stop();

    const stats = pool.stats();
    assert.equal(stats.activeWorkers, 0);
  });

  it("avgProcessingMs is non-negative after processing events", async () => {
    const pool = createEventWorkerPool({
      workerCount: 2,
      queueSize: 10,
      processingTimeoutMs: 1_000,
      onEvent: async () => {
        await sleep(5);
      },
    });
    pool.start();

    for (let i = 0; i < 4; i++) {
      pool.submit(makeEvent(`0x${i.toString(16).padStart(64, "0")}`));
    }

    await pool.stop();

    const stats = pool.stats();
    assert.ok(stats.avgProcessingMs >= 0);
  });

  it("stats reflects received count correctly", async () => {
    const pool = createEventWorkerPool({
      workerCount: 1,
      queueSize: 10,
      processingTimeoutMs: 1_000,
      onEvent: async () => {
        await sleep(5);
      },
    });
    pool.start();

    pool.submit(makeEvent("0x01"));
    pool.submit(makeEvent("0x02"));
    pool.submit(makeEvent("0x03"));

    await pool.stop();

    const stats = pool.stats();
    assert.equal(stats.received, 3);
  });
});
