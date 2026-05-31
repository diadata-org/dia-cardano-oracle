import type { Db, TransactionLogRow, TransactionViewRow } from "../persistence/index.js";

export type TransactionUpdateEntry = {
  intentHash: string;
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
  createdAtMs: number;
};

export type TransactionResponse = {
  txHash: string;
  status: "pending" | "submitted" | "confirmed" | "failed";
  submittedAtMs?: number;
  confirmedAtMs?: number;
  updateCount: number;
  updates: TransactionUpdateEntry[];
};

export type TransactionsResponse = {
  count: number;
  transactions: TransactionLogRow[];
};

export function buildTransactionsResponse(rows: TransactionLogRow[]): TransactionsResponse {
  return { count: rows.length, transactions: rows };
}

export async function buildTransactionResponse(
  db: Db,
  txHash: string,
): Promise<TransactionResponse | null> {
  const rows = await db.getTransactionsByHash(txHash);
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0]!;
  const updates = rows
    .slice()
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.intentHash.localeCompare(b.intentHash))
    .map(toTransactionUpdateEntry);

  return {
    txHash,
    status: first.status,
    submittedAtMs: first.submittedAtMs,
    confirmedAtMs: first.confirmedAtMs,
    updateCount: updates.length,
    updates,
  };
}

function toTransactionUpdateEntry(row: TransactionViewRow): TransactionUpdateEntry {
  return {
    intentHash: row.intentHash,
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
    createdAtMs: row.createdAtMs,
  };
}
