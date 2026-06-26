// Wallet pool registry.
//
// Holds the static set of signer wallets that pay Cardano fees + collateral,
// plus a per-wallet UTxO cache and lifecycle flags. The arbiter (wallet-arbiter.ts)
// reads this registry together with the UTxO lock table to hand out reservations.
//
// Roles: exactly one wallet is the `main` (its address is the on-chain
// PaymentHook withdraw target; protocol-fee withdraws land there and are fanned
// out to the `pool` wallets). The rest are `pool` wallets that only pay fees.

import type { RouterSigner } from "../types.js";

/** A wallet's role: `main` is the single on-chain PaymentHook withdraw target
 *  (funds the pool); `pool` wallets pay tx fees alongside the main. */
export type WalletRole = "main" | "pool";

export type PoolWallet = {
  /** Stable identifier (from the `wallets:` config block). */
  id: string;
  role: WalletRole;
  /** Cardano signing key (seed or private key). */
  signer: RouterSigner;
  /** Bech32 address derived from the signer. */
  address: string;
};

/** Minimal view of a wallet UTxO the arbiter needs to allocate fee/collateral. */
export type WalletUtxo = {
  /** Out-reference `<txHash>#<index>`. */
  outRef: string;
  /** Lovelace held by the UTxO. */
  lovelace: bigint;
  /** True when the UTxO holds ONLY ADA (no native assets) — the only kind
   *  eligible for collateral and clean fee inputs. */
  hasOnlyAda: boolean;
};

export type WalletPool = {
  /** All wallets, in declaration order. */
  all(): PoolWallet[];
  /** Resolve a wallet by id. */
  get(id: string): PoolWallet | undefined;
  /** The single main wallet (the on-chain PaymentHook withdraw target). */
  main(): PoolWallet;
  /** Replace the cached UTxO set for a wallet (refreshed from chain / on release). */
  setUtxos(walletId: string, utxos: WalletUtxo[]): void;
  /** The last-known UTxO set for a wallet (empty until first `setUtxos`). */
  getUtxos(walletId: string): WalletUtxo[];
  /** Mark a wallet as mid-consolidation (so the arbiter skips it as unusable). */
  setConsolidating(walletId: string, on: boolean): void;
  /** Whether a wallet is currently consolidating. */
  isConsolidating(walletId: string): boolean;
};

export function createWalletPool(wallets: PoolWallet[]): WalletPool {
  if (wallets.length === 0) {
    throw new Error("createWalletPool: the pool must declare at least one wallet.");
  }

  const byId = new Map<string, PoolWallet>();
  for (const w of wallets) {
    if (byId.has(w.id)) {
      throw new Error(`createWalletPool: duplicate wallet id "${w.id}".`);
    }
    byId.set(w.id, w);
  }

  const mains = wallets.filter((w) => w.role === "main");
  if (mains.length !== 1) {
    throw new Error(
      `createWalletPool: the pool must declare exactly one main wallet, found ${mains.length}.`,
    );
  }
  const mainWallet = mains[0]!;

  const utxoCache = new Map<string, WalletUtxo[]>();
  const consolidating = new Set<string>();

  return {
    all() {
      return wallets.slice();
    },
    get(id) {
      return byId.get(id);
    },
    main() {
      return mainWallet;
    },
    setUtxos(walletId, utxos) {
      utxoCache.set(walletId, utxos.slice());
    },
    getUtxos(walletId) {
      return utxoCache.get(walletId)?.slice() ?? [];
    },
    setConsolidating(walletId, on) {
      if (on) consolidating.add(walletId);
      else consolidating.delete(walletId);
    },
    isConsolidating(walletId) {
      return consolidating.has(walletId);
    },
  };
}
