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
//     reconnect after `reconnectIntervalMs` up to `maxReconnects`
//     attempts.
//   - Beyond `maxReconnects`, the scanner aborts. The caller (a
//     supervisor at the cmd/feeder level) is responsible for switching
//     to the HTTP fallback.
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
  reconnectIntervalMs: number;
  maxReconnects: number;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Optional Prometheus emitter — shared shape with the HTTP scanner. */
  metrics?: ScannerMetricsSink;
  /** Numeric source chain id used as the `chain_id` label. */
  chainId?: number;
};

/**
 * Run the WS scanner until the abort signal fires or the reconnect
 * budget is exhausted. Returns gracefully on abort; throws when the
 * reconnect budget is exceeded so the caller can fall back to HTTP.
 */
export async function runWsScanner(options: WsScannerOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const { signal, metrics } = options;
  const chainIdLabel = options.chainId !== undefined ? String(options.chainId) : "unknown";

  let attempt = 0;
  while (!signal?.aborted) {
    const client = createPublicClient({ transport: webSocket(options.wsUrl) });
    log(`scanner-ws: connecting (attempt ${attempt + 1}/${options.maxReconnects + 1})`);

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
      });
      // Graceful disconnect (abort signal). Stop the loop.
      log("scanner-ws: aborted");
      return;
    } catch (error) {
      log(`scanner-ws: connection lost (${(error as Error).message})`);
      metrics?.incRpcError({ chain_id: chainIdLabel, error_type: "websocket" });
    } finally {
      closeClientSocket(client);
    }

    attempt += 1;
    if (attempt > options.maxReconnects) {
      throw new Error(
        `scanner-ws: exhausted reconnect budget (${options.maxReconnects} attempts).`,
      );
    }
    await waitOrAbort(options.reconnectIntervalMs, signal);
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
    const { client, registryAddress, eventAbi, checkpoint, onBatch, log, signal, metrics, chainIdLabel } = inputs;

    let stopped = false;
    const stop = (cause: "abort" | { error: Error }): void => {
      if (stopped) return;
      stopped = true;
      try {
        unwatch();
      } catch {
        // ignore; cleanup is best-effort
      }
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
      });
      // Update head-tracking gauge whenever the WS stream delivers a log.
      metrics?.setLastBlock({ chain_id: chainIdLabel, scanner_type: "ws" }, Number(maxBlock));
      log(`scanner-ws: delivered ${decoded.length} log(s) (blocks ${minBlock}..${maxBlock})`);
    }
  });
}

/** Project viem's `Log` into the narrower `RegistryLog` the extractor
 *  consumes. */
function toRegistryLog(log: Log): RegistryLog {
  return {
    topics: log.topics as readonly Hex[],
    data: log.data as Hex,
    blockNumber: log.blockNumber ?? 0n,
    transactionHash: (log.transactionHash ?? ("0x" as Hex)) as Hex,
    logIndex: log.logIndex ?? 0,
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
