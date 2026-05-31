import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTransformer,
  buildTransformContext,
  evaluateCondition,
  type TransformationOp,
} from "../transformer.js";
import type { ExtractedEvent } from "../../source/types.js";
import type { OracleIntent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_EVENT: ExtractedEvent = {
  intentHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000001",
  symbolHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000002",
  price: 100_000_000n,
  timestamp: 1_700_000_000n,
  signer: "0xaAbBcCdDeEfF0011223344556677889900112233" as `0x${string}`,
  blockNumber: 42n,
  txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000003",
  logIndex: 0,
  blockTimestamp: 1_700_000_001n,
};

const FAKE_INTENT: OracleIntent = {
  intentType: "price_update",
  version: "1",
  chainId: 10050n,
  nonce: 7n,
  expiry: 1_800_000_000n,
  symbol: "BTC/USD",
  price: 100_000_000n,
  timestamp: 1_700_000_000n,
  source: "dia",
  signature: "0xsig",
  signer: "0xaAbBcCdDeEfF0011223344556677889900112233",
};

// ---------------------------------------------------------------------------
// Operation tests
// ---------------------------------------------------------------------------

describe("createTransformer — individual operations", () => {
  it("slice: extracts a substring at [start, end)", () => {
    const transform = createTransformer([
      { operation: "slice", field: "out", input: "val", start: 2, end: 5 },
    ]);
    const result = transform({ val: "hello world" });
    assert.equal(result["out"], "llo");
  });

  it("concat: joins multiple fields with a separator", () => {
    const transform = createTransformer([
      { operation: "concat", field: "out", input: ["a", "b", "c"], separator: "-" },
    ]);
    const result = transform({ a: "foo", b: "bar", c: "baz" });
    assert.equal(result["out"], "foo-bar-baz");
  });

  it("hash: produces keccak256 of the input string", () => {
    const transform = createTransformer([
      { operation: "hash", field: "out", input: "val" },
    ]);
    const result = transform({ val: "hello" });
    // keccak256("hello") is a known value.
    assert.match(result["out"] as string, /^0x[0-9a-f]{64}$/);
  });

  it("encode: ABI-encodes fields according to types", () => {
    const transform = createTransformer([
      { operation: "encode", field: "out", input: ["price"], types: ["uint256"] },
    ]);
    const result = transform({ price: 42n });
    // ABI-encoded uint256(42) is 32 bytes = 66 hex chars with 0x prefix.
    assert.equal((result["out"] as string).length, 66);
    assert.match(result["out"] as string, /^0x/);
  });

  it("to_bigint: converts a numeric string to a decimal bigint string", () => {
    const transform = createTransformer([
      { operation: "to_bigint", field: "out", input: "val" },
    ]);
    const result = transform({ val: "9007199254740993" });
    assert.equal(result["out"], "9007199254740993");
  });

  it("to_address: extracts the last 20 bytes from a bytes32 hex value", () => {
    const transform = createTransformer([
      { operation: "to_address", field: "out", input: "val" },
    ]);
    const bytes32 = "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12";
    const result = transform({ val: bytes32 });
    // Result should be a checksummed EVM address.
    assert.match(result["out"] as string, /^0x[0-9a-fA-F]{40}$/);
  });

  it("to_hex: converts a string value to 0x-prefixed hex", () => {
    const transform = createTransformer([
      { operation: "to_hex", field: "out", input: "val" },
    ]);
    const result = transform({ val: "abc" });
    assert.match(result["out"] as string, /^0x/);
  });

  it("to_string: converts a bigint value to its string representation", () => {
    const transform = createTransformer([
      { operation: "to_string", field: "out", input: "val" },
    ]);
    const result = transform({ val: 123456789n });
    assert.equal(result["out"], "123456789");
  });

  it("identity transformer is returned for an empty ops array", () => {
    const transform = createTransformer([]);
    const ctx = { a: 1 };
    assert.strictEqual(transform(ctx), ctx);
  });

  it("throws when a required input field is absent", () => {
    const transform = createTransformer([
      { operation: "slice", field: "out", input: "missing" },
    ]);
    assert.throws(() => transform({}), /not found in context/);
  });
});

// ---------------------------------------------------------------------------
// buildTransformContext
// ---------------------------------------------------------------------------

describe("buildTransformContext", () => {
  it("datasource=event exposes ExtractedEvent fields", () => {
    const ctx = buildTransformContext(FAKE_EVENT, null, "event");
    assert.equal(ctx["intentHash"], FAKE_EVENT.intentHash);
    assert.equal(ctx["price"], FAKE_EVENT.price);
    assert.equal(ctx["blockTimestamp"], FAKE_EVENT.blockTimestamp);
    assert.equal(ctx["symbol"], undefined, "symbol should not be present in event context");
  });

  it("datasource=enrichment merges OracleIntent fields on top of event fields", () => {
    const ctx = buildTransformContext(FAKE_EVENT, FAKE_INTENT, "enrichment");
    assert.equal(ctx["symbol"], "BTC/USD");
    assert.equal(ctx["chainId"], 10050n);
    // Event fields still present.
    assert.equal(ctx["intentHash"], FAKE_EVENT.intentHash);
    assert.equal(ctx["blockTimestamp"], FAKE_EVENT.blockTimestamp);
  });

  it("datasource=processed produces the same merged context as enrichment", () => {
    const enrichment = buildTransformContext(FAKE_EVENT, FAKE_INTENT, "enrichment");
    const processed = buildTransformContext(FAKE_EVENT, FAKE_INTENT, "processed");
    assert.deepEqual(enrichment, processed);
  });

  it("datasource=enrichment with null intent returns only event fields", () => {
    const ctx = buildTransformContext(FAKE_EVENT, null, "enrichment");
    assert.equal(ctx["symbol"], undefined);
    assert.equal(ctx["intentHash"], FAKE_EVENT.intentHash);
  });
});

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  it("undefined condition → true", () => {
    assert.equal(evaluateCondition(undefined, {}), true);
  });

  it("empty string condition → true", () => {
    assert.equal(evaluateCondition("", {}), true);
  });

  it("equality: field == value passes when equal", () => {
    assert.equal(evaluateCondition("symbol == BTC/USD", { symbol: "BTC/USD" }), true);
  });

  it("equality: field == value fails when not equal", () => {
    assert.equal(evaluateCondition("symbol == ETH/USD", { symbol: "BTC/USD" }), false);
  });

  it("inequality: field != value passes when different", () => {
    assert.equal(evaluateCondition("symbol != ETH/USD", { symbol: "BTC/USD" }), true);
  });

  it("inequality: field != value fails when same", () => {
    assert.equal(evaluateCondition("symbol != BTC/USD", { symbol: "BTC/USD" }), false);
  });

  it("template: ${fieldName} is resolved from context before comparison", () => {
    const ctx = { expected: "BTC/USD", symbol: "BTC/USD" };
    assert.equal(evaluateCondition("symbol == ${expected}", ctx), true);
  });

  it("template on lhs: ${field} resolves field value", () => {
    const ctx = { chain: "10050" };
    assert.equal(evaluateCondition("${chain} == 10050", ctx), true);
  });

  it("unknown condition form → true (pass-through)", () => {
    // Prevents silently dropping events on unrecognised syntax.
    assert.equal(evaluateCondition("something weird", {}), true);
  });
});
