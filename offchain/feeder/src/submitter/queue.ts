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

export type QueueEntry = {
  requests: SubmitRequest[];
  resolve: (result: SubmitResult[]) => void;
};

export type SubmissionQueue = {
  /** Enqueue a request. Resolves when the request has been processed
   *  (ok or error). */
  enqueue(request: SubmitRequest): Promise<SubmitResult>;
  /** Enqueue a batch of requests for one shared Cardano submission. */
  enqueueBatch(requests: SubmitRequest[]): Promise<SubmitResult[]>;
  /** Number of requests waiting to be processed. */
  readonly pending: number;
  /** Whether the queue is currently processing a request. */
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

  async function drain(): Promise<void> {
    if (busy || pending.length === 0) return;
    busy = true;

    const entry = pending.shift()!;
    const { requests, resolve } = entry;

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
          requests: [request],
          resolve: (results) => resolve(results[0]!),
        });
        void drain();
      });
    },

    enqueueBatch(requests) {
      return new Promise<SubmitResult[]>((resolve) => {
        pending.push({ requests, resolve });
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
