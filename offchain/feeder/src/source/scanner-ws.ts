// WebSocket subscription scanner.
//
// Watches `IntentRegistered` live via viem's `watchEvent` and forwards
// every confirmed log to the same batch handler the HTTP scanner uses,
// so downstream pipeline code does not have to care which transport
// produced the event.
//
// The Spectra Bridge ships a parallel `event_source.go` that does the
// same thing for `block_scanner_enhanced.go`; this file is its
// TypeScript counterpart.
//
// Resilience model:
//   - If the WS connection drops, viem's `unwatch` returns; we
//     reconnect using exponential backoff with ±20% jitter, capped at
//     5 minutes.
//   - The delay resets to the base value on a successful log delivery.
//   - Reconnect attempts are logged as warnings; the scanner never
//     terminates on its own — the HTTP baseline keeps running in
//     parallel and covers any gap.
//   - Once a log is delivered to `onBatch`, the checkpoint is advanced
//     to that log's block. A subsequent HTTP scan starting from the
//     checkpoint will pick up anything missed during a reconnect.
//
// Source coordinates (WS URL, registry address, event ABI) are passed
// in by the caller — they originate in the YAML config, not in this
// file. The only env touch is `DIA_WS_CREDENTIAL_<network>`, which
// is a secret and therefore belongs in `.env`.

import { setTimeout as sleep } from "node:timers/promises";

import {
  createPublicClient,
  webSocket,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";

import type { Checkpoint } from "./checkpoint.js";
import type { RegistryLog } from "./registry-client.js";
import { processLogBatch, type ScanHandler } from "./scan-handler.js";
import type { ScannerMetricsSink } from "./scanner-http.js";

// Reconnect backoff parameters (sourced from WsScannerOptions defaults).
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 300_000;

/**
 * Compute the next reconnect delay with exponential backoff and ±20% jitter.
 *
 * @param attempt  Zero-based attempt index (0 = first reconnect).
 * @param base     Base delay in ms (default: `BASE_RECONNECT_MS`).
 * @param max      Cap in ms (default: `MAX_RECONNECT_MS`).
 */
export function nextDelay(
  attempt: number,
  base: number = BASE_RECONNECT_MS,
  max: number = MAX_RECONNECT_MS,
): number {
  const exp = Math.min(base * Math.pow(2, attempt), max);
  const jitter = exp * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(base, Math.min(max, Math.round(exp + jitter)));
}

export type WsScannerOptions = {
  /** Full WS URL including the path-style credential. Compose with
   *  `composeAuthenticatedWsUrl` in `registry-client.ts`. */
  wsUrl: string;
  /** Source registry address to subscribe against. */
  registryAddress: Address;
  /** ABI for the event to watch. Comes from `events.yaml`. */
  eventAbi: AbiEvent;
  checkpoint: Checkpoint;
  onBatch: ScanHandler;
  /** Initial reconnect delay in ms. Grows exponentially on repeated failures.
   *  Defaults to `BASE_RECONNECT_MS` (1 s). */
  reconnectIntervalMs: number;
  /** Kept for interface compatibility; no longer used as a hard budget.
   *  When reconnects exceed this count, a warning is logged but scanning
   *  continues. */
  maxReconnects: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Optional Prometheus emitter — shared shape with the HTTP scanner. */
  metrics?: ScannerMetricsSink;
  /** Numeric source chain id used as the `chain_id` label. */
  chainId?: number;
  /** Optional block-timestamp resolver. When absent, `blockTimestamp`
   *  on delivered events defaults to 0n and the intent_to_registration /
   *  registration_to_scan latency phases stay at 0. Callers that want
   *  those metrics live should pass the registry client's
   *  `getBlockTimestamp`. */
  getBlockTimestamp?: (blockNumber: bigint) => Promise<bigint>;
};

/**
 * Run the WS scanner until the abort signal fires.
 * On connection failure, reconnects with exponential backoff (±20% jitter),
 * capped at 5 minutes. Never terminates on its own — the HTTP baseline covers
 * any gap while the WS scanner is reconnecting.
 */
export async function runWsScanner(options: WsScannerOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const { signal, metrics } = options;
  const chainIdLabel = options.chainId !== undefined ? String(options.chainId) : "unknown";

  let attempt = 0;
  while (!signal?.aborted) {
    const client = createPublicClient({ transport: webSocket(options.wsUrl) });
    log(
      `scanner-ws: connecting (attempt ${attempt + 1})`,
    );
    metrics?.setTransportUp({ chain_id: chainIdLabel, transport: "ws" }, 1);

    let receivedLog = false;
    try {
      await watchUntilDisconnect({
        client,
        registryAddress: options.registryAddress,
        eventAbi: options.eventAbi,
        checkpoint: options.checkpoint,
        onBatch: options.onBatch,
        log,
        signal,
        metrics,
        chainIdLabel,
        getBlockTimestamp: options.getBlockTimestamp,
        onLogReceived: () => {
          receivedLog = true;
        },
      });
      // Graceful disconnect (abort signal). Stop the loop.
      log("scanner-ws: aborted");
      metrics?.setTransportUp({ chain_id: chainIdLabel, transport: "ws" }, 0);
      return;
    } catch (error) {
      log(`scanner-ws: connection lost (${(error as Error).message})`);
      metrics?.incRpcError({ chain_id: chainIdLabel, error_type: "websocket" });
      metrics?.setTransportUp({ chain_id: chainIdLabel, transport: "ws" }, 0);
    } finally {
      closeClientSocket(client);
    }

    // Reset backoff counter when we successfully received at least one log
    // before losing the connection — the link was healthy for a while.
    if (receivedLog) {
      attempt = 0;
    } else {
      attempt += 1;
    }

    if (attempt > options.maxReconnects) {
      log(
        `scanner-ws: WARNING — exceeded soft reconnect budget (${options.maxReconnects}). ` +
          `Continuing with backoff (HTTP baseline is active).`,
      );
    }

    const delay = nextDelay(attempt, options.reconnectIntervalMs, MAX_RECONNECT_MS);
    log(`scanner-ws: reconnecting in ${delay}ms (attempt ${attempt})`);
    await waitOrAbort(delay, signal);
  }
}

/** Best-effort socket close (viem hides the socket on the transport
 *  object; we type-erase to reach it). */
function closeClientSocket(client: PublicClient): void {
  const transportInternals = (client.transport as unknown) as {
    socket?: { close: () => void };
  };
  transportInternals.socket?.close();
}

type WatchInputs = {
  client: PublicClient;
  registryAddress: Address;
  eventAbi: AbiEvent;
  checkpoint: Checkpoint;
  onBatch: ScanHandler;
  log: (line: string) => void;
  signal?: AbortSignal;
  metrics?: ScannerMetricsSink;
  chainIdLabel: string;
  getBlockTimestamp?: (blockNumber: bigint) => Promise<bigint>;
  onLogReceived: () => void;
};

/**
 * Subscribe to the configured event and resolve when either:
 *   - the abort signal fires (returns), or
 *   - the underlying socket errors (rejects with the error).
 *
 * Every log arrives one at a time from viem; we deliver each one as a
 * single-element batch so the downstream pipeline shape stays
 * identical to the HTTP scanner's.
 */
function watchUntilDisconnect(inputs: WatchInputs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const {
      client,
      registryAddress,
      eventAbi,
      checkpoint,
      onBatch,
      log,
      signal,
      metrics,
      chainIdLabel,
      getBlockTimestamp,
      onLogReceived,
    } = inputs;

    let stopped = false;
    const stop = (cause: "abort" | { error: Error }): void => {
      if (stopped) return;
      stopped = true;
      try {
        unwatch();
      } catch (_err) { /* swallow intentionally — socket already closing */ }
      if (cause === "abort") resolve();
      else reject(cause.error);
    };

    const unwatch = client.watchEvent({
      address: registryAddress,
      event: eventAbi,
      onLogs: (logs) => {
        void handleIncomingLogs(logs).catch((error) =>
          stop({ error: error as Error }),
        );
      },
      onError: (error) => stop({ error }),
    });

    if (signal) {
      if (signal.aborted) {
        stop("abort");
        return;
      }
      signal.addEventListener("abort", () => stop("abort"), { once: true });
    }

    async function handleIncomingLogs(logs: Log[]): Promise<void> {
      const decoded = logs.map(toRegistryLog);
      if (decoded.length === 0) return;
      onLogReceived();
      const blockNumbers = decoded
        .map((l) => l.blockNumber)
        .filter((b): b is bigint => b !== undefined);
      const minBlock = blockNumbers.reduce((a, b) => (a < b ? a : b), blockNumbers[0]);
      const maxBlock = blockNumbers.reduce((a, b) => (a > b ? a : b), blockNumbers[0]);
      await processLogBatch({
        logs: decoded,
        eventAbi,
        fromBlock: minBlock,
        toBlock: maxBlock,
        checkpoint,
        onBatch,
        getBlockTimestamp,
      });
      // Update head-tracking gauge whenever the WS stream delivers a log.
      metrics?.setLastBlock({ chain_id: chainIdLabel, scanner_type: "ws" }, Number(maxBlock));
      log(`scanner-ws: delivered ${decoded.length} log(s) (blocks ${minBlock}..${maxBlock})`);
    }
  });
}

