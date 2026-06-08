// HTTP polling scanner.
//
// On each tick:
//   1. read the persisted checkpoint (or fall back to `startBlock`),
//   2. read the current HEAD,
//   3. fetch `IntentRegistered` logs in chunks no larger than
//      `blockRange`, advancing the checkpoint after each chunk,
//   4. sleep for `scanInterval` and repeat.
//
// "Re-org tolerance" is implemented in the simplest way that works for
// the DIA Lasernet source chain: we trail HEAD by `confirmations`
// blocks before treating a block as final. Tunable from the
// `infrastructure.<network>.yaml` block-scanner section.

import { setTimeout as sleep } from "node:timers/promises";

import type { AbiEvent } from "viem";

import type { Checkpoint } from "./checkpoint.js";
import { BACKFILL_CHUNK_BLOCKS } from "../config/constants.js";
import type { RegistryClient } from "./registry-client.js";
import { processLogBatch, type ScanHandler } from "./scan-handler.js";

export { BACKFILL_CHUNK_BLOCKS };

/**
 * Minimal Prometheus surface the scanner needs. Decoupled from the full
 * `FeederMetrics` type to keep `src/source/` independent of the metrics
 * package; the daemon adapts its `FeederMetrics` instance to this shape.
 */
export type ScannerMetricsSink = {
  /** Last processed source block per `(chain_id, scanner_type)`. */
  setLastBlock(labels: { chain_id: string; scanner_type: "http" | "ws" }, block: number): void;
  /** Difference between chain head and last persisted checkpoint, per `chain_id`. */
  setBlockLag(labels: { chain_id: string }, lag: number): void;
  /** RPC failure counter — increment once per caught error from the source provider. */
  incRpcError(labels: { chain_id: string; error_type: string }): void;
  /** Blocks fast-backfilled during a gap-recovery run. Increment by chunk size. */
  incBackfillBlocks(labels: { chain_id: string }, blocks: number): void;
  /** Number of backfill chunks executed (one per `eth_getLogs` inside the gap-recovery loop). */
  incBackfillChunks(labels: { chain_id: string }): void;
  /** Mark a transport (http or ws) as up (1) or down (0). */
  setTransportUp(labels: { chain_id: string; transport: string }, up: number): void;
};

export type HttpScannerOptions = {
  /** Registry client (HTTP transport). */
  client: RegistryClient;
  /** ABI for the event the scanner watches. Comes from the parsed
   *  YAML at config load; the scanner does not re-parse. */
  eventAbi: AbiEvent;
  /** Where to resume from across restarts. */
  checkpoint: Checkpoint;
  /** Fallback block when the checkpoint is empty. `0n` = registry tip
   *  minus a small lookback (handled by the scanner). */
  startBlock: bigint;
  /** Max blocks per `eth_getLogs` request during NORMAL (steady-state) scanning. */
  blockRange: bigint;
  /** Idle wait between scan ticks. */
  scanIntervalMs: number;
  /** How many blocks to trail HEAD before treating a block as final. */
  confirmations: bigint;
  /** Per-batch sink. */
  onBatch: ScanHandler;
  /** Optional structured log hook. */
  log?: (line: string) => void;
  /** Abort the scan loop cleanly. */
  signal?: AbortSignal;
  /** Optional Prometheus emitter — populated by the daemon. Tests pass
   *  a no-op. When omitted the scanner runs without metrics. */
  metrics?: ScannerMetricsSink;
  /** Numeric source chain id (e.g. 10050 for DIA Testnet). Used as the
   *  `chain_id` label on emitted metrics. */
  chainId?: number;
  /** When true, switch to BACKFILL MODE if the gap between head and the
   *  current checkpoint exceeds `maxBlockGap`. In backfill mode the scanner
   *  uses larger chunks (`backfillChunkBlocks`) and skips the
   *  `scan_interval` sleep between chunks. Defaults to false (Spectra parity:
   *  `block_scanner.backward_sync` flag). */
  backwardSync?: boolean;
  /** Gap threshold (in blocks) above which backfill mode kicks in.
   *  Ignored when `backwardSync` is false. Sourced from
   *  `block_scanner.max_block_gap`. Default 5000 — exactly one backfill chunk. */
  maxBlockGap?: bigint;
  /** Chunk size used in backfill mode. Sourced from
   *  `block_scanner.backfill_chunk_blocks`. Default: `BACKFILL_CHUNK_BLOCKS` (5000). */
  backfillChunkBlocks?: bigint;
  /** Cadence for the separate head-tracker loop that keeps the block-lag
   *  gauge fresh independent of the scan tick rate. When absent, defaults
   *  to `scanIntervalMs`. */
  headTrackerIntervalMs?: number;
  /** Cadence for the gap-detection loop. When absent, defaults to
   *  `scanIntervalMs`. */
  gapDetectionIntervalMs?: number;
  /** Block-timestamp resolver used to populate `ExtractedEvent.blockTimestamp`.
   *  When absent, `blockTimestamp` defaults to 0n. */
  getBlockTimestamp?: (blockNumber: bigint) => Promise<bigint>;
};

