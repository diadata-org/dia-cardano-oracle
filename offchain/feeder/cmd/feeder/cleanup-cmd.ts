// Cleanup command — removes stale feeder-generated state files.
//
// Removes files older than --max-age (default: 1h) from:
//
//   logs/intents/          Per-intent lifecycle files.
//   logs/feeder.log        Main line-oriented event stream.
//   logs/transactions.jsonl  Per-tx step events + summaries.
//   logs/lane.jsonl          Lane state events.
//   feeder.sqlite            Old rows pruned from processed_events and transaction_log.
//   feeder-checkpoint.json   Block-scanner position (if older than max-age).
//
// CLI bootstrap state files are never touched:
//   config-bootstrap.json, clients/<name>.json
//
// Usage:
//   feeder cleanup [--max-age <duration>] [--dry-run]
//
//   --max-age   e.g. 1h, 30m, 2h30m (default: 1h)
//   --dry-run   print what would be deleted without deleting

import { readdir, stat, unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { createDb, type DbConfig } from "../../src/persistence/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CleanupCmdOptions = {
  network: string;
  maxAgeMs: number;
  dryRun: boolean;
  dbConfig?: DbConfig;
  report: (line: string) => void;
};

type CleanupSummary = {
  intentFilesDeleted: number;
  intentFilesSkipped: number;
  logFilesRotated: number;
  dbRowsPruned: { processedEvents: number; transactionLog: number } | null;
  checkpointDeleted: boolean;
  errors: string[];
};

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

/**
 * Parse a human duration string like "1h", "30m", "2h30m", "90s" into ms.
 * Throws on unrecognised input.
 */
