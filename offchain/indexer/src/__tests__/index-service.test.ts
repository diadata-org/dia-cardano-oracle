import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildConfigDatumCbor,
  buildPairDatumCbor,
  buildReceiverDatumCbor,
} from "@diadata-org/dia-cardano-oracle-cli/core/chain-helpers";
import type { ConfigState } from "@diadata-org/dia-cardano-oracle-cli/core/state";

import { createIndexService } from "../index-service.js";
import { symbolToPairId } from "../pair-codec.js";
import type { ChainReader, ChainTip, IndexerUtxo } from "../chain-reader.js";
import type { Registry } from "../registry.js";

// --- fixtures ---------------------------------------------------------------

const PAIR_POLICY = "b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f";
const PAIR_ADDR = "addr1_pair_validator";
const RECEIVER_ADDR = "addr1_receiver_validator";
const RECEIVER_UNIT = "6ec4b5aa572382beb11bb8db28a87884d147afe4e2b3d8f5a7331a25" + "4449415f52454345495645525f434c49454e545f41";
const CONFIG_ADDR = "addr1_config_validator";
const CONFIG_UNIT = "0e73aac631bf11fc78ac53a8d85dee490b4a61ed6577de0857027691" + "4449415f434f4e464947";

const REGISTRY: Registry = {
  network: "Preview",
  config: { configValidatorAddress: CONFIG_ADDR, configUnit: CONFIG_UNIT },
  clients: [
    {
      clientId: "client-test-01",
      pairPolicyId: PAIR_POLICY,
      pairValidatorAddress: PAIR_ADDR,
      receiverValidatorAddress: RECEIVER_ADDR,
      receiverUnit: RECEIVER_UNIT,
    },
  ],
};

/** A minimal-but-valid Config datum carrying the two fee fields. */
function configDatum(baseFeeLovelace: string, perPairFeeLovelace: string): string {
  const state: ConfigState = {
    validConfigSigners: ["50186fd477be5e6bbcf42e0143bcf8d6612901d19c515f93f3f30d2d"],
    authorizedDiaPublicKeys: ["02".repeat(33)],
    domain: { name: "DIA Oracle", version: "1.0", sourceChainId: "1", verifyingContract: "ab".repeat(20) },
    baseFeeLovelace,
    perPairFeeLovelace,
    maxBootstrapDriftSeconds: "300",
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: "2000000",
    depositMinLovelace: "5000000",
    depositMaxPerMerge: "20",
    depositMaxPerUpdateFold: "5",
  };
  return buildConfigDatumCbor(state);
}

/** A Config UTxO carrying the Config NFT + inline datum. */
function configUtxo(baseFeeLovelace: string, perPairFeeLovelace: string, txHash: string): IndexerUtxo {
  return {
    address: CONFIG_ADDR,
    txHash,
    outputIndex: 0,
    assets: { lovelace: 5_000_000n, [CONFIG_UNIT]: 1n },
    datum: configDatum(baseFeeLovelace, perPairFeeLovelace),
  };
}

const TIP: ChainTip = { slot: 1000, height: 50, hash: "ab".repeat(32) };

function pairDatum(symbol: string, price: string, timestamp: string, nonce = "1"): string {
  return buildPairDatumCbor({
    pairId: symbolToPairId(symbol),
    price,
    timestamp,
    nonce,
    intentHash: "ab".repeat(32),
    signer: "cd".repeat(20),
    minUtxoLovelace: "2000000",
  });
}

/** A Pair UTxO that carries a Pair NFT + inline datum. */
function pairUtxo(symbol: string, price: string, timestamp: string, txHash: string, ix: number): IndexerUtxo {
  return {
    address: PAIR_ADDR,
    txHash,
    outputIndex: ix,
    assets: { lovelace: 2_000_000n, [`${PAIR_POLICY}aa01`]: 1n },
    datum: pairDatum(symbol, price, timestamp),
  };
}