/**
 * Run the polling loop until the abort signal fires (or forever).
 * Returns gracefully on abort; throws on unrecoverable RPC errors so
 * the caller can decide whether to fall back to a different transport
 * or exit.
 */
export async function runHttpScanner(options: HttpScannerOptions): Promise<void> {
  const {
    client,
    checkpoint,
    startBlock,
    blockRange,
    scanIntervalMs,
    confirmations,
    onBatch,
    signal,
  } = options;
  const log = options.log ?? (() => {});
  const metrics = options.metrics;
  const chainIdLabel = options.chainId !== undefined ? String(options.chainId) : "unknown";
  const backwardSyncEnabled = options.backwardSync === true;
  const maxBlockGap = options.maxBlockGap ?? BACKFILL_CHUNK_BLOCKS;
  const backfillChunkBlocks = options.backfillChunkBlocks ?? BACKFILL_CHUNK_BLOCKS;
  const headTrackerIntervalMs = options.headTrackerIntervalMs ?? scanIntervalMs;
  const gapDetectionIntervalMs = options.gapDetectionIntervalMs ?? scanIntervalMs;

  let cursor = await resolveStartCursor(checkpoint, startBlock);
  log(`scanner-http: starting at block ${cursor} (transport=${client.transport})`);

  // Highest head seen so far, for reorg detection. When the chain head drops
  // by more than `confirmations` below this watermark, a reorg reorganised
  // blocks at/under our cursor; we rewind the cursor so the reorged range is
  // re-scanned instead of permanently skipped. `0n` means "no head seen yet".
  let highWaterHead = 0n;

  // Separate head-tracker loop — keeps block-lag gauges fresh at its own
  // cadence without coupling to the main scan tick.
  if (options.headTrackerIntervalMs !== undefined) {
    void runHeadTrackerLoop({
      client,
      chainIdLabel,
      intervalMs: headTrackerIntervalMs,
      signal,
      metrics,
      log,
      getCursor: () => cursor,
    });
  }

  // Separate gap-detection loop — triggers backfill check at its own cadence.
  if (options.gapDetectionIntervalMs !== undefined && backwardSyncEnabled) {
    void runGapDetectionLoop({
      client,
      chainIdLabel,
      intervalMs: gapDetectionIntervalMs,
      signal,
      metrics,
      log,
      getCursor: () => cursor,
      maxBlockGap,
      confirmations,
    });
  }

  while (!signal?.aborted) {
    let head: bigint;
    try {
      head = await client.getHeadBlockNumber();
    } catch (error) {
      metrics?.incRpcError({ chain_id: chainIdLabel, error_type: classifyRpcError(error) });
      throw error;
    }
    const finalizedHead = head > confirmations ? head - confirmations : 0n;

    // Reorg detection. If HEAD has dropped more than `confirmations` below the
    // highest head we have seen, the chain reorganised below our cursor: the
    // blocks we already scanned in [finalizedHead+1 .. cursor-1] may no longer
    // be canonical. Rewind the cursor to re-scan from the new finalized head
    // (minus one chunk for margin) so no canonical log is permanently skipped.
    // Dedup on intentHash absorbs any logs that survived the reorg unchanged.
    if (highWaterHead > 0n && head + confirmations < highWaterHead && cursor > finalizedHead) {
      const rewindTarget = finalizedHead > blockRange ? finalizedHead - blockRange : 0n;
      if (rewindTarget < cursor) {
        log(
          `scanner-http: REORG detected — head ${head} dropped below high-water ${highWaterHead} ` +
          `(confirmations=${confirmations}); rewinding cursor ${cursor} → ${rewindTarget} to re-scan.`,
        );
        metrics?.incRpcError({ chain_id: chainIdLabel, error_type: "reorg" });
        cursor = rewindTarget;
      }
    }
    if (head > highWaterHead) highWaterHead = head;

    // Expose chain head and how far the checkpoint trails it. Used by
    // the OraclePairStale / scanner block-lag panels in Grafana.
    // Skip if a separate head-tracker loop handles this.
    if (options.headTrackerIntervalMs === undefined) {
      metrics?.setLastBlock({ chain_id: chainIdLabel, scanner_type: "http" }, Number(head));
      metrics?.setBlockLag({ chain_id: chainIdLabel }, Number(head - cursor));
    }

    if (cursor > finalizedHead) {
      // We're caught up. Wait for HEAD to advance past the
      // confirmations window before doing another round-trip.
      await waitOrAbort(scanIntervalMs, signal);
      continue;
    }

    // Gap recovery — Spectra parity. When the gap between the finalized
    // head and the cursor exceeds `maxBlockGap`, switch to backfill mode:
    //   - chunks of `backfillChunkBlocks` instead of `blockRange` (500)
    //   - no scan_interval sleep between chunks (tight loop until caught up)
    //   - emit dedicated metrics so operators can see catch-up progress
    // Once the cursor is within `maxBlockGap` of the finalized head, fall
    // back to the steady-state loop above.
    const gap = finalizedHead - cursor;
    const inBackfill = backwardSyncEnabled && gap > maxBlockGap;
    const chunkSize = inBackfill ? backfillChunkBlocks : blockRange;

    const rangeEnd = clampToCeiling(cursor + chunkSize - 1n, finalizedHead);
    let logs;
    try {
      logs = await client.getIntentRegisteredLogs({
        fromBlock: cursor,
        toBlock: rangeEnd,
      });
    } catch (error) {
      metrics?.incRpcError({ chain_id: chainIdLabel, error_type: classifyRpcError(error) });
      throw error;
    }

    await processLogBatch({
      logs,
      eventAbi: options.eventAbi,
      fromBlock: cursor,
      toBlock: rangeEnd,
      checkpoint,
      onBatch,
      getBlockTimestamp: options.getBlockTimestamp,
    });

    if (inBackfill) {
      const blocks = Number(rangeEnd - cursor + 1n);
      metrics?.incBackfillBlocks({ chain_id: chainIdLabel }, blocks);
      metrics?.incBackfillChunks({ chain_id: chainIdLabel });
      log(
        `scanner-http: BACKFILL ${cursor}..${rangeEnd} (${logs.length} log(s), gap=${gap}, head=${head})`,
      );
    } else {
      log(
        `scanner-http: scanned ${cursor}..${rangeEnd} (${logs.length} log(s), head=${head}, finalized=${finalizedHead})`,
      );
    }
    cursor = rangeEnd + 1n;
  }

  log("scanner-http: aborted");
}

