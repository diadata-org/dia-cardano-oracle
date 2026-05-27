// Price API builders.
//
// The feeder keeps the latest confirmed price in-memory keyed by
// `(routerId, destinationIndex, symbol)`. These helpers expose that
// cache through the API surface:
//
//   - `GET /api/v1/prices`
//   - `GET /api/v1/prices/:symbol`
//
// Spectra equivalent: `pkg/api/prices.go`.

import type { PriceCache } from "../processor/price-cache.js";

export type PriceEntry = {
  routerId: string;
  destinationIndex: number;
  symbol: string;
  price: string;
  timestamp: string;
  intentHash: string;
  cardanoTxHash?: string;
  confirmedAtDepth: number;
  updatedAtMs: number;
};

export type PricesResponse = {
  count: number;
  prices: PriceEntry[];
};

export type PriceResponse = {
  symbol: string;
  count: number;
  prices: PriceEntry[];
};

export function buildPricesResponse(cache: PriceCache): PricesResponse {
  const prices: PriceEntry[] = [];

  for (const [key, entry] of cache.entries()) {
    prices.push(toPriceEntry(key, entry));
  }

  // Stable order: routerId → destinationIndex → symbol.
  prices.sort((a, b) => {
    if (a.routerId !== b.routerId) return a.routerId.localeCompare(b.routerId);
    if (a.destinationIndex !== b.destinationIndex) return a.destinationIndex - b.destinationIndex;
    return a.symbol.localeCompare(b.symbol);
  });

  return { count: prices.length, prices };
}

export function buildPriceResponse(
  cache: PriceCache,
  symbol: string,
): PriceResponse | null {
  const prices: PriceEntry[] = [];
  for (const [key, entry] of cache.entries()) {
    if (key.symbol === symbol) {
      prices.push(toPriceEntry(key, entry));
    }
  }
  if (prices.length === 0) {
    return null;
  }
  prices.sort((a, b) => a.routerId.localeCompare(b.routerId) || a.destinationIndex - b.destinationIndex);
  return { symbol, count: prices.length, prices };
}

function toPriceEntry(
  key: { routerId: string; destinationIndex: number; symbol: string },
  entry: {
    price: bigint;
    timestamp: bigint;
    intentHash: string;
    cardanoTxHash?: string;
    confirmedAtDepth?: number;
    updatedAtMs: number;
  },
): PriceEntry {
  return {
    routerId: key.routerId,
    destinationIndex: key.destinationIndex,
    symbol: key.symbol,
    price: entry.price.toString(),
    timestamp: entry.timestamp.toString(),
    intentHash: entry.intentHash,
    cardanoTxHash: entry.cardanoTxHash,
    confirmedAtDepth: entry.confirmedAtDepth ?? 1,
    updatedAtMs: entry.updatedAtMs,
  };
}
