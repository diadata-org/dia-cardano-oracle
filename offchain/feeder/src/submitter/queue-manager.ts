// Queue manager — one serial queue per (updaterWallet, receiverUnit).
//
// The manager is the single entry point the rest of the feeder calls
// to schedule a Cardano submission. It routes each `SubmitRequest` to
// the correct queue based on its destination configuration, creating
// new queues on demand.
//
// Spectra equivalent:
//   `pkg/submitter/queue_manager.go` — routes EVM txs to the
//   per-(wallet, chainID) queue. Here the key is
//   (clientStatePath, protocolStatePath) which uniquely identifies
//   a (receiver, client config) pair on Cardano.
//
// Why per-queue and not one global queue?
//   Different Cardano destinations share no UTxO state. We can safely
//   submit to client-A and client-B in parallel; only submissions
//   within the same client must be serial.

import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "./types.js";
import { createInflightTable, type InflightTable, type InflightTableOptions } from "./inflight.js";
import { createSubmissionQueue, type SubmissionQueue } from "./queue.js";
import { setTimeout as sleep } from "node:timers/promises";

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
  /** Result callback forwarded to each queue. */
  onResult?: (result: SubmitResult) => void;
  /**
   * Maximum wall-clock ms for a single submit+confirm cycle before it
   * is considered failed. Maps to `worker_pool.task_timeout` in the YAML.
   * Default: 60 000 ms.
   */
  taskTimeoutMs?: number;
  /**
   * How many ms to wait between retry attempts on a transient failure.
   * Maps to `worker_pool.retry_delay` in the YAML. Default: 5 000 ms.
   */
  retryDelayMs?: number;
  /**
   * Max consecutive retry attempts per intent before giving up.
   * Maps to `worker_pool.max_retries` in the YAML. Default: 3.
   */
  maxRetries?: number;
};

export type QueueManager = {
  /** Schedule a submit request on the appropriate queue. Returns a
   *  promise that resolves when the request has been processed. */
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** All currently-active queue keys (for diagnostics). */
  queueKeys(): string[];
  /** Total pending items across all queues. */
  totalPending(): number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The queue key identifies the Cardano "lane" — the UTxO pair that a
 * submission touches. It is the concatenation of the client-state path
 * and the protocol-state path from the destination config, since those
 * two files uniquely identify a (receiver, protocol) deployment.
 */
function queueKey(clientStatePath: string, protocolStatePath: string): string {
  return `${clientStatePath}::${protocolStatePath}`;
}

export function createQueueManager(options: QueueManagerOptions): QueueManager {
  const {
    clientFactory,
    onResult,
    inflightOptions,
    taskTimeoutMs = 60_000,
    retryDelayMs  = 5_000,
    maxRetries    = 3,
  } = options;

  const queues = new Map<string, SubmissionQueue>();
  const sharedInflight = options.inflightTable ?? createInflightTable(inflightOptions);

  function getOrCreateQueue(clientStatePath: string, protocolStatePath: string): SubmissionQueue {
    const key = queueKey(clientStatePath, protocolStatePath);
    let queue = queues.get(key);
    if (!queue) {
      const client = clientFactory(clientStatePath, protocolStatePath);
      queue = createSubmissionQueue({
        client,
        inflight: sharedInflight,
        inflightTimeoutMs: taskTimeoutMs,
        onResult,
      });
      queues.set(key, queue);
    }
    return queue;
  }

  return {
    async submit(request) {
      const { client_state_path, protocol_state_path } = request.destination;
      const queue = getOrCreateQueue(client_state_path, protocol_state_path);

      let attempt = 0;
      while (true) {
        const result = await queue.enqueue(request);
        if (result.ok || attempt >= maxRetries) return result;
        attempt++;
        await sleep(retryDelayMs);
      }
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
  };
}
