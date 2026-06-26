// UTxO lock table.
//
// Tracks individual wallet UTxOs reserved by an in-flight build/submit so two
// transactions drawing fee/collateral from the SAME signer wallet never select
// the same UTxO. A reservation locks one or more UTxOs under a shared
// `reservationId`; the lock is released when the tx confirms or fails.
//
// Mirrors `inflight.ts` (which locks a whole receiver UTxO per lane). This table
// is finer-grained — it locks individual wallet outRefs so PARALLEL lanes can
// share one wallet by using disjoint UTxOs, which is the whole point of the
// wallet pool. Locks are in-memory and keyed `${walletId}:${outRef}`, so a stale
// chain-provider UTxO view cannot cause a double-allocation within the process.

export type UtxoLockEntry = {
  /** Pool wallet that owns the UTxO. */
  walletId: string;
  /** UTxO out-reference (`<txHash>#<index>`) — the lock key within a wallet. */
  outRef: string;
  /** Groups every outRef locked together for one build, so a single
   *  `releaseReservation` frees them all. */
  reservationId: string;
  /** Wall-clock time the lock was created (ms since epoch). */
  createdAtMs: number;
  /** Timeout after which a lock is considered stuck and is released
   *  (ms since epoch). */
  timeoutAtMs: number;
};

export type UtxoLockTable = {
  /** Lock one wallet UTxO under a reservation. */
  lock(entry: UtxoLockEntry): void;
  /** True if a non-expired lock exists for `(walletId, outRef)`. */
  isLocked(walletId: string, outRef: string): boolean;
  /** The set of currently-locked outRefs for a wallet (expired locks excluded). */
  lockedOutRefs(walletId: string): Set<string>;
  /** Release a single `(walletId, outRef)` lock. */
  release(walletId: string, outRef: string): void;
  /** Release every outRef locked under `reservationId` (call on confirm/fail). */
  releaseReservation(reservationId: string): void;
  /** All current locks (snapshot). */
  all(): UtxoLockEntry[];
  /** Expire locks whose `timeoutAtMs` has passed. Returns the count evicted. */
  evictExpired(): number;
};

export type UtxoLockTableOptions = {
  /** Injectable clock for tests. */
  now?: () => number;
};

function key(walletId: string, outRef: string): string {
  return `${walletId}:${outRef}`;
}

export function createUtxoLockTable(options: UtxoLockTableOptions = {}): UtxoLockTable {
  const clock = options.now ?? Date.now;

  // Keyed `${walletId}:${outRef}` for O(1) isLocked / release.
  const byKey = new Map<string, UtxoLockEntry>();

  function deleteEntry(entry: UtxoLockEntry): void {
    byKey.delete(key(entry.walletId, entry.outRef));
  }

  return {
    lock(entry) {
      byKey.set(key(entry.walletId, entry.outRef), entry);
    },

    isLocked(walletId, outRef) {
      const entry = byKey.get(key(walletId, outRef));
      if (!entry) return false;
      if (clock() >= entry.timeoutAtMs) {
        deleteEntry(entry);
        return false;
      }
      return true;
    },

    lockedOutRefs(walletId) {
      const now = clock();
      const out = new Set<string>();
      for (const entry of byKey.values()) {
        if (entry.walletId !== walletId) continue;
        if (now >= entry.timeoutAtMs) {
          deleteEntry(entry);
          continue;
        }
        out.add(entry.outRef);
      }
      return out;
    },

    release(walletId, outRef) {
      byKey.delete(key(walletId, outRef));
    },

    releaseReservation(reservationId) {
      for (const entry of byKey.values()) {
        if (entry.reservationId === reservationId) {
          deleteEntry(entry);
        }
      }
    },

    all() {
      return Array.from(byKey.values());
    },

    evictExpired() {
      const now = clock();
      let count = 0;
      for (const entry of byKey.values()) {
        if (now >= entry.timeoutAtMs) {
          deleteEntry(entry);
          count++;
        }
      }
      return count;
    },
  };
}

/**
 * Build a `UtxoLockEntry`. `timeoutMs` is REQUIRED — sourced from the same
 * `infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms` the in-flight
 * table uses. No silent default, so a missing YAML key can never produce a
 * hardcoded lock duration.
 */
export function makeUtxoLockEntry(
  walletId: string,
  outRef: string,
  reservationId: string,
  options: { timeoutMs: number; now?: () => number },
): UtxoLockEntry {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(
      `makeUtxoLockEntry: timeoutMs must be a positive number, got ${options.timeoutMs}. ` +
        "Source: infrastructure.<network>.yaml::worker_pool.inflight_timeout_ms",
    );
  }
  const now = (options.now ?? Date.now)();
  return {
    walletId,
    outRef,
    reservationId,
    createdAtMs: now,
    timeoutAtMs: now + options.timeoutMs,
  };
}