function fakeReader(utxosByAddress: Record<string, IndexerUtxo[]>): ChainReader {
  return {
    async utxosAt(address) {
      return utxosByAddress[address] ?? [];
    },
    async tip() {
      return TIP;
    },
  };
}

// --- tests ------------------------------------------------------------------

describe("createIndexService.listPairs", () => {
  it("decodes every Pair UTxO into the consumer shape with utxoRef + ageSeconds", async () => {
    const reader = fakeReader({
      [PAIR_ADDR]: [
        pairUtxo("BTC/USD", "65000000000", "1700000000", "11".repeat(32), 0),
        pairUtxo("ETH/USD", "3200000000", "1700000000", "22".repeat(32), 1),
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_060_000 });

    const pairs = await service.listPairs();
    assert.equal(pairs.length, 2);
    const btc = pairs.find((p) => p.symbol === "BTC/USD")!;
    assert.equal(btc.price, "65000000000");
    assert.equal(btc.timestamp, "1700000000");
    assert.equal(btc.ageSeconds, 60, "now − timestamp");
    assert.deepEqual(btc.utxoRef, { txHash: "11".repeat(32), outputIndex: 0 });
    assert.equal(btc.clientId, "client-test-01");
    assert.equal(btc.pairId, symbolToPairId("BTC/USD"));
    assert.equal(btc.pairPolicyId, PAIR_POLICY, "exposes the Pair NFT policy id for consumers");
  });

  it("ignores UTxOs without a Pair NFT or without a datum", async () => {
    const reader = fakeReader({
      [PAIR_ADDR]: [
        pairUtxo("BTC/USD", "65000000000", "1700000000", "11".repeat(32), 0),
        // dust: no Pair NFT
        { address: PAIR_ADDR, txHash: "99".repeat(32), outputIndex: 0, assets: { lovelace: 5_000_000n }, datum: pairDatum("XX/YY", "1", "1") },
        // a Pair NFT but no datum
        { address: PAIR_ADDR, txHash: "88".repeat(32), outputIndex: 0, assets: { [`${PAIR_POLICY}bb`]: 1n }, datum: null },
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_060_000 });

    const pairs = await service.listPairs();
    assert.deepEqual(pairs.map((p) => p.symbol), ["BTC/USD"]);
  });

  it("clamps ageSeconds to 0 for a future timestamp", async () => {
    const reader = fakeReader({ [PAIR_ADDR]: [pairUtxo("BTC/USD", "1", "1700000100", "11".repeat(32), 0)] });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });
    const [pair] = await service.listPairs();
    assert.equal(pair!.ageSeconds, 0);
  });
});

describe("createIndexService.getPair", () => {
  it("returns the matching pair", async () => {
    const reader = fakeReader({ [PAIR_ADDR]: [pairUtxo("BTC/USD", "65000000000", "1700000000", "11".repeat(32), 0)] });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });
    const pair = await service.getPair("BTC/USD");
    assert.equal(pair?.symbol, "BTC/USD");
    assert.deepEqual(pair?.utxoRef, { txHash: "11".repeat(32), outputIndex: 0 });
  });

  it("returns null for an unknown symbol", async () => {
    const reader = fakeReader({ [PAIR_ADDR]: [pairUtxo("BTC/USD", "1", "1700000000", "11".repeat(32), 0)] });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });
    assert.equal(await service.getPair("DOGE/USD"), null);
  });
});

