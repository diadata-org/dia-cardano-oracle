// Wallet arbiter.
//
// Hands out a reservation (a wallet + a disjoint subset of its pure-ADA UTxOs)
// for one oracle-update build, so PARALLEL lanes never draw the same fee or
// collateral UTxO from a shared signer wallet. This is what lets cross-lane
// parallelism keep working even when several lanes share one wallet: each lane
// gets its own UTxOs.
//
// Selection priority (the operator-facing contract):
//   1. a FREE wallet (no active reservation), pool-role before main, LRU within;
//   2. else a BUSY wallet whose remaining unlocked UTxOs still cover a build;
//   3. else `{ unavailable: true }` — the lane retries shortly, no failed intent.
//
// The main wallet is preferred LAST so it stays free for funding the pool and
// receiving protocol-fee withdraws. Locks are in-process by `walletId:outRef`
// (see utxo-lock-table.ts), so a stale chain-provider UTxO view can never cause
// a double-allocation within the process.

import {
  MIN_COLLATERAL_UTXO_LOVELACE,
  RESERVED_UTXOS_PER_TX,
} from "../../config/constants.js";
import type { RouterSigner } from "../types.js";
import type { UtxoLockTable } from "./utxo-lock-table.js";
import { makeUtxoLockEntry } from "./utxo-lock-table.js";
import type { PoolWallet, WalletPool, WalletRole, WalletUtxo } from "./wallet-pool.js";

export type WalletReservation = {
  /** Unique id grouping this reservation's UTxO locks. */
  reservationId: string;
  /** Id of the reserved wallet (`PoolWallet.id`). */
  walletId: string;
  /** Role of the reserved wallet (`main` or `pool`). */
  role: WalletRole;
  /** Signing key to attach to Lucid (`selectWallet.fromSeed` / `fromPrivateKey`). */
  signer: RouterSigner;
  /** Bech32 address of the reserved wallet. */
  address: string;
  /** The reserved pure-ADA UTxOs; pass to `lucid.overrideUTxOs` so coin
   *  selection draws fee + collateral only from this set. */
  utxos: WalletUtxo[];
};

export type AcquireResult = WalletReservation | { unavailable: true };

/** Thrown at the build boundary when `acquire()` yields no wallet. Carries a
 *  stable `name` so the error classifier maps it to the retryable
 *  `WalletUnavailable` code without importing this class. */
export class WalletUnavailableError extends Error {
  constructor(message = "No signer wallet available to build the transaction.") {
    super(message);
    this.name = "WalletUnavailableError";
  }
}

export type WalletArbiter = {
  /** Reserve a wallet + UTxO subset for one build, or report none available. */
  acquire(): AcquireResult;
  /** Release a reservation once its tx confirms or fails. `consumedOutRefs` are
   *  removed from the wallet's cache and `producedUtxos` (the change) added, so
   *  the next acquire sees fresh UTxOs. */
  release(
    reservation: WalletReservation,
    settled: { consumedOutRefs: string[]; producedUtxos: WalletUtxo[] },
  ): void;
  /** Per-wallet snapshot for gauges. */
  stats(): { wallets: Array<{ walletId: string; reservations: number; spendableLovelace: bigint }> };
};

export type WalletArbiterDeps = {
  pool: WalletPool;
  lockTable: UtxoLockTable;
  /** UTxO-lock TTL — sourced from `worker_pool.inflight_timeout_ms`. */
  lockTtlMs: number;
  /** Override the per-tx reservation size (defaults to the structural constant). */
  reservedUtxosPerTx?: number;
  /** Override the collateral floor (defaults to the structural constant). */
  minCollateralLovelace?: bigint;
  /** Injectable clock for tests. */
  now?: () => number;
};

