import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDurationMs, parseDeviationPct, createPolicyGate, computePriceDeviationPct } from "../policy.js";
import { createPriceCache } from "../../processor/price-cache.js";

// ---------------------------------------------------------------------------
// computePriceDeviationPct
// ---------------------------------------------------------------------------

describe("computePriceDeviationPct", () => {
  it("returns undefined when oldPrice is 0 (no baseline)", () => {
    assert.equal(computePriceDeviationPct(0n, 100n), undefined);
  });

  it("returns 0 when the price is unchanged", () => {
    assert.equal(computePriceDeviationPct(100n, 100n), 0);
  });

  it("computes a symmetric absolute deviation (up move)", () => {
    // 100 -> 110 == +10%
    assert.equal(computePriceDeviationPct(100n, 110n), 10);
  });

  it("computes a symmetric absolute deviation (down move)", () => {
    // 100 -> 90 == 10% (absolute, sign-independent)
    assert.equal(computePriceDeviationPct(100n, 90n), 10);
  });

  it("keeps fractional precision below 1%", () => {
    // 1_000_000 -> 1_001_000 == 0.1%
    assert.equal(computePriceDeviationPct(1_000_000n, 1_001_000n), 0.1);
  });
});

// ---------------------------------------------------------------------------
// parseDurationMs
// ---------------------------------------------------------------------------

describe("parseDurationMs", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(parseDurationMs(undefined), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.equal(parseDurationMs(""), undefined);
    assert.equal(parseDurationMs("   "), undefined);
  });

  it("parses seconds", () => {
    assert.equal(parseDurationMs("30s"), 30_000);
  });

  it("parses minutes", () => {
    assert.equal(parseDurationMs("1m"), 60_000);
    assert.equal(parseDurationMs("2m"), 120_000);
  });

  it("parses hours", () => {
    assert.equal(parseDurationMs("1h"), 3_600_000);
  });

  it("parses milliseconds", () => {
    assert.equal(parseDurationMs("500ms"), 500);
  });

  it("parses compound durations", () => {
    assert.equal(parseDurationMs("1h30m"), 3_600_000 + 30 * 60_000);
    assert.equal(parseDurationMs("1h30m10s"), 3_600_000 + 30 * 60_000 + 10_000);
  });

  it("parses fractional seconds", () => {
    assert.equal(parseDurationMs("0.5s"), 500);
  });

  it("throws on unrecognised format", () => {
    assert.throws(() => parseDurationMs("1x"), /Invalid duration/);
  });

  it("returns 0 for the '0s' disabled-gate sentinel", () => {
    // 0 is intentional: time gate always passes / cron has no cadence.
    assert.equal(parseDurationMs("0s"), 0);
    assert.equal(parseDurationMs("0ms"), 0);
  });

  it("throws on a negative duration (the regex rejects the leading '-')", () => {
    assert.throws(() => parseDurationMs("-5s"), /Invalid duration/);
  });

  it("parses a max_staleness-style long duration", () => {
    // max_staleness uses the same duration grammar as time_threshold.
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("6h"), 6 * 3_600_000);
    assert.equal(parseDurationMs("1d"), 86_400_000);
  });
});

// ---------------------------------------------------------------------------
// parseDeviationPct
// ---------------------------------------------------------------------------

describe("parseDeviationPct", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(parseDeviationPct(undefined), undefined);
  });

  it("returns undefined for empty string", () => {
    assert.equal(parseDeviationPct(""), undefined);
  });

  it("parses integer percent", () => {
    assert.equal(parseDeviationPct("1%"), 1);
    assert.equal(parseDeviationPct("5%"), 5);
  });

  it("parses fractional percent", () => {
    assert.equal(parseDeviationPct("0.5%"), 0.5);
    assert.equal(parseDeviationPct("0.1%"), 0.1);
  });

  it("throws when % suffix is absent", () => {
    assert.throws(() => parseDeviationPct("1"), /must end with "%"/);
  });

  it("throws on negative percent", () => {
    assert.throws(() => parseDeviationPct("-1%"), /non-negative/);
  });
});

// ---------------------------------------------------------------------------
// createPolicyGate
// ---------------------------------------------------------------------------

const SYMBOL = "BTC/USD";
const BASE_KEY = { routerId: "r1", destinationIndex: 0, symbol: SYMBOL };

describe("createPolicyGate — no thresholds", () => {
  it("always allows when no thresholds configured", () => {
    const cache = createPriceCache();
    const gate = createPolicyGate(cache, {});
    assert.deepEqual(gate(BASE_KEY, 100n), { allowed: true });
  });

  it("allows even with a cached entry when no thresholds", () => {
    const cache = createPriceCache();
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 100n, timestamp: 1000n, intentHash: "0xaaa", updatedAtMs: 0 });
    const gate = createPolicyGate(cache, {});
    assert.deepEqual(gate(BASE_KEY, 100n), { allowed: true });
  });
});

