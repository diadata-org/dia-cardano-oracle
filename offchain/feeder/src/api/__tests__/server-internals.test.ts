// R10.C.16 — server internals: rate limiter + parseLimit.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRateLimiter, parseLimit } from "../server.js";

describe("createRateLimiter", () => {
  it("allows the first request from a new address", () => {
    const allow = createRateLimiter();
    assert.equal(allow("1.2.3.4"), true);
  });

  it("allows up to 60 requests then blocks the 61st within the window", () => {
    const allow = createRateLimiter();
    for (let i = 0; i < 60; i++) {
      assert.equal(allow("1.2.3.4"), true, `request ${i + 1} should be allowed`);
    }
    assert.equal(allow("1.2.3.4"), false, "61st request should be blocked");
  });

  it("tracks independent buckets per remote address", () => {
    const allow = createRateLimiter();
    for (let i = 0; i < 60; i++) allow("1.1.1.1");
    // A different IP is unaffected.
    assert.equal(allow("2.2.2.2"), true);
    assert.equal(allow("1.1.1.1"), false);
  });
});

describe("parseLimit", () => {
  it("returns the default 50 for null/empty", () => {
    assert.equal(parseLimit(null), 50);
    assert.equal(parseLimit(""), 50);
  });

  it("parses a valid positive integer", () => {
    assert.equal(parseLimit("100"), 100);
  });

  it("clamps values above 500 to 500", () => {
    assert.equal(parseLimit("501"), 500);
    assert.equal(parseLimit("100000"), 500);
  });

  it("throws on zero, negative, non-integer, and non-numeric input", () => {
    assert.throws(() => parseLimit("0"), /positive integer/);
    assert.throws(() => parseLimit("-1"), /positive integer/);
    assert.throws(() => parseLimit("5.5"), /positive integer/);
    assert.throws(() => parseLimit("abc"), /positive integer/);
  });
});
