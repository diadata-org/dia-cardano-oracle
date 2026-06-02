// Destination policy gating — time_threshold and price_deviation.
//
// Before the router dispatches an intent to a destination it calls
// `shouldSubmit()`. The function returns a typed result so the caller
// can log the exact reason a dispatch was suppressed.
//
// Spectra equivalent:
//   `pkg/router/generic_router.go` — DestinationState + the
//   `time_threshold` / `price_deviation` guards inside
//   `processIntentEvent`.
//
// Semantics (OR-gate — identical to Spectra):
//
//   time_threshold   — suppress the update if the last confirmed
//                      Cardano tx for this (route, dest, symbol) was
//                      less than `time_threshold` milliseconds ago
//                      (wall-clock time since the last `updatedAtMs`).
//
//   price_deviation  — suppress the update if the new price is within
//                      `price_deviation` percent of the last recorded
//                      price, i.e. skip if
//                        |new - old| / old * 100  <  deviation%.
//
// OR-gate logic (matches Spectra generic_router.go:361-414):
//   - if neither threshold is configured: always pass
//   - if only time configured: pass iff timePasses
//   - if only price configured: pass iff pricePasses
//   - if both configured: pass iff timePasses OR pricePasses
//   - if no prior cache entry exists: always pass
//
// Timestamp monotonicity:
//   - newTimestamp < lastTimestamp: warn + suppress (timestamp_regression)
//   - newTimestamp === lastTimestamp: suppress (timestamp_duplicate)
//
// String parsing:
//   time_threshold   accepts "1m", "30s", "2h", "1h30m", etc.
//   price_deviation  accepts "0.5%", "1%", "0.1%". Leading/trailing
//                    whitespace is stripped.

import type { PriceCache, PriceCacheKey } from "../processor/price-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyGateOptions = {
  /** Parsed from `time_threshold` in the router YAML. `undefined` = no gate. */
  timeThresholdMs?: number;
  /** Parsed from `price_deviation` in the router YAML. `undefined` = no gate.
   *  Value is in percent (e.g. 0.5 means 0.5%). */
  priceDeviationPct?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason: "time_threshold"; lastUpdatedAtMs: number; thresholdMs: number; filterReason: string }
  | { allowed: false; reason: "price_deviation"; oldPrice: bigint; newPrice: bigint; deviationPct: number; thresholdPct: number; filterReason: string }
  | { allowed: false; reason: "timestamp_regression"; lastTimestamp: bigint; newTimestamp: bigint; filterReason: string }
  | { allowed: false; reason: "timestamp_duplicate"; timestamp: bigint; filterReason: string };

// ---------------------------------------------------------------------------
// String parsers — Spectra YAML format.
// ---------------------------------------------------------------------------

/**
 * Parse a Spectra-style duration string into milliseconds.
 * Supports: "30s", "1m", "2h", "1h30m", "1h30m10s", "500ms".
 * Returns `undefined` for an empty or absent string.
 * Throws for an unrecognised format.
 *
 * `"0s"` is a VALID value that returns 0 — it is the intentional "disabled
 * gate" sentinel: a `time_threshold` of 0 means the time gate always passes
 * (submit on every event, subject to the price gate), and the cron service
 * reads 0 as "this destination has no cron cadence". Negative durations are
 * rejected by the token regex (`\d+` does not match a leading `-`), so a
 * malformed `"-5s"` throws rather than silently disabling the gate.
 */
export function parseDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;

  let remaining = s;
  let total = 0;
  const UNIT: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  // Greedy token: (<number>)(ms|s|m|h|d)
  const token = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)/;
  while (remaining.length > 0) {
    const match = token.exec(remaining);
    if (!match) {
      throw new Error(
        `Invalid duration "${raw}": unrecognised token at "${remaining}". ` +
        `Expected format: "30s", "1m", "2h", "1h30m10s", "500ms".`,
      );
    }
    total += parseFloat(match[1]) * UNIT[match[2]];
    remaining = remaining.slice(match[0].length);
  }
  return total;
}

/**
 * Parse a Spectra-style percentage string into a number.
 * "0.5%" → 0.5, "1%" → 1.
 * Returns `undefined` for an empty or absent string. Throws on bad format.
 */
