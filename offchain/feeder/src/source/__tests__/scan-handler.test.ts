import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toHex,
  type AbiEvent,
} from "viem";

import { processLogBatch, type ScannedBatch } from "../scan-handler.js";
import type { RegistryLog } from "../registry-client.js";
import type { Hex } from "viem";
import type { Checkpoint } from "../checkpoint.js";

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

function makeRegistryLog(blockNumber: bigint, intentHashSeed: number): RegistryLog {
  const intentHash = `0x${intentHashSeed.toString(16).padStart(64, "0")}` as `0x${string}`;
  const symbolHash = keccak256(toHex("BTC/USD"));
  const priceHex = `0x${(1_000n).toString(16).padStart(64, "0")}` as `0x${string}`;
  const topics = encodeEventTopics({
    abi: [INTENT_REGISTERED_ABI],
    eventName: "IntentRegistered",
    args: { intentHash, symbol: symbolHash, price: 1_000n },
  }).filter((t): t is Hex => t !== null);
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }],
    [42n, "0x000000000000000000000000000000000000dead"],
  );
  return {
    topics,
    data,
    blockNumber,
    transactionHash: `0x${"aa".repeat(32)}` as `0x${string}`,
    logIndex: 0,
  };
}

function makeMemoryCheckpoint(): Checkpoint {
  let saved: bigint | null = null;
  return {
    async load() { return saved; },
    async save(block: bigint) { saved = block; },
  };
}

describe("processLogBatch — blockTimestamp wiring", () => {
  it("leaves blockTimestamp at 0n when no resolver is supplied", async () => {
    let captured: ScannedBatch | null = null;
    await processLogBatch({
      logs: [makeRegistryLog(100n, 1)],
      eventAbi: INTENT_REGISTERED_ABI,
      fromBlock: 100n,
      toBlock: 100n,
      checkpoint: makeMemoryCheckpoint(),
      onBatch: (batch) => { captured = batch; },
    });
    assert.ok(captured, "onBatch must be called");
    const events = (captured as unknown as ScannedBatch).events;
    assert.equal(events[0].blockTimestamp, 0n);
  });

  it("populates blockTimestamp from the resolver and caches per-block lookups", async () => {
    const calls: bigint[] = [];
    const resolver = async (block: bigint): Promise<bigint> => {
      calls.push(block);
      return 1_700_000_000n + block; // deterministic ts per block
    };
    let captured: ScannedBatch | null = null;
    await processLogBatch({
      logs: [
        makeRegistryLog(100n, 1),
        makeRegistryLog(100n, 2), // same block — should reuse cached ts
        makeRegistryLog(101n, 3),
      ],
      eventAbi: INTENT_REGISTERED_ABI,
      fromBlock: 100n,
      toBlock: 101n,
      checkpoint: makeMemoryCheckpoint(),
      onBatch: (batch) => { captured = batch; },
      getBlockTimestamp: resolver,
    });
    assert.ok(captured, "onBatch must be called");
    const events = (captured as unknown as ScannedBatch).events;
    assert.equal(events[0].blockTimestamp, 1_700_000_100n);
    assert.equal(events[1].blockTimestamp, 1_700_000_100n);
    assert.equal(events[2].blockTimestamp, 1_700_000_101n);
    // The resolver must be called exactly once per distinct block number.
    assert.deepEqual(calls.sort(), [100n, 101n]);
  });
});
