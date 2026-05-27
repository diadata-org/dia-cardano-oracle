import type { Db, TransactionViewRow } from "../persistence/index.js";

export type TransactionUpdateEntry = {
  intentHash: string;
  symbol: string;
  price: string;
  timestamp: string;
  signer: string;
  sourceChainId: number;
  sourceBlockNumber: string;
  sourceTxHash: string;
  sourceLogIndex: number;
  processedAtMs: number;
  routerId: string;
  destinationIndex: number;
  clientStatePath: string;
  status: "submitted" | "confirmed" | "failed";
  errorMessage?: string;
};

export type TransactionResponse = {
  txHash: string;
  status: "submitted" | "confirmed" | "failed";
  submittedAtMs: number;
  confirmedAtMs?: number;
  updateCount: number;
  updates: TransactionUpdateEntry[];
};

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
    symbol: row.symbol,
    price: row.price,
    timestamp: row.timestamp,
    signer: row.signer,
    sourceChainId: row.sourceChainId,
    sourceBlockNumber: row.sourceBlockNumber.toString(),
    sourceTxHash: row.sourceTxHash,
    sourceLogIndex: row.sourceLogIndex,
    processedAtMs: row.processedAtMs,
    routerId: row.routerId,
    destinationIndex: row.destinationIndex,
    clientStatePath: row.clientStatePath,
    status: row.status,
    errorMessage: row.errorMessage,
  };
}
