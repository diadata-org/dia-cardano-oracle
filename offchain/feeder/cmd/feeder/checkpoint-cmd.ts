// Checkpoint sub-command — read or set the block-scanner checkpoint.
//
// Usage:
//   feeder checkpoint set --from-latest
//   feeder checkpoint set --from-block <N>
//   feeder checkpoint get
//   feeder checkpoint set --clear
//
// The checkpoint is stored in chain_state.last_scan_block in the DB.
// It is safe to run while the daemon is stopped; running it while the
// daemon is live will cause the daemon to ignore the change (it only
// reads the checkpoint on startup).

import { createPublicClient, http } from "viem";
import {
  resolveSourceFromConfig,
} from "../../src/source/index.js";
import { loadModularConfig } from "../../src/config/index.js";
import { createDb, type DbConfig } from "../../src/persistence/index.js";
import { createDbCheckpoint } from "../../src/source/checkpoint-db.js";
import type { CardanoNetwork } from "../../src/source/env.js";
import path from "node:path";
import { resolveRunStateDir } from "@diadata-org/dia-cardano-oracle-cli/core/run-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckpointSubCommand = "set" | "get";

export type CheckpointCmdOptions = {
  network: CardanoNetwork;
  subCommand: CheckpointSubCommand;
  configPath: string;
  /** --from-block <N>: set checkpoint to N-1 (scanner will start from N). */
  fromBlock?: string;
  /** --from-latest: query the chain tip and set checkpoint to that block. */
  fromLatest: boolean;
  /** --clear: reset the checkpoint to 0 (scanner will start from block 0). */
  clear?: boolean;
  report: (line: string) => void;
};

// ---------------------------------------------------------------------------
// DB config helper (mirrors daemon-cmd.ts resolveDbConfig)
// ---------------------------------------------------------------------------

function resolveDbConfig(network: CardanoNetwork): DbConfig {
  const driver = (process.env.DATABASE_DRIVER?.trim() ?? "sqlite") as "sqlite" | "postgres";
  const suffix = network === "Mainnet" ? "MAINNET" : "TESTNET";

  if (driver === "postgres") {
    const dsn = process.env[`DATABASE_DSN_${suffix}`]?.trim();
    if (!dsn) {
      throw new Error(
        `DATABASE_DSN_${suffix} is required when DATABASE_DRIVER=postgres.`,
      );
    }
    return { driver: "postgres", dsn };
  }

  const defaultPath = path.join(resolveRunStateDir(network), "feeder.sqlite");
  const filePath = process.env[`DATABASE_PATH_${suffix}`]?.trim() ?? defaultPath;
  return { driver: "sqlite", path: filePath };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runCheckpoint(options: CheckpointCmdOptions): Promise<number> {
  const { network, subCommand, configPath, report } = options;

  // Load config + resolve source to get chainId and registryContractId.
  report(`checkpoint: loading config at ${configPath} for network=${network}`);
  let chainId: number;
  let contractId: string;
  let rpcUrl: string;
  try {
    const config = await loadModularConfig({ baseDir: configPath, network });
    const source = resolveSourceFromConfig(config);
    chainId = source.chainId;
    contractId = source.registryContractId;
    rpcUrl = source.rpcUrls[0]!;
  } catch (err) {
    report(`checkpoint: config load failed — ${(err as Error).message}`);
    return 1;
  }

  // Open DB and create the checkpoint backed by chain_state.last_scan_block.
  // Mirror daemon-cmd.ts:367-373 so the chain_state row exists before we try
  // to read/write it — the underlying setLastScanBlock is UPDATE-only and
  // would silently no-op on a missing row otherwise.
  const dbConfig = resolveDbConfig(network);
  const db = await createDb(dbConfig);
  try {
    await db.migrate();
    await db.initialiseChainState({
      chainId,
      chainName: network,
      contractId,
    });
    const checkpoint = createDbCheckpoint({ db, chainId, contractId });

    // ------------------------------------------------------------------
    // get — print the current value and exit
    // ------------------------------------------------------------------
    if (subCommand === "get") {
      const block = await checkpoint.load();
      if (block === null) {
        report(`checkpoint: no DB row found for chain_id=${chainId} contract_id=${contractId}`);
        report(`checkpoint: daemon will start from YAML start_block (or block 0)`);
      } else {
        report(`checkpoint: last_scan_block=${block} (scanner will start from block ${block + 1n})`);
        report(`checkpoint: driver=${dbConfig.driver} chain_id=${chainId} contract_id=${contractId}`);
      }
      return 0;
    }

    // ------------------------------------------------------------------
    // set — requires --from-block, --from-latest, or --clear
    // ------------------------------------------------------------------
    if (!options.fromLatest && options.fromBlock === undefined && !options.clear) {
      report(`checkpoint set: requires --from-latest, --from-block <N>, or --clear`);
      return 2;
    }
    if (
      [options.fromLatest, options.fromBlock !== undefined, options.clear === true].filter(Boolean).length > 1
    ) {
      report(`checkpoint set: --from-latest, --from-block, and --clear are mutually exclusive`);
      return 2;
    }

    if (options.clear) {
      await checkpoint.save(0n);
      report(`checkpoint: cleared — daemon will start from block 0 (or YAML start_block)`);
      report(`checkpoint: driver=${dbConfig.driver} chain_id=${chainId} contract_id=${contractId}`);
      return 0;
    }

    if (options.fromBlock !== undefined) {
      const block = BigInt(options.fromBlock);
      const saveTo = block > 0n ? block - 1n : 0n;
      await checkpoint.save(saveTo);
      report(`checkpoint: set to ${saveTo} — daemon will scan from block ${block} onwards`);
      report(`checkpoint: driver=${dbConfig.driver} chain_id=${chainId} contract_id=${contractId}`);
      return 0;
    }

    // --from-latest: query the chain tip
    report(`checkpoint: querying chain tip from ${rpcUrl} …`);
    let tip: bigint;
    try {
      const client = createPublicClient({ transport: http(rpcUrl) });
      tip = await client.getBlockNumber();
    } catch (err) {
      report(`checkpoint: RPC call failed — ${(err as Error).message}`);
      return 1;
    }

    await checkpoint.save(tip);
    report(`checkpoint: set to ${tip} (current chain tip) — only new intents will be processed`);
    report(`checkpoint: driver=${dbConfig.driver} chain_id=${chainId} contract_id=${contractId}`);
    return 0;
  } finally {
    await db.close();
  }
}
