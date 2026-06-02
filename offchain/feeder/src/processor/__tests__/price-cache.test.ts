// R10.C.2 — price-cache unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPriceCache, type PriceCacheEntry } from "../price-cache.js";

function entry(overrides: Partial<PriceCacheEntry> = {}): PriceCacheEntry {
  return {
    symbol: "BTC/USD",
    price: 65_000n,
    timestamp: 1_700_000_000n,
    intentHash: "0xabc",
    updatedAtMs: 0,
    ...overrides,
  };
}

describe("price-cache: set/get", () => {
  it("get returns undefined for a missing key before any set", () => {
    const c = createPriceCache();
    assert.equal(c.get({ routerId: "r", destinationIndex: 0, symbol: "BTC/USD" }), undefined);
  });

  it("set then get round-trips the entry", () => {
    const c = createPriceCache({ now: () => 123 });
    const key = { routerId: "r", destinationIndex: 0, symbol: "BTC/USD" };
    c.set(key, entry({ price: 100n }));
    const got = c.get(key);
    assert.equal(got?.price, 100n);
    assert.equal(got?.updatedAtMs, 123); // stamped by now()
  });

  it("set overwrites an existing entry for the same key without changing size", () => {
    const c = createPriceCache();
    const key = { routerId: "r", destinationIndex: 0, symbol: "BTC/USD" };
    c.set(key, entry({ price: 1n }));
    c.set(key, entry({ price: 2n }));
    assert.equal(c.get(key)?.price, 2n);
    assert.equal(c.size(), 1);
  });

  it("entries from different (routerId, destinationIndex, symbol) triples do not collide", () => {
    const c = createPriceCache();
    c.set({ routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" }, entry({ price: 1n }));
    c.set({ routerId: "r2", destinationIndex: 0, symbol: "BTC/USD" }, entry({ price: 2n }));
    c.set({ routerId: "r1", destinationIndex: 1, symbol: "BTC/USD" }, entry({ price: 3n }));
    assert.equal(c.size(), 3);
    assert.equal(c.get({ routerId: "r2", destinationIndex: 0, symbol: "BTC/USD" })?.price, 2n);
  });
});

describe("price-cache: all/entries/size", () => {
  it("all() is empty on a new cache and returns a snapshot", () => {
    const c = createPriceCache();
    assert.deepEqual(c.all(), []);
    c.set({ routerId: "r", destinationIndex: 0, symbol: "BTC/USD" }, entry());
    const snap = c.all();
    assert.equal(snap.length, 1);
    // Mutating the snapshot must not affect the cache.
    snap.pop();
    assert.equal(c.size(), 1);
  });

  it("size() tracks distinct keys", () => {
    const c = createPriceCache();
    assert.equal(c.size(), 0);
    c.set({ routerId: "r", destinationIndex: 0, symbol: "A" }, entry({ symbol: "A" }));
    assert.equal(c.size(), 1);
    c.set({ routerId: "r", destinationIndex: 0, symbol: "B" }, entry({ symbol: "B" }));
    assert.equal(c.size(), 2);
  });

  it("entries() reconstructs the key, splitting symbols that contain ':'", () => {
    const c = createPriceCache();
    c.set({ routerId: "r", destinationIndex: 0, symbol: "BTC:USDT" }, entry({ symbol: "BTC:USDT" }));
    const pairs = [...c.entries()];
    assert.equal(pairs.length, 1);
    const [key] = pairs[0]!;
    assert.equal(key.routerId, "r");
    assert.equal(key.destinationIndex, 0);
    assert.equal(key.symbol, "BTC:USDT"); // rejoined after split
  });

  it("entries() yields the same count as size()", () => {
    const c = createPriceCache();
    c.set({ routerId: "r", destinationIndex: 0, symbol: "A" }, entry({ symbol: "A" }));
    c.set({ routerId: "r", destinationIndex: 1, symbol: "B" }, entry({ symbol: "B" }));
    assert.equal([...c.entries()].length, c.size());
  });
});
