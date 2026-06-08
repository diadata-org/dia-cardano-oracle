import { readdirSync } from "node:fs";
import path from "node:path";

export type CardanoNetworkName = "Preview" | "Mainnet";

/** Root that holds all per-network / per-run state dirs. */
export const STATE_ROOT = "../state";

/** The `<network>_run_` prefix for a network's run directories. */
export function runDirPrefix(network: CardanoNetworkName | string): string {
  return `${network.toLowerCase()}_run_`;
}

/**
 * Resolve the active per-run state directory.
 *
 * Selection order:
 * 1. `RUN_ID` env set -> `<stateRoot>/<network>_run_<RUN_ID>/`
 * 2. else newest existing `<stateRoot>/<network>_run_*`
 * 3. else legacy flat fallback -> `<stateRoot>/<network>/`
 */
export function resolveRunStateDir(
  network: CardanoNetworkName | string,
  stateRoot = STATE_ROOT,
): string {
  const tag = network.toLowerCase();
  const runId = process.env.RUN_ID?.trim();
  if (runId) {
    return path.join(stateRoot, `${tag}_run_${runId}`);
  }

  const latest = latestRunDir(network, stateRoot);
  if (latest) {
    return latest;
  }

  return path.join(stateRoot, tag);
}

/**
 * Newest `<stateRoot>/<network>_run_*` directory, or null if none exist.
 * Run ids are UTC timestamps, so lexical sort equals chronological order.
 */
export function latestRunDir(
  network: CardanoNetworkName | string,
  stateRoot = STATE_ROOT,
): string | null {
  const prefix = runDirPrefix(network);
  try {
    const runs = readdirSync(stateRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
    const newest = runs[runs.length - 1];
    return newest ? path.join(stateRoot, newest) : null;
  } catch {
    return null;
  }
}