describe("createPolicyGate — time_threshold", () => {
  it("allows when no prior entry exists", () => {
    const cache = createPriceCache();
    const gate = createPolicyGate(cache, { timeThresholdMs: 60_000, now: () => 100_000 });
    assert.deepEqual(gate(BASE_KEY, 500n), { allowed: true });
  });

  it("blocks when elapsed time < threshold", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 100n, timestamp: 1000n, intentHash: "0xaaa", updatedAtMs: now });
    now = 120_000; // 20 s later, threshold is 60 s
    const gate = createPolicyGate(cache, { timeThresholdMs: 60_000, now: () => now });
    const result = gate(BASE_KEY, 200n);
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "time_threshold");
  });

  it("allows when elapsed time >= threshold", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 100n, timestamp: 1000n, intentHash: "0xaaa", updatedAtMs: now });
    now = 200_000; // 100 s later, threshold is 60 s
    const gate = createPolicyGate(cache, { timeThresholdMs: 60_000, now: () => now });
    assert.deepEqual(gate(BASE_KEY, 200n), { allowed: true });
  });
});

describe("createPolicyGate — price_deviation", () => {
  it("allows when no prior entry exists", () => {
    const cache = createPriceCache();
    const gate = createPolicyGate(cache, { priceDeviationPct: 1, now: () => 0 });
    assert.deepEqual(gate(BASE_KEY, 100n), { allowed: true });
  });

  it("blocks when deviation is below threshold", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, { priceDeviationPct: 1.0, now: () => now });
    // 0.5% change — below 1% threshold
    const result = gate(BASE_KEY, 1_005n);
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "price_deviation");
  });

  it("allows when deviation meets threshold", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, { priceDeviationPct: 1.0, now: () => now });
    // exactly 1% change
    const result = gate(BASE_KEY, 1_010n);
    assert.deepEqual(result, { allowed: true });
  });

  it("allows when old price is zero (avoids division by zero)", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 0n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, { priceDeviationPct: 0.5, now: () => now });
    assert.deepEqual(gate(BASE_KEY, 1_000n), { allowed: true });
  });
});

describe("createPolicyGate — both thresholds (OR-gate)", () => {
  it("passes when only time passes (price fails)", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 200_000; // 100s elapsed >= 60s threshold → time passes
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 5.0, // 0.1% change — would NOT meet 5% deviation
      now: () => now,
    });
    const result = gate(BASE_KEY, 1_001n); // 0.1% change
    assert.deepEqual(result, { allowed: true });
  });

  it("passes when only price passes (time fails)", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 110_000; // only 10s elapsed, threshold 60s → time fails
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 0.1, // 100% change — far exceeds 0.1% threshold → price passes
      now: () => now,
    });
    const result = gate(BASE_KEY, 2_000n); // 100% change
    assert.deepEqual(result, { allowed: true });
  });

  it("suppresses when BOTH fail — returns time_threshold verdict", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 110_000; // 10s elapsed < 60s threshold → time fails
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 5.0, // 0.1% change < 5% threshold → price also fails
      now: () => now,
    });
    const result = gate(BASE_KEY, 1_001n); // 0.1% change
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "time_threshold");
    assert.ok("filterReason" in result && typeof result.filterReason === "string");
  });

  it("passes when both pass", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 200_000; // 100s >= 60s → time passes
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 0.1, // 100% >> 0.1% → price passes
      now: () => now,
    });
    assert.deepEqual(gate(BASE_KEY, 2_000n), { allowed: true });
  });
});