// ---------------------------------------------------------------------------
// Background loops
// ---------------------------------------------------------------------------

type HeadTrackerLoopArgs = {
  client: RegistryClient;
  chainIdLabel: string;
  intervalMs: number;
  signal?: AbortSignal;
  metrics?: ScannerMetricsSink;
  log: (line: string) => void;
  getCursor: () => bigint;
};

async function runHeadTrackerLoop(args: HeadTrackerLoopArgs): Promise<void> {
  const { client, chainIdLabel, intervalMs, signal, metrics, log, getCursor } = args;
  while (!signal?.aborted) {
    await waitOrAbort(intervalMs, signal);
    if (signal?.aborted) break;
    try {
      const head = await client.getHeadBlockNumber();
      metrics?.setLastBlock({ chain_id: chainIdLabel, scanner_type: "http" }, Number(head));
      metrics?.setBlockLag({ chain_id: chainIdLabel }, Number(head - getCursor()));
    } catch (error) {
      log(`scanner-http: head-tracker error: ${(error as Error).message}`);
    }
  }
}

type GapDetectionLoopArgs = {
  client: RegistryClient;
  chainIdLabel: string;
  intervalMs: number;
  signal?: AbortSignal;
  metrics?: ScannerMetricsSink;
  log: (line: string) => void;
  getCursor: () => bigint;
  maxBlockGap: bigint;
  confirmations: bigint;
};

async function runGapDetectionLoop(args: GapDetectionLoopArgs): Promise<void> {
  const {
    client,
    chainIdLabel,
    intervalMs,
    signal,
    log,
    getCursor,
    maxBlockGap,
    confirmations,
  } = args;
  while (!signal?.aborted) {
    await waitOrAbort(intervalMs, signal);
    if (signal?.aborted) break;
    try {
      const head = await client.getHeadBlockNumber();
      const finalizedHead = head > confirmations ? head - confirmations : 0n;
      const gap = finalizedHead - getCursor();
      if (gap > maxBlockGap) {
        log(
          `scanner-http: gap-detection: gap=${gap} blocks exceeds maxBlockGap=${maxBlockGap} (chain_id=${chainIdLabel})`,
        );
      }
    } catch (error) {
      log(`scanner-http: gap-detection error: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Categorise an RPC error for the `error_type` label on
 * `dia_bridge_scanner_rpc_errors_total`. Buckets are kept coarse on
 * purpose — a high-cardinality label here would explode Prometheus
 * storage.
 */
function classifyRpcError(error: unknown): string {
  const message = (error as { message?: string })?.message ?? "";
  const name = (error as { name?: string })?.name ?? "";
  if (name === "AbortError") return "abort";
  if (/timeout/i.test(message)) return "timeout";
  if (/(ECONN|fetch failed|network|ENOTFOUND|EHOSTUNREACH)/i.test(message)) return "network";
  if (/(json-?rpc|invalid response|429|5\d\d)/i.test(message)) return "protocol";
  return "unknown";
}

/** Use the persisted checkpoint when present; otherwise fall back to
 *  the configured `startBlock`. */
async function resolveStartCursor(
  checkpoint: Checkpoint,
  startBlock: bigint,
): Promise<bigint> {
  const persisted = await checkpoint.load();
  if (persisted !== null) {
    return persisted + 1n;
  }
  return startBlock;
}

function clampToCeiling(value: bigint, ceiling: bigint): bigint {
  return value > ceiling ? ceiling : value;
}

/** Sleep `ms` but resolve immediately if the abort signal fires. */
async function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") return;
    throw error;
  }
}
