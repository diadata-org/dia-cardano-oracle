import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toHex,
  type AbiEvent,
} from "viem";

import {
  createIntentRegisteredDecoder,
  decodeIntentRegisteredLog,
  decodeIntentRegisteredLogs,
} from "../extractor.js";
import type { RegistryLog } from "../registry-client.js";

// ---------------------------------------------------------------------------
// ABI shared across all tests — matches the live IntentRegistered event.
// ---------------------------------------------------------------------------

const INTENT_REGISTERED_ABI: AbiEvent = {
  type: "event",
  name: "IntentRegistered",
  inputs: [
    { type: "bytes32", name: "intentHash", indexed: true },
    { type: "string",  name: "symbol",     indexed: true },
    { type: "uint256", name: "price",      indexed: true },
    { type: "uint256", name: "timestamp",  indexed: false },
    { type: "address", name: "signer",     indexed: false },
  ],
};

// ---------------------------------------------------------------------------
// Helpers to build a valid encoded log fixture.
// ---------------------------------------------------------------------------

const INTENT_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const SYMBOL = "BTC/USD";
const PRICE = 9_999_888_777_666_000n;
const TIMESTAMP = 1_700_000_000n;
const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

const BLOCK_NUMBER = 12_345_678n;
const TX_HASH = `0x${"cc".repeat(32)}` as `0x${string}`;
const LOG_INDEX = 3;

function buildLog(): RegistryLog {
  const topics = encodeEventTopics({
    abi: [INTENT_REGISTERED_ABI],
    eventName: "IntentRegistered",
    args: {
      intentHash: INTENT_HASH,
      symbol: SYMBOL,
      price: PRICE,
    },
  }) as [`0x${string}`, ...`0x${string}`[]];

  const data = encodeAbiParameters(
    [
      { type: "uint256", name: "timestamp" },
      { type: "address", name: "signer" },
    ],
    [TIMESTAMP, SIGNER],
  );

  return {
    topics,
    data,
    blockNumber: BLOCK_NUMBER,
    transactionHash: TX_HASH,
    logIndex: LOG_INDEX,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decodeIntentRegisteredLog", () => {
  it("decodes a well-formed log into ExtractedEvent", () => {
    const log = buildLog();
    const event = decodeIntentRegisteredLog(log, INTENT_REGISTERED_ABI);

    assert.equal(event.intentHash, INTENT_HASH);
    // symbol is indexed → stored as keccak256(bytes(symbol))
    const expectedSymbolHash = keccak256(toHex(SYMBOL, { size: undefined }));
    assert.equal(event.symbolHash, expectedSymbolHash);
    assert.equal(event.price, PRICE);
    assert.equal(event.timestamp, TIMESTAMP);
    assert.equal(event.signer.toLowerCase(), SIGNER.toLowerCase());
    assert.equal(event.blockNumber, BLOCK_NUMBER);
    assert.equal(event.txHash, TX_HASH);
    assert.equal(event.logIndex, LOG_INDEX);
  });

  it("throws with txHash and logIndex when decoding fails", () => {
    const badLog: RegistryLog = {
      topics: ["0x0000000000000000000000000000000000000000000000000000000000000000"],
      data: "0x",
      blockNumber: 1n,
      transactionHash: "0xdeadbeef",
      logIndex: 0,
    };
    assert.throws(
      () => decodeIntentRegisteredLog(badLog, INTENT_REGISTERED_ABI),
      (err: Error) => err.message.length > 0,
    );
  });
});

describe("createIntentRegisteredDecoder", () => {
  it("returns a reusable decoder that produces the same result as the direct call", () => {
    const log = buildLog();
    const decoder = createIntentRegisteredDecoder(INTENT_REGISTERED_ABI);
    const fromFactory = decoder(log);
    const fromDirect = decodeIntentRegisteredLog(log, INTENT_REGISTERED_ABI);
    assert.deepEqual(fromFactory, fromDirect);
  });
});

describe("decodeIntentRegisteredLogs", () => {
  it("decodes a batch and preserves order", () => {
    const log = buildLog();
    const events = decodeIntentRegisteredLogs([log, log], INTENT_REGISTERED_ABI);
    assert.equal(events.length, 2);
    assert.equal(events[0].intentHash, INTENT_HASH);
    assert.equal(events[1].intentHash, INTENT_HASH);
  });

  it("wraps a bad log error with tx hash and logIndex context", () => {
    const badLog: RegistryLog = {
      topics: ["0x0000000000000000000000000000000000000000000000000000000000000000"],
      data: "0x",
      blockNumber: 1n,
      transactionHash: "0xdeadbeef01" as `0x${string}`,
      logIndex: 7,
    };
    assert.throws(
      () => decodeIntentRegisteredLogs([badLog], INTENT_REGISTERED_ABI),
      (err: Error) => err.message.includes("0xdeadbeef01") && err.message.includes("logIndex=7"),
    );
  });

  it("returns empty array for empty input", () => {
    const result = decodeIntentRegisteredLogs([], INTENT_REGISTERED_ABI);
    assert.deepEqual(result, []);
  });
});
