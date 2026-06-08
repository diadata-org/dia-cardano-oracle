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
//   This module provides (a) the WASM-signature matcher (mirroring the CLI's
//   `isTransientWasmBuildError`, intentionally NOT imported from the CLI
//   package) and (b) the pure decision/counter logic the daemon uses to decide
//   when to self-exit so a supervisor restarts it with a fresh WASM module.
//   Kept pure (no process.exit, no I/O) so the threshold logic is unit-tested
//   in isolation.
// ---------------------------------------------------------------------------

/**
 * Return true only for the transient lucid WASM detached-ArrayBuffer error
 * signature. Mirrors the CLI tx-build's `isTransientWasmBuildError` matcher
 * (kept as an independent copy — the feeder does not import from the CLI
 * package). Matches the known forms:
 *   - "...detached ArrayBuffer"
 *   - "%TypedArray%.prototype.set..."
 *   - any message mentioning "detached"
 */
export function isTransientWasmBuildError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    message.includes("detached ArrayBuffer") ||
    message.includes("%TypedArray%") ||
    message.includes("detached")
  );
}

/**
 * Compute the next consecutive-WASM-failure count given the current count and
 * the outcome of a submission that has ALREADY exhausted the worker-pool
 * retries (so a single transient blip the retries clear never reaches here).
 *
 *   - success            → reset to 0
 *   - WASM-signature fail → increment
 *   - any other failure   → unchanged (handled by the normal retry/alert path)
 *
 * Pure: no side effects, so the counter transitions are unit-tested directly.
 */
export function nextWasmFailureCount(
  current: number,
  outcome: { ok: boolean; error?: unknown },
): number {
  if (outcome.ok) return 0;
  return isTransientWasmBuildError(outcome.error) ? current + 1 : current;
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
