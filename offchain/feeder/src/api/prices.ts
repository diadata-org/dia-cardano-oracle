// /prices handler.
//
// Returns the contents of the in-memory price cache keyed by
// (routerId, destinationIndex, symbol). Shape matches Spectra's /prices
// response: one entry per (clientId, symbol) with last price, timestamp,
// intentHash, and optional Cardano txHash.
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
  updatedAtMs: number;
};

export type PricesResponse = {
  count: number;
  prices: PriceEntry[];
};

export function buildPricesResponse(cache: PriceCache): PricesResponse {
  const prices: PriceEntry[] = [];

  for (const [key, entry] of cache.entries()) {
    prices.push({
      routerId: key.routerId,
      destinationIndex: key.destinationIndex,
      symbol: key.symbol,
      price: entry.price.toString(),
      timestamp: entry.timestamp.toString(),
      intentHash: entry.intentHash,
      cardanoTxHash: entry.cardanoTxHash,
      updatedAtMs: entry.updatedAtMs,
    });
  }

  // Stable order: routerId → destinationIndex → symbol.
  prices.sort((a, b) => {
    if (a.routerId !== b.routerId) return a.routerId.localeCompare(b.routerId);
    if (a.destinationIndex !== b.destinationIndex) return a.destinationIndex - b.destinationIndex;
    return a.symbol.localeCompare(b.symbol);
  });

  return { count: prices.length, prices };
}