describe("createPolicyGate — deviation-only push mode (max_staleness)", () => {
  // Active when time_threshold is disabled (0 / absent) AND max_staleness set.
  const MAX_STALENESS_MS = 3_600_000; // 1h

  it("passes on deviation while still within the staleness window", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 60_000; // 60s — far inside the 1h staleness window
    const gate = createPolicyGate(cache, {
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => now,
    });
    // 2% change >= 1% threshold → deviation passes.
    assert.deepEqual(gate(BASE_KEY, 1_020n, 1n), { allowed: true });
  });

  it("blocks on a flat price within the staleness window (reason max_staleness)", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 60_000; // inside the 1h window
    const gate = createPolicyGate(cache, {
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => now,
    });
    // 0.5% change < 1% threshold and within window → suppressed.
    const result = gate(BASE_KEY, 1_005n, 1n);
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "max_staleness");
    assert.ok("filterReason" in result && result.filterReason.includes("max_staleness"));
  });

  it("passes once age exceeds max_staleness even with a flat price", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = MAX_STALENESS_MS + 1; // just past the ceiling
    const gate = createPolicyGate(cache, {
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => now,
    });
    // Flat price (0% change) but age > max → passes on the staleness term.
    assert.deepEqual(gate(BASE_KEY, 1_000n, 1n), { allowed: true });
  });

  it("treats time_threshold '0s' the same as absent (deviation-only mode)", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 60_000;
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 0, // explicit disabled-gate sentinel
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => now,
    });
    const result = gate(BASE_KEY, 1_005n, 1n); // flat-within-window
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "max_staleness");
  });

  it("blocks within window when no deviation gate is set (max_staleness only)", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 60_000;
    const gate = createPolicyGate(cache, { maxStalenessMs: MAX_STALENESS_MS, now: () => now });
    // No price gate: a 100% move is still suppressed until the ceiling.
    const result = gate(BASE_KEY, 2_000n, 1n);
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "max_staleness");
  });

  it("always passes when no prior entry exists", () => {
    const cache = createPriceCache();
    const gate = createPolicyGate(cache, {
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => 0,
    });
    assert.deepEqual(gate(BASE_KEY, 1_000n, 1n), { allowed: true });
  });

  it("is IGNORED when time_threshold > 0 (classic OR-gate preserved)", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 200_000; // 100s elapsed >= 60s time_threshold → classic time pass
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 5.0, // 0.1% move would fail deviation
      maxStalenessMs: MAX_STALENESS_MS, // present but must be ignored
      now: () => now,
    });
    // Classic OR-gate: time passes → allowed, and reason is never max_staleness.
    assert.deepEqual(gate(BASE_KEY, 1_001n, 1n), { allowed: true });
  });

  it("still enforces timestamp monotonicity before the staleness check", () => {
    let now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    now = MAX_STALENESS_MS + 1; // age would otherwise pass on staleness
    const gate = createPolicyGate(cache, {
      priceDeviationPct: 1.0,
      maxStalenessMs: MAX_STALENESS_MS,
      now: () => now,
    });
    const result = gate(BASE_KEY, 2_000n, 500n); // regression timestamp
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "timestamp_regression");
  });
});

describe("createPolicyGate — filterReason on suppressed verdicts", () => {
  it("includes filterReason string on time_threshold verdict", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 100n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 120_000;
    const gate = createPolicyGate(cache, { timeThresholdMs: 60_000, now: () => now });
    const result = gate(BASE_KEY, 200n);
    assert.equal(result.allowed, false);
    assert.ok("filterReason" in result && result.filterReason.includes("time_threshold"));
  });

  it("includes filterReason string on price_deviation verdict", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, { priceDeviationPct: 1.0, now: () => now });
    const result = gate(BASE_KEY, 1_005n);
    assert.equal(result.allowed, false);
    assert.ok("filterReason" in result && result.filterReason.includes("price_deviation"));
  });
});

describe("createPolicyGate — timestamp monotonicity", () => {
  it("suppresses with timestamp_regression when new < last", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, {});
    const result = gate(BASE_KEY, 1_100n, 500n); // newTimestamp 500 < last 1000
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "timestamp_regression");
    assert.ok("filterReason" in result && result.filterReason.includes("timestamp_regression"));
  });

  it("suppresses with timestamp_duplicate when new === last", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, {});
    const result = gate(BASE_KEY, 1_100n, 1_000n); // same timestamp
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "timestamp_duplicate");
    assert.ok("filterReason" in result && result.filterReason.includes("timestamp_duplicate"));
  });

  it("allows when newTimestamp > lastTimestamp", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, {});
    assert.deepEqual(gate(BASE_KEY, 1_100n, 1_001n), { allowed: true });
  });

  it("skips timestamp check when newTimestamp is not provided", () => {
    const now = 0;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    const gate = createPolicyGate(cache, {});
    // No timestamp passed — should still allow (no thresholds).
    assert.deepEqual(gate(BASE_KEY, 1_100n), { allowed: true });
  });

  it("timestamp check runs before OR-gate thresholds", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 1_000n, intentHash: "0xaaa", updatedAtMs: now });
    now = 200_000; // would pass time threshold
    const gate = createPolicyGate(cache, { timeThresholdMs: 60_000, now: () => now });
    // Regression timestamp should still suppress even if time would pass.
    const result = gate(BASE_KEY, 2_000n, 500n);
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "timestamp_regression");
  });
});
