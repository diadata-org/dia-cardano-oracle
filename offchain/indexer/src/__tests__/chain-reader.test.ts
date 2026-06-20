import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createProviderChainReader,
  parseBlockfrostTip,
  parseKoiosTip,
  type ChainTip,
  type UtxoProvider,
} from "../chain-reader.js";

describe("createProviderChainReader", () => {
  it("maps provider UTxOs to the indexer shape (datum preserved)", async () => {
    const provider: UtxoProvider = {
      async getUtxos(address) {
        return [
          {
            address,
            txHash: "aa".repeat(32),
            outputIndex: 1,
            assets: { lovelace: 2_000_000n, "policy.PairNFT": 1n },
            datum: "d8799f...",
          },
        ];
      },
    };
    const reader = createProviderChainReader(provider, async () => ({ slot: 0, height: 0, hash: "" }));

    const utxos = await reader.utxosAt("addr_test1xyz");
    assert.equal(utxos.length, 1);
    assert.deepEqual(utxos[0], {
      address: "addr_test1xyz",
      txHash: "aa".repeat(32),
      outputIndex: 1,
      assets: { lovelace: 2_000_000n, "policy.PairNFT": 1n },
      datum: "d8799f...",
    });
  });

  it("normalises a missing datum to null", async () => {
    const provider: UtxoProvider = {
      async getUtxos(address) {
        return [{ address, txHash: "bb".repeat(32), outputIndex: 0, assets: { lovelace: 1_000_000n } }];
      },
    };
    const reader = createProviderChainReader(provider, async () => ({ slot: 0, height: 0, hash: "" }));

    const [utxo] = await reader.utxosAt("addr");
    assert.equal(utxo!.datum, null);
  });

  it("delegates tip() to the injected fetcher", async () => {
    const tip: ChainTip = { slot: 123, height: 45, hash: "cc".repeat(32) };
    const reader = createProviderChainReader({ getUtxos: async () => [] }, async () => tip);
    assert.deepEqual(await reader.tip(), tip);
  });
});

describe("parseBlockfrostTip", () => {
  it("parses a /blocks/latest body", () => {
    assert.deepEqual(
      parseBlockfrostTip({ slot: 1000, height: 50, hash: "dd".repeat(32), extra: "ignored" }),
      { slot: 1000, height: 50, hash: "dd".repeat(32) },
    );
  });

  it("throws on an unexpected shape", () => {
    assert.throws(() => parseBlockfrostTip({ slot: "x" }), /unexpected response shape/);
    assert.throws(() => parseBlockfrostTip(null), /unexpected response shape/);
  });
});

describe("parseKoiosTip", () => {
  it("parses the first row of a /tip array", () => {
    assert.deepEqual(
      parseKoiosTip([{ abs_slot: 2000, block_no: 80, hash: "ee".repeat(32) }]),
      { slot: 2000, height: 80, hash: "ee".repeat(32) },
    );
  });

  it("throws on an empty array or bad shape", () => {
    assert.throws(() => parseKoiosTip([]), /unexpected response shape/);
    assert.throws(() => parseKoiosTip({ abs_slot: 1 }), /unexpected response shape/);
  });
});
