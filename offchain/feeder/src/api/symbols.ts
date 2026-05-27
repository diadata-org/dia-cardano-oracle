import type { ModularConfig } from "../config/types.js";
import type { Db, TransactionViewRow } from "../persistence/index.js";

export type SymbolsResponse = {
  symbols: string[];
};

export type SymbolUpdateEntry = {
  intentHash: string;
  sourceChainId: number;
  sourceBlockNumber: string;
  sourceTxHash: string;
  sourceLogIndex: number;
  symbol: string;
  price: string;
  timestamp: string;
  signer: string;
  processedAtMs: number;
  cardanoTxHash: string;
  routerId: string;
  destinationIndex: number;
  clientStatePath: string;
  status: "submitted" | "confirmed" | "failed";
  errorMessage?: string;
  submittedAtMs: number;
  confirmedAtMs?: number;
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
    for (const condition of router.triggers.conditions ?? []) {
      const field = normalizeField(condition.field);
      if (field !== "enrichment.fullIntent.Symbol" && field !== "enrichment.fullIntent.symbol") {
        continue;
      }

      if (condition.operator === "eq" && typeof condition.value === "string") {
        out.add(condition.value);
        continue;
      }

      if (condition.operator === "in" && Array.isArray(condition.value)) {
        for (const value of condition.value) {
          if (typeof value === "string") {
            out.add(value);
          }
        }
      }
    }
  }

  return out;
}

function normalizeField(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith("${") && trimmed.endsWith("}")
    ? trimmed.slice(2, -1).trim()
    : trimmed;
}

function toSymbolUpdateEntry(row: TransactionViewRow): SymbolUpdateEntry {
  return {
    intentHash: row.intentHash,
    sourceChainId: row.sourceChainId,
    sourceBlockNumber: row.sourceBlockNumber.toString(),
    sourceTxHash: row.sourceTxHash,
    sourceLogIndex: row.sourceLogIndex,
    symbol: row.symbol,
    price: row.price,
    timestamp: row.timestamp,
    signer: row.signer,
    processedAtMs: row.processedAtMs,
    cardanoTxHash: row.cardanoTxHash,
    routerId: row.routerId,
    destinationIndex: row.destinationIndex,
    clientStatePath: row.clientStatePath,
    status: row.status,
    errorMessage: row.errorMessage,
    submittedAtMs: row.submittedAtMs,
    confirmedAtMs: row.confirmedAtMs,
  };
}