export function parseDuration(raw: string): number {
  const s = raw.trim().toLowerCase();
  const pattern = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = pattern.exec(s);
  if (!match || s === "") {
    throw new Error(
      `Invalid duration "${raw}". Expected format: 1h | 30m | 2h30m | 90s`,
    );
  }
  const hours   = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const ms = (hours * 3600 + minutes * 60 + seconds) * 1_000;
  if (ms === 0) {
    throw new Error(`Duration "${raw}" resolves to zero — must be positive.`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mtimeMs(filePath: string): Promise<number> {
  const s = await stat(filePath);
  return s.mtimeMs;
}

/**
 * Remove lines whose leading ISO timestamp is older than `cutoffMs`
 * from a line-oriented log file (feeder.log, *.jsonl).
 *
 * Lines without a recognisable timestamp are kept (header/noise lines).
 * If all lines would be removed the file is truncated to empty.
 */
async function rotateLineLog(
  filePath: string,
  cutoffMs: number,
  dryRun: boolean,
  report: (line: string) => void,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const kept = lines.filter((line) => {
    if (line === "") return false; // trailing newline
    // feeder.log: [2026-05-27T10:24:06.014Z] ...
    const m1 = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line);
    if (m1) return new Date(m1[1]!).getTime() >= cutoffMs;
    // *.jsonl: {"ts":"2026-05-27T10:24:06.014Z", ...}
    const m2 = /^\{"ts":"(\d{4}-\d{2}-\d{2}T[\d:.]+Z)"/.exec(line);
    if (m2) return new Date(m2[1]!).getTime() >= cutoffMs;
    return true; // keep unrecognised lines
  });

  const removed = lines.filter((l) => l !== "").length - kept.length;
  if (removed === 0) return false;

  report(
    `cleanup: ${dryRun ? "[dry-run] would rotate" : "rotating"} ${path.basename(filePath)} — removing ${removed} old line(s), keeping ${kept.length}`,
  );
  if (!dryRun) {
    const content = kept.length > 0 ? kept.join("\n") + "\n" : "";
    await writeFile(filePath, content, "utf8");
  }
  return true;
}

/**
 * Delete a file if it exists and its mtime is older than cutoffMs.
 */
async function deleteIfOld(
  filePath: string,
  cutoffMs: number,
  dryRun: boolean,
  report: (line: string) => void,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  const mtime = await mtimeMs(filePath);
  if (mtime >= cutoffMs) return false;

  report(
    `cleanup: ${dryRun ? "[dry-run] would delete" : "deleting"} ${path.basename(filePath)}`,
  );
  if (!dryRun) await unlink(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runCleanup(options: CleanupCmdOptions): Promise<number> {
  const { network, maxAgeMs, dryRun, report } = options;

  const stateBase  = `state/${network.toLowerCase()}`;
  const logDir     = process.env.FEEDER_LOG_DIR?.trim() ?? `${stateBase}/logs`;
  const intentsDir = path.join(logDir, "intents");
  const cutoffMs   = Date.now() - maxAgeMs;

  const summary: CleanupSummary = {
    intentFilesDeleted: 0,
    intentFilesSkipped: 0,
    logFilesRotated: 0,
    dbRowsPruned: null,
    checkpointDeleted: false,
    errors: [],
  };

  report(
    `cleanup: network=${network} max-age=${maxAgeMs / 1_000}s cutoff=${new Date(cutoffMs).toISOString()} dry-run=${dryRun}`,
  );

  // ------------------------------------------------------------------
  // 1. Per-intent files: intents/*.log
  // ------------------------------------------------------------------
  if (existsSync(intentsDir)) {
    let entries: string[];
    try {
      entries = await readdir(intentsDir);
    } catch (err) {
      summary.errors.push(`readdir(${intentsDir}): ${(err as Error).message}`);
      entries = [];
    }

    for (const name of entries) {
      if (!name.endsWith(".log")) continue;
      const filePath = path.join(intentsDir, name);
      try {
        const mtime = await mtimeMs(filePath);
        if (mtime < cutoffMs) {
          report(`cleanup: ${dryRun ? "[dry-run] would delete" : "deleting"} intents/${name}`);
          if (!dryRun) await unlink(filePath);
          summary.intentFilesDeleted++;
        } else {
          summary.intentFilesSkipped++;
        }
      } catch (err) {
        summary.errors.push(`intent ${name}: ${(err as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // 2. Line-oriented log files: rotate out old lines
  // ------------------------------------------------------------------
  const lineFiles = [
    path.join(logDir, "feeder.log"),
    path.join(logDir, "transactions.jsonl"),
    path.join(logDir, "lane.jsonl"),
  ];

  for (const filePath of lineFiles) {
    try {
      const rotated = await rotateLineLog(filePath, cutoffMs, dryRun, report);
      if (rotated) summary.logFilesRotated++;
    } catch (err) {
      summary.errors.push(`rotate ${path.basename(filePath)}: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // 3. Database — prune old rows (never deletes the DB file itself).
  //    processed_events: rows older than cutoffMs.
  //    transaction_log:  rows older than cutoffMs with status confirmed/failed.
  //    chain_state:      never touched.
  // ------------------------------------------------------------------
  const defaultDbPath = `${stateBase}/feeder.sqlite`;
  const dbConfig: DbConfig = options.dbConfig ?? {
    driver: (process.env.DATABASE_DRIVER?.trim() ?? "sqlite") as "sqlite" | "postgres",
    path: defaultDbPath,
    dsn: process.env[`DATABASE_DSN_${network === "Mainnet" ? "MAINNET" : "TESTNET"}`]?.trim(),
  };

  if (dryRun) {
    report(`cleanup: [dry-run] would prune DB rows older than ${new Date(cutoffMs).toISOString()} from processed_events and transaction_log (confirmed/failed only)`);
  } else {
    try {
      const db = await createDb(dbConfig);
      try {
        const pruned = await db.pruneOldRows(cutoffMs);
        summary.dbRowsPruned = pruned;
        report(
          `cleanup: pruned DB rows — processed_events=${pruned.processedEvents} transaction_log=${pruned.transactionLog}`,
        );
      } finally {
        await db.close();
      }
    } catch (err) {
      summary.errors.push(`db prune: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // 4. Checkpoint file
  // ------------------------------------------------------------------
  const checkpointPath = `${stateBase}/feeder-checkpoint.json`;
  try {
    summary.checkpointDeleted = await deleteIfOld(checkpointPath, cutoffMs, dryRun, report);
  } catch (err) {
    summary.errors.push(`checkpoint: ${(err as Error).message}`);
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const dbSummary = summary.dbRowsPruned
    ? `db_rows_pruned(processed_events=${summary.dbRowsPruned.processedEvents},transaction_log=${summary.dbRowsPruned.transactionLog})`
    : dryRun ? "db_rows_pruned=dry-run" : "db_rows_pruned=skipped";

  report(
    `cleanup: done — intent_files_deleted=${summary.intentFilesDeleted} ` +
    `intent_files_skipped=${summary.intentFilesSkipped} ` +
    `log_files_rotated=${summary.logFilesRotated} ` +
    `${dbSummary} ` +
    `checkpoint_deleted=${summary.checkpointDeleted}`,
  );

  if (summary.errors.length > 0) {
    for (const e of summary.errors) {
      report(`cleanup: [error] ${e}`);
    }
    return 1;
  }
  return 0;
}
