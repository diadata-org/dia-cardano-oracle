// Price cache — last known (price, timestamp) per
// (routerId, destinationIndex, symbol) triple.
//
// Two consumers:
//
//   1. `router/policy.ts` — `time_threshold` and `price_deviation`
//      gating. Before sending an update the policy reads the cached
//      last price and timestamp for that (route, destination, symbol)
//      pair to decide whether the update is worth submitting.
//
//   2. `api/prices.ts` — the `/prices` HTTP endpoint. Same cache,
//      read-only from the API side.
//
// Spectra equivalent: `internal/processor/price_cache.go`
// (`DestinationState` keyed on `(routerId, destinationIndex, symbol)`).
//
// The key is a string concatenation for simple O(1) Map access:
//   "<routerId>:<destinationIndex>:<symbol>"
//
// Thread-safety: the feeder is single-threaded (async, no worker
// threads). No mutex is needed.

export type PriceCacheEntry = {
  /** Normalised symbol string from the enriched intent (e.g. "BTC/USD"). */
  symbol: string;
  /** Raw price from the `OracleIntent` (bigint, no decimals). */
  price: bigint;
  /** Intent timestamp (unix seconds, as bigint). */
  timestamp: bigint;
  /** EVM intent hash (`0x…`) for correlation in logs and `/prices`. */
  intentHash: string;
  /** Cardano tx hash once confirmed; `undefined` until then. */
  cardanoTxHash?: string;
  /** Wall-clock time the entry was last written (ms since epoch). */
  updatedAtMs: number;
};

export type PriceCacheKey = {
  routerId: string;
  destinationIndex: number;
  symbol: string;
};

/** Public surface of the price cache. */
export type PriceCache = {
  /** Record a new price. Overwrites any existing entry for the same key. */
  set(key: PriceCacheKey, entry: PriceCacheEntry): void;
  /** Retrieve the last recorded entry, or `undefined` if none. */
  get(key: PriceCacheKey): PriceCacheEntry | undefined;
  /** All entries, for the `/prices` API. Returns a snapshot array. */
  all(): PriceCacheEntry[];
  /** All (key, entry) pairs — used by the `/prices` endpoint. */
  entries(): IterableIterator<[PriceCacheKey, PriceCacheEntry]>;
  /** Total distinct keys recorded. */
  size(): number;
};

// ---------------------------------------------------------------------------
// Implementation.
// ---------------------------------------------------------------------------

function cacheKey(key: PriceCacheKey): string {
  return `${key.routerId}:${key.destinationIndex}:${key.symbol}`;
}

/**
 * Create an in-memory price cache. The optional `now` parameter
 * accepts a clock function so tests can control `updatedAtMs`.
 */
export function createPriceCache(options: { now?: () => number } = {}): PriceCache {
  const now = options.now ?? Date.now;
  const store = new Map<string, PriceCacheEntry>();

  return {
    set(key, entry) {
      store.set(cacheKey(key), { ...entry, updatedAtMs: now() });
    },

    get(key) {
      return store.get(cacheKey(key));
    },

    all() {
      return Array.from(store.values());
    },

    *entries() {
      for (const [rawKey, entry] of store) {
        const [routerId, destIdx, ...symbolParts] = rawKey.split(":");
        yield [
          { routerId, destinationIndex: Number(destIdx), symbol: symbolParts.join(":") },
          entry,
        ] as [PriceCacheKey, PriceCacheEntry];
      }
    },

    size() {
      return store.size;
    },
  };
}
