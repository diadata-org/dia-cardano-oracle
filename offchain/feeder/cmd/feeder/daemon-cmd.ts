// `daemon` command implementation — long-running feeder process.
//
// Composes every subsystem in order:
//
//   config load + validate
//     ↓
//   API server    (health / readyz / metrics / prices)
//     ↓
//   router registry + price cache
//     ↓
//   queue manager  (one serial queue per Cardano destination)
//     ↓
//   scan pipeline  (scanner → dedup → enricher → router → queue)
//
// The write client is dependency-injected via `OracleIntentBridge`.
// In dry-run mode the bridge is a no-op stub so the full routing
// pipeline can be exercised without touching Cardano.
//
// env vars consumed:
//   CARDANO_NETWORK          resolved before this function is called.
//   DRY_RUN                  skip actual Cardano submissions.
//   DATABASE_DRIVER          sqlite (default) | postgres
//   DATABASE_PATH_TESTNET    SQLite file path for Preview network.
//   DATABASE_PATH_MAINNET    SQLite file path for Mainnet network.
//   DATABASE_DSN_TESTNET     Postgres DSN for Preview.
//   DATABASE_DSN_MAINNET     Postgres DSN for Mainnet.
//   API_LISTEN_ADDR          host:port — default ":8080".
//   METRICS_ENABLED          "true" to enable prom-client metrics.
//   METRICS_NAMESPACE        metric name prefix — default "dia_feeder".

import path from "node:path";

import { createPublicClient, http, type PublicClient } from "viem";

