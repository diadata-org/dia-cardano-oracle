// Scanner checkpoint persistence.
//
// The `Checkpoint` interface abstracts over the storage backend so the
// scanner does not care whether the high-water mark lives in a JSON
// file, a SQLite table, or a Postgres row. This file ships the
// JSON-file backend; additional backends are added by implementing
// the same interface.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CardanoNetwork } from "./env.js";

/** Storage abstraction. The scanner only sees this interface; the
 *  concrete backend is selected by the caller. */
export type Checkpoint = {
  /** Last block whose `IntentRegistered` logs have been fully processed. */
  load(): Promise<bigint | null>;
  /** Atomically persist the new high-water mark. */
  save(blockNumber: bigint): Promise<void>;
};

export type JsonCheckpointOptions = {
  filePath: string;
};

/**
 * Build a `Checkpoint` backed by a single JSON file. The file holds
 * one record: `{ "last_processed_block": "<bigint-as-string>" }`. We
 * serialize the block number as a string to avoid the JSON `Number`
 * precision ceiling at 2^53.
 *
 * Writes are atomic (temp file + rename) so a crashed feeder never
 * leaves a half-written checkpoint behind.
 */
export function createJsonCheckpoint(options: JsonCheckpointOptions): Checkpoint {
  const filePath = path.resolve(options.filePath);
  const tempPath = `${filePath}.tmp`;

  return {
    async load(): Promise<bigint | null> {
      const content = await tryReadFile(filePath);
      if (content === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new Error(
          `Checkpoint file ${filePath} is not valid JSON: ${(error as Error).message}`,
        );
      }
      const value = (parsed as { last_processed_block?: unknown }).last_processed_block;
      if (value === undefined || value === null) return null;
      try {
        return BigInt(value as string | number | bigint);
      } catch {
        throw new Error(
          `Checkpoint file ${filePath} has an invalid \`last_processed_block\` value: ${JSON.stringify(value)}.`,
        );
      }
    },

    async save(blockNumber: bigint): Promise<void> {
      await mkdir(path.dirname(filePath), { recursive: true });
      const payload = JSON.stringify({ last_processed_block: blockNumber.toString() }, null, 2);
      await writeFile(tempPath, `${payload}\n`, "utf8");
      await rename(tempPath, filePath);
    },
  };
}

/**
 * Default checkpoint path for a given network. Lives under the same
 * `state/<network>/` tree the CLI uses for its on-chain artifacts so
 * everything related to one network sits together.
 */
export function defaultCheckpointPath(network: CardanoNetwork): string {
  const tag = network.toLowerCase();
  return path.join("state", tag, "feeder-checkpoint.json");
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
