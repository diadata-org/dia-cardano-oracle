import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWalletPoolSigners } from "../load-pool.js";
import type { WalletConfigEntry } from "../../../config/types.js";

describe("resolveWalletPoolSigners", () => {
  it("resolves a multi-wallet block, inferring the signer kind from the env var name", () => {
    const wallets: WalletConfigEntry[] = [
      { id: "main", role: "main", private_key_env: "CARDANO_WALLET_SEED_TESTNET" },
      { id: "pool-1", role: "pool", private_key_env: "CARDANO_WALLET_SEED_TESTNET_POOL_1" },
      { id: "pool-2", role: "pool", private_key_env: "CARDANO_PRIVATE_KEY_TESTNET_POOL_2" },
    ];
    const env = {
      CARDANO_WALLET_SEED_TESTNET: "main seed",
      CARDANO_WALLET_SEED_TESTNET_POOL_1: "pool1 seed",
      CARDANO_PRIVATE_KEY_TESTNET_POOL_2: "ed25519_sk...",
    } as NodeJS.ProcessEnv;

    const resolved = resolveWalletPoolSigners({ wallets, networkSuffix: "TESTNET", env });

    assert.deepEqual(resolved, [
      { id: "main", role: "main", signer: { kind: "seed", value: "main seed" } },
      { id: "pool-1", role: "pool", signer: { kind: "seed", value: "pool1 seed" } },
      { id: "pool-2", role: "pool", signer: { kind: "privateKey", value: "ed25519_sk..." } },
    ]);
  });

  it("throws when a declared wallet's env var is missing", () => {
    const wallets: WalletConfigEntry[] = [
      { id: "main", role: "main", private_key_env: "CARDANO_WALLET_SEED_TESTNET" },
      { id: "pool-1", role: "pool", private_key_env: "CARDANO_WALLET_SEED_TESTNET_POOL_1" },
    ];
    const env = { CARDANO_WALLET_SEED_TESTNET: "main seed" } as NodeJS.ProcessEnv;

    assert.throws(
      () => resolveWalletPoolSigners({ wallets, networkSuffix: "TESTNET", env }),
      /CARDANO_WALLET_SEED_TESTNET_POOL_1.*not set/,
    );
  });

  it("degenerates to a single main wallet from the network seed env var when no block is set", () => {
    const env = { CARDANO_WALLET_SEED_MAINNET: "the seed" } as NodeJS.ProcessEnv;

    const resolved = resolveWalletPoolSigners({ wallets: undefined, networkSuffix: "MAINNET", env });

    assert.deepEqual(resolved, [
      { id: "main", role: "main", signer: { kind: "seed", value: "the seed" } },
    ]);
  });

  it("uses the private-key env var for the single-wallet default when no seed is set", () => {
    const env = { CARDANO_PRIVATE_KEY_TESTNET: "ed25519_sk..." } as NodeJS.ProcessEnv;

    const resolved = resolveWalletPoolSigners({ wallets: undefined, networkSuffix: "TESTNET", env });

    assert.deepEqual(resolved, [
      { id: "main", role: "main", signer: { kind: "privateKey", value: "ed25519_sk..." } },
    ]);
  });

  it("throws when neither the wallets block nor the default env vars are set", () => {
    assert.throws(
      () => resolveWalletPoolSigners({ wallets: undefined, networkSuffix: "TESTNET", env: {} }),
      /No wallet pool configured/,
    );
  });

  it("throws when both the seed and the private key are set for the single-wallet default", () => {
    const env = {
      CARDANO_WALLET_SEED_TESTNET: "the seed",
      CARDANO_PRIVATE_KEY_TESTNET: "ed25519_sk...",
    } as NodeJS.ProcessEnv;

    assert.throws(
      () => resolveWalletPoolSigners({ wallets: undefined, networkSuffix: "TESTNET", env }),
      /Both "CARDANO_WALLET_SEED_TESTNET" and "CARDANO_PRIVATE_KEY_TESTNET" are set/,
    );
  });
});
