import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createDedupCache } from "../dedup-cache.js";

describe("createDedupCache", () => {
  it("rejects invalid capacity", () => {
    assert.throws(() => createDedupCache({ capacity: 0, ttlMs: 0 }), /capacity must be > 0/);
  });

  it("rejects negative ttlMs", () => {
    assert.throws(() => createDedupCache({ capacity: 10, ttlMs: -1 }), /ttlMs must be >= 0/);
  });

  it("returns true (new) then false (duplicate) for the same hash", () => {
    const cache = createDedupCache({ capacity: 10, ttlMs: 0 });
    assert.equal(cache.add("0xabc"), true);
    assert.equal(cache.add("0xabc"), false);
  });

  it("has() does not mutate counters", () => {
    const cache = createDedupCache({ capacity: 10, ttlMs: 0 });
    cache.add("0xaaa");
    const before = cache.stats();
    assert.equal(cache.has("0xaaa"), true);
    assert.equal(cache.has("0xbbb"), false);
    assert.deepEqual(cache.stats(), before);
  });

  it("size() reflects current entry count", () => {
    const cache = createDedupCache({ capacity: 10, ttlMs: 0 });
    assert.equal(cache.size(), 0);
    cache.add("h1");
    assert.equal(cache.size(), 1);
    cache.add("h2");
    assert.equal(cache.size(), 2);
    cache.add("h1");
    assert.equal(cache.size(), 2);
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    const cache = createDedupCache({ capacity: 2, ttlMs: 0 });
    cache.add("h1");
    cache.add("h2");
    cache.add("h3");
    assert.equal(cache.size(), 2);
    assert.equal(cache.has("h1"), false, "h1 should have been evicted");
    assert.equal(cache.has("h2"), true);
    assert.equal(cache.has("h3"), true);
    const { evictions } = cache.stats();
    assert.equal(evictions, 1);
  });

  it("TTL expires entries", () => {
    let fakeNow = 1000;
    const cache = createDedupCache({ capacity: 100, ttlMs: 500, now: () => fakeNow });
    cache.add("stale");
    fakeNow = 1600;
    assert.equal(cache.has("stale"), false, "entry should be expired");
    assert.equal(cache.size(), 0);
  });

  it("TTL=0 disables expiry", () => {
    let fakeNow = 1000;
    const cache = createDedupCache({ capacity: 100, ttlMs: 0, now: () => fakeNow });
    cache.add("forever");
    fakeNow = 99_999_999;
    assert.equal(cache.has("forever"), true);
  });

  it("stats tracks hits and misses", () => {
    const cache = createDedupCache({ capacity: 10, ttlMs: 0 });
    cache.add("a"); // miss
    cache.add("b"); // miss
    cache.add("a"); // hit
    const { hits, misses } = cache.stats();
    assert.equal(hits, 1);
    assert.equal(misses, 2);
  });

  it("clear() resets all state", () => {
    const cache = createDedupCache({ capacity: 10, ttlMs: 0 });
    cache.add("x");
    cache.add("x");
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.stats(), { size: 0, hits: 0, misses: 0, evictions: 0 });
    assert.equal(cache.add("x"), true, "after clear, hash should be new again");
  });

  it("multiple items, no false positives", () => {
    const cache = createDedupCache({ capacity: 100, ttlMs: 0 });
    const hashes = Array.from({ length: 50 }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);
    for (const h of hashes) assert.equal(cache.add(h), true);
    for (const h of hashes) assert.equal(cache.add(h), false);
    assert.equal(cache.size(), 50);
  });
});
