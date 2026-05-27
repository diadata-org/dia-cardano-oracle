// Checkpoint seeding — applied once at daemon/scan startup when
// --from-block or --from-latest is given.
//
// Keeping this logic in its own module lets both daemon-cmd and scan-cmd
// share it and lets tests inject a fake checkpoint + fake getLatestBlock
// without touching any network or filesystem state.

/** Minimal checkpoint surface needed for seeding. */
export type SeedableCheckpoint = {
  save(blockNumber: bigint): Promise<void>;
};

export type SeedCheckpointOptions = {
  checkpoint: SeedableCheckpoint;
  /** Raw string from --from-block (e.g. "7200000"). */
  fromBlock: string | undefined;
  /** True when --from-latest was passed. */
  fromLatest: boolean;
  /** Returns the current chain tip block number. Only called when fromLatest=true. */
  getLatestBlock: () => Promise<bigint>;
  report: (line: string) => void;
};

/**
 * Seed the scanner checkpoint according to the startup flags.
 *
 * --from-block N   → saves N-1 so the scanner processes from block N onwards.
 * --from-latest    → queries the chain tip and saves it; scanner processes
 *                    only blocks that arrive after startup.
 * Neither flag     → no-op; existing checkpoint (or YAML start_block) applies.
 */
export async function seedCheckpointIfNeeded(opts: SeedCheckpointOptions): Promise<void> {
  const { checkpoint, fromBlock, fromLatest, getLatestBlock, report } = opts;

  if (fromLatest) {
    const tip = await getLatestBlock();
    await checkpoint.save(tip);
    report(`checkpoint: seeded to tip block ${tip} — only new intents will be processed`);
  } else if (fromBlock !== undefined) {
    const block = BigInt(fromBlock);
    const saveTo = block > 0n ? block - 1n : 0n;
    await checkpoint.save(saveTo);
    report(`checkpoint: seeded to block ${saveTo} — scanning from block ${block} onwards`);
  }
}
