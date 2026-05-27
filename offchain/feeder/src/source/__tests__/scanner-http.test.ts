import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runHttpScanner, BACKFILL_CHUNK_BLOCKS, type ScannerMetricsSink } from "../scanner-http.js";
import type { RegistryClient, RegistryLog } from "../registry-client.js";
import type { Checkpoint } from "../checkpoint.js";
import type { ScannedBatch } from "../scan-handler.js";
import type { AbiEvent, Address, Hex } from "viem";

// The processor below only inspects fromBlock/toBlock — the ABI is not
// actually decoded. A minimal placeholder keeps the type checker happy.
const FAKE_EVENT_ABI: AbiEvent = {
  type: "event",
  name: "IntentRegistered",
  anonymous: false,
  inputs: [],
};

function makeMetricsSink() {
  const lastBlocks: Array<{ labels: { chain_id: string; scanner_type: string }; block: number }> = [];
  const lags: Array<{ labels: { chain_id: string }; lag: number }> = [];
  const rpcErrors: Array<{ chain_id: string; error_type: string }> = [];
  const backfillBlocks: Array<{ labels: { chain_id: string }; blocks: number }> = [];
  const backfillChunks: Array<{ chain_id: string }> = [];
  const sink: ScannerMetricsSink = {
    setLastBlock: (labels, block) => lastBlocks.push({ labels, block }),
    setBlockLag: (labels, lag) => lags.push({ labels, lag }),
    incRpcError: (labels) => rpcErrors.push(labels),
    incBackfillBlocks: (labels, blocks) => backfillBlocks.push({ labels, blocks }),
    incBackfillChunks: (labels) => backfillChunks.push(labels),
  };
  return { sink, lastBlocks, lags, rpcErrors, backfillBlocks, backfillChunks };
}

function makeMemoryCheckpoint(initial: bigint | null = null): Checkpoint {
  let value: bigint | null = initial;
  return {
    async load() {
      return value;
    },
    async save(v) {
      value = v;
    },
  };
}

function makeFakeClient(headSequence: bigint[]): {
  client: RegistryClient;
  getLogsCalls: Array<{ fromBlock: bigint; toBlock: bigint }>;
} {
  const getLogsCalls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let headIndex = 0;
  const client: RegistryClient = {
    chainId: 10050,
    registryAddress: ("0x" + "11".repeat(20)) as Address,
    transport: "http",
    async getHeadBlockNumber() {
      const h = headSequence[Math.min(headIndex, headSequence.length - 1)] ?? 0n;
      headIndex++;
      return h;
    },
    async getIntentRegisteredLogs(args) {
      getLogsCalls.push(args);
      return [] as RegistryLog[];
    },
    async getIntent() {
      throw new Error("getIntent not used by scanner");
    },
    async close() {},
  };
  return { client, getLogsCalls };
}

function makeScannedBatchSink(): {
  handler: (batch: ScannedBatch) => Promise<void>;
  batches: ScannedBatch[];
} {
  const batches: ScannedBatch[] = [];
  return {
    handler: async (batch) => {
      batches.push(batch);
    },
    batches,
  };
}

