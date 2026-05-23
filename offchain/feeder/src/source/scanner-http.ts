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
  /** Max blocks per `eth_getLogs` request. */
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

  let cursor = await resolveStartCursor(checkpoint, startBlock);
  log(`scanner-http: starting at block ${cursor} (transport=${client.transport})`);

  while (!signal?.aborted) {
    const head = await client.getHeadBlockNumber();
    const finalizedHead = head > confirmations ? head - confirmations : 0n;

    if (cursor > finalizedHead) {
      // We're caught up. Wait for HEAD to advance past the
      // confirmations window before doing another round-trip.
      await waitOrAbort(scanIntervalMs, signal);
      continue;
    }

    const rangeEnd = clampToCeiling(cursor + blockRange - 1n, finalizedHead);
    const logs = await client.getIntentRegisteredLogs({
      fromBlock: cursor,
      toBlock: rangeEnd,
    });

    await processLogBatch({
      logs,
      eventAbi: options.eventAbi,
      fromBlock: cursor,
      toBlock: rangeEnd,
      checkpoint,
      onBatch,
    });

    log(
      `scanner-http: scanned ${cursor}..${rangeEnd} (${logs.length} log(s), head=${head}, finalized=${finalizedHead})`,
    );
    cursor = rangeEnd + 1n;
  }

  log("scanner-http: aborted");
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
