// Parallel-mode integration test.
//
// Exercises the daemon's parallel-mode wiring at the same shape as
// daemon-cmd.ts:
//
//   ScannedBatch → eventWorkerPool.submit(event)
//                     → worker → onEvent(event)
//                     → processOneEvent (here: a fake that records the event)
//
// Asserts:
//   - Every submitted event is delivered to onEvent (no silent drops below capacity).
//   - The pool emits onStats so healthState.workerQueueDepth wiring stays live.
//   - When the queue saturates, submit() returns false (dropped events are
//     visible to the caller, not swallowed).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createEventWorkerPool, type EventWorkerStats } from "../event-worker-pool.js";
import type { ExtractedEvent } from "../../source/types.js";

function makeEvent(seed: number): ExtractedEvent {
  return {
    intentHash: `0x${seed.toString(16).padStart(64, "0")}` as `0x${string}`,
    symbolHash: "0xdeadbeef",
    price: BigInt(seed),
    timestamp: 1_700_000_000n,
    signer: "0x1234567890123456789012345678901234567890",
    blockNumber: BigInt(seed),
    txHash: "0xtx",
    logIndex: 0,
    blockTimestamp: 1_700_000_000n + BigInt(seed),
  };
}

describe("EventWorkerPool — daemon parallel-mode wiring", () => {
  it("delivers every submitted event to onEvent in parallel mode", async () => {
    const seen: string[] = [];
    const pool = createEventWorkerPool({
      workerCount: 4,
      queueSize: 32,
      processingTimeoutMs: 500,
      onEvent: async (event) => {
        // Simulate enrichment + routing latency. Workers process in parallel.
        await new Promise((r) => setTimeout(r, 5));
        seen.push(event.intentHash);
      },
    });
    pool.start();

    for (let i = 0; i < 10; i++) {
      assert.equal(pool.submit(makeEvent(i)), true, `submit ${i} accepted`);
    }
    await pool.stop();

    assert.equal(seen.length, 10, "every event delivered to onEvent");
    // Order is not guaranteed under parallelism — check set equality.
    const expected = new Set(
      Array.from({ length: 10 }, (_v, i) => makeEvent(i).intentHash),
    );
    assert.deepEqual(new Set(seen), expected);
  });

  it("emits stats so health queue depth wiring stays live", async () => {
    const samples: EventWorkerStats[] = [];
    const pool = createEventWorkerPool({
      workerCount: 2,
      queueSize: 8,
      processingTimeoutMs: 500,
      onEvent: async () => {
        await new Promise((r) => setTimeout(r, 5));
      },
      onStats: (stats) => { samples.push({ ...stats }); },
    });
    pool.start();
    for (let i = 0; i < 4; i++) pool.submit(makeEvent(i));
    await pool.stop();

    assert.ok(samples.length > 0, "onStats must be called");
    const last = samples[samples.length - 1];
    assert.equal(last.received, 4);
    assert.equal(last.processed, 4);
    assert.equal(last.queueLength, 0);
  });

  it("returns false when the queue is saturated (no silent drops)", async () => {
    let release: (() => void) = () => {};
    const blocker = new Promise<void>((r) => { release = r; });

    const pool = createEventWorkerPool({
      workerCount: 1,
      queueSize: 2,
      processingTimeoutMs: 5_000,
      onEvent: async () => { await blocker; },
    });
    pool.start();

    // 1st claimed by the only worker, 2nd + 3rd buffer the queue (qSize=2).
    assert.equal(pool.submit(makeEvent(1)), true);
    assert.equal(pool.submit(makeEvent(2)), true);
    assert.equal(pool.submit(makeEvent(3)), true);
    // The 4th must be dropped — queue full.
    assert.equal(pool.submit(makeEvent(4)), false);

    release();
    await pool.stop();
  });
});