describe("runHttpScanner — gap recovery (Etapa B.1)", () => {
  it("uses BACKFILL_CHUNK_BLOCKS while gap > maxBlockGap, then switches to blockRange chunks", async () => {
    // Gap setup: cursor=0, head=11_000 → finalizedHead=11_000.
    // First tick: gap=11_000 > 5_000 → backfill chunk [0, 4999]. cursor=5000.
    // Second tick: gap=6_000 > 5_000 → backfill chunk [5000, 9999]. cursor=10000.
    // Third tick: gap=1_000 ≤ 5_000 → NORMAL mode, 500-block chunk
    //   [10000, 10499]. cursor=10500.
    // Fourth tick: gap=500 ≤ 5_000 → NORMAL, chunk [10500, 10999]. cursor=11000.
    // Fifth tick: cursor > finalizedHead → caught up → sleep then abort.
    const head = 11_000n;
    const { client, getLogsCalls } = makeFakeClient([head, head, head, head, head, head, head]);
    const checkpoint = makeMemoryCheckpoint(null);
    const { handler } = makeScannedBatchSink();
    const { sink, backfillBlocks, backfillChunks, lastBlocks, lags } = makeMetricsSink();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);

    await runHttpScanner({
      client,
      eventAbi: FAKE_EVENT_ABI,
      checkpoint,
      startBlock: 0n,
      blockRange: 500n,
      scanIntervalMs: 5,
      confirmations: 0n,
      onBatch: handler,
      signal: controller.signal,
      metrics: sink,
      chainId: 10050,
      backwardSync: true,
      maxBlockGap: 5000n,
    });

    // First two calls are backfill-sized; subsequent calls are blockRange-sized.
    assert.ok(getLogsCalls.length >= 4, `expected ≥4 chunks, got ${getLogsCalls.length}`);
    assert.equal(getLogsCalls[0]!.fromBlock, 0n);
    assert.equal(getLogsCalls[0]!.toBlock, BACKFILL_CHUNK_BLOCKS - 1n);
    assert.equal(getLogsCalls[1]!.fromBlock, BACKFILL_CHUNK_BLOCKS);
    assert.equal(getLogsCalls[1]!.toBlock, BACKFILL_CHUNK_BLOCKS * 2n - 1n);
    // Third call is the first normal-mode chunk: 500-wide.
    assert.equal(getLogsCalls[2]!.fromBlock, BACKFILL_CHUNK_BLOCKS * 2n);
    assert.equal(getLogsCalls[2]!.toBlock, BACKFILL_CHUNK_BLOCKS * 2n + 499n);

    // Exactly 2 backfill-chunk increments (for the first two ticks).
    assert.equal(backfillChunks.length, 2);
    const totalBackfillBlocks = backfillBlocks.reduce((sum, e) => sum + e.blocks, 0);
    assert.equal(totalBackfillBlocks, 10_000, "5000 + 5000 backfilled blocks");

    // Last-block + lag gauges fire at least once per tick.
    assert.ok(lastBlocks.length >= 2);
    assert.ok(lags.length >= 2);
    assert.equal(lastBlocks[0]!.labels.scanner_type, "http");
    assert.equal(lastBlocks[0]!.labels.chain_id, "10050");
  });

  it("does NOT use backfill mode when backwardSync is disabled — uses blockRange chunks", async () => {
    // Same 12_000-block gap, but backwardSync=false. The scanner should
    // process 500-block chunks per tick.
    const head = 12_000n;
    const { client, getLogsCalls } = makeFakeClient([head, head, head, head, head]);
    const checkpoint = makeMemoryCheckpoint(null);
    const { handler } = makeScannedBatchSink();
    const { sink, backfillBlocks, backfillChunks } = makeMetricsSink();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    await runHttpScanner({
      client,
      eventAbi: FAKE_EVENT_ABI,
      checkpoint,
      startBlock: 0n,
      blockRange: 500n,
      scanIntervalMs: 5,
      confirmations: 0n,
      onBatch: handler,
      signal: controller.signal,
      metrics: sink,
      chainId: 10050,
      backwardSync: false,
      maxBlockGap: 5000n,
    });

    assert.ok(getLogsCalls.length >= 1);
    assert.equal(getLogsCalls[0]!.fromBlock, 0n);
    assert.equal(getLogsCalls[0]!.toBlock, 499n);
    assert.equal(backfillBlocks.length, 0, "no backfill emit when disabled");
    assert.equal(backfillChunks.length, 0);
  });

  it("classifies head-fetch RPC errors and increments scannerRpcErrors", async () => {
    const checkpoint = makeMemoryCheckpoint(null);
    const { handler } = makeScannedBatchSink();
    const { sink, rpcErrors } = makeMetricsSink();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const erroringClient: RegistryClient = {
      chainId: 10050,
      registryAddress: ("0x" + "11".repeat(20)) as Address,
      transport: "http",
      async getHeadBlockNumber() {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:8545");
        throw err;
      },
      async getIntentRegisteredLogs() {
        return [] as RegistryLog[];
      },
      async getIntent() {
        throw new Error("not used");
      },
      async close() {},
    };

    await assert.rejects(
      runHttpScanner({
        client: erroringClient,
        eventAbi: FAKE_EVENT_ABI,
        checkpoint,
        startBlock: 0n,
        blockRange: 500n,
        scanIntervalMs: 5,
        confirmations: 0n,
        onBatch: handler,
        signal: controller.signal,
        metrics: sink,
        chainId: 10050,
      }),
    );

    assert.equal(rpcErrors.length, 1);
    assert.equal(rpcErrors[0]!.error_type, "network");
    assert.equal(rpcErrors[0]!.chain_id, "10050");
  });
});