describe("createIndexService.getClient", () => {
  it("returns receiver balance + the client's subscribed pairs", async () => {
    const reader = fakeReader({
      [PAIR_ADDR]: [pairUtxo("BTC/USD", "1", "1700000000", "11".repeat(32), 0)],
      [RECEIVER_ADDR]: [
        {
          address: RECEIVER_ADDR,
          txHash: "33".repeat(32),
          outputIndex: 0,
          assets: { lovelace: 10_000_000n, [RECEIVER_UNIT]: 1n },
          datum: buildReceiverDatumCbor({ balanceLovelace: "8000000", accruedToHookLovelace: "500000", minUtxoLovelace: "2000000" }),
        },
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });

    const client = await service.getClient("client-test-01");
    assert.equal(client?.receiverBalanceLovelace, "8000000");
    assert.equal(client?.accruedToHookLovelace, "500000");
    assert.deepEqual(client?.subscribedPairs, ["BTC/USD"]);
  });

  it("returns null for an unknown client", async () => {
    const service = createIndexService({ reader: fakeReader({}), registry: REGISTRY, now: () => 1 });
    assert.equal(await service.getClient("nope"), null);
  });

  it("returns null when the Receiver UTxO is absent", async () => {
    const service = createIndexService({ reader: fakeReader({ [RECEIVER_ADDR]: [] }), registry: REGISTRY, now: () => 1 });
    assert.equal(await service.getClient("client-test-01"), null);
  });
});

describe("createIndexService.listClients", () => {
  it("lists every client whose Receiver UTxO is on-chain", async () => {
    const reader = fakeReader({
      [PAIR_ADDR]: [pairUtxo("BTC/USD", "1", "1700000000", "11".repeat(32), 0)],
      [RECEIVER_ADDR]: [
        {
          address: RECEIVER_ADDR,
          txHash: "33".repeat(32),
          outputIndex: 0,
          assets: { lovelace: 10_000_000n, [RECEIVER_UNIT]: 1n },
          datum: buildReceiverDatumCbor({ balanceLovelace: "8000000", accruedToHookLovelace: "500000", minUtxoLovelace: "2000000" }),
        },
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });

    const clients = await service.listClients();
    assert.equal(clients.length, 1);
    assert.equal(clients[0]!.clientId, "client-test-01");
    assert.deepEqual(clients[0]!.subscribedPairs, ["BTC/USD"]);
  });

  it("omits clients whose Receiver UTxO is absent (empty list, not nulls)", async () => {
    const service = createIndexService({ reader: fakeReader({ [RECEIVER_ADDR]: [] }), registry: REGISTRY, now: () => 1 });
    assert.deepEqual(await service.listClients(), []);
  });
});

describe("createIndexService.getProtocolFees", () => {
  it("decodes the fee formula inputs from the on-chain Config UTxO", async () => {
    const reader = fakeReader({ [CONFIG_ADDR]: [configUtxo("600000", "250000", "44".repeat(32))] });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1 });

    const fees = await service.getProtocolFees();
    assert.equal(fees?.baseFeeLovelace, "600000");
    assert.equal(fees?.perPairFeeLovelace, "250000");
    // protocol_fee(N) = base + N × perPair — surfaced so a consumer can price an update.
    assert.equal(fees?.feeForPairs(1), "850000");
    assert.equal(fees?.feeForPairs(3), "1350000");
  });

  it("ignores a UTxO at the config address that lacks the Config NFT", async () => {
    const reader = fakeReader({
      [CONFIG_ADDR]: [
        { address: CONFIG_ADDR, txHash: "99".repeat(32), outputIndex: 0, assets: { lovelace: 5_000_000n }, datum: configDatum("1", "1") },
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1 });
    assert.equal(await service.getProtocolFees(), null);
  });

  it("returns null when the registry has no Config (published-from-clients registry)", async () => {
    const reader = fakeReader({ [CONFIG_ADDR]: [configUtxo("600000", "250000", "44".repeat(32))] });
    const service = createIndexService({ reader, registry: { network: "Preview", clients: REGISTRY.clients }, now: () => 1 });
    assert.equal(await service.getProtocolFees(), null);
  });
});

describe("createIndexService.health", () => {
  it("reports the tip and the live pair count", async () => {
    const reader = fakeReader({
      [PAIR_ADDR]: [
        pairUtxo("BTC/USD", "1", "1700000000", "11".repeat(32), 0),
        pairUtxo("ETH/USD", "1", "1700000000", "22".repeat(32), 1),
      ],
    });
    const service = createIndexService({ reader, registry: REGISTRY, now: () => 1_700_000_000_000 });
    const health = await service.health();
    assert.deepEqual(health.tip, TIP);
    assert.equal(health.pairCount, 2);
  });
});
