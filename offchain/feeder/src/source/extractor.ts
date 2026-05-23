// Decode raw `IntentRegistered` logs into the canonical
// `ExtractedEvent` shape.
//
// The event ABI is the one parsed from `events.yaml` at config load
// time (see `src/config/abi-parser.ts`). This file does not import
// any ABI constant — every decode happens against the operator's
// YAML so that editing the YAML actually changes the decode at next
// restart.

import { decodeEventLog, type Address, type AbiEvent, type Hex } from "viem";

import type { RegistryLog } from "./registry-client.js";
import type { ExtractedEvent } from "./types.js";

/**
 * Build a decoder bound to one `AbiEvent` instance. The decoder is a
 * plain function; constructing it once per scanner instance avoids
 * re-resolving the ABI for every log.
 */
export function createIntentRegisteredDecoder(
  abi: AbiEvent,
): (log: RegistryLog) => ExtractedEvent {
  return (log) => decodeIntentRegisteredLog(log, abi);
}

/** Single-log decode against the supplied event ABI. */
export function decodeIntentRegisteredLog(log: RegistryLog, abi: AbiEvent): ExtractedEvent {
  const decoded = decodeEventLog({
    abi: [abi],
    eventName: abi.name,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  });
  const args = decoded.args as {
    intentHash: Hex;
    symbol: Hex; // indexed `string` → keccak256(symbol)
    price: bigint;
    timestamp: bigint;
    signer: Address;
  };

  return {
    intentHash: args.intentHash,
    symbolHash: args.symbol,
    price: args.price,
    timestamp: args.timestamp,
    signer: args.signer,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}

/**
 * Decode a batch of logs against the supplied event ABI. A single bad
 * log throws with the offending tx hash + log index so the operator
 * can investigate; the rest of the batch is not silently dropped.
 */
export function decodeIntentRegisteredLogs(
  logs: RegistryLog[],
  abi: AbiEvent,
): ExtractedEvent[] {
  return logs.map((log) => {
    try {
      return decodeIntentRegisteredLog(log, abi);
    } catch (error) {
      throw new Error(
        `Failed to decode IntentRegistered log from tx ${log.transactionHash} (logIndex=${log.logIndex}): ${
          (error as Error).message
        }`,
      );
    }
  });
}
