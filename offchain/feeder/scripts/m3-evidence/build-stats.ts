// Query the feeder SQLite DB for M3 evidence statistics.
//
// Usage (from offchain/feeder/):
//   node --import tsx/esm scripts/m3-evidence/build-stats.ts [<db-path>]
//
// Env vars:
//   DATABASE_PATH_TESTNET  Path to the SQLite database file. Overridden by first positional arg.
//
// Output:
//   Writes docs/milestones/evidence/m3-<network>-<timestamp>/stats.json
//   Prints the same JSON to stdout.

import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Configuration — database path from env or first CLI arg.
// DATABASE_PATH_TESTNET : path to the feeder SQLite DB
// ---------------------------------------------------------------------------
const dbPath = process.argv[2] ?? process.env["DATABASE_PATH_TESTNET"];
if (!dbPath) {
  process.stderr.write(
    "[build-stats] error: provide DB path as first argument or set DATABASE_PATH_TESTNET\n",
  );
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  process.stderr.write(`[build-stats] error: DB file not found: ${dbPath}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve output directory: docs/milestones/evidence/m3-<network>-<timestamp>/
// ---------------------------------------------------------------------------
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
// m3-evidence → scripts → feeder → offchain → repo root (4 levels up)
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
const STAMP = process.env["EVIDENCE_STAMP"]?.trim() || new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 14)
  .replace(/(\d{8})(\d{6})/, "$1-$2");
// Network goes in the evidence dir name (matches the M1 convention
// m1-<network>-<stamp>): CARDANO_NETWORK env wins, else infer from the DB
// path (.../mainnet/... vs .../preview/...), else default preview. Evidence
// lives under docs/milestones/evidence/ alongside the M1 packs.
const NETWORK = (
  process.env["CARDANO_NETWORK"]?.trim().toLowerCase() ||
  (String(dbPath).includes("mainnet") ? "mainnet" : "preview")
);
const OUT_DIR = path.join(REPO_ROOT, "docs", "milestones", "evidence", `m3-${NETWORK}-${STAMP}`);
const OUT_FILE = path.join(OUT_DIR, "stats.json");

// ---------------------------------------------------------------------------
// Row types for the aggregation queries
// ---------------------------------------------------------------------------

type StatusCountRow = { status: string; count: number };
type SingleNumberRow = { value: number | null };
type TimeWindowRow = { min_ms: number | null; max_ms: number | null };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const db = new Database(dbPath as string, { readonly: true, fileMustExist: true });

  let processedEventsByStatus: Record<string, number>;
  let transactionsByStatus: Record<string, number>;
  let totalSymbols: number;
  let totalPairsUpdated: number;
  let totalFeePaidLovelace: string;
  let timeWindow: { minMs: number | null; maxMs: number | null };

  try {
    // 1. processed_events by status
    const peRows = db.prepare(
      "SELECT status, COUNT(*) AS count FROM processed_events GROUP BY status",
    ).all() as StatusCountRow[];
    processedEventsByStatus = Object.fromEntries(peRows.map((r) => [r.status, Number(r.count)]));

    // 2. transaction_log by status
    const tlRows = db.prepare(
      "SELECT status, COUNT(*) AS count FROM transaction_log GROUP BY status",
    ).all() as StatusCountRow[];
    transactionsByStatus = Object.fromEntries(tlRows.map((r) => [r.status, Number(r.count)]));

    // 3. distinct symbols in contract_symbol_updates
    const symRow = db.prepare(
      "SELECT COUNT(DISTINCT symbol) AS value FROM contract_symbol_updates",
    ).get() as SingleNumberRow;
    totalSymbols = Number(symRow.value ?? 0);

    // 4. pairs with at least one confirmed update
    const pairsRow = db.prepare(
      "SELECT COUNT(*) AS value FROM contract_symbol_updates WHERE update_count > 0",
    ).get() as SingleNumberRow;
    totalPairsUpdated = Number(pairsRow.value ?? 0);

    // 5. total fee paid for confirmed transactions
    const feeRow = db.prepare(
      "SELECT SUM(CAST(fee_paid_lovelace AS INTEGER)) AS value FROM transaction_log WHERE status = 'confirmed'",
    ).get() as SingleNumberRow;
    totalFeePaidLovelace = String(feeRow.value ?? 0);

    // 6. time window from transaction_log
    const windowRow = db.prepare(
      "SELECT MIN(created_at_ms) AS min_ms, MAX(created_at_ms) AS max_ms FROM transaction_log",
    ).get() as TimeWindowRow;
    timeWindow = { minMs: windowRow.min_ms ?? null, maxMs: windowRow.max_ms ?? null };
  } finally {
    db.close();
  }

  const stats = {
    generatedAtMs: Date.now(),
    generatedAt: new Date().toISOString(),
    processedEventsByStatus,
    transactionsByStatus,
    totalSymbols,
    totalPairsUpdated,
    totalFeePaidLovelace,
    timeWindow: {
      firstTxMs: timeWindow.minMs,
      lastTxMs: timeWindow.maxMs,
      firstTxIso: timeWindow.minMs ? new Date(timeWindow.minMs).toISOString() : null,
      lastTxIso: timeWindow.maxMs ? new Date(timeWindow.maxMs).toISOString() : null,
    },
  };

  // Write JSON.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(stats, null, 2) + "\n", "utf8");
  process.stderr.write(`[build-stats] wrote ${OUT_FILE}\n`);

  // Print JSON to stdout.
  process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
}

main();
