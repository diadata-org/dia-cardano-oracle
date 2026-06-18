// Update worker pool — per-router update-task processing.
//
// Mirrors Spectra's internal/worker/worker_pool.go plus
// Bridge.getOrCreateOraclePool(routerID).
//
// One bounded worker pool per router/client lane group. Independent
// routers progress in parallel; a saturated router cannot starve others.
// All submission still goes through the shared coalescer+queue manager:
// workers build SubmitRequests but never call the Cardano write client
// directly.

import type { SubmitRequest } from "../submitter/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type UpdateTask = {
  routerId: string;
  requests: SubmitRequest[];
};

export type UpdateWorkerPoolOptions = {
  /**
   * Maximum number of tasks processed concurrently within one pool.
   * Maps to `worker_pool.max_workers` in the YAML.
   */
  maxWorkers: number;
  /**
   * Maximum depth of the per-pool task queue. Tasks submitted when the
   * queue is full are dropped (returned false from `submit`).
   * Maps to `worker_pool.task_queue_size` in the YAML.
   */
  taskQueueSize: number;
  /**
   * Wall-clock ms budget for a single task. When exceeded the task is
   * cancelled and the failure is logged.
   * Maps to `worker_pool.task_timeout` (parsed to ms) in the YAML.
   */
  taskTimeoutMs: number;
  /** Called once per task by the worker. Must not throw — errors are caught
   *  and logged. */
  onTask: (task: UpdateTask) => Promise<void>;
  /** Called when a task threw or timed out (after it is caught + logged) — drives
   *  the worker_tasks_failed metric. */
  onTaskError?: (task: UpdateTask, err: unknown) => void;
  /** Optional structured-log sink for pool-level messages. */
  log?: (line: string) => void;
};

export type UpdateWorkerStats = {
  routerId: string;
  /** Number of workers currently executing a task. */
  activeWorkers: number;
  /** Configured worker concurrency limit for this pool. */
  maxWorkers: number;
  /** Tasks currently waiting in the queue. */
  pendingCount: number;
  /** Configured queue capacity for this pool. */
  queueCapacity: number;
};

export type UpdateWorkerPool = {
  /** Enqueue a task. Returns false if the queue is full (task is dropped). */
  submit(task: UpdateTask): boolean;
  /** Start the background worker loops. Idempotent. */
  start(): void;
  /** Drain the queue and wait for all active workers to finish. */
  stop(): Promise<void>;
  /** Current pool counters and queue depth. */
  stats(): UpdateWorkerStats;
  /** Snapshot of all tasks currently waiting in the queue. */
  listPendingTasks(): UpdateTask[];
};

export type UpdateWorkerPoolManager = {
  /** Return the pool for `routerId`, creating it lazily on first call. */
  getOrCreatePool(routerId: string): UpdateWorkerPool;
  /** Call `start()` on every pool that has been created so far. */
  startAll(): void;
  /** Call `stop()` on every pool and resolve when all have drained. */
  stopAll(): Promise<void>;
  /** Snapshot of stats for every pool created so far, in insertion order. */
  listAllStats(): UpdateWorkerStats[];
};

// ---------------------------------------------------------------------------
// Per-pool factory (internal)
// ---------------------------------------------------------------------------

function createUpdateWorkerPool(
  routerId: string,
  options: UpdateWorkerPoolOptions,
): UpdateWorkerPool {
  const { maxWorkers, taskQueueSize, taskTimeoutMs, onTask, onTaskError, log } = options;

  const queue: UpdateTask[] = [];
  let activeWorkers = 0;
  let started = false;
  let stopping = false;

  // Resolvers that unblock a worker waiting for the next task.
  const waiters: Array<() => void> = [];

  function nextTask(): Promise<UpdateTask | null> {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    if (stopping) {
      return Promise.resolve(null);
    }
    return new Promise<UpdateTask | null>((resolve) => {
      waiters.push(() => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
        } else {
          resolve(null);
        }
      });
    });
  }

  async function workerLoop(): Promise<void> {
    while (true) {
      const task = await nextTask();
      if (task === null) {
        break;
      }

      activeWorkers++;
      try {
        await Promise.race([
          onTask(task),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Update task timed out after ${taskTimeoutMs} ms (routerId=${task.routerId})`,
                  ),
                ),
              taskTimeoutMs,
            ),
          ),
        ]);
      } catch (err) {
        log?.(
          `[update-worker-pool] task failed routerId=${task.routerId}: ${String(err)}`,
        );
        onTaskError?.(task, err);
      } finally {
        activeWorkers--;
      }
    }
  }

  const workerPromises: Promise<void>[] = [];

  return {
    submit(task: UpdateTask): boolean {
      if (queue.length >= taskQueueSize) {
        return false;
      }
      queue.push(task);
      const waiter = waiters.shift();
      if (waiter) waiter();
      return true;
    },

    start(): void {
      if (started) return;
      started = true;
      for (let i = 0; i < maxWorkers; i++) {
        workerPromises.push(workerLoop());
      }
    },

    async stop(): Promise<void> {
      stopping = true;
      const pending = waiters.splice(0);
      for (const w of pending) w();
      await Promise.all(workerPromises);
    },

    stats(): UpdateWorkerStats {
      return {
        routerId,
        activeWorkers,
        maxWorkers,
        pendingCount: queue.length,
        queueCapacity: taskQueueSize,
      };
    },

    listPendingTasks(): UpdateTask[] {
      return [...queue];
    },
  };
}

// ---------------------------------------------------------------------------
// Manager factory (public entry point)
// ---------------------------------------------------------------------------

export function createUpdateWorkerPoolManager(
  options: Omit<UpdateWorkerPoolOptions, "onTask"> & {
    onTask: (routerId: string, task: UpdateTask) => Promise<void>;
  },
): UpdateWorkerPoolManager {
  const pools = new Map<string, UpdateWorkerPool>();

  function getOrCreatePool(routerId: string): UpdateWorkerPool {
    let pool = pools.get(routerId);
    if (!pool) {
      pool = createUpdateWorkerPool(routerId, {
        maxWorkers: options.maxWorkers,
        taskQueueSize: options.taskQueueSize,
        taskTimeoutMs: options.taskTimeoutMs,
        onTask: (task) => options.onTask(routerId, task),
        onTaskError: options.onTaskError,
        log: options.log,
      });
      pools.set(routerId, pool);
    }
    return pool;
  }

  return {
    getOrCreatePool,

    startAll(): void {
      for (const pool of pools.values()) {
        pool.start();
      }
    },

    async stopAll(): Promise<void> {
      await Promise.all(Array.from(pools.values()).map((p) => p.stop()));
    },

    listAllStats(): UpdateWorkerStats[] {
      return Array.from(pools.values()).map((p) => p.stats());
    },
  };
}
