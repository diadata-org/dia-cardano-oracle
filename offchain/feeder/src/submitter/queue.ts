// Serial submission queue for one (receiverUnit) lane.
//
// Cardano UTxO semantics require that updates to the same
// (Pair UTxO, Receiver UTxO) pair be strictly serial: the second tx
// must spend the UTxOs produced by the first. Concurrency would
// produce double-spend conflicts.
//
// This queue enforces that serialization by processing one
// `SubmitRequest` at a time and blocking enqueue when the receiver is
// locked in the in-flight table.
//
// Spectra equivalent:
//   `pkg/submitter/queue.go` — per-(wallet, chainID) serial executor.
//
// The queue does NOT retry. A failed submission surfaces the error to
// the caller via `SubmitResultErr`; retry policy is the caller's
// concern (the queue manager will re-enqueue on transient errors if
// configured).

import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "./types.js";
import type { InflightTable } from "./inflight.js";
import { makeInflightEntry } from "./inflight.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueEntry = {
  request: SubmitRequest;
  resolve: (result: SubmitResult) => void;
};

export type SubmissionQueue = {
  /** Enqueue a request. Resolves when the request has been processed
   *  (ok or error). */
  enqueue(request: SubmitRequest): Promise<SubmitResult>;
  /** Number of requests waiting to be processed. */
  readonly pending: number;
  /** Whether the queue is currently processing a request. */
  readonly busy: boolean;
};

export type QueueOptions = {
  client: CardanoWriteClient;
  inflight: InflightTable;
  /** Called after each result for logging. */
  onResult?: (result: SubmitResult) => void;
  /** Timeout (ms) for in-flight entries created by this queue. */
  inflightTimeoutMs?: number;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubmissionQueue(options: QueueOptions): SubmissionQueue {
  const { client, inflight, onResult, inflightTimeoutMs, now } = options;

  const pending: QueueEntry[] = [];
  let busy = false;

  async function drain(): Promise<void> {
    if (busy || pending.length === 0) return;
    busy = true;

    const entry = pending.shift()!;
    const { request, resolve } = entry;

    let result: SubmitResult;
    try {
      result = await client.submit(request);
    } catch (err) {
      result = {
        ok: false,
        intentHash: request.intentHash,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    // Record in inflight table if submit succeeded.
    if (result.ok) {
      inflight.add(
        makeInflightEntry(
          result.cardanoTxHash,
          result.intentHash,
          // The client resolves the receiverUnit; we approximate with intentHash
          // until the client surfaces the receiverUnit in the result (Phase 3.5).
          `pending:${result.intentHash}`,
          { timeoutMs: inflightTimeoutMs, now },
        ),
      );
    }

    onResult?.(result);
    resolve(result);
    busy = false;

    // Process next without growing the call stack.
    setImmediate(drain);
  }

  return {
    enqueue(request) {
      return new Promise<SubmitResult>((resolve) => {
        pending.push({ request, resolve });
        void drain();
      });
    },

    get pending() {
      return pending.length;
    },

    get busy() {
      return busy;
    },
  };
}
