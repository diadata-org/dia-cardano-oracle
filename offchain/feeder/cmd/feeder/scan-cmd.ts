// `--scan` command implementation.
//
// Composes the source-side pipeline end-to-end:
//   loader → scanner (HTTP or WS) → extractor → dedup → enricher → stdout
//
// `--scan` runs in observation mode: it prints enriched intents but
// never submits a Cardano tx. The submitter is wired in by a separate
// command path; this file deliberately stays read-only.
//
// Source coordinates (chain id, RPC, WS URL, registry address, event
// + enrichment ABIs) come from the loaded `ModularConfig`. The only
// env reads on this path are the WS credential (a secret) and the
// dedup-cache tuning knobs (operational).

import path from "node:path";

import { seedCheckpointIfNeeded } from "./checkpoint-seed.js";
import {
  loadModularConfig,
  validateModularConfig,
  type ModularConfig,
  type ValidationIssue,
} from "../../src/config/index.js";
import { createRegistryEnricher, identityTransformer } from "../../src/pipeline/index.js";
import {
  createDedupCache,
  type DedupCache,
} from "../../src/processor/index.js";
import {
  composeAuthenticatedWsUrl,
  createHttpRegistryClient,
  createJsonCheckpoint,
  defaultCheckpointPath,
  resolveSourceFromConfig,
  runHttpScanner,
  runWsScanner,
  type CardanoNetwork,
  type Checkpoint,
  type EnrichedIntent,
  type ExtractedEvent,
  type RegistryClient,
  type ResolvedSource,
  type ScannedBatch,
} from "../../src/source/index.js";
import { createPublicClient, http, type PublicClient } from "viem";

/** What the scan command supports. */
export type ScanCmdOptions = {
  network: CardanoNetwork;
  transport: "http" | "ws";
  dryRun: boolean;
  fromBlock?: string;
  fromLatest: boolean;
  /** Logger sink. */
  report: (line: string) => void;
  /** Modular config directory. */
  configPath: string;
  /** Where the scanner persists `last_processed_block`. Defaults to
   *  `state/<network>/feeder-checkpoint.json`. */
  checkpointPath?: string;
  /** Polling cadence + chunk size. */
  scanIntervalMs?: number;
  blockRange?: bigint;
  confirmations?: bigint;
  startBlock?: bigint;
  /** Dedup-cache tuning. */
  dedupCapacity?: number;
  dedupTtlMs?: number;
  /** WS-only tuning. */
  reconnectIntervalMs?: number;
  maxReconnects?: number;
  /** Stop signal. */
  signal?: AbortSignal;
};

const DEFAULTS = {
  scanIntervalMs: 10_000,
  blockRange: 500n,
  confirmations: 6n,
  startBlock: 0n,
  dedupCapacity: 4096,
  dedupTtlMs: 60 * 60_000, // 1h
  reconnectIntervalMs: 5_000,
  maxReconnects: 60,
} as const;

/**
 * Run the scan pipeline until aborted. Returns the process exit code
 * (0 on graceful shutdown, non-zero on unrecoverable error).
 */
