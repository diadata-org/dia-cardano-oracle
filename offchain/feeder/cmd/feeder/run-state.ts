// Per-run state directory resolution — mirrors the CLI's
// `cli/state/<network>_run_<id>/` layout so multiple deployments of the same
// network never clobber each other's feeder state (DB, logs, pair state).
//
// The CLI threads a run id (run-all-cli.sh `RUN_ID`, default a UTC timestamp)
// into every `--*-state` path. The feeder mirrors that with a single `RUN_ID`
// env honoured by the daemon and every state-touching sub-command, plus the
// `init` importers that materialise a run dir from the CLI state.
//
// Selection order:
//   1. `RUN_ID` env set        -> state/<network>_run_<RUN_ID>/
//   2. else newest existing    -> state/<network>_run_*  (lexically last; the
//                                 run id is a sortable UTC timestamp)
//   3. else (no run dirs yet)  -> state/<network>/        (flat pre-run layout)
//
// Step 3 keeps a feeder that was set up under the old flat layout working
// until it is migrated to a run dir (re-run `init`). DATABASE_PATH_<suffix>
// and FEEDER_LOG_DIR still override the derived paths when an operator wants
// to pin an explicit location.

import { readdirSync } from "node:fs";
import path from "node:path";

import type { CardanoNetwork } from "../../src/source/env.js";

/** Root that holds all per-network / per-run state dirs (relative to cwd). */
export const STATE_ROOT = "state";

/** The `<network>_run_` prefix for a network's run directories. */
export function runDirPrefix(network: CardanoNetwork): string {
  return `${network.toLowerCase()}_run_`;
}

/**
 * Resolve the active per-run state directory for `network`. See the file
 * header for the selection order (RUN_ID env → newest run dir → flat
 * fallback). Returns a path relative to cwd (e.g. `state/mainnet_run_2026…`).
 */
export function resolveRunStateDir(network: CardanoNetwork, stateRoot = STATE_ROOT): string {
  const tag = network.toLowerCase();
  const runId = process.env.RUN_ID?.trim();
  if (runId) {
    return path.join(stateRoot, `${tag}_run_${runId}`);
  }
  const latest = latestRunDir(network, stateRoot);
  if (latest) {
    return latest;
  }
  // Pre-run fallback: the original flat layout. Lets a not-yet-migrated
  // deployment keep running until `init` materialises a run dir.
  return path.join(stateRoot, tag);
}

/**
 * Newest `state/<network>_run_*` directory, or null if none exist. Run ids
 * are UTC timestamps, so lexical sort == chronological.
 */
export function latestRunDir(network: CardanoNetwork, stateRoot = STATE_ROOT): string | null {
  const prefix = runDirPrefix(network);
  try {
    const runs = readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
    const newest = runs[runs.length - 1];
    return newest ? path.join(stateRoot, newest) : null;
  } catch {
    // stateRoot does not exist yet.
    return null;
  }
}