import {
  loadModularConfig,
  validateModularConfig,
  type ModularConfig,
  type InfrastructureConfig,
  type ValidationIssue,
} from "../../src/config/index.js";
import { createRegistryEnricher, identityTransformer } from "../../src/pipeline/index.js";
import {
  createDedupCache,
  createPriceCache,
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
import {
  createRouterRegistry,
  routeIntent,
} from "../../src/router/index.js";
import {
  createQueueManager,
  type QueueManager,
} from "../../src/submitter/index.js";
import type { SubmitRequest, SubmitResult } from "../../src/submitter/types.js";
import type { OracleIntentBridge } from "../../src/lib-bridge/index.js";
import { createRealOracleIntentBridge } from "../../src/lib-bridge/index.js";
import { createCardanoWriteClient } from "../../src/submitter/cardano-write-client.js";
import type { CardanoDestinationConfig } from "../../src/config/types.js";
import {
  createApiServer,
  createMetrics,
  noopMetrics,
  type HealthState,
} from "../../src/api/index.js";
import { createDb, type DbConfig } from "../../src/persistence/index.js";
import { createFileLogger, type FileLogger, type IntentLogEntry } from "../../src/logger/file-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonCmdOptions = {
  network: CardanoNetwork;
  configPath: string;
  transport: "http" | "ws";
  dryRun: boolean;
  logLevel: string;
  report: (line: string) => void;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Duration parser  "10s" | "5m" | "1h" → milliseconds
// ---------------------------------------------------------------------------
function parseDurationMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  const num = parseFloat(trimmed);
  if (isNaN(num)) return fallback;
  if (trimmed.endsWith("ms")) return Math.round(num);
  if (trimmed.endsWith("s"))  return Math.round(num * 1_000);
  if (trimmed.endsWith("m"))  return Math.round(num * 60_000);
  if (trimmed.endsWith("h"))  return Math.round(num * 3_600_000);
  return Math.round(num * 1_000); // bare number → seconds
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runDaemon(options: DaemonCmdOptions): Promise<number> {
  const { network, configPath, transport, report: reportToConsole, signal } = options;
  
  // Mutable report - starts as console-only, gets wrapped after fileLogger ready
  let report = reportToConsole;

  // ------------------------------------------------------------------
  // 1. Load + validate config.
  // ------------------------------------------------------------------
  report(`daemon: loading config at ${configPath} for network=${network}`);
  let config: ModularConfig;
  try {
    config = await loadModularConfig({ baseDir: configPath, network });
  } catch (err) {
    report(`daemon: config load failed — ${(err as Error).message}`);
    return 1;
  }

  const issues = validateModularConfig(config);
  if (countErrors(issues, report) > 0) {
    report("daemon: refusing to start — fix config errors above.");
    return 1;
  }

  // dry_run: YAML true || CLI --dry-run flag || DRY_RUN=true env var.
  const dryRun =
    config.infrastructure?.dry_run === true ||
    options.dryRun ||
    process.env.DRY_RUN?.trim().toLowerCase() === "true";

  let source: ResolvedSource;
  try {
    source = resolveSourceFromConfig(config);
  } catch (err) {
    report(`daemon: source resolution failed — ${(err as Error).message}`);
    return 1;
  }

  // ------------------------------------------------------------------
  // 2. Database.
  // ------------------------------------------------------------------
  const dbConfig = resolveDbConfig(network);
  const db = await createDb(dbConfig);
  await db.migrate();
  report(`daemon: database driver=${dbConfig.driver} ready`);

  // ------------------------------------------------------------------
  // 2b. File logger — structured JSON logs per intent/transaction.
  // ------------------------------------------------------------------
  const logDir = process.env.FEEDER_LOG_DIR?.trim() ?? `state/${network.toLowerCase()}/logs`;
  const fileLogger: FileLogger = await createFileLogger(logDir);
  
  // Wrap report to write to both console and file
  report = fileLogger.getReportingFn(reportToConsole);
  
  report(`daemon: file logger ready at ${logDir}`);

  // ------------------------------------------------------------------
  // 3. Metrics — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const metricsEnabledYaml = config.infrastructure?.metrics?.enabled;
  const metricsEnabled =
    metricsEnabledYaml !== undefined
      ? metricsEnabledYaml
      : process.env.METRICS_ENABLED?.trim().toLowerCase() === "true";
  const metricsNamespace =
    config.infrastructure?.metrics?.namespace ??
    process.env.METRICS_NAMESPACE?.trim() ??
    "dia_feeder";
  const metrics = metricsEnabled
    ? await createMetrics({ namespace: metricsNamespace, defaultLabels: { network } })
    : noopMetrics;

  // ------------------------------------------------------------------
  // 4. Health state (mutated by the pipeline as it runs).
  // ------------------------------------------------------------------
  const healthState: HealthState = {
    lastRegistryPollMs: 0,
    lastSubmitMs: 0,
    maxStalenessMs: 5 * 60_000, // overwritten below after infra config is resolved
  };

  // ------------------------------------------------------------------
  // 5. Price cache.
  // ------------------------------------------------------------------
  const priceCache = createPriceCache();

  // ------------------------------------------------------------------
  // 6. HTTP API server — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const { host: apiHost, port: apiPort } = resolveApiAddr(config.infrastructure?.api?.listen_addr);
  const apiServer = createApiServer({
    host: apiHost,
    port: apiPort,
    metrics,
    priceCache,
    healthState,
  });
  await apiServer.start();
  report(`daemon: API server listening on ${apiHost}:${apiPort}`);

  // ------------------------------------------------------------------
  // 7. Resolve all YAML knobs before any subsystem that needs them.
  // ------------------------------------------------------------------
  const infra: InfrastructureConfig =
    config.infrastructure ?? ({} as InfrastructureConfig);
  const scanIntervalMs   = parseDurationMs(infra.block_scanner?.scan_interval,   10_000);
  const blockRange       = BigInt(infra.block_scanner?.block_range               ?? 500);
  const startBlock       = BigInt(infra.source?.start_block                      ?? 0);
  const confirmations    = 6n; // not in Spectra schema — keep fixed
  const dedupCapacity    = infra.event_processor?.dedup_cache_size               ?? 4096;
  const dedupTtlMs       = parseDurationMs(infra.event_processor?.dedup_cache_ttl, 60 * 60_000);
  const reconnectMs      = parseDurationMs(infra.event_monitor?.reconnect_interval, 5_000);
  const maxReconnects    = infra.event_monitor?.max_reconnect_attempts           ?? 60;
  const maxStalenessMs   = parseDurationMs(infra.health_check?.max_processing_lag, 5 * 60_000);
  const taskTimeoutMs    = parseDurationMs(infra.worker_pool?.task_timeout,         60_000);
  const retryDelayMs     = parseDurationMs(infra.worker_pool?.retry_delay,           5_000);
  const maxRetries       = infra.worker_pool?.max_retries                           ?? 3;

  healthState.maxStalenessMs = maxStalenessMs;

  // ------------------------------------------------------------------
  // 8. Router registry.
  // ------------------------------------------------------------------
  const routerRegistry = createRouterRegistry(config.routers);
  report(`daemon: router registry loaded (${routerRegistry.all.length} router(s))`);

  // ------------------------------------------------------------------
  // 9. Oracle intent bridge + queue manager.
  // ------------------------------------------------------------------
  const bridge: OracleIntentBridge = dryRun
    ? makeDryRunBridge(report)
    : createRealOracleIntentBridge({ log: report });

  // Correlate submit results back to their originating requests so we can
  // update the price cache with symbol/price/timestamp (which live on the
  // enriched intent, not on the SubmitResult).
  const pendingRequests = new Map<string, SubmitRequest>();

  const queueManager: QueueManager = createQueueManager({
    clientFactory: (clientStatePath, protocolStatePath) =>
      createCardanoWriteClient(clientStatePath, protocolStatePath, { bridge, log: report }),
    taskTimeoutMs,
    retryDelayMs,
    maxRetries,
    onResult: async (result: SubmitResult) => {
      const req = pendingRequests.get(result.intentHash);
      pendingRequests.delete(result.intentHash);

      if (result.ok) {
        healthState.lastSubmitMs = Date.now();
        metrics.cardanoTxSubmitted.inc({ network });
        if (req) {
          const { routerId, destinationIndex, enriched } = req;
          const { symbol, price, timestamp } = enriched.fullIntent;
          priceCache.set(
            { routerId, destinationIndex, symbol },
            {
              symbol,
              price,
              timestamp,
              intentHash: result.intentHash,
              cardanoTxHash: result.cardanoTxHash,
              updatedAtMs: Date.now(),
            },
          );
          void db.updateTransactionLog(result.intentHash, result.cardanoTxHash, {
            status: "confirmed",
            confirmedAtMs: Date.now(),
          });
          // Log: transaction confirmed
          await fileLogger.logIntentStep({
            ts: new Date().toISOString(),
            level: "info",
            intentHash: result.intentHash,
            symbol,
            step: "confirm",
            message: `Cardano transaction confirmed`,
            meta: { cardanoTxHash: result.cardanoTxHash },
          });
        }
      } else {
        metrics.cardanoTxFailed.inc({ network });
        const symbol = req?.enriched.fullIntent.symbol ?? "unknown";
        report(`daemon: TRANSACTION FAILED — intentHash=${result.intentHash} symbol=${symbol} error="${result.error}"`);
        report(`daemon: WARNING — Queue continues but subsequent transactions may also fail until the issue is resolved.`);
        // Log: transaction failed
        await fileLogger.logIntentStep({
          ts: new Date().toISOString(),
          level: "error",
          intentHash: result.intentHash,
          symbol,
          step: "failed",
          message: `Cardano transaction failed: ${result.error}`,
          meta: { error: result.error },
        });
      }
    },
  });

  // ------------------------------------------------------------------
  // 10. Source pipeline.
  // ------------------------------------------------------------------
  const checkpointPath = defaultCheckpointPath(network);
  const checkpoint = createJsonCheckpoint({ filePath: checkpointPath });
  const dedupCache = createDedupCache({
    capacity: dedupCapacity,
    ttlMs: dedupTtlMs,
  });

  const enricherClient = createPublicClient({ transport: http(source.rpcUrls[0]) });
  const enricher = createRegistryEnricher({
    client: enricherClient as PublicClient,
    registryAddress: source.registryAddress,
    enrichmentAbi: source.enrichmentAbi,
  });

  const handleBatch = async (batch: ScannedBatch): Promise<void> => {
    healthState.lastRegistryPollMs = Date.now();
    metrics.eventsScanned.inc({ chain_id: String(source.chainId) });

    for (const event of batch.events) {
      await processOneEvent({
        event,
        dedupCache,
        enricher,
        routerRegistry,
        priceCache,
        queueManager,
        pendingRequests,
        db,
        fileLogger,
        network,
        dryRun,
        report,
        metrics,
      });
    }
  };

  report(
    `daemon: starting scan pipeline transport=${transport} chain_id=${source.chainId} ` +
    `registry=${source.registryAddress} dry_run=${dryRun} ` +
    `blockRange=${blockRange} scanIntervalMs=${scanIntervalMs} dedupCapacity=${dedupCapacity} ` +
    `reconnectMs=${reconnectMs} maxReconnects=${maxReconnects}`,
  );

  try {
    switch (transport) {
      case "http":
        await runHttpTransport({ source, checkpoint, handleBatch, signal, report,
          startBlock, blockRange, scanIntervalMs, confirmations });
        break;
      case "ws":
        await runWsTransport({ source, checkpoint, handleBatch, network, signal, report,
          reconnectIntervalMs: reconnectMs, maxReconnects });
        break;
    }
    report("daemon: scan pipeline exited cleanly.");
    return 0;
  } catch (err) {
    report(`daemon: scan pipeline failed — ${(err as Error).message}`);
    return 1;
  } finally {
    await apiServer.stop();
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Per-event processing
// ---------------------------------------------------------------------------

type ProcessOneEventInputs = {
  event: ExtractedEvent;
  dedupCache: ReturnType<typeof createDedupCache>;
  enricher: (event: ExtractedEvent) => Promise<EnrichedIntent>;
  routerRegistry: ReturnType<typeof createRouterRegistry>;
  priceCache: ReturnType<typeof createPriceCache>;
  queueManager: QueueManager;
  pendingRequests: Map<string, SubmitRequest>;
  db: Awaited<ReturnType<typeof createDb>>;
  fileLogger: FileLogger;
  network: string;
  dryRun: boolean;
  report: (line: string) => void;
  metrics: typeof noopMetrics;
};

async function processOneEvent(inputs: ProcessOneEventInputs): Promise<void> {
  const {
    event, dedupCache, enricher, routerRegistry,
    priceCache, queueManager, pendingRequests, db, fileLogger, dryRun, report, metrics,
  } = inputs;

  if (!dedupCache.add(event.intentHash)) {
    metrics.eventsDedupHit.inc({ chain_id: String(event.blockNumber) });
    return;
  }

  let enriched: EnrichedIntent;
  try {
    enriched = await enricher(event);
  } catch (err) {
    report(`daemon: enrichment failed for ${event.intentHash}: ${(err as Error).message}`);
    return;
  }

  const transformed = identityTransformer(enriched);
  const output = routeIntent(routerRegistry, priceCache, "IntentRegistered", transformed);

  for (const { routerId, reason } of output.conditionFiltered) {
    metrics.intentsFiltered.inc({ router_id: routerId, reason: "condition" });
    report(`daemon: condition-filtered router=${routerId} reason="${reason}"`);
    // Note: no file log for filtered intents - only terminal output
  }
  for (const { routerId, destinationIndex } of output.policyFiltered) {
    metrics.intentsFiltered.inc({ router_id: routerId, reason: "policy" });
    report(`daemon: policy-filtered router=${routerId} dest=${destinationIndex}`);
    // Note: no file log for filtered intents - only terminal output
  }

  for (const dispatch of output.dispatched) {
    metrics.intentsRouted.inc({ router_id: dispatch.routerId });

    const cardano = dispatch.destination.cardano;
    if (!cardano) {
      report(
        `daemon: skipping router=${dispatch.routerId} dest=${dispatch.destinationIndex} — no cardano block in destination config`,
      );
      continue;
    }

    // Log intent lifecycle start (only for intents that pass filters)
    const now = new Date().toISOString();
    
    // 1. enriched (await to ensure order)
    await fileLogger.logIntentStep({
      ts: now,
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "enriched",
      message: `Intent enriched: ${enriched.fullIntent.symbol} @ ${enriched.fullIntent.price.toString()}`,
      meta: { 
        price: enriched.fullIntent.price.toString(), 
        timestamp: enriched.fullIntent.timestamp.toString(),
        expiry: enriched.fullIntent.expiry.toString(),
        blockNumber: Number(event.blockNumber),
      },
    });
    
    // 2. routed (passed filters)
    await fileLogger.logIntentStep({
      ts: now,
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "routed",
      message: `Intent passed all filters`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex },
    });

    if (dryRun) {
      report(
        `daemon: [dry-run] would submit router=${dispatch.routerId} dest=${dispatch.destinationIndex} ` +
        `symbol=${enriched.fullIntent.symbol} price=${enriched.fullIntent.price} intentHash=${event.intentHash}`,
      );
      continue;
    }

    const req: SubmitRequest = {
      intentHash: event.intentHash,
      enriched: transformed,
      destination: cardano,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
    };

    inputs.pendingRequests.set(event.intentHash, req);

    // 3. submit
    await fileLogger.logIntentStep({
      ts: new Date().toISOString(),
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "submit",
      message: `Intent queued for Cardano submission`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex, clientStatePath: cardano.client_state_path },
    });

    void db.insertTransactionLog({
      intentHash: event.intentHash,
      cardanoTxHash: "",
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
      clientStatePath: cardano.client_state_path,
      status: "submitted",
      submittedAtMs: Date.now(),
    });

    void queueManager.submit(req);
  }
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

type TransportInputs = {
  source: ResolvedSource;
  checkpoint: Checkpoint;
  handleBatch: (batch: ScannedBatch) => Promise<void>;
  signal?: AbortSignal;
  report: (line: string) => void;
  network?: CardanoNetwork;
  // HTTP
  startBlock?: bigint;
  blockRange?: bigint;
  scanIntervalMs?: number;
  confirmations?: bigint;
  // WS
  reconnectIntervalMs?: number;
  maxReconnects?: number;
};

async function runHttpTransport(inputs: TransportInputs): Promise<void> {
  const client: RegistryClient = createHttpRegistryClient(inputs.source);
  try {
    await runHttpScanner({
      client,
      eventAbi: inputs.source.eventAbi,
      checkpoint: inputs.checkpoint,
      startBlock: inputs.startBlock ?? 0n,
      blockRange: inputs.blockRange ?? 500n,
      scanIntervalMs: inputs.scanIntervalMs ?? 10_000,
      confirmations: inputs.confirmations ?? 6n,
      onBatch: inputs.handleBatch,
      log: inputs.report,
      signal: inputs.signal,
    });
  } finally {
    await client.close();
  }
}

async function runWsTransport(inputs: TransportInputs & { network: CardanoNetwork }): Promise<void> {
  if (!inputs.source.wsUrl) {
    throw new Error(
      "infrastructure.source.ws_url not set — use --transport http or add ws_url to the infrastructure YAML.",
    );
  }
  const wsUrl = composeAuthenticatedWsUrl(inputs.source.wsUrl, inputs.network);
  await runWsScanner({
    wsUrl,
    registryAddress: inputs.source.registryAddress,
    eventAbi: inputs.source.eventAbi,
    checkpoint: inputs.checkpoint,
    onBatch: inputs.handleBatch,
    reconnectIntervalMs: inputs.reconnectIntervalMs ?? 5_000,
    maxReconnects: inputs.maxReconnects ?? 60,
    log: inputs.report,
    signal: inputs.signal,
  });
}

// ---------------------------------------------------------------------------
// Bridge stubs
// ---------------------------------------------------------------------------

function makeDryRunBridge(report: (line: string) => void): OracleIntentBridge {
  return {
    async submitOracleUpdate(params) {
      report(
        `daemon: [dry-run bridge] submitOracleUpdate intentHash=${params.intentHash} ` +
        `client=${params.clientStatePath}`,
      );
      return "dry-run-tx-hash";
    },
  };
}


// ---------------------------------------------------------------------------
// Config + env helpers
// ---------------------------------------------------------------------------

function resolveDbConfig(network: CardanoNetwork): DbConfig {
  const driver = (process.env.DATABASE_DRIVER?.trim() ?? "sqlite") as "sqlite" | "postgres";
  const suffix = network === "Mainnet" ? "MAINNET" : "TESTNET";

  if (driver === "postgres") {
    const dsn = process.env[`DATABASE_DSN_${suffix}`]?.trim();
    if (!dsn) {
      throw new Error(
        `DATABASE_DSN_${suffix} is required when DATABASE_DRIVER=postgres.`,
      );
    }
    return { driver: "postgres", dsn };
  }

  const defaultPath = `state/${network.toLowerCase()}/feeder.sqlite`;
  const filePath = process.env[`DATABASE_PATH_${suffix}`]?.trim() ?? defaultPath;
  return { driver: "sqlite", path: filePath };
}

/**
 * Resolve the API listen address. Priority (highest first):
 *   1. `infrastructure.api.listen_addr` in the network YAML
 *   2. `API_LISTEN_ADDR` env var
 *   3. hard default ":8080"
 */
function resolveApiAddr(yamlAddr?: string): { host: string; port: number } {
  const raw = yamlAddr?.trim() ?? process.env.API_LISTEN_ADDR?.trim() ?? ":8080";
  const colonIdx = raw.lastIndexOf(":");
  const host = colonIdx > 0 ? raw.slice(0, colonIdx) : "0.0.0.0";
  const port = parseInt(raw.slice(colonIdx + 1), 10) || 8080;
  return { host, port };
}

function countErrors(issues: ValidationIssue[], report: (line: string) => void): number {
  let n = 0;
  for (const issue of issues) {
    const tag = issue.severity === "error" ? "ERROR" : "WARN ";
    report(`[${tag}] ${issue.path || "(root)"}: ${issue.message}`);
    if (issue.severity === "error") n++;
  }
  return n;
}
