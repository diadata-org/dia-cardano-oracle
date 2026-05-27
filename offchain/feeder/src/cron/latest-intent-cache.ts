// Latest-seen intent cache — Spectra parity for the cron service.
//
// Purpose: hold the most recent fully-enriched intent the feeder has
// observed for each `(routerId, destinationIndex, symbol)` triple,
// regardless of whether the router policy ultimately submitted it
// on-chain. The cron service uses this cache to re-submit the latest
// known intent when the on-chain pair has gone stale beyond
// `time_threshold` (router destination YAML).
//
// Why a separate cache (not the existing `priceCache`):
//   - `priceCache` is updated only AFTER a Cardano confirm and is
//     consumed by `/api/v1/prices` — its semantics are "what's on chain".
//   - This cache is updated on EVERY enriched intent the daemon sees,
//     before policy filtering — its semantics are "newest known by the
//     feeder", which is exactly what the cron service needs to re-submit
//     when an event was dropped by the deviation filter but the pair has
//     since gone stale.
//
// Spectra equivalent: the `priceCache` in `internal/processor/` is
// updated on every enriched intent in `generic_event_processor.go:519`
// and consumed by `internal/cron/cron_service.go`.
//
// Storage: in-memory `Map`. The feeder restarts on crash and the
// pipeline re-fills the cache as soon as new events arrive; there is no
// need for disk persistence.

import type { EnrichedIntent } from "../source/types.js";

export type LatestIntentKey = {
  routerId: string;
  destinationIndex: number;
  symbol: string;
};

export type LatestIntentEntry = {
  /** Identifies which router+destination pair observed this intent. */
  routerId: string;
  destinationIndex: number;
  /** Normalised symbol string. */
  symbol: string;
  /** The fully-enriched intent. Carries the full DIA OracleIntent and
   *  signature so the cron service can build a `SubmitRequest` without
   *  hitting the source chain again. */
  enriched: EnrichedIntent;
  /** EVM intent hash for correlation in logs. */
  intentHash: string;
  /** Wall-clock time the entry was last written (ms since epoch). */
  observedAtMs: number;
};

export type LatestIntentCache = {
  set(key: LatestIntentKey, entry: Omit<LatestIntentEntry, "observedAtMs">): void;
  get(key: LatestIntentKey): LatestIntentEntry | undefined;
  /** Iterate every entry currently held. Used by the cron service tick. */
  entries(): IterableIterator<[LatestIntentKey, LatestIntentEntry]>;
  size(): number;
};

function cacheKey(key: LatestIntentKey): string {
  return `${key.routerId}:${key.destinationIndex}:${key.symbol}`;
}

export function createLatestIntentCache(
  options: { now?: () => number } = {},
): LatestIntentCache {
  const now = options.now ?? Date.now;
  const store = new Map<string, LatestIntentEntry>();

  return {
    set(key, entry) {
      store.set(cacheKey(key), { ...entry, observedAtMs: now() });
    },
    get(key) {
      return store.get(cacheKey(key));
    },
    *entries() {
      for (const [rawKey, entry] of store) {
        const [routerId, destIdx, ...symbolParts] = rawKey.split(":");
        yield [
          { routerId, destinationIndex: Number(destIdx), symbol: symbolParts.join(":") },
          entry,
        ] as [LatestIntentKey, LatestIntentEntry];
      }
    },
    size() {
      return store.size;
    },
  };
}
