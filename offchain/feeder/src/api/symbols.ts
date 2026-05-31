import type { ModularConfig } from "../config/types.js";
import type { Db, TransactionViewRow } from "../persistence/index.js";
import { extractRouterSymbols } from "../router/symbols.js";

export type SymbolsResponse = {
  symbols: string[];
};

export type SymbolUpdateEntry = {
  intentHash: string;
  cardanoTxHash: string;
  routerId: string;
  destinationIndex: number;
  destinationChainName: string;
  destinationContractAddress: string;
  symbol: string;
  price: string;
  timestamp: number;
  status: "pending" | "submitted" | "confirmed" | "failed";
  errorMessage?: string;
  retryCount: number;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  createdAtMs: number;
};

export type SymbolUpdatesResponse = {
  symbol: string;
  count: number;
  updates: SymbolUpdateEntry[];
};

export function buildSymbolsResponse(config: ModularConfig): SymbolsResponse {
  const symbols = Array.from(extractConfiguredSymbols(config)).sort((a, b) => a.localeCompare(b));
  return { symbols };
}

export async function buildSymbolUpdatesResponse(
  db: Db,
  symbol: string,
  limit: number,
): Promise<SymbolUpdatesResponse> {
  const rows = await db.listSymbolUpdates(symbol, limit);
  return {
    symbol,
    count: rows.length,
    updates: rows.map(toSymbolUpdateEntry),
  };
}

export function extractConfiguredSymbols(config: ModularConfig): Set<string> {
  const out = new Set<string>();
  for (const router of Object.values(config.routers)) {
    for (const symbol of extractRouterSymbols(router)) {
      out.add(symbol);
    }
  }
  return out;
}

function toSymbolUpdateEntry(row: TransactionViewRow): SymbolUpdateEntry {
  return {
    intentHash: row.intentHash,
    cardanoTxHash: row.cardanoTxHash,
    routerId: row.routerId,
    destinationIndex: row.destinationIndex,
    destinationChainName: row.destinationChainName,
    destinationContractAddress: row.destinationContractAddress,
    symbol: row.symbol,
    price: row.price,
    timestamp: row.timestamp,
    status: row.status,
    errorMessage: row.errorMessage,
    retryCount: row.retryCount,
    submittedAtMs: row.submittedAtMs,
    confirmedAtMs: row.confirmedAtMs,
    createdAtMs: row.createdAtMs,
  };
}
