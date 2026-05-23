import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPricesResponse } from "../prices.js";
import { createPriceCache } from "../../processor/price-cache.js";

describe("buildPricesResponse", () => {
  it("returns empty response for an empty cache", () => {
    const cache = createPriceCache();
    const r = buildPricesResponse(cache);
    assert.equal(r.count, 0);
    assert.deepEqual(r.prices, []);
  });

  it("returns one entry per distinct key", () => {
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100_000n, timestamp: 1_700_000_000n, intentHash: "0xabc", updatedAtMs: 1_000 },
    );
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ETH/USD" },
      { symbol: "ETH/USD", price: 3_000n, timestamp: 1_700_000_001n, intentHash: "0xdef", updatedAtMs: 1_000 },
    );
    const r = buildPricesResponse(cache);
    assert.equal(r.count, 2);
    assert.equal(r.prices.length, 2);
  });

  it("overwrite: set() twice for same key gives one entry", () => {
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100_000n, timestamp: 1_700_000_000n, intentHash: "0xold", updatedAtMs: 1_000 },
    );
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 105_000n, timestamp: 1_700_000_001n, intentHash: "0xnew", updatedAtMs: 2_000 },
    );
    const r = buildPricesResponse(cache);
    assert.equal(r.count, 1);
    assert.equal(r.prices[0].intentHash, "0xnew");
    assert.equal(r.prices[0].price, "105000");
  });

  it("sorts by routerId then destinationIndex then symbol", () => {
    const cache = createPriceCache({ now: () => 1_000 });
    const base = { price: 1n, timestamp: 1n, intentHash: "0x1", updatedAtMs: 1_000 };
    cache.set({ routerId: "z-router", destinationIndex: 0, symbol: "A" }, { ...base, symbol: "A" });
    cache.set({ routerId: "a-router", destinationIndex: 1, symbol: "Z" }, { ...base, symbol: "Z" });
    cache.set({ routerId: "a-router", destinationIndex: 0, symbol: "B" }, { ...base, symbol: "B" });
    cache.set({ routerId: "a-router", destinationIndex: 0, symbol: "A" }, { ...base, symbol: "A" });

    const r = buildPricesResponse(cache);
    assert.equal(r.prices[0].routerId, "a-router");
    assert.equal(r.prices[0].destinationIndex, 0);
    assert.equal(r.prices[0].symbol, "A");
    assert.equal(r.prices[1].symbol, "B");
    assert.equal(r.prices[2].destinationIndex, 1);
    assert.equal(r.prices[3].routerId, "z-router");
  });

  it("includes cardanoTxHash when set", () => {
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "ADA/USD" },
      { symbol: "ADA/USD", price: 500n, timestamp: 1n, intentHash: "0xh", cardanoTxHash: "tx123abc", updatedAtMs: 1_000 },
    );
    const r = buildPricesResponse(cache);
    assert.equal(r.prices[0].cardanoTxHash, "tx123abc");
  });

  it("price and timestamp are serialised as strings (bigint-safe)", () => {
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 9007199254740993n, timestamp: 9007199254740994n, intentHash: "0xbig", updatedAtMs: 1_000 },
    );
    const r = buildPricesResponse(cache);
    assert.equal(r.prices[0].price, "9007199254740993");
    assert.equal(r.prices[0].timestamp, "9007199254740994");
  });
});