/** Project viem's `Log` into the narrower `RegistryLog` the extractor
 *  consumes.
 *
 *  viem types `blockNumber`, `transactionHash` and `logIndex` as nullable
 *  because they are `null` for *pending* logs (a tx in the mempool, not yet
 *  mined). The feeder only ever subscribes to mined logs, so a null here
 *  signals a malformed delivery — NOT a value to be silently coerced. We
 *  throw instead of defaulting to `0n` / `"0x"` / `0`, because a fake
 *  blockNumber=0 would checkpoint the scanner at block 0 (replaying the
 *  whole chain on restart) and a fake txHash="0x" would collide in the
 *  dedup cache. The watcher's onLogs handler catches this and triggers a
 *  reconnect, surfacing the bad delivery instead of corrupting state. */
function toRegistryLog(log: Log): RegistryLog {
  if (log.blockNumber === null || log.blockNumber === undefined) {
    throw new Error(
      `scanner-ws: received log with null blockNumber (pending tx?) — ` +
      `txHash=${log.transactionHash ?? "unknown"} logIndex=${log.logIndex ?? "unknown"}`,
    );
  }
  if (log.transactionHash === null || log.transactionHash === undefined) {
    throw new Error(
      `scanner-ws: received log with null transactionHash at block ${log.blockNumber}`,
    );
  }
  if (log.logIndex === null || log.logIndex === undefined) {
    throw new Error(
      `scanner-ws: received log with null logIndex (block ${log.blockNumber}, tx ${log.transactionHash})`,
    );
  }
  return {
    topics: log.topics as readonly Hex[],
    data: log.data as Hex,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash as Hex,
    logIndex: log.logIndex,
  };
}

async function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") return;
    throw error;
  }
}
