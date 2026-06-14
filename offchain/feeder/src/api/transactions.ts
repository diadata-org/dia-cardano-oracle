import type { Db, TransactionLogRow } from "../persistence/index.js";

export type TransactionUpdateEntry = {
  intentHash: string;
  routerId: string;
  clientId: string;
  customerId: string;
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
  /** One transaction is one lane = one on-chain client under one customer on
   *  one network. These identify the tx itself; per-router detail is in
   *  `routerIds` / `updates` (a batch can mix routers on the shared lane). */
  network: string;
  clientId: string;
  customerId: string;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  updateCount: number;
  /** Every distinct router that contributed an update to this transaction,
   *  sorted. A coalesced batch can mix routers that share one lane, so a tx is
   *  a list of routers, not a single one. Derived from `updates`. */
  routerIds: string[];
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

  const routerIds = [...new Set(updates.map((u) => u.routerId))].sort();

  return {
    txHash,
    status: first.status,
    network: first.destinationChainName,
    clientId: first.clientId,
    customerId: first.customerId,
    submittedAtMs: first.submittedAtMs,
    confirmedAtMs: first.confirmedAtMs,
    updateCount: updates.length,
    routerIds,
    updates,
  };
}

function toTransactionUpdateEntry(row: TransactionLogRow): TransactionUpdateEntry {
  return {
    intentHash: row.intentHash,
    routerId: row.routerId,
    clientId: row.clientId,
    customerId: row.customerId,
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
