// DB-backed checkpoint — drop-in replacement for the JSON-file checkpoint.
// Implements the same Checkpoint interface (load/save) but reads/writes
// chain_state.last_scan_block via the Db interface.

import type { Checkpoint } from "./checkpoint.js";
import type { Db } from "../persistence/db.js";

export type DbCheckpointOptions = {
  db: Db;
  chainId: number;
  contractId: string;
};

export function createDbCheckpoint(options: DbCheckpointOptions): Checkpoint {
  return {
    async load() {
      const row = await options.db.getChainState(options.chainId, options.contractId);
      return row ? row.lastScanBlock : null;
    },
    async save(block) {
      await options.db.setLastScanBlock(options.chainId, options.contractId, block);
    },
  };
}
