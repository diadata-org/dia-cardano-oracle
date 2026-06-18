import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createUpdateWorkerPoolManager } from "../update-worker-pool.js";
import type { UpdateTask } from "../update-worker-pool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(routerId: string): UpdateTask {
  return { routerId, requests: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createUpdateWorkerPoolManager", () => {
  it("getOrCreatePool returns the same pool on subsequent calls", () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 2,
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {},
    });

    const poolA = manager.getOrCreatePool("router-1");
    const poolB = manager.getOrCreatePool("router-1");
    assert.equal(poolA, poolB, "same routerId must return the same pool instance");
  });

  it("getOrCreatePool creates independent pools per routerId", () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 2,
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {},
    });

    const poolA = manager.getOrCreatePool("router-a");
    const poolB = manager.getOrCreatePool("router-b");
    assert.notEqual(poolA, poolB, "different routerIds must yield different pool instances");
  });

  it("submit returns false and task is dropped when queue is full", async () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 1,
      taskQueueSize: 1,
      taskTimeoutMs: 5_000,
      // Worker blocks so the queue slot stays occupied.
      onTask: async () => {
        await new Promise(() => {});
      },
    });

    const pool = manager.getOrCreatePool("router-x");
    pool.start();

    // Fill the active worker + one queue slot.
    pool.submit(makeTask("router-x")); // picked up by worker
    await sleep(5); // let worker start
    pool.submit(makeTask("router-x")); // fills queue

    const dropped = pool.submit(makeTask("router-x")); // queue full
    assert.equal(dropped, false);

    const stats = pool.stats();
    assert.equal(stats.pendingCount, 1);
  });

  it("listAllStats returns one entry per created pool", () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 2,
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {},
    });

    manager.getOrCreatePool("r1");
    manager.getOrCreatePool("r2");
    manager.getOrCreatePool("r3");

    const allStats = manager.listAllStats();
    assert.equal(allStats.length, 3);
    const ids = allStats.map((s) => s.routerId).sort();
    assert.deepEqual(ids, ["r1", "r2", "r3"]);
  });

  it("stats reflects maxWorkers and queueCapacity from options", () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 4,
      taskQueueSize: 20,
      taskTimeoutMs: 1_000,
      onTask: async () => {},
    });

    const pool = manager.getOrCreatePool("router-z");
    const stats = pool.stats();
    assert.equal(stats.maxWorkers, 4);
    assert.equal(stats.queueCapacity, 20);
    assert.equal(stats.routerId, "router-z");
  });

  it("startAll starts every created pool and tasks are processed", async () => {
    let processed = 0;
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 2,
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {
        await sleep(5);
        processed++;
      },
    });

    const pool1 = manager.getOrCreatePool("p1");
    const pool2 = manager.getOrCreatePool("p2");

    manager.startAll();

    pool1.submit(makeTask("p1"));
    pool2.submit(makeTask("p2"));

    await manager.stopAll();

    assert.equal(processed, 2);
  });

  it("stopAll resolves when all workers finish", async () => {
    let finished = 0;
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 2,
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {
        await sleep(10);
        finished++;
      },
    });

    const pool = manager.getOrCreatePool("pool-finish");
    pool.start();

    pool.submit(makeTask("pool-finish"));
    pool.submit(makeTask("pool-finish"));
    pool.submit(makeTask("pool-finish"));

    await manager.stopAll();

    assert.equal(finished, 3);
  });

  it("listPendingTasks returns a snapshot of the queue", () => {
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 0, // no workers — tasks pile up in the queue
      taskQueueSize: 10,
      taskTimeoutMs: 1_000,
      onTask: async () => {},
    });

    const pool = manager.getOrCreatePool("pending-test");
    // Do NOT start — no workers drain the queue.

    const task1 = makeTask("pending-test");
    const task2 = makeTask("pending-test");
    pool.submit(task1);
    pool.submit(task2);

    const pending = pool.listPendingTasks();
    assert.equal(pending.length, 2);
    // Snapshot should be a copy — mutating it must not affect internal state.
    pending.pop();
    assert.equal(pool.listPendingTasks().length, 2);
  });

  it("task timeout increments via onTask rejection caught silently", async () => {
    let logOutput = "";
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 1,
      taskQueueSize: 10,
      taskTimeoutMs: 20, // very short
      onTask: async () => {
        await sleep(200); // longer than timeout
      },
      log: (line) => {
        logOutput += line;
      },
    });

    const pool = manager.getOrCreatePool("timeout-test");
    pool.start();
    pool.submit(makeTask("timeout-test"));

    await sleep(100); // allow timeout to fire
    await pool.stop();

    assert.ok(logOutput.includes("timed out"), `expected timeout log, got: ${logOutput}`);
  });

  it("calls onTaskError when a task throws (drives worker_tasks_failed)", async () => {
    const failed: UpdateTask[] = [];
    const manager = createUpdateWorkerPoolManager({
      maxWorkers: 1,
      taskQueueSize: 10,
      taskTimeoutMs: 5_000,
      onTask: async () => {
        throw new Error("boom");
      },
      onTaskError: (task) => {
        failed.push(task);
      },
    });

    const pool = manager.getOrCreatePool("router-err");
    pool.start();
    pool.submit(makeTask("router-err"));
    await sleep(20);
    await pool.stop();

    assert.equal(failed.length, 1, "onTaskError should fire once for a thrown task");
    assert.equal(failed[0]!.routerId, "router-err");
  });
});