export function createWalletArbiter(deps: WalletArbiterDeps): WalletArbiter {
  const { pool, lockTable } = deps;
  const clock = deps.now ?? Date.now;
  const reservedPerTx = deps.reservedUtxosPerTx ?? RESERVED_UTXOS_PER_TX;
  const minCollateral = deps.minCollateralLovelace ?? MIN_COLLATERAL_UTXO_LOVELACE;

  /** Active reservations per wallet (a wallet is free at 0). */
  const activeReservations = new Map<string, number>();
  /** Reservation ids currently outstanding — guards against a double release. */
  const liveReservations = new Set<string>();
  /** Acquire sequence stamp per wallet, for least-recently-used fairness. */
  const lastUsedSeq = new Map<string, number>();
  let seq = 0;

  /** Spendable pure-ADA UTxOs of a wallet (those still free of an active lock). */
  function spendable(walletId: string): WalletUtxo[] {
    return pool
      .getUtxos(walletId)
      .filter((u) => u.hasOnlyAda && !lockTable.isLocked(walletId, u.outRef));
  }

  function isUsable(w: PoolWallet): boolean {
    if (pool.isConsolidating(w.id)) return false;
    const free = spendable(w.id);
    if (free.length < reservedPerTx) return false;
    return free.some((u) => u.lovelace >= minCollateral);
  }

  function isFree(walletId: string): boolean {
    return (activeReservations.get(walletId) ?? 0) === 0;
  }

  /** Free-first, then pool-role-first, then least-recently-used. */
  function chooseWallet(): PoolWallet | undefined {
    const usable = pool.all().filter(isUsable);
    if (usable.length === 0) return undefined;
    usable.sort((a, b) => {
      const freeRank = (isFree(a.id) ? 0 : 1) - (isFree(b.id) ? 0 : 1);
      if (freeRank !== 0) return freeRank;
      const roleRank = (a.role === "pool" ? 0 : 1) - (b.role === "pool" ? 0 : 1);
      if (roleRank !== 0) return roleRank;
      return (lastUsedSeq.get(a.id) ?? 0) - (lastUsedSeq.get(b.id) ?? 0);
    });
    return usable[0];
  }

  /** Pick `reservedPerTx` UTxOs from `free`, guaranteeing one collateral-capable
   *  input. Collateral takes the smallest eligible UTxO; the rest cover the fee. */
  function pickUtxos(free: WalletUtxo[]): WalletUtxo[] {
    const byLovelaceAsc = [...free].sort((a, b) =>
      a.lovelace < b.lovelace ? -1 : a.lovelace > b.lovelace ? 1 : 0,
    );
    const collateral = byLovelaceAsc.find((u) => u.lovelace >= minCollateral);
    if (!collateral) {
      // Unreachable via acquire() (chooseWallet only returns usable wallets);
      // guarded so a future caller gets a clear error instead of a crash.
      throw new Error("pickUtxos: no collateral-capable UTxO in the candidate set.");
    }
    const rest = byLovelaceAsc
      .filter((u) => u.outRef !== collateral.outRef)
      .reverse() // largest first, for fee coverage
      .slice(0, reservedPerTx - 1);
    return [collateral, ...rest];
  }

  return {
    acquire() {
      const w = chooseWallet();
      if (!w) return { unavailable: true };

      const reservationId = `res-${(seq += 1)}`;
      const reserved = pickUtxos(spendable(w.id));
      for (const u of reserved) {
        lockTable.lock(
          makeUtxoLockEntry(w.id, u.outRef, reservationId, {
            timeoutMs: deps.lockTtlMs,
            now: clock,
          }),
        );
      }
      activeReservations.set(w.id, (activeReservations.get(w.id) ?? 0) + 1);
      liveReservations.add(reservationId);
      lastUsedSeq.set(w.id, seq);

      return {
        reservationId,
        walletId: w.id,
        role: w.role,
        signer: w.signer,
        address: w.address,
        utxos: reserved,
      };
    },

    release(reservation, settled) {
      // A reservation releases exactly once; a repeat call is a safe no-op so a
      // double release can never under-count the wallet's active reservations.
      if (!liveReservations.delete(reservation.reservationId)) return;

      lockTable.releaseReservation(reservation.reservationId);
      const active = activeReservations.get(reservation.walletId) ?? 0;
      activeReservations.set(reservation.walletId, Math.max(0, active - 1));

      // Refresh the cache: drop consumed inputs, add the produced change, and
      // dedupe by outRef so a repeated outRef counts once toward liquidity.
      const consumed = new Set(settled.consumedOutRefs);
      const byOutRef = new Map<string, WalletUtxo>();
      for (const u of pool.getUtxos(reservation.walletId)) {
        if (!consumed.has(u.outRef)) byOutRef.set(u.outRef, u);
      }
      for (const u of settled.producedUtxos) byOutRef.set(u.outRef, u);
      pool.setUtxos(reservation.walletId, Array.from(byOutRef.values()));
    },

    stats() {
      return {
        wallets: pool.all().map((w) => ({
          walletId: w.id,
          reservations: activeReservations.get(w.id) ?? 0,
          spendableLovelace: spendable(w.id).reduce((acc, u) => acc + u.lovelace, 0n),
        })),
      };
    },
  };
}
