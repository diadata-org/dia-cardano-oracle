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
import type { RegistryClient } from "./registry-client.js";
import { processLogBatch, type ScanHandler } from "./scan-handler.js";

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
};

/** Default chunk size when the gap-recovery loop is active (Spectra parity:
 *  internal/scanner/block_scanner_enhanced.go uses 5000). Larger chunks
 *  let the scanner catch up in fewer round-trips after a long outage. */
export const BACKFILL_CHUNK_BLOCKS = 5000n;

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
   *  uses larger chunks (`BACKFILL_CHUNK_BLOCKS`) and skips the
   *  `scan_interval` sleep between chunks. Defaults to false (Spectra parity:
   *  `block_scanner.backward_sync` flag). */
  backwardSync?: boolean;
  /** Gap threshold (in blocks) above which backfill mode kicks in.
   *  Ignored when `backwardSync` is false. Sourced from
   *  `block_scanner.max_block_gap`. Default 5000 — exactly one backfill chunk. */
  maxBlockGap?: bigint;
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

  let cursor = await resolveStartCursor(checkpoint, startBlock);
  log(`scanner-http: starting at block ${cursor} (transport=${client.transport})`);

  while (!signal?.aborted) {
    let head: bigint;
    try {
      head = await client.getHeadBlockNumber();
    } catch (error) {
      metrics?.incRpcError({ chain_id: chainIdLabel, error_type: classifyRpcError(error) });
      throw error;
    }
    const finalizedHead = head > confirmations ? head - confirmations : 0n;

    // Expose chain head and how far the checkpoint trails it. Used by
    // the OraclePairStale / scanner block-lag panels in Grafana.
    metrics?.setLastBlock({ chain_id: chainIdLabel, scanner_type: "http" }, Number(head));
    metrics?.setBlockLag({ chain_id: chainIdLabel }, Number(head - cursor));

    if (cursor > finalizedHead) {
      // We're caught up. Wait for HEAD to advance past the
      // confirmations window before doing another round-trip.
      await waitOrAbort(scanIntervalMs, signal);
      continue;
    }

    // Gap recovery — Spectra parity. When the gap between the finalized
    // head and the cursor exceeds `maxBlockGap`, switch to backfill mode:
    //   - chunks of BACKFILL_CHUNK_BLOCKS (5000) instead of `blockRange` (500)
    //   - no scan_interval sleep between chunks (tight loop until caught up)
    //   - emit dedicated metrics so operators can see catch-up progress
    // Once the cursor is within `maxBlockGap` of the finalized head, fall
    // back to the steady-state loop above.
    const gap = finalizedHead - cursor;
    const inBackfill = backwardSyncEnabled && gap > maxBlockGap;
    const chunkSize = inBackfill ? BACKFILL_CHUNK_BLOCKS : blockRange;

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
