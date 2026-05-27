import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCardanoWriteClient } from "../cardano-write-client.js";
import type { SubmitRequest, SubmitResult } from "../types.js";
import type { OracleIntentBridge } from "../../lib-bridge/index.js";
import type { TransactionLogEntry } from "../../logger/file-logger.js";
import type { EnrichedIntent } from "../../source/types.js";

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol: string): EnrichedIntent {
  return {
    event: {
      intentHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      signer: SIGNER,
      blockNumber: 1n,
      txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0,
    },
    fullIntent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: 10050n,
      nonce: 1n,
      expiry: 9_999_999_999n,
      symbol,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRequest(intentHash: string, symbol: string): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(symbol),
    destination: {
      network: "Preview",
      client_state_path: "state/preview/clients/client-a.json",
      protocol_state_path: "state/preview/config-bootstrap.json",
    },
    routerId: "router-a",
    destinationIndex: 0,
  };
}

function emitStandardSteps(
  onStep: ((step: string, meta?: { txHash?: string }) => void) | undefined,
  txHash = "cardano-tx-1",
): void {
  onStep?.("connecting");
  onStep?.("building");
  onStep?.("signing", { txHash });
  onStep?.("submitting", { txHash });
  onStep?.("submitted", { txHash });
  onStep?.("waiting_confirm", { txHash });
  onStep?.("waiting_utxo", { txHash });
  onStep?.("writing_state", { txHash });
}

