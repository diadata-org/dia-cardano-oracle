// Queue manager — one serial queue per (updaterWallet, receiverUnit).
//
// The manager is the single entry point the rest of the feeder calls
// to schedule a Cardano submission. It routes each `SubmitRequest` to
// the correct queue based on its destination configuration, creating
// new queues on demand.
//
// The queue key is (clientStatePath, protocolStatePath), which uniquely
// identifies a (receiver, client config) pair on Cardano.
//
// Why per-queue and not one global queue?
//   Different Cardano destinations share no UTxO state. We can safely
//   submit to client-A and client-B in parallel; only submissions
//   within the same client must be serial. This "lane" model replaces
//   a concurrent worker-pool: on Cardano, the EUTxO model forces serial
//   execution within a lane while allowing cross-lane parallelism.

import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "./types.js";
import { createInflightTable, type InflightTable, type InflightTableOptions } from "./inflight.js";
import { createSubmissionQueue, type SubmissionQueue } from "./queue.js";
import type { RetryPolicy } from "./retry-policy.js";
import { laneKey } from "./lane-key.js";
import type { CardanoDestinationConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueManagerOptions = {
  /** Factory that builds or returns the `CardanoWriteClient` for a
   *  given destination. May be called multiple times with the same
   *  destination config; implementations should cache internally. */
  clientFactory: (clientStatePath: string, protocolStatePath: string) => CardanoWriteClient;
  /** Shared inflight table. When absent a new one is created per queue.
   *  Share one table across all queues if you want global lock tracking. */
  inflightTable?: InflightTable;
  inflightOptions?: InflightTableOptions;
  /** Result callback forwarded to each queue (fires once per enqueue call,
   *  after all retries have been exhausted or a success was observed). */
  onResult?: (result: SubmitResult) => void;
  /**
   * Retry policy applied by each queue after a failed submission.
   * Construct with `createDefaultRetryPolicy` from `retry-policy.ts`.
   * When absent, failed submissions are surfaced immediately with no retry.
   * Maps to `worker_pool.max_retries` + `worker_pool.retry_delay` in the YAML.
   */
  retryPolicy?: RetryPolicy;
  /**
   * REQUIRED — how long an inflight-table entry remains valid before the
   * lock is released and a new submission for the same receiver can be
   * scheduled. Sourced from
   * `infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms`.
   * No silent default — daemon-cmd validates the YAML value at startup.
   */
  inflightTimeoutMs: number;
};

export type QueueManager = {
  /** Schedule a submit request on the appropriate queue. Returns a
   *  promise that resolves when the request has been processed. */
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** Schedule one Cardano submission covering multiple requests for the same
   *  destination lane. Returns per-request results in the same order. */
  submitBatch(requests: SubmitRequest[]): Promise<SubmitResult[]>;
  /**
   * Schedule an arbitrary async body on the SAME serial lane an oracle update
   * for `dest` uses (routed by `laneKey(dest)`). The body runs only when the
   * lane is free and the next lane entry waits for it to finish — so a
   * non-update operation that spends the same Receiver UTxO (a side-deposit
   * merge) is mutually exclusive with updates by construction, not by an
   * external lock check. Resolves/rejects with the body's outcome.
   */
  enqueueLaneTask(dest: CardanoDestinationConfig, run: () => Promise<void>): Promise<void>;
  /** All currently-active queue keys (for diagnostics). */
  queueKeys(): string[];
  /** Total pending items across all queues. */
  totalPending(): number;
  /** Pending items per lane key (for the per-client queue-depth gauge). */
  pendingByLane(): Record<string, number>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQueueManager(options: QueueManagerOptions): QueueManager {
  const {
    clientFactory,
    onResult,
    inflightOptions,
    retryPolicy,
    inflightTimeoutMs,
  } = options;
  if (!Number.isFinite(inflightTimeoutMs) || inflightTimeoutMs <= 0) {
    throw new Error(
      `createQueueManager: inflightTimeoutMs must be a positive number, got ${inflightTimeoutMs}. ` +
        "Source: infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms",
    );
  }

  const queues = new Map<string, SubmissionQueue>();
  const sharedInflight = options.inflightTable ?? createInflightTable(inflightOptions);

  function getOrCreateQueue(dest: CardanoDestinationConfig): SubmissionQueue {
    const key = laneKey(dest);
    let queue = queues.get(key);
    if (!queue) {
      const client = clientFactory(dest.client_state_path, dest.protocol_state_path);
      queue = createSubmissionQueue({
        client,
        inflight: sharedInflight,
        retryPolicy,
        inflightTimeoutMs,
        onResult,
      });
      queues.set(key, queue);
    }
    return queue;
  }

  return {
    async submit(request) {
      const queue = getOrCreateQueue(request.destination);
      return queue.enqueue(request);
    },

    async submitBatch(requests) {
      if (requests.length === 0) {
        return [];
      }

      const [{ destination: firstDestination }] = requests;
      const firstKey = laneKey(firstDestination);

      for (const request of requests) {
        const requestKey = laneKey(request.destination);
        if (requestKey !== firstKey) {
          throw new Error(
            "QueueManager.submitBatch requires every request to target the same client/protocol lane.",
          );
        }
      }

      const queue = getOrCreateQueue(firstDestination);
      return queue.enqueueBatch(requests);
    },

    async enqueueLaneTask(dest, run) {
      const queue = getOrCreateQueue(dest);
      return queue.enqueueTask(run);
    },

    queueKeys() {
      return Array.from(queues.keys());
    },

    totalPending() {
      let total = 0;
      for (const queue of queues.values()) {
        total += queue.pending;
      }
      return total;
    },

    pendingByLane() {
      const out: Record<string, number> = {};
      for (const [key, queue] of queues) {
        out[key] = queue.pending;
      }
      return out;
    },
  };
}
