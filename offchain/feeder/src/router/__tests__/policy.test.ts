import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDurationMs, parseDeviationPct, createPolicyGate } from "../policy.js";
import { createPriceCache } from "../../processor/price-cache.js";

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

describe("createPolicyGate — both thresholds", () => {
  it("time_threshold blocks before price_deviation is evaluated", () => {
    let now = 100_000;
    const cache = createPriceCache({ now: () => now });
    cache.set(BASE_KEY, { symbol: SYMBOL, price: 1_000n, timestamp: 0n, intentHash: "0xaaa", updatedAtMs: now });
    now = 110_000; // only 10 s, threshold 60 s
    const gate = createPolicyGate(cache, {
      timeThresholdMs: 60_000,
      priceDeviationPct: 0.1,
      now: () => now,
    });
    const result = gate(BASE_KEY, 2_000n); // 100% change — would pass deviation
    assert.equal(result.allowed, false);
    assert.equal("reason" in result && result.reason, "time_threshold");
  });
});
