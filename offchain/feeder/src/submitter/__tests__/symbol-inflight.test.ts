import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSymbolInflightTracker } from "../symbol-inflight.js";

describe("createSymbolInflightTracker", () => {
  it("has() is false for a tuple that was never marked", () => {
    const t = createSymbolInflightTracker({ ttlMs: 1_000 });
    assert.equal(t.has("router-a", 0, "ARS/USDT"), false);
  });

  it("has() is true after mark()", () => {
    const t = createSymbolInflightTracker({ ttlMs: 1_000 });
    t.mark("router-a", 0, "ARS/USDT");
    assert.equal(t.has("router-a", 0, "ARS/USDT"), true);
  });

  it("has() is false after clear()", () => {
    const t = createSymbolInflightTracker({ ttlMs: 1_000 });
    t.mark("router-a", 0, "ARS/USDT");
    t.clear("router-a", 0, "ARS/USDT");
    assert.equal(t.has("router-a", 0, "ARS/USDT"), false);
  });

  it("distinguishes router, destination index, and symbol", () => {
    const t = createSymbolInflightTracker({ ttlMs: 1_000 });
    t.mark("router-a", 0, "ARS/USDT");
    assert.equal(t.has("router-b", 0, "ARS/USDT"), false, "different router");
    assert.equal(t.has("router-a", 1, "ARS/USDT"), false, "different destination");
    assert.equal(t.has("router-a", 0, "BTC/USD"), false, "different symbol");
  });

  it("auto-expires an entry once the TTL elapses (leak safeguard)", () => {
    let nowMs = 0;
    const t = createSymbolInflightTracker({ ttlMs: 1_000, now: () => nowMs });
    t.mark("router-a", 0, "ARS/USDT");
    nowMs = 999;
    assert.equal(t.has("router-a", 0, "ARS/USDT"), true, "still in-flight before TTL");
    nowMs = 1_000;
    assert.equal(t.has("router-a", 0, "ARS/USDT"), false, "expired at TTL");
  });

  it("re-marking refreshes the expiry", () => {
    let nowMs = 0;
    const t = createSymbolInflightTracker({ ttlMs: 1_000, now: () => nowMs });
    t.mark("router-a", 0, "ARS/USDT");
    nowMs = 800;
    t.mark("router-a", 0, "ARS/USDT");
    nowMs = 1_500;
    assert.equal(t.has("router-a", 0, "ARS/USDT"), true, "refreshed window still open");
    nowMs = 1_800;
    assert.equal(t.has("router-a", 0, "ARS/USDT"), false, "expired after refreshed window");
  });

  it("clear() of an unmarked tuple is a no-op (does not throw)", () => {
    const t = createSymbolInflightTracker({ ttlMs: 1_000 });
    assert.doesNotThrow(() => t.clear("router-a", 0, "ARS/USDT"));
  });

  it("rejects a non-positive ttlMs (no silent default)", () => {
    assert.throws(() => createSymbolInflightTracker({ ttlMs: 0 }), /ttlMs/);
    assert.throws(() => createSymbolInflightTracker({ ttlMs: -1 }), /ttlMs/);
    assert.throws(
      () => createSymbolInflightTracker({ ttlMs: Number.NaN }),
      /ttlMs/,
    );
  });
});