export async function runScan(options: ScanCmdOptions): Promise<number> {
  const { network, transport, configPath, report, signal } = options;

  report(`scan: loading config at ${configPath} for network=${network}`);
  let config: ModularConfig;
  try {
    config = await loadModularConfig({ baseDir: configPath, network });
  } catch (error) {
    report(`scan: config load failed — ${(error as Error).message}`);
    return 1;
  }

  const issues = validateModularConfig(config);
  if (renderAndCountErrors(issues, report) > 0) {
    report(`scan: refusing to start — fix the config errors above (run --validate-only for a clean report).`);
    return 1;
  }

  let source: ResolvedSource;
  try {
    source = resolveSourceFromConfig(config);
  } catch (error) {
    report(`scan: source resolution failed — ${(error as Error).message}`);
    return 1;
  }

  if (options.dryRun) {
    report(`scan: dry-run mode — events will be printed but no Cardano txs will be submitted.`);
  } else {
    report(`scan: observation mode — no submitter is wired into this command path.`);
  }

  const checkpointPath = options.checkpointPath ?? defaultCheckpointPath(network);
  const checkpoint = createJsonCheckpoint({ filePath: checkpointPath });
  await seedCheckpointIfNeeded({
    checkpoint,
    fromBlock: options.fromBlock,
    fromLatest: options.fromLatest,
    getLatestBlock: async () => {
      const c = createPublicClient({ transport: http(source.rpcUrls[0]) });
      return c.getBlockNumber();
    },
    report,
  });

  const dedupCache = createDedupCache({
    capacity: options.dedupCapacity ?? config.infrastructure?.event_processor?.dedup_cache_size ?? DEFAULTS.dedupCapacity,
    ttlMs: options.dedupTtlMs ?? parseDurationMs(config.infrastructure?.event_processor?.dedup_cache_ttl, DEFAULTS.dedupTtlMs),
  });

  const enricherClient = createPublicClient({ transport: http(source.rpcUrls[0]) });
  const enricher = createRegistryEnricher({
    client: enricherClient as PublicClient,
    registryAddress: source.registryAddress,
    enrichmentAbi: source.enrichmentAbi,
  });

  const handleBatch = async (batch: ScannedBatch): Promise<void> => {
    for (const event of batch.events) {
      await processOneEvent({ event, dedupCache, enricher, report });
    }
  };

  report(`scan: checkpoint=${path.resolve(checkpointPath)}`);
  report(
    `scan: transport=${transport}, chain_id=${source.chainId}, registry=${source.registryAddress}, contract_id=${source.registryContractId}`,
  );

  try {
    switch (transport) {
      case "http":
        await runHttpTransport({ ...options, config, source, checkpoint, handleBatch, signal });
        break;
      case "ws":
        await runWsTransport({ ...options, config, source, checkpoint, handleBatch, signal });
        break;
    }
    return 0;
  } catch (error) {
    report(`scan: aborted with error — ${(error as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Transports.
// ---------------------------------------------------------------------------

type TransportInputs = ScanCmdOptions & {
  config: ModularConfig;
  source: ResolvedSource;
  checkpoint: Checkpoint;
  handleBatch: (batch: ScannedBatch) => Promise<void>;
};

async function runHttpTransport(inputs: TransportInputs): Promise<void> {
  const infra = inputs.config.infrastructure;
  const client: RegistryClient = createHttpRegistryClient(inputs.source);
  try {
    await runHttpScanner({
      client,
      eventAbi: inputs.source.eventAbi,
      checkpoint: inputs.checkpoint,
      startBlock:
        inputs.startBlock ??
        (infra?.source?.start_block !== undefined ? BigInt(infra.source.start_block) : DEFAULTS.startBlock),
      blockRange:
        inputs.blockRange ??
        (infra?.block_scanner?.block_range !== undefined ? BigInt(infra.block_scanner.block_range) : DEFAULTS.blockRange),
      scanIntervalMs: inputs.scanIntervalMs ?? parseDurationMs(infra?.block_scanner?.scan_interval, DEFAULTS.scanIntervalMs),
      confirmations:
        inputs.confirmations ??
        (infra?.block_scanner?.confirmations !== undefined ? BigInt(infra.block_scanner.confirmations) : DEFAULTS.confirmations),
      onBatch: inputs.handleBatch,
      log: inputs.report,
      signal: inputs.signal,
    });
  } finally {
    await client.close();
  }
}

function parseDurationMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const num = parseFloat(trimmed);
  if (Number.isNaN(num)) return fallback;
  if (trimmed.endsWith("ms")) return Math.round(num);
  if (trimmed.endsWith("s")) return Math.round(num * 1_000);
  if (trimmed.endsWith("m")) return Math.round(num * 60_000);
  if (trimmed.endsWith("h")) return Math.round(num * 3_600_000);
  return Math.round(num * 1_000);
}

async function runWsTransport(inputs: TransportInputs): Promise<void> {
  if (!inputs.source.wsUrl) {
    throw new Error(
      "infrastructure.source.ws_url not set in YAML — use --transport http or add ws_url to infrastructure.<network>.yaml.",
    );
  }
  const wsUrl = composeAuthenticatedWsUrl(inputs.source.wsUrl, inputs.network);
  await runWsScanner({
    wsUrl,
    registryAddress: inputs.source.registryAddress,
    eventAbi: inputs.source.eventAbi,
    checkpoint: inputs.checkpoint,
    onBatch: inputs.handleBatch,
    reconnectIntervalMs: inputs.reconnectIntervalMs ?? DEFAULTS.reconnectIntervalMs,
    maxReconnects: inputs.maxReconnects ?? DEFAULTS.maxReconnects,
    log: inputs.report,
    signal: inputs.signal,
  });
}

// ---------------------------------------------------------------------------
// Per-event processing — dedup → enrich → render.
// ---------------------------------------------------------------------------

type ProcessOneEventInputs = {
  event: ExtractedEvent;
  dedupCache: DedupCache;
  enricher: (event: ExtractedEvent) => Promise<EnrichedIntent>;
  report: (line: string) => void;
};

async function processOneEvent(inputs: ProcessOneEventInputs): Promise<void> {
  const { event, dedupCache, enricher, report } = inputs;

  if (!dedupCache.add(event.intentHash)) {
    report(`scan: dedup hit ${event.intentHash} (skipped)`);
    return;
  }

  let enriched: EnrichedIntent;
  try {
    enriched = await enricher(event);
  } catch (error) {
    report(
      `scan: enrichment failed for ${event.intentHash} (tx ${event.txHash}): ${(error as Error).message}`,
    );
    return;
  }

  const transformed = identityTransformer(enriched);
  report(renderEnrichedIntent(transformed));
}

/** Single-line, human-readable summary plus the full intent as JSON
 *  so operators can grep both ways. The summary prefers the enriched
 *  symbol (a readable string) over the event's `symbolHash` topic
 *  (a keccak digest that is not human-meaningful). */
function renderEnrichedIntent(enriched: EnrichedIntent): string {
  const { event, fullIntent } = enriched;
  const summary =
    `scan: routed ${fullIntent.symbol} price=${fullIntent.price} ts=${fullIntent.timestamp} ` +
    `signer=${event.signer} intentHash=${event.intentHash} ` +
    `block=${event.blockNumber} tx=${event.txHash}#${event.logIndex}`;
  const detail = JSON.stringify(enriched, bigintReplacer);
  return `${summary}\n  ${detail}`;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Print every issue and return the error-severity count. Used by
 *  `runScan` to refuse to start when the validator surfaces errors. */
function renderAndCountErrors(
  issues: ValidationIssue[],
  report: (line: string) => void,
): number {
  let errorCount = 0;
  for (const issue of issues) {
    const tag = issue.severity === "error" ? "ERROR" : "WARN ";
    report(`[${tag}] ${issue.path || "(root)"}: ${issue.message}`);
    if (issue.severity === "error") errorCount += 1;
  }
  return errorCount;
}
