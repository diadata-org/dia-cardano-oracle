// Wallet-pool signer resolution.
//
// Turns the `infrastructure.<network>.yaml::wallets` block into the resolved
// signers the arbiter's pool is built from, reading each entry's `private_key_env`
// from the environment. The signer kind is inferred from the env var name
// (contains `PRIVATE_KEY` → key, else seed).
//
// When the `wallets` block is absent, the pool degenerates to a single `main`
// wallet read from `CARDANO_WALLET_SEED_<SUFFIX>` / `CARDANO_PRIVATE_KEY_<SUFFIX>`
// — the same env vars the single-wallet deployment already uses.
//
// Address derivation is intentionally NOT done here (it needs Lucid); the daemon
// derives each address when it builds the `PoolWallet[]` for `createWalletPool`.

import type { WalletConfigEntry } from "../../config/types.js";
import type { RouterSigner } from "../types.js";
import type { WalletRole } from "./wallet-pool.js";

/** A pool wallet with its signer resolved, before address derivation. */
export type ResolvedPoolWallet = {
  id: string;
  role: WalletRole;
  signer: RouterSigner;
};

/** Network env-var suffix (`CARDANO_WALLET_SEED_<SUFFIX>`). */
export type NetworkEnvSuffix = "TESTNET" | "MAINNET";

function signerKind(envVarName: string): RouterSigner["kind"] {
  return envVarName.includes("PRIVATE_KEY") ? "privateKey" : "seed";
}

function readEnvSigner(env: NodeJS.ProcessEnv, envVarName: string, label: string): RouterSigner {
  const value = env[envVarName]?.trim();
  if (!value) {
    throw new Error(
      `${label}: env var "${envVarName}" is not set (or empty). Set it before starting the daemon.`,
    );
  }
  return { kind: signerKind(envVarName), value };
}

/**
 * Resolve the signer-wallet pool from config + environment. With a `wallets`
 * block, every entry's `private_key_env` is read; without one, a single `main`
 * wallet is read from the network's default seed/key env vars.
 */
export function resolveWalletPoolSigners(args: {
  wallets: WalletConfigEntry[] | undefined;
  networkSuffix: NetworkEnvSuffix;
  env: NodeJS.ProcessEnv;
}): ResolvedPoolWallet[] {
  const { wallets, networkSuffix, env } = args;

  if (wallets === undefined) {
    const seedVar = `CARDANO_WALLET_SEED_${networkSuffix}`;
    const keyVar = `CARDANO_PRIVATE_KEY_${networkSuffix}`;
    const seed = env[seedVar]?.trim();
    const key = env[keyVar]?.trim();
    if (seed && key) {
      throw new Error(
        `Both "${seedVar}" and "${keyVar}" are set — configure exactly one for the single-wallet default (a seed phrase or a raw private key, not both).`,
      );
    }
    if (seed) return [{ id: "main", role: "main", signer: { kind: "seed", value: seed } }];
    if (key) return [{ id: "main", role: "main", signer: { kind: "privateKey", value: key } }];
    throw new Error(
      `No wallet pool configured and neither "${seedVar}" nor "${keyVar}" is set. ` +
        "Set one for the single-wallet default, or declare a `wallets` block.",
    );
  }

  return wallets.map((w) => ({
    id: w.id,
    role: w.role,
    signer: readEnvSigner(env, w.private_key_env, `Wallet "${w.id}"`),
  }));
}
