// R10.C.4 — toRegistryLog null-field guard (R10.A.6).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Log } from "viem";

import { toRegistryLog } from "../scanner-ws.js";

function minedLog(overrides: Partial<Log> = {}): Log {
  return {
    address: "0x0000000000000000000000000000000000000001",
    topics: ["0x" + "aa".repeat(32)],
    data: "0x",
    blockNumber: 100n,
    blockHash: "0x" + "bb".repeat(32),
    transactionHash: "0x" + "cc".repeat(32),
    transactionIndex: 0,
    logIndex: 3,
    removed: false,
    ...overrides,
  } as Log;
}

describe("toRegistryLog", () => {
  it("passes a fully-mined log through unchanged", () => {
    const out = toRegistryLog(minedLog());
    assert.equal(out.blockNumber, 100n);
    assert.equal(out.logIndex, 3);
    assert.equal(out.transactionHash, "0x" + "cc".repeat(32));
  });

  it("throws when blockNumber is null (pending tx) instead of defaulting to 0n", () => {
    assert.throws(
      () => toRegistryLog(minedLog({ blockNumber: null })),
      /null blockNumber/,
    );
  });

  it("throws when transactionHash is null instead of defaulting to 0x", () => {
    assert.throws(
      () => toRegistryLog(minedLog({ transactionHash: null })),
      /null transactionHash/,
    );
  });

  it("throws when logIndex is null instead of defaulting to 0", () => {
    assert.throws(
      () => toRegistryLog(minedLog({ logIndex: null })),
      /null logIndex/,
    );
  });
});
