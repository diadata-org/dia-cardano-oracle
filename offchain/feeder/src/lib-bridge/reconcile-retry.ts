// Stale-input reconcile-and-rebuild for the oracle-update submit path.
//
// The build path fetches every input fresh from the provider, but after a
// restart or RPC turbulence the provider's indexer can lag the real chain: a
// UTxO it still reports as live was already spent by the previous batch on this
// lane. Building against it makes the node reject the tx with `BadInputsUTxO` /
// `TranslationLogicMissingInput` / `UtxoNotFound`. The lane serialisation is
// correct (one batch per lane); the gap is purely the provider's view drifting.
//
// `withStaleInputReconcile` retries the build+submit on exactly those rejections:
// it waits (via the injected `reconcile` step, which re-fetches the UTxO set)
// and rebuilds from the fresh view, instead of failing the batch. Any other
// error rethrows immediately so genuine failures are never masked.

// Substrings (lower-cased) that mark a stale-input ledger rejection: the local
// view selected a UTxO the chain has already consumed.
const STALE_INPUT_MARKERS = [
  "badinputsutxo",
  "translationlogicmissinginput",
  "utxonotfound",
  "utxo was not found",
  "missing input",
];

function errorHaystack(error: unknown): string {
  const ownMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return `${ownMessage} ${causeMessage}`.toLowerCase();
}

/**
 * True only for stale-input rejections that re-fetching the UTxO set and
 * rebuilding can recover from. Inspects the message and a nested `cause`.
 */
export function isStaleInputError(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return STALE_INPUT_MARKERS.some((marker) => haystack.includes(marker));
}

export type StaleInputReconcileOptions = {
  /** Total build attempts (>= 1). */
  maxAttempts: number;
  /** Predicate for a reconcilable error (defaults to {@link isStaleInputError}). */
  isRetriable?: (error: unknown) => boolean;
  /** Injectable sleep between attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Wait before each reconcile so the provider's indexer can catch up. */
  reconcileDelayMs?: number;
  /** Optional progress sink. */
  log?: (message: string) => void;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `build` (fetch fresh UTxOs → build → sign → submit). On a stale-input
 * rejection, run `reconcile(attempt)` (re-fetch the UTxO view, after a settle
 * delay) and retry `build`, up to `maxAttempts` times. Non-stale errors and the
 * final stale error rethrow.
 *
 * `build` MUST re-fetch its inputs each call — the whole point is that the
 * second attempt sees a fresh provider view.
 */
export async function withStaleInputReconcile<T>(
  build: () => Promise<T>,
  reconcile: (attempt: number) => Promise<void>,
  options: StaleInputReconcileOptions,
): Promise<T> {
  const { maxAttempts } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `withStaleInputReconcile: maxAttempts must be a number >= 1, got ${maxAttempts}.`,
    );
  }
  const isRetriable = options.isRetriable ?? isStaleInputError;
  const sleep = options.sleep ?? defaultSleep;
  const reconcileDelayMs = options.reconcileDelayMs ?? 0;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await build();
    } catch (error) {
      if (!isRetriable(error)) throw error;
      lastError = error;
      if (attempt >= maxAttempts) break;
      const detail = error instanceof Error ? error.message : String(error);
      options.log?.(
        `stale-input rejection on attempt ${attempt}/${maxAttempts} (${detail}); ` +
          `reconciling UTxO view and rebuilding.`,
      );
      if (reconcileDelayMs > 0) await sleep(reconcileDelayMs);
      await reconcile(attempt);
    }
  }
  throw lastError;
}
