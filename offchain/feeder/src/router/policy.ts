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
// Semantics (identical to Spectra):
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
// Both thresholds are AND-gated: the update is suppressed if EITHER
// threshold blocks it. If neither threshold is configured the update
// always passes.
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
  | { allowed: false; reason: "time_threshold"; lastUpdatedAtMs: number; thresholdMs: number }
  | { allowed: false; reason: "price_deviation"; oldPrice: bigint; newPrice: bigint; deviationPct: number; thresholdPct: number };

// ---------------------------------------------------------------------------
// String parsers — Spectra YAML format.
// ---------------------------------------------------------------------------

/**
 * Parse a Spectra-style duration string into milliseconds.
 * Supports: "30s", "1m", "2h", "1h30m", "1h30m10s", "500ms".
 * Returns `undefined` for an empty or absent string.
 * Throws for an unrecognised format.
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
 */
export function createPolicyGate(
  priceCache: PriceCache,
  options: PolicyGateOptions,
): (key: PriceCacheKey, newPrice: bigint) => PolicyVerdict {
  const { timeThresholdMs, priceDeviationPct } = options;
  const clock = options.now ?? Date.now;

  return (key, newPrice) => {
    const last = priceCache.get(key);

    // --- time_threshold ---
    if (timeThresholdMs !== undefined && last !== undefined) {
      const elapsedMs = clock() - last.updatedAtMs;
      if (elapsedMs < timeThresholdMs) {
        return {
          allowed: false,
          reason: "time_threshold",
          lastUpdatedAtMs: last.updatedAtMs,
          thresholdMs: timeThresholdMs,
        };
      }
    }

    // --- price_deviation ---
    if (priceDeviationPct !== undefined && last !== undefined && last.price !== 0n) {
      const diff = newPrice > last.price ? newPrice - last.price : last.price - newPrice;
      // deviation% = diff / old * 100.  All bigint arithmetic; multiply by
      // 10^6 before dividing to keep fractional precision.
      const deviationMilliPct = Number((diff * 100_000_000n) / last.price) / 1_000_000;
      if (deviationMilliPct < priceDeviationPct) {
        return {
          allowed: false,
          reason: "price_deviation",
          oldPrice: last.price,
          newPrice,
          deviationPct: deviationMilliPct,
          thresholdPct: priceDeviationPct,
        };
      }
    }

    return { allowed: true };
  };
}
