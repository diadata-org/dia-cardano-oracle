import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createLatestIntentCache } from "../latest-intent-cache.js";
import type { EnrichedIntent } from "../../source/types.js";

const FAKE_ENRICHED: EnrichedIntent = {
  fullIntent: {
    symbol: "BTC/USD",
    price: 5000000000000n,
    timestamp: 1_700_000_000n,
    expiry: 1_700_000_300n,
    nonce: 1n,
    signer: "0x" + "11".repeat(20),
    signature: "0x" + "22".repeat(65),
    intentHash: "0x" + "ab".repeat(32),
  } as unknown as EnrichedIntent["fullIntent"],
} as unknown as EnrichedIntent;

describe("createLatestIntentCache", () => {
  it("stores and retrieves an entry by composite key", () => {
    const cache = createLatestIntentCache();
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      {
        routerId: "r1",
        destinationIndex: 0,
        symbol: "BTC/USD",
        enriched: FAKE_ENRICHED,
        intentHash: "0xabc",
      },
    );

    const entry = cache.get({ routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" });
    assert.ok(entry);
    assert.equal(entry.intentHash, "0xabc");
    assert.equal(entry.symbol, "BTC/USD");
    assert.equal(entry.routerId, "r1");
    assert.equal(entry.destinationIndex, 0);
  });

  it("returns undefined for unknown keys", () => {
    const cache = createLatestIntentCache();
    assert.equal(
      cache.get({ routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" }),
      undefined,
    );
  });

  it("stamps observedAtMs from the injectable clock", () => {
    let t = 1_700_000_000_000;
    const cache = createLatestIntentCache({ now: () => t });
    cache.set(
      { routerId: "r", destinationIndex: 0, symbol: "ETH/USD" },
      {
        routerId: "r",
        destinationIndex: 0,
        symbol: "ETH/USD",
        enriched: FAKE_ENRICHED,
        intentHash: "0xeth",
      },
    );
    t = 1_700_000_999_000;
    const e1 = cache.get({ routerId: "r", destinationIndex: 0, symbol: "ETH/USD" });
    assert.equal(e1?.observedAtMs, 1_700_000_000_000);

    // Update should refresh observedAtMs to the current clock value.
    cache.set(
      { routerId: "r", destinationIndex: 0, symbol: "ETH/USD" },
      {
        routerId: "r",
        destinationIndex: 0,
        symbol: "ETH/USD",
        enriched: FAKE_ENRICHED,
        intentHash: "0xeth2",
      },
    );
    const e2 = cache.get({ routerId: "r", destinationIndex: 0, symbol: "ETH/USD" });
    assert.equal(e2?.observedAtMs, 1_700_000_999_000);
    assert.equal(e2?.intentHash, "0xeth2");
  });

  it("iterates every entry with its composite key reconstructed", () => {
    const cache = createLatestIntentCache();
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0x1" },
    );
    cache.set(
      { routerId: "r1", destinationIndex: 1, symbol: "ETH/USD" },
      { routerId: "r1", destinationIndex: 1, symbol: "ETH/USD", enriched: FAKE_ENRICHED, intentHash: "0x2" },
    );
    cache.set(
      { routerId: "r2", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "r2", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0x3" },
    );

    const seen = new Set<string>();
    for (const [key, entry] of cache.entries()) {
      seen.add(`${key.routerId}|${key.destinationIndex}|${key.symbol}|${entry.intentHash}`);
    }
    assert.equal(seen.size, 3);
    assert.ok(seen.has("r1|0|BTC/USD|0x1"));
    assert.ok(seen.has("r1|1|ETH/USD|0x2"));
    assert.ok(seen.has("r2|0|BTC/USD|0x3"));
  });

  it("handles symbols that contain a colon (preserves them via split-and-join)", () => {
    const cache = createLatestIntentCache();
    // The internal cache key is `${routerId}:${destIdx}:${symbol}`. A
    // colon-containing symbol like "ABC:DEF/USD" must round-trip.
    cache.set(
      { routerId: "r", destinationIndex: 0, symbol: "ABC:DEF/USD" },
      { routerId: "r", destinationIndex: 0, symbol: "ABC:DEF/USD", enriched: FAKE_ENRICHED, intentHash: "0x9" },
    );
    const [[key]] = [...cache.entries()];
    assert.equal(key.symbol, "ABC:DEF/USD");
  });
});
