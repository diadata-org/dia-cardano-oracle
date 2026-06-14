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
//   2. `api/prices.ts` — the `/api/v1/prices` HTTP endpoint. Same cache,
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
  /** DIA OracleIntent nonce of the last confirmed update (bigint). Lets the
   *  cron skip resubmitting an intent whose nonce cannot beat the on-chain one
   *  (the contract requires strictly greater). Optional: absent on entries that
   *  predate nonce tracking. */
  nonce?: bigint;
  /** EVM intent hash (`0x…`) for correlation in logs and `/api/v1/prices`. */
  intentHash: string;
  /** Cardano tx hash once confirmed; `undefined` until then. */
  cardanoTxHash?: string;
  /** Block depth at which the feeder declared the Cardano tx confirmed. */
  confirmedAtDepth?: number;
  /** Wall-clock time the entry was last written (ms since epoch). */
  updatedAtMs: number;
  /** On-chain client deployment that owns this price (from the destination's
   *  client state path). Optional: absent on entries that predate identity
   *  tracking; the production write paths always set it. */
  clientId?: string;
  /** Customer that owns the router (router config's `customer_id`). */
  customerId?: string;
  /** Network the destination lives on (`Preview` / `Mainnet`). */
  network?: string;
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
  /** All entries, for the `/api/v1/prices` API. Returns a snapshot array. */
  all(): PriceCacheEntry[];
  /** All (key, entry) pairs — used by the `/api/v1/prices` endpoint. */
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
      store.set(cacheKey(key), {
        ...entry,
        updatedAtMs: entry.updatedAtMs > 0 ? entry.updatedAtMs : now(),
      });
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
