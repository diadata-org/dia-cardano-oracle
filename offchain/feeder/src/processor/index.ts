// Public surface of the event-processor subsystem.

export {
  createDedupCache,
  type DedupCache,
  type DedupCacheOptions,
  type DedupCacheStats,
} from "./dedup-cache.js";

export {
  createPriceCache,
  type PriceCache,
  type PriceCacheEntry,
  type PriceCacheKey,
} from "./price-cache.js";

export {
  createEventWorkerPool,
  type EventWorkerPool,
  type EventWorkerPoolOptions,
  type EventWorkerStats,
} from "./event-worker-pool.js";
