import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readIndexerConfig } from "../config.js";

describe("readIndexerConfig", () => {
  it("reads a Blockfrost config using the feeder env conventions (Mainnet → _MAINNET)", () => {
    const config = readIndexerConfig({
      CARDANO_NETWORK: "Mainnet",
      BLOCKFROST_API_URL_MAINNET: "https://cardano-mainnet.blockfrost.io/api/v0",
      BLOCKFROST_PROJECT_ID_MAINNET: "mainnetXXX",
    });
    assert.deepEqual(config, {
      network: "Mainnet",
      provider: "Blockfrost",
      blockfrostUrl: "https://cardano-mainnet.blockfrost.io/api/v0",
      blockfrostProjectId: "mainnetXXX",
      port: 3001,
      registryFile: undefined,
    });
  });

  it("reads a Koios config (Preview → _TESTNET suffix)", () => {
    const config = readIndexerConfig({
      CARDANO_NETWORK: "Preview",
      CARDANO_PROVIDER: "Koios",
      KOIOS_API_URL_TESTNET: "https://preview.koios.rest/api/v1",
      INDEXER_PORT: "8080",
    });
    assert.deepEqual(config, {
      network: "Preview",
      provider: "Koios",
      koiosUrl: "https://preview.koios.rest/api/v1",
      port: 8080,
      registryFile: undefined,
    });
  });

  it("defaults to Preview + Blockfrost + port 3001, reading the _TESTNET vars", () => {
    const config = readIndexerConfig({
      BLOCKFROST_API_URL_TESTNET: "u",
      BLOCKFROST_PROJECT_ID_TESTNET: "p",
    });
    assert.equal(config.network, "Preview");
    assert.equal(config.provider, "Blockfrost");
    assert.equal(config.port, 3001);
  });

  it("passes through INDEXER_REGISTRY_FILE", () => {
    const config = readIndexerConfig({
      BLOCKFROST_API_URL_TESTNET: "u",
      BLOCKFROST_PROJECT_ID_TESTNET: "p",
      INDEXER_REGISTRY_FILE: "/etc/indexer/registry.json",
    });
    assert.equal(config.registryFile, "/etc/indexer/registry.json");
  });

  it("rejects an invalid network", () => {
    assert.throws(() => readIndexerConfig({ CARDANO_NETWORK: "Testnet" }), /CARDANO_NETWORK/);
  });

  it("rejects an invalid provider", () => {
    assert.throws(() => readIndexerConfig({ CARDANO_PROVIDER: "Ogmios" }), /CARDANO_PROVIDER/);
  });

  it("rejects an invalid port", () => {
    assert.throws(
      () =>
        readIndexerConfig({
          BLOCKFROST_API_URL_TESTNET: "u",
          BLOCKFROST_PROJECT_ID_TESTNET: "p",
          INDEXER_PORT: "0",
        }),
      /INDEXER_PORT/,
    );
  });

  it("requires the suffixed Blockfrost url + project id", () => {
    assert.throws(() => readIndexerConfig({ CARDANO_NETWORK: "Mainnet" }), /BLOCKFROST_API_URL_MAINNET/);
    assert.throws(
      () => readIndexerConfig({ CARDANO_NETWORK: "Mainnet", BLOCKFROST_API_URL_MAINNET: "u" }),
      /BLOCKFROST_PROJECT_ID_MAINNET/,
    );
  });

  it("requires the suffixed Koios url", () => {
    assert.throws(
      () => readIndexerConfig({ CARDANO_NETWORK: "Preview", CARDANO_PROVIDER: "Koios" }),
      /KOIOS_API_URL_TESTNET/,
    );
  });
});
