// ---------------------------------------------------------------------------
// wasm-failure-guard.ts — persistent lucid WASM-build failure detection.
//
// WHY
//   @lucid-evolution/lucid (^0.4.29) intermittently throws a transient WASM
//   build error from inside `.complete()`:
//       TypeError: Cannot perform %TypedArray%.prototype.set on a detached
//       ArrayBuffer
//   when its WASM linear memory grows mid-build and detaches a held TypedArray
//   view. The COMMON glitch is already handled in-process: the CLI tx-build's
//   `completeWithRetry` rebuilds-and-retries, and the feeder's worker pool
//   retries the lane task (`worker_pool.max_retries`). The RARE case is a
//   genuinely corrupted WASM module that an in-process rebuild can NOT clear —
//   the daemon is long-running, so only a FRESH PROCESS recovers.
//
//   This module provides (a) the WASM-signature matcher and (b) the pure
//   decision/counter logic the daemon uses to decide when to self-exit so a
//   supervisor restarts it with a fresh WASM module. Kept pure (no
//   process.exit, no I/O) so the threshold logic is unit-tested in isolation.
//
//   The matcher recognises TWO lucid WASM build-error families that a fresh
//   PROCESS clears but an in-process rebuild does not:
//     1. the detached-ArrayBuffer family (WASM linear memory grew mid-build and
//        detached a held TypedArray view), and
//     2. the hard WASM trap family — `RuntimeError: unreachable` — which poisons
//        the WASM module for every subsequent build in the same process. A live
//        Preview run proved this: after the trap the CLI (a fresh process) built
//        the byte-identical tx fine while the long-running daemon kept failing
//        until it was restarted. Counting it here is what makes the self-exit
//        fire; before, the streak only counted the detached family, so a trap
//        storm left the daemon mute for hours with no restart.
// ---------------------------------------------------------------------------

/**
 * Return true for a lucid WASM build-error signature that only a FRESH PROCESS
 * recovers from (an in-process rebuild cannot clear it). Matches:
 *   - the detached-ArrayBuffer family: "...detached ArrayBuffer",
 *     "%TypedArray%.prototype.set...", any message mentioning "detached"
 *   - the hard WASM trap family: "RuntimeError: unreachable" / "unreachable"
 * Kept as an independent copy — the feeder does not import from the CLI package.
 */
export function isProcessRecoverableWasmError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    message.includes("detached ArrayBuffer") ||
    message.includes("%TypedArray%") ||
    message.includes("detached") ||
    message.includes("unreachable")
  );
}

/**
 * Compute the next consecutive-WASM-failure count given the current count and
 * the outcome of a submission that has ALREADY exhausted the worker-pool
 * retries (so a single transient blip the retries clear never reaches here).
 *
 *   - success                       → reset to 0
 *   - process-recoverable WASM fail → increment
 *   - any other failure             → unchanged (handled by the normal
 *                                     retry/alert path; e.g. NonMonotonicNonce,
 *                                     or a collateral-exhaustion build error
 *                                     that auto-consolidate — not a restart —
 *                                     resolves)
 *
 * Pure: no side effects, so the counter transitions are unit-tested directly.
 */
export function nextWasmFailureCount(
  current: number,
  outcome: { ok: boolean; error?: unknown },
): number {
  if (outcome.ok) return 0;
  return isProcessRecoverableWasmError(outcome.error) ? current + 1 : current;
}

/**
 * Decision: has the consecutive WASM-failure count reached the fatal threshold
 * (so the daemon should self-exit and let a supervisor restart it with a fresh
 * WASM module)? Pure — does NOT call process.exit; the caller owns that.
 */
export function shouldExitOnWasmFailures(
  consecutiveCount: number,
  threshold: number,
): boolean {
  return consecutiveCount >= threshold;
}
