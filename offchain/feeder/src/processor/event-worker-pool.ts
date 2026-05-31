// Event worker pool — parallel source-event processing.
//
// Mirrors Spectra's internal/processor/event_worker_pool.go.
// Accepts extracted events from the scanner, processes each in parallel
// (up to workerCount concurrent tasks), enforces per-event timeout,
// and tracks received/processed/failed/dropped/active counters.
//
// Cardano lane safety: workers process events (extract/enrich/route/build)
// but do NOT submit to Cardano. Submit requests go through the shared
// coalescer+queue manager which ensures per-lane serialization.

import type { ExtractedEvent } from "../source/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EventWorkerPoolOptions = {
  /**
   * Maximum number of events processed concurrently.
   * Maps to `event_processor.parallel_worker_count` in the YAML.
   */
  workerCount: number;
  /**
   * Maximum depth of the in-memory event queue. Events submitted when the
   * queue is full are dropped (returned false from `submit`).
   * Maps to `event_processor.parallel_queue_size` in the YAML.
   */
  queueSize: number;
  /**
   * Wall-clock ms budget for a single event's processing. When exceeded
   * the task is cancelled and the failed counter increments.
   * Maps to `event_processor.parallel_timeout` (parsed to ms) in the YAML.
   */
  processingTimeoutMs: number;
  /** Called once per event by the worker. Must not throw — errors are caught
   *  and counted as failures. */
  onEvent: (event: ExtractedEvent) => Promise<void>;
  /** Optional callback invoked whenever the internal stats change.
   *  Useful for wiring into the metrics layer. */
  onStats?: (stats: EventWorkerStats) => void;
  /** Optional structured-log sink for pool-level messages. */
  log?: (line: string) => void;
};

export type EventWorkerStats = {
  /** Total events handed to `submit()` since the pool started. */
  received: number;
  /** Events whose `onEvent` resolved without error or timeout. */
  processed: number;
  /** Events that timed out or whose `onEvent` threw. */
  failed: number;
  /** Events dropped because the queue was full at submission time. */
  dropped: number;
  /** Number of workers currently executing an `onEvent` call. */
  activeWorkers: number;
  /** Events currently waiting in the queue. */
  queueLength: number;
  /** Rolling average processing time (last 100 completed tasks), in ms. */
  avgProcessingMs: number;
};

export type EventWorkerPool = {
  /** Enqueue one event for processing. Returns false if the queue is full
   *  (event is dropped). */
  submit(event: ExtractedEvent): boolean;
  /** Start the background worker loops. Idempotent. */
  start(): void;
  /** Drain the queue and wait for all active workers to finish. */
  stop(): Promise<void>;
  /** Current counters and queue depth. */
  stats(): EventWorkerStats;
};

// ---------------------------------------------------------------------------
// Rolling-average helper
// ---------------------------------------------------------------------------

/**
 * A fixed-capacity circular buffer that maintains the mean of the last
 * `capacity` numeric samples. Does not allocate a new array on each push.
 */
function createRollingAverage(capacity: number) {
  const samples: number[] = new Array(capacity).fill(0) as number[];
  let index = 0;
  let count = 0;

  return {
    push(value: number): void {
      samples[index % capacity] = value;
      index++;
      if (count < capacity) count++;
    },
    mean(): number {
      if (count === 0) return 0;
      let sum = 0;
      for (let i = 0; i < count; i++) sum += samples[i] ?? 0;
      return sum / count;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventWorkerPool(options: EventWorkerPoolOptions): EventWorkerPool {
  const { workerCount, queueSize, processingTimeoutMs, onEvent, onStats, log } = options;

  // Queue is a simple FIFO array — push to tail, shift from head.
  const queue: ExtractedEvent[] = [];

  let received = 0;
  let processed = 0;
  let failed = 0;
  let dropped = 0;
  let activeWorkers = 0;
  let started = false;
  let stopping = false;

  // Rolling average over the last 100 processing samples.
  const rollingAvg = createRollingAverage(100);

  // Resolvers that unblock a worker waiting for the next event.
  const waiters: Array<() => void> = [];

  function notifyStats(): void {
    onStats?.({
      received,
      processed,
      failed,
      dropped,
      activeWorkers,
      queueLength: queue.length,
      avgProcessingMs: rollingAvg.mean(),
    });
  }

  /** Returns the next event from the queue, waiting if it is empty. */
  function nextEvent(): Promise<ExtractedEvent | null> {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    if (stopping) {
      return Promise.resolve(null);
    }
    return new Promise<ExtractedEvent | null>((resolve) => {
      waiters.push(() => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
        } else {
          // Stopped while waiting.
          resolve(null);
        }
      });
    });
  }

  /** Process events in a loop until stopped and the queue is empty. */
  async function workerLoop(): Promise<void> {
    while (true) {
      const event = await nextEvent();
      if (event === null) {
        break;
      }

      activeWorkers++;
      notifyStats();

      const startMs = Date.now();
      try {
        await Promise.race([
          onEvent(event),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Event processing timeout after ${processingTimeoutMs} ms`)),
              processingTimeoutMs,
            ),
          ),
        ]);
        processed++;
      } catch (err) {
        failed++;
        const hash = (event as { intentHash?: string }).intentHash;
        log?.(
          `[event-worker-pool] event processing failed${hash ? ` hash=${hash}` : ""}: ${String(err)}`,
        );
      } finally {
        activeWorkers--;
        rollingAvg.push(Date.now() - startMs);
        notifyStats();
      }
    }
  }

  // All active worker promises (used by stop()).
  const workerPromises: Promise<void>[] = [];

  return {
    submit(event: ExtractedEvent): boolean {
      if (queue.length >= queueSize) {
        dropped++;
        notifyStats();
        return false;
      }
      received++;
      queue.push(event);
      // Wake up one waiting worker if any.
      const waiter = waiters.shift();
      if (waiter) waiter();
      notifyStats();
      return true;
    },

    start(): void {
      if (started) return;
      started = true;
      for (let i = 0; i < workerCount; i++) {
        workerPromises.push(workerLoop());
      }
    },

    async stop(): Promise<void> {
      stopping = true;
      // Wake all waiting workers so they can observe the stopping flag.
      const pending = waiters.splice(0);
      for (const w of pending) w();
      await Promise.all(workerPromises);
    },

    stats(): EventWorkerStats {
      return {
        received,
        processed,
        failed,
        dropped,
        activeWorkers,
        queueLength: queue.length,
        avgProcessingMs: rollingAvg.mean(),
      };
    },
  };
}
