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
}): Promise<void> {
  const events = decodeIntentRegisteredLogs(args.logs, args.eventAbi);
  await args.onBatch({ fromBlock: args.fromBlock, toBlock: args.toBlock, events });
  await args.checkpoint.save(args.toBlock);
}
