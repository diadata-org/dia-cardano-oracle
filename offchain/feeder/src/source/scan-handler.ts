// Shared event handling for both scanner transports.
//
// Both `scanner-http.ts` (polling `eth_getLogs`) and `scanner-ws.ts`
// (subscribing via WS) ultimately produce the same thing: a stream of
// decoded `ExtractedEvent` objects with their origin block numbers.
// This module owns the bits that should not be duplicated:
//
//   - decoding logs into `ExtractedEvent` against the YAML-supplied ABI,
//   - persisting the high-water mark via the `Checkpoint`,
//   - delivering events + checkpoint updates to the caller's handler.

import type { AbiEvent } from "viem";

import { decodeIntentRegisteredLogs } from "./extractor.js";
import type { Checkpoint } from "./checkpoint.js";
import type { RegistryLog } from "./registry-client.js";
import type { ExtractedEvent } from "./types.js";

/** Per-block-range payload delivered to the caller. */
export type ScannedBatch = {
  fromBlock: bigint;
  toBlock: bigint;
  events: ExtractedEvent[];
};

export type ScanHandler = (batch: ScannedBatch) => Promise<void> | void;

/** Decode + checkpoint + deliver a chunk of logs. Used by both scanners. */
export async function processLogBatch(args: {
  logs: RegistryLog[];
  eventAbi: AbiEvent;
  fromBlock: bigint;
  toBlock: bigint;
  checkpoint: Checkpoint;
  onBatch: ScanHandler;
  /** Optional block-timestamp resolver. When absent, `blockTimestamp` is
   *  set to 0n. Callers that support block lookups pass this to enable
   *  end-to-end latency metrics. */
  getBlockTimestamp?: (blockNumber: bigint) => Promise<bigint>;
}): Promise<void> {
  const rawEvents = decodeIntentRegisteredLogs(args.logs, args.eventAbi);

  // Attach block timestamps when the resolver is available. The lookup is
  // batched per distinct block number to avoid quadratic RPC pressure when a
  // single block carries multiple IntentRegistered logs.
  let events = rawEvents;
  if (args.getBlockTimestamp && rawEvents.length > 0) {
    const resolver = args.getBlockTimestamp;
    const distinct = [...new Set(rawEvents.map((ev) => ev.blockNumber))];
    const entries = await Promise.all(
      distinct.map(async (block) => [block, await resolver(block)] as const),
    );
    const tsCache = new Map<bigint, bigint>(entries);
    events = rawEvents.map((ev) => ({
      ...ev,
      blockTimestamp: tsCache.get(ev.blockNumber) ?? 0n,
    }));
  }

  await args.onBatch({ fromBlock: args.fromBlock, toBlock: args.toBlock, events });
  await args.checkpoint.save(args.toBlock);
}
