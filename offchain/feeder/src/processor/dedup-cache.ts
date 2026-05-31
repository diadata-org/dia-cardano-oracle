// Deduplication cache keyed on `intentHash`.
//
// Three reasons the same intent may arrive twice:
//
//   1. HTTP scanner and WS scanner overlap during a transport
//      handover.
//   2. The WS scanner reconnects and replays a few blocks before the
//      HTTP catch-up kicks in.
//   3. A provider re-delivers a log it already emitted.
//
// The cache is in-memory only — it does not survive a restart. After
// a restart the checkpoint advances us past already-processed blocks,
// so duplicate delivery is bounded by the scanner's confirmation
// window. A DB-backed `processed_events` table is layered on top of
// this in-memory cache when persistence is wired in; the in-memory
// cache remains the hot path either way.
//
// Behavior:
//
//   - `add(hash)` returns `true` when this is the first time we see
//     the hash (caller should process it), `false` when it is a
//     duplicate (caller should skip).
//   - An optional `composite` argument adds a secondary key
//     `symbol:signer:timestamp` for replay protection when different
//     intents share the same (symbol, signer, timestamp) triple.
//   - Entries expire after `ttlMs` or when the cache exceeds
//     `capacity`, whichever happens first.
//   - The eviction policy is LRU by insertion order; a Map's iterator
//     order is the insertion order, so removing the oldest key is O(1).

export type DedupCacheOptions = {
  /** Maximum number of entries to retain. Older entries are evicted in
   *  insertion order once the cache is full. */
  capacity: number;
  /** Time-to-live per entry, in milliseconds. `0` disables TTL. */
  ttlMs: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export type DedupCacheStats = {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
};

/** Public surface — `add` is the only operation the pipeline calls
 *  during the hot path. Stats are exposed for `/metrics`. */
export type DedupCache = {
  /**
   * `true` when neither `intentHash` nor the composite key (when provided)
   * was previously seen, and the entry was inserted.
   * `false` when either key was already present (a duplicate).
   *
   * @param intentHash  Primary dedup key — fast-path short-circuit.
   * @param composite   Optional secondary key `(symbol, signer, timestamp)`
   *                    for replay protection across different intent hashes.
   */
  add(intentHash: string, composite?: { symbol: string; signer: string; timestamp: bigint }): boolean;
  /** Inspect without mutating. */
  has(intentHash: string): boolean;
  size(): number;
  stats(): DedupCacheStats;
  clear(): void;
};

/**
 * Build a cache instance with the given capacity and TTL.
 *
 * The implementation uses `Map<string, number>` where the value is the
 * insertion timestamp; the Map's insertion-order iteration gives us
 * O(1) LRU eviction.
 *
 * When `composite` keys are provided to `add`, a second entry with key
 * `symbol:signer:timestamp_string` is stored alongside the intentHash entry,
 * pointing to the same insertion time.
 */
export function createDedupCache(options: DedupCacheOptions): DedupCache {
  if (options.capacity <= 0) {
    throw new Error(`DedupCache capacity must be > 0 (got ${options.capacity}).`);
  }
  if (options.ttlMs < 0) {
    throw new Error(`DedupCache ttlMs must be >= 0 (got ${options.ttlMs}).`);
  }

  const entries = new Map<string, number>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs;
  const capacity = options.capacity;
  const counters = { hits: 0, misses: 0, evictions: 0 };

  function compositeKey(symbol: string, signer: string, timestamp: bigint): string {
    return `${symbol}:${signer}:${timestamp.toString()}`;
  }

  return {
    add(intentHash, composite) {
      sweepExpired();

      // Primary key check.
      if (entries.has(intentHash)) {
        counters.hits += 1;
        return false;
      }

      // Secondary composite key check — guards against replay with a
      // different intentHash but identical (symbol, signer, timestamp).
      if (composite !== undefined) {
        const ck = compositeKey(composite.symbol, composite.signer, composite.timestamp);
        if (entries.has(ck)) {
          counters.hits += 1;
          return false;
        }
      }

      // Insert both keys at the same timestamp so they age together.
      const insertedAt = now();
      if (entries.size >= capacity) {
        evictOldest();
      }
      entries.set(intentHash, insertedAt);

      if (composite !== undefined) {
        if (entries.size >= capacity) {
          evictOldest();
        }
        const ck = compositeKey(composite.symbol, composite.signer, composite.timestamp);
        entries.set(ck, insertedAt);
      }

      counters.misses += 1;
      return true;
    },

    has(intentHash) {
      sweepExpired();
      return entries.has(intentHash);
    },

    size() {
      return entries.size;
    },

    stats() {
      return { size: entries.size, ...counters };
    },

    clear() {
      entries.clear();
      counters.hits = 0;
      counters.misses = 0;
      counters.evictions = 0;
    },
  };

  function evictOldest(): void {
    const firstKey = entries.keys().next().value;
    if (firstKey !== undefined) {
      entries.delete(firstKey);
      counters.evictions += 1;
    }
  }

  function sweepExpired(): void {
    if (ttlMs <= 0) return;
    const cutoff = now() - ttlMs;
    for (const [key, insertedAt] of entries) {
      if (insertedAt < cutoff) {
        entries.delete(key);
        counters.evictions += 1;
      } else {
        // Map iterates in insertion order; everything after this point
        // is newer than the cutoff.
        return;
      }
    }
  }
}
