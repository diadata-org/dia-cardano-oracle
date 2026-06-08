// ---------------------------------------------------------------------------
// tx-build.ts — resilient `.complete()` wrapper for the BUILD step.
//
// WHY
//   @lucid-evolution/lucid (^0.4.29) intermittently throws a transient WASM
//   error from inside `.complete()`:
//       TypeError: Cannot perform %TypedArray%.prototype.set on a detached
//       ArrayBuffer
//   This happens when lucid's WASM linear memory grows mid-build and detaches
//   a TypedArray view it was still holding. The build inputs are valid — the
//   same `.complete()`, retried, succeeds. A full Preview run hit this at
//   `payment-hook:withdraw` even though the byte-identical `receiver:withdraw`
//   builder had just succeeded.
//
//   completeWithRetry retries ONLY on that transient WASM signature, and on
//   each attempt it REBUILDS a fresh tx from scratch via the supplied build
//   factory. This is required because lucid's TxBuilder is STATEFUL and
//   `.complete()` is NOT idempotent — re-calling `.complete()` on the same
//   builder after a failed attempt DUPLICATES the outputs and produces a
//   corrupt tx (a live Preview run hit this at `payment-hook:withdraw`, where
//   the retried `.complete()` built a tx with both outputs TWICE and the node
//   rejected it with a deserialise size mismatch). Any other error
//   (validation, fee, "amount exceeds…", etc.) rethrows immediately so real
//   failures are never masked.
//
// ENV OVERRIDES (defaults live in core/constants.ts)
//   TX_BUILD_ATTEMPTS        (default 3)    total build attempts
//   TX_BUILD_RETRY_DELAY_MS  (default 300)  backoff between attempts, in ms
// ---------------------------------------------------------------------------

import type { TxSignBuilder } from "@lucid-evolution/lucid";

import {
  DEFAULT_TX_BUILD_ATTEMPTS,
  DEFAULT_TX_BUILD_RETRY_DELAY_MS,
  envNumber,
} from "./constants.js";

/** Minimal structural view of a lucid tx builder: just the build `.complete()`. */
type CompletableTxBuilder = {
  complete(): Promise<TxSignBuilder>;
};

type ReportProgress = (message: string) => void;

/**
 * Return true only for the transient lucid WASM detached-ArrayBuffer error
 * that retrying the build can recover from. Matches the known signatures:
 *   - "...detached ArrayBuffer"
 *   - "%TypedArray%.prototype.set..."
 *   - any message mentioning "detached"
 */
function isTransientWasmBuildError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    message.includes("detached ArrayBuffer") ||
    message.includes("%TypedArray%") ||
    message.includes("detached")
  );
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Build a tx and run its `.complete()` with retries scoped to the transient
 * lucid WASM detached-ArrayBuffer bug. On each attempt the build factory is
 * invoked to construct a FRESH builder, because lucid's `.complete()` is not
 * idempotent (re-completing the same builder duplicates outputs). Real build
 * errors rethrow on the first attempt.
 *
 * @param buildTx        factory that constructs a fresh lucid builder. It must
 *                       only do the SYNCHRONOUS builder construction; the async
 *                       data fetches (config/ref-script/wallet UTxOs, datums,
 *                       redeemers) belong OUTSIDE the factory so they are not
 *                       re-fetched per attempt.
 * @param reportProgress optional progress sink (commands pass theirs; library
 *                       builders without one fall back to console.warn)
 */
export async function completeWithRetry(
  buildTx: () => CompletableTxBuilder | Promise<CompletableTxBuilder>,
  reportProgress?: ReportProgress,
): Promise<TxSignBuilder> {
  const log: ReportProgress =
    reportProgress ?? ((message) => console.warn(message));
  const attempts = envNumber("TX_BUILD_ATTEMPTS", DEFAULT_TX_BUILD_ATTEMPTS);
  const retryDelayMs = envNumber(
    "TX_BUILD_RETRY_DELAY_MS",
    DEFAULT_TX_BUILD_RETRY_DELAY_MS,
  );

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const builder = await buildTx();
      return await builder.complete();
    } catch (error) {
      // Real errors (validation, fee, balancing, …) must surface immediately.
      if (!isTransientWasmBuildError(error)) {
        throw error;
      }
      lastError = error;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        log(
          `Transient lucid WASM build error on attempt ${attempt}/${attempts}; ` +
            `retrying .complete() in ${retryDelayMs}ms (${detail}).`,
        );
        await sleep(retryDelayMs);
      } else {
        log(
          `Transient lucid WASM build error persisted after ${attempts} attempts (${detail}).`,
        );
      }
    }
  }

  throw lastError;
}
