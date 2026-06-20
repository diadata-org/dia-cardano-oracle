// ---------------------------------------------------------------------------
// provider-retry.ts — transient-network retry wrapper for the Lucid Provider.
//
// WHY
//   One-shot admin commands (`pair:burn`, `receiver:settle`,
//   `payment-hook:withdraw`, …) make several provider calls — wallet/UTxO
//   fetches during `.complete()`, the `submitTx`, protocol-parameter lookups.
//   A single transient `fetch failed` (a network blip to Blockfrost/Koios)
//   aborts the whole command mid-run, forcing the operator to re-run by hand.
//
//   Wrapping the Provider itself (rather than each of the ~16 call sites) gives
//   every command — and the feeder's CLI-backed path — transparent retry with
//   backoff on transient network errors. Real ledger/validation errors
//   (BadInputsUTxO, ValueNotConservedUTxO, …) and the Blockfrost 402 quota wall
//   are NOT retried — they rethrow immediately so genuine failures surface fast.
//
//   `submitTx` retry is safe: re-submitting the identical signed transaction is
//   idempotent on its tx hash; the node dedupes it.
//
// ENV OVERRIDES (defaults live in core/constants.ts)
//   PROVIDER_RETRY_ATTEMPTS    total attempts per provider call
//   PROVIDER_RETRY_DELAY_MS    base backoff (doubles each attempt)
// ---------------------------------------------------------------------------

import type { Provider } from "@lucid-evolution/core-types";

// Substrings (lower-cased) that mark a retriable transient transport error.
// Textual HTTP phrases are used instead of bare status numbers so a hex tx hash
// that happens to contain "429"/"503" is never misclassified.
const TRANSIENT_MARKERS = [
  "fetch failed",
  "econnreset",
  "econnrefused",
  "etimedout",
  "epipe",
  "socket hang up",
  "network error",
  "timed out",
  "timeout",
  "enotfound",
  "eai_again",
  "too many requests", // 429
  "service unavailable", // 503
  "bad gateway", // 502
  "gateway timeout", // 504
];

// Lower-cased message + nested cause (fetch wraps the underlying socket error).
function errorHaystack(error: unknown): string {
  const ownMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const causeMessage =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return `${ownMessage} ${causeMessage}`.toLowerCase();
}

/**
 * True only for transient transport errors that a retry can recover from.
 * Inspects the error message and a nested `cause` (fetch wraps the underlying
 * socket error). Ledger/validation errors and the 402 quota wall return false.
 */
export function isTransientProviderError(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return TRANSIENT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * True for the Blockfrost 402 "Payment Required" quota wall — the daily request
 * budget is spent. NOT transient: retrying cannot recover it, so it is never
 * retried; it is surfaced (and counted) so the operator rotates/upgrades the key.
 */
export function isQuotaError(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return (
    haystack.includes("payment required") ||
    haystack.includes(" 402") ||
    haystack.includes("402 ")
  );
}

/**
 * True for a 429 "Too Many Requests" throttle — transient (retried) but worth
 * counting separately as the leading indicator that the key is nearing its
 * quota / rate ceiling.
 */
export function isRateLimitError(error: unknown): boolean {
  const haystack = errorHaystack(error);
  return (
    haystack.includes("too many requests") ||
    haystack.includes("rate limit") ||
    haystack.includes(" 429") ||
    haystack.includes("429 ")
  );
}

/** Per-attempt outcome reported to the call observer. */
export type ProviderCallOutcome = "ok" | "rate_limited" | "quota_exceeded" | "error";

export type ProviderCallEvent = {
  /** Provider name (e.g. "Blockfrost", "Koios", or "unknown"). */
  provider: string;
  /** Provider method invoked (e.g. "submitTx", "getUtxos"). */
  method: string;
  /** Outcome of THIS attempt (fires once per underlying request). */
  outcome: ProviderCallOutcome;
};

function classifyOutcome(error: unknown): ProviderCallOutcome {
  if (isQuotaError(error)) return "quota_exceeded";
  if (isRateLimitError(error)) return "rate_limited";
  return "error";
}

export type ProviderRetryOptions = {
  /** Total attempts per provider call (>= 1). */
  attempts: number;
  /** Base backoff in ms; doubles each attempt. */
  delayMs: number;
  /** Optional cap on the backoff delay. */
  maxDelayMs?: number;
  /** Injectable sleep (tests pass a no-op spy). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress sink for retry notices. */
  log?: (message: string) => void;
  /** Provider name stamped on every {@link ProviderCallEvent}. */
  providerName?: string;
  /** Observer fired once per underlying request (each attempt), for the
   *  per-provider request/error/quota consumption metrics. */
  onCall?: (event: ProviderCallEvent) => void;
};

// Only these Provider methods are wrapped — never constructor/toString/symbols,
// which a blanket proxy would otherwise intercept and break.
const PROVIDER_METHODS = new Set<string>([
  "getProtocolParameters",
  "getUtxos",
  "getUtxosWithUnit",
  "getUtxoByUnit",
  "getUtxosByOutRef",
  "getDelegation",
  "getDatum",
  "awaitTx",
  "submitTx",
  "evaluateTx",
]);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a Lucid Provider so every network call retries transient transport
 * errors with exponential backoff. Non-transient errors rethrow on the first
 * failure. Non-method properties pass through untouched.
 */
export function createRetryingProvider(
  provider: Provider,
  options: ProviderRetryOptions,
): Provider {
  if (!Number.isFinite(options.attempts) || options.attempts < 1) {
    throw new Error(
      `createRetryingProvider: attempts must be a number >= 1, got ${options.attempts}.`,
    );
  }
  const { attempts, delayMs } = options;
  const sleep = options.sleep ?? defaultSleep;
  const maxDelayMs = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  const providerName = options.providerName ?? "unknown";

  async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await run();
        options.onCall?.({ provider: providerName, method: label, outcome: "ok" });
        return result;
      } catch (error) {
        options.onCall?.({
          provider: providerName,
          method: label,
          outcome: classifyOutcome(error),
        });
        if (!isTransientProviderError(error)) throw error;
        lastError = error;
        if (attempt >= attempts) break;
        const backoffMs = Math.min(delayMs * 2 ** (attempt - 1), maxDelayMs);
        const detail = error instanceof Error ? error.message : String(error);
        options.log?.(
          `provider.${label}: transient error on attempt ${attempt}/${attempts}; ` +
            `retrying in ${backoffMs}ms (${detail}).`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastError;
  }

  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !PROVIDER_METHODS.has(prop) || typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): Promise<unknown> =>
        withRetry(prop, () => Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args)));
    },
  });
}