describe("createCardanoWriteClient", () => {
  it("records single-submit steps and transaction summary on success", async () => {
    const stepEvents: Array<{ intentHash: string; symbol: string; step: string; txHash?: string }> = [];
    const transactions: TransactionLogEntry[] = [];

    const bridge: OracleIntentBridge = {
      async submitOracleUpdate(params) {
        emitStandardSteps(params.onStep, "tx-single");
        return {
          txHash: "tx-single",
          receiverUnit: "receiver-unit",
          pairUnit: "pair-unit-btc",
          isCreate: true,
        };
      },
      async submitOracleUpdateBatch() {
        throw new Error("unexpected batch call");
      },
    };

    const client = createCardanoWriteClient(
      "state/preview/clients/client-a.json",
      "state/preview/config-bootstrap.json",
      {
        bridge,
        onStep: (intentHash, symbol, step, txHash) => {
          stepEvents.push({ intentHash, symbol, step, txHash });
        },
        onTransaction: async (entry) => {
          transactions.push(entry);
        },
      },
    );

    const result = await client.submit(makeRequest("intent-1", "BTC/USD"));

    assert.equal(result.ok, true);
    assert.equal(result.intentHash, "intent-1");
    assert.equal("cardanoTxHash" in result && result.cardanoTxHash, "tx-single");
    assert.equal("pairAction" in result && result.pairAction, "mint");
    assert.deepEqual(
      stepEvents.map((event) => event.step),
      [
        "tx_start",
        "connecting",
        "building",
        "signing",
        "submitting",
        "submitted",
        "waiting_confirm",
        "waiting_utxo",
        "writing_state",
      ],
    );
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.status, "confirmed");
    assert.equal(transactions[0]?.isCreate, true);
    assert.equal(transactions[0]?.txHash, "tx-single");
    assert.equal(transactions[0]?.pairAction, "mint");
    assert.equal(transactions[0]?.pairUnit, "pair-unit-btc");
  });

  it("maps batch results by intent hash and preserves request order", async () => {
    const stepEvents: Array<{ intentHash: string; step: string; txHash?: string }> = [];
    const transactions: TransactionLogEntry[] = [];

    const bridge: OracleIntentBridge = {
      async submitOracleUpdate() {
        throw new Error("unexpected single call");
      },
      async submitOracleUpdateBatch(params) {
        for (const update of params.updates) {
          emitStandardSteps(update.onStep, "tx-batch");
        }
        return {
          txHash: "tx-batch",
          receiverUnit: "receiver-unit",
          entries: [
            { intentHash: params.updates[1]!.intentHash, pairUnit: "pair-eth", isCreate: false },
            { intentHash: params.updates[0]!.intentHash, pairUnit: "pair-btc", isCreate: true },
          ],
        };
      },
    };

    const client = createCardanoWriteClient(
      "state/preview/clients/client-a.json",
      "state/preview/config-bootstrap.json",
      {
        bridge,
        onStep: (intentHash, _symbol, step, txHash) => {
          stepEvents.push({ intentHash, step, txHash });
        },
        onTransaction: async (entry) => {
          transactions.push(entry);
        },
      },
    );

    const results = await client.submitBatch([
      makeRequest("intent-1", "BTC/USD"),
      makeRequest("intent-2", "ETH/USD"),
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, true);
    assert.equal(results[0]?.intentHash, "intent-1");
    assert.equal(results[1]?.intentHash, "intent-2");
    assert.equal(results[0] && "pairUnit" in results[0] && results[0].pairUnit, "pair-btc");
    assert.equal(results[1] && "pairUnit" in results[1] && results[1].pairUnit, "pair-eth");
    assert.equal(results[0] && "batch" in results[0] && results[0].batch?.size, 2);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.isCreate, true);
    assert.equal(transactions[0]?.batch?.size, 2);
    assert.deepEqual(
      transactions[0]?.batch?.members.map((member) => `${member.intentHash}:${member.symbol}:${member.action}`),
      ["intent-1:BTC/USD:mint", "intent-2:ETH/USD:update"],
    );
    assert.ok(stepEvents.some((event) => event.intentHash === "intent-1" && event.step === "submitted"));
    assert.ok(stepEvents.some((event) => event.intentHash === "intent-2" && event.step === "submitted"));
  });

  it("fans out a batch failure to every request with structured errors", async () => {
    const transactions: TransactionLogEntry[] = [];

    const bridge: OracleIntentBridge = {
      async submitOracleUpdate() {
        throw new Error("unexpected single call");
      },
      async submitOracleUpdateBatch() {
        throw new Error("batch size exceeded");
      },
    };

    const client = createCardanoWriteClient(
      "state/preview/clients/client-a.json",
      "state/preview/config-bootstrap.json",
      {
        bridge,
        onTransaction: async (entry) => {
          transactions.push(entry);
        },
      },
    );

    const results = await client.submitBatch([
      makeRequest("intent-1", "BTC/USD"),
      makeRequest("intent-2", "ETH/USD"),
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((result) => !result.ok));
    assert.ok(
      results.every(
        (result) => !result.ok && result.code === "BatchSizeExceeded",
      ),
    );
    assert.equal(results[0] && "batch" in results[0] && results[0].batch?.size, 2);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]?.status, "failed");
    assert.equal(transactions[0]?.batch?.size, 2);
  });

  it("uses the single path when submitBatch receives exactly one request", async () => {
    let singleCalls = 0;
    let batchCalls = 0;

    const bridge: OracleIntentBridge = {
      async submitOracleUpdate(params) {
        singleCalls++;
        emitStandardSteps(params.onStep, "tx-singleton");
        return {
          txHash: "tx-singleton",
          receiverUnit: "receiver-unit",
          pairUnit: "pair-unit-btc",
          isCreate: false,
        };
      },
      async submitOracleUpdateBatch() {
        batchCalls++;
        throw new Error("unexpected batch call");
      },
    };

    const client = createCardanoWriteClient(
      "state/preview/clients/client-a.json",
      "state/preview/config-bootstrap.json",
      { bridge },
    );

    const results = await client.submitBatch([makeRequest("intent-1", "BTC/USD")]);

    assert.equal(singleCalls, 1);
    assert.equal(batchCalls, 0);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[0]?.intentHash, "intent-1");
  });
});