export function parseDeviationPct(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (!s.endsWith("%")) {
    throw new Error(`Invalid price_deviation "${raw}": must end with "%".`);
  }
  const n = parseFloat(s.slice(0, -1));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid price_deviation "${raw}": must be a non-negative number.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Policy gate
// ---------------------------------------------------------------------------

/**
 * Build a reusable policy gate for one destination within one router.
 * The gate consults the price cache to retrieve the last state and
 * returns a typed verdict so the caller can log what happened.
 *
 * The returned function accepts `(key, newPrice, newTimestamp)`.
 * Timestamp monotonicity is checked before the OR-gate thresholds.
 */
export function createPolicyGate(
  priceCache: PriceCache,
  options: PolicyGateOptions,
): (key: PriceCacheKey, newPrice: bigint, newTimestamp?: bigint) => PolicyVerdict {
  const { timeThresholdMs, priceDeviationPct } = options;
  const clock = options.now ?? Date.now;

  return (key, newPrice, newTimestamp) => {
    const last = priceCache.get(key);

    // --- Timestamp monotonicity (checked before OR-gate) ---
    if (newTimestamp !== undefined && last !== undefined) {
      if (newTimestamp < last.timestamp) {
        return {
          allowed: false,
          reason: "timestamp_regression",
          lastTimestamp: last.timestamp,
          newTimestamp,
          filterReason: `timestamp_regression: new=${newTimestamp} < last=${last.timestamp}`,
        };
      }
      if (newTimestamp === last.timestamp) {
        return {
          allowed: false,
          reason: "timestamp_duplicate",
          timestamp: newTimestamp,
          filterReason: `timestamp_duplicate: timestamp=${newTimestamp} already recorded`,
        };
      }
    }

    // If no prior entry, always pass.
    if (last === undefined) {
      return { allowed: true };
    }

    // If no thresholds configured, always pass.
    if (timeThresholdMs === undefined && priceDeviationPct === undefined) {
      return { allowed: true };
    }

    // --- OR-gate: evaluate each configured threshold ---
    let timePasses: boolean | undefined;
    let timeVerdictOnFail: Extract<PolicyVerdict, { reason: "time_threshold" }> | undefined;

    if (timeThresholdMs !== undefined) {
      const elapsedMs = clock() - last.updatedAtMs;
      timePasses = elapsedMs >= timeThresholdMs;
      if (!timePasses) {
        timeVerdictOnFail = {
          allowed: false,
          reason: "time_threshold",
          lastUpdatedAtMs: last.updatedAtMs,
          thresholdMs: timeThresholdMs,
          filterReason: `time_threshold: ${Math.round(elapsedMs / 1000)}s elapsed < ${Math.round(timeThresholdMs / 1000)}s`,
        };
      }
    }

    let pricePasses: boolean | undefined;
    let priceVerdictOnFail: Extract<PolicyVerdict, { reason: "price_deviation" }> | undefined;

    if (priceDeviationPct !== undefined && last.price !== 0n) {
      const diff = newPrice > last.price ? newPrice - last.price : last.price - newPrice;
      // deviation% = diff / old * 100.  All bigint arithmetic; multiply by
      // 10^6 before dividing to keep fractional precision.
      const deviationMilliPct = Number((diff * 100_000_000n) / last.price) / 1_000_000;
      pricePasses = deviationMilliPct >= priceDeviationPct;
      if (!pricePasses) {
        priceVerdictOnFail = {
          allowed: false,
          reason: "price_deviation",
          oldPrice: last.price,
          newPrice,
          deviationPct: deviationMilliPct,
          thresholdPct: priceDeviationPct,
          filterReason: `price_deviation: ${deviationMilliPct.toFixed(4)}% < ${priceDeviationPct}%`,
        };
      }
    } else if (priceDeviationPct !== undefined && last.price === 0n) {
      // Division-by-zero guard: old price is zero, treat as passing.
      pricePasses = true;
    }

    // Apply OR-gate logic.
    if (timeThresholdMs !== undefined && priceDeviationPct !== undefined) {
      // Both configured: pass if either passes.
      if (timePasses || pricePasses) {
        return { allowed: true };
      }
      // Both fail: return time_threshold verdict (higher operator visibility).
      return timeVerdictOnFail!;
    }

    if (timeThresholdMs !== undefined) {
      // Only time configured.
      if (timePasses) return { allowed: true };
      return timeVerdictOnFail!;
    }

    // Only price configured.
    if (pricePasses) return { allowed: true };
    // priceVerdictOnFail may be undefined when last.price === 0n (treated as pass above).
    return priceVerdictOnFail ?? { allowed: true };
  };
}
