// Bucket failed transactions by error_code from the SQLite DB.
//
// Usage (from offchain/feeder/):
//   node --import tsx/esm scripts/m2-evidence/build-error-counts.ts [<db-path>]
//
// Env vars:
//   DATABASE_PATH_TESTNET  Path to the SQLite database file. Overridden by first positional arg.
//
// Output:
//   Writes docs/evidence/m2-<timestamp>/error-counts.tsv (error_code\tcount)
//   Prints JSON array to stdout: [{ "error_code": "...", "count": N }, ...]

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
    "[build-error-counts] error: provide DB path as first argument or set DATABASE_PATH_TESTNET\n",
  );
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  process.stderr.write(`[build-error-counts] error: DB file not found: ${dbPath}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve output directory: docs/evidence/m2-<timestamp>/
// ---------------------------------------------------------------------------
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
// scripts/m2-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..", "..");
const STAMP = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 15)
  .replace(/(\d{8})(\d{6})/, "$1-$2");
const OUT_DIR = path.join(REPO_ROOT, "docs", "evidence", `m2-${STAMP}`);
const OUT_FILE = path.join(OUT_DIR, "error-counts.tsv");

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

type ErrorCountRow = { error_code: string | null; count: number };

function main(): void {
  const db = new Database(dbPath as string, { readonly: true, fileMustExist: true });

  let rows: ErrorCountRow[];
  try {
    rows = db.prepare(
      `SELECT error_code, COUNT(*) AS count
       FROM transaction_log
       WHERE status = 'failed'
       GROUP BY error_code
       ORDER BY count DESC`,
    ).all() as ErrorCountRow[];
  } finally {
    db.close();
  }

  // Normalise null error_code to empty string for TSV output.
  const normalised = rows.map((r) => ({
    error_code: r.error_code ?? "",
    count: Number(r.count),
  }));

  // Write TSV.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tsvLines = ["error_code\tcount", ...normalised.map((r) => `${r.error_code}\t${r.count}`)];
  fs.writeFileSync(OUT_FILE, tsvLines.join("\n") + "\n", "utf8");
  process.stderr.write(`[build-error-counts] wrote ${OUT_FILE}\n`);

  // Print JSON to stdout.
  process.stdout.write(JSON.stringify(normalised, null, 2) + "\n");
}

main();
