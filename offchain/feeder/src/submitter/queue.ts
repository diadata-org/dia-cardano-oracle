// Serial submission queue for one (receiverUnit) lane.
//
// Cardano UTxO semantics require that updates to the same
// (Pair UTxO, Receiver UTxO) pair be strictly serial: the second tx
// must spend the UTxOs produced by the first. Concurrency would
// produce double-spend conflicts.
//
// This queue enforces that serialization by processing one
// `SubmitRequest` at a time. When a `RetryPolicy` is configured, failed
// submissions are retried inside `drain()` before the result is
// surfaced to `onResult` and the enqueue promise. This means the caller
// sees only the final outcome (success or exhausted retries), never
// intermediate failures.
//
// Spectra equivalent:
//   `pkg/submitter/queue.go` — per-(wallet, chainID) serial executor.

import { setTimeout as sleep } from "node:timers/promises";

import type { CardanoWriteClient, SubmitRequest, SubmitResult, SubmitResultErr } from "./types.js";
import type { InflightTable } from "./inflight.js";
import { makeInflightEntry } from "./inflight.js";
import { classifyError } from "../errors/index.js";
import type { RetryPolicy } from "./retry-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A unit of work the serial queue processes. Two shapes share one lane so
 * they never overlap on the same Receiver UTxO:
 *
 *   - `submit`: a batch of oracle-update `SubmitRequest`s submitted via the
 *     write client (the normal update path).
 *   - `task`:   an arbitrary async body run to completion before the next
 *     entry starts. Used to fold a side-deposit merge onto the SAME lane as
 *     the client's updates so an update and a merge can never run at once.
 *     The body itself owns its in-flight lock + confirm-wait (the queue does
 *     not record an inflight entry for it, unlike a `submit`).
 */
export type QueueEntry =
  | {
      kind: "submit";
      requests: SubmitRequest[];
      resolve: (result: SubmitResult[]) => void;
    }
  | {
      kind: "task";
      run: () => Promise<void>;
      resolve: () => void;
      reject: (err: unknown) => void;
    };

export type SubmissionQueue = {
  /** Enqueue a request. Resolves when the request has been processed
   *  (ok or error). */
  enqueue(request: SubmitRequest): Promise<SubmitResult>;
  /** Enqueue a batch of requests for one shared Cardano submission. */
  enqueueBatch(requests: SubmitRequest[]): Promise<SubmitResult[]>;
  /**
   * Enqueue an arbitrary async body onto this lane's serial queue. The body
   * runs only when no other entry (update batch or task) is executing on the
   * lane, and the next entry waits until it completes — this is the hard
   * mutual-exclusion guarantee a deposit merge relies on to never race an
   * oracle update for the same Receiver UTxO. The returned promise settles
   * when the body settles (its result/throw is propagated to the caller).
   */
  enqueueTask(run: () => Promise<void>): Promise<void>;
  /** Number of entries waiting to be processed. */
  readonly pending: number;
  /** Whether the queue is currently processing an entry. */
  readonly busy: boolean;
};

export type QueueOptions = {
  client: CardanoWriteClient;
  inflight: InflightTable;
  /** Called once per enqueue call with the final result (after all retries). */
  onResult?: (result: SubmitResult) => void;
  /** Retry policy applied after each failed attempt. When absent the queue
   *  surfaces the first failure immediately without retrying. */
  retryPolicy?: RetryPolicy;
  /** REQUIRED — timeout (ms) for in-flight entries created by this queue.
   *  Sourced from `infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms`. */
  inflightTimeoutMs: number;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubmissionQueue(options: QueueOptions): SubmissionQueue {
  const { client, inflight, onResult, retryPolicy, inflightTimeoutMs, now } = options;

  const pending: QueueEntry[] = [];
  let busy = false;

  function wrapErrorResults(requests: SubmitRequest[], err: unknown): SubmitResult[] {
    const { code, remediation } = classifyError(err);
    const error = err instanceof Error ? err : new Error(String(err));
    return requests.map((request) => ({
      ok: false,
      intentHash: request.intentHash,
      error,
      code,
      remediation,
    }));
  }

  async function trySubmitBatch(requests: SubmitRequest[]): Promise<SubmitResult[]> {
    try {
      if (requests.length === 1) {
        return [await client.submit(requests[0]!)];
      }
      return await client.submitBatch(requests);
    } catch (err) {
      return wrapErrorResults(requests, err);
    }
  }

  async function drainTask(entry: Extract<QueueEntry, { kind: "task" }>): Promise<void> {
    // Run the caller-supplied body to completion before the next lane entry
    // starts. The body owns its own in-flight lock + confirm-wait, so the
    // queue records nothing in the inflight table here — it only guarantees
    // serialization on the lane. Errors propagate to the enqueue caller.
    try {
      await entry.run();
      entry.resolve();
    } catch (err) {
      entry.reject(err);
    }
  }

  async function drain(): Promise<void> {
    if (busy || pending.length === 0) return;
    busy = true;

    const nextEntry = pending.shift()!;
    if (nextEntry.kind === "task") {
      await drainTask(nextEntry);
      busy = false;
      setImmediate(drain);
      return;
    }

    const { requests, resolve } = nextEntry;

    // First attempt.
    let results = await trySubmitBatch(requests);

    // Retry loop — only entered when a policy is configured and the first
    // attempt failed. Each retry uses the policy's decision for the current
    // attempt count (0 = first failure, 1 = after first retry, …).
    if (results.length > 0 && !results.every((result) => result.ok) && retryPolicy) {
      let attempt = 0;
      while (true) {
        const firstError = results.find((result): result is SubmitResultErr => !result.ok);
        if (!firstError) break;
        const decision = retryPolicy.decide(firstError, attempt);
        if (!decision.shouldRetry) break;
        await sleep(decision.delayMs);
        attempt++;
        results = await trySubmitBatch(requests);
        if (results.every((result) => result.ok)) break;
      }
    }

    // Record in inflight table when the final result is a success.
    const firstSuccess = results.find((result) => result.ok);
    if (firstSuccess) {
      inflight.add(
        makeInflightEntry(
          firstSuccess.cardanoTxHash,
          firstSuccess.intentHash,
          firstSuccess.receiverUnit,
          { timeoutMs: inflightTimeoutMs, now },
        ),
      );
    }

    for (const result of results) {
      onResult?.(result);
    }
    resolve(results);
    busy = false;

    // Process next without growing the call stack.
    setImmediate(drain);
  }

  return {
    enqueue(request) {
      return new Promise<SubmitResult>((resolve) => {
        pending.push({
          kind: "submit",
          requests: [request],
          resolve: (results) => resolve(results[0]!),
        });
        void drain();
      });
    },

    enqueueBatch(requests) {
      return new Promise<SubmitResult[]>((resolve) => {
        pending.push({ kind: "submit", requests, resolve });
        void drain();
      });
    },

    enqueueTask(run) {
      return new Promise<void>((resolve, reject) => {
        pending.push({ kind: "task", run, resolve, reject });
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
