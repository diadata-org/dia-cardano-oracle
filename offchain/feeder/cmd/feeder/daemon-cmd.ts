// `daemon` command implementation — long-running feeder process.
//
// Composes every subsystem in order:
//
//   config load + validate
//     ↓
//   API server    (health / metrics / prices / symbols / chains / txs)
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
//   METRICS_NAMESPACE        metric name prefix — default "dia_bridge".

import { access, rm, readdir } from "node:fs/promises";

import { seedCheckpointIfNeeded } from "./checkpoint-seed.js";

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
  createLatestIntentCache,
  startCronService,
  type LatestIntentCache,
} from "../../src/cron/index.js";
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
  type ScannerMetricsSink,
} from "../../src/source/index.js";
import {
  createRouterRegistry,
  routeIntent,
} from "../../src/router/index.js";
import {
  createQueueManager,
  createCoalescerManager,
  type CoalescerManager,
} from "../../src/submitter/index.js";
import type { SubmitRequest, SubmitResult } from "../../src/submitter/types.js";
import type { OracleIntentBridge } from "../../src/lib-bridge/index.js";
import { createRealOracleIntentBridge } from "../../src/lib-bridge/index.js";
import { reconcileAllDestinations } from "../../src/lib-bridge/reconcile.js";
import { createCardanoWriteClient } from "../../src/submitter/cardano-write-client.js";
import {
  createApiServer,
  createChainRuntimeState,
  createMetrics,
  noopMetrics,
  type FeederMetrics,
  type HealthState,
} from "../../src/api/index.js";
import { createDb, type Db, type DbConfig } from "../../src/persistence/index.js";
import { createFileLogger, type FileLogger } from "../../src/logger/file-logger.js";
import { runPreflight } from "../../src/submitter/preflight.js";
import { createDefaultRetryPolicy } from "../../src/submitter/retry-policy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DaemonCmdOptions = {
  network: CardanoNetwork;
  configPath: string;
  transport: "http" | "ws";
  dryRun: boolean;
  cleanState: boolean;
  logLevel: string;
  fromBlock?: string;
  fromLatest: boolean;
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

type IntentRuntimeEntry = {
  observedAtMs: number;
  routerId: string;
  destinationIndex: number;
  clientStatePath: string;
  clientId: string;
  symbol: string;
  submittedAtMs?: number;
};

function clientIdFromStatePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

function parsePositiveInteger(raw: number | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  return Math.max(1, Math.floor(raw));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Delete all feeder-generated state for the given network so the next
 * run starts clean.  Never touches CLI bootstrap artifacts:
 *   config-bootstrap.json, clients/<name>.json.
 *
 * Deleted:
 *   state/<network>/logs/                    (all log streams)
 *   state/<network>/feeder-checkpoint.json   (block scanner position)
 *   state/<network>/feeder.sqlite*           (SQLite DB + WAL files)
 *   state/<network>/clients/*\/pairs/*.json  (feeder-written pair state)
 */
// ---------------------------------------------------------------------------
// Log-level filter
// ---------------------------------------------------------------------------

type LogLevelStr = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevelStr, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

/**
 * Wrap a base reporter so only messages at or above `minLevel` reach it.
 *
 * Messages may carry an explicit level prefix — `[debug]`, `[info]`,
 * `[warn]`, `[error]` — that is stripped before forwarding so the output
 * stays clean.  Messages with no prefix are treated as `info`.
 *
 * Scanner block-delivery lines (`scanner-ws:`, `scanner-http:`) are
 * automatically treated as `debug` regardless of any prefix.
 *
 * The file logger always receives the raw (prefixed) line so the full
 * record is preserved for post-hoc analysis.
 */
function createLeveledReport(
  base: (line: string) => void,
  minLevel: LogLevelStr,
): (line: string) => void {
  const min = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;
  return (line: string) => {
    let msgLevel: LogLevelStr = "info";
    let stripped = line;
    for (const lv of Object.keys(LEVEL_ORDER) as LogLevelStr[]) {
      const tag = `[${lv}] `;
      if (line.startsWith(tag)) {
        msgLevel = lv;
        stripped = line.slice(tag.length);
        break;
      }
    }
    if (stripped.startsWith("scanner-ws:") || stripped.startsWith("scanner-http:")) {
      msgLevel = "debug";
    }
    if (LEVEL_ORDER[msgLevel] >= min) {
      base(stripped);
    }
  };
}

export async function cleanFeederState(
  network: string,
  report: (line: string) => void,
  stateBase = "state",
): Promise<void> {
  const base = `${stateBase}/${network.toLowerCase()}`;

  const targets: string[] = [
    `${base}/logs`,
    `${base}/feeder-checkpoint.json`,
    `${base}/feeder.sqlite`,
    `${base}/feeder.sqlite-shm`,
    `${base}/feeder.sqlite-wal`,
  ];

  // Pair state files: state/<network>/clients/*/pairs/*.json
  const clientsDir = `${base}/clients`;
  try {
    const clientEntries = await readdir(clientsDir, { withFileTypes: true });
    for (const entry of clientEntries) {
      if (!entry.isDirectory()) continue;
      const pairsDir = `${clientsDir}/${entry.name}/pairs`;
      try {
        const pairFiles = await readdir(pairsDir, { withFileTypes: true });
        for (const pf of pairFiles) {
          if (pf.isFile() && pf.name.endsWith(".json")) {
            targets.push(`${pairsDir}/${pf.name}`);
          }
        }
      } catch {
        // no pairs dir for this client
      }
    }
  } catch {
    // no clients dir
  }

  for (const path of targets) {
    try {
      await rm(path, { recursive: true, force: true });
      report(`clean: removed ${path}`);
    } catch (err) {
      report(`clean: could not remove ${path} — ${(err as Error).message}`);
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export async function checkBootstrapArtifacts(
  config: ModularConfig,
  network: string,
  report: (line: string) => void,
  stateBase = "state",
): Promise<boolean> {
  const bootstrapPath = `${stateBase}/${network.toLowerCase()}/config-bootstrap.json`;
  if (!await fileExists(bootstrapPath)) {
    report(`daemon: missing bootstrap artifact: ${bootstrapPath}`);
    report(`daemon: hint → npm run feeder:dev -- init bootstrap`);
    return false;
  }
  for (const [routerId, router] of Object.entries(config.routers)) {
    for (const dest of router.destinations) {
      if (dest.cardano) {
        const clientPath = dest.cardano.client_state_path;
        if (!await fileExists(clientPath)) {
          report(`daemon: router "${routerId}": missing client state: ${clientPath}`);
          report(`daemon: hint → npm run feeder:dev -- init client`);
          return false;
        }
      }
    }
  }
  return true;
}

export async function runDaemon(options: DaemonCmdOptions): Promise<number> {
  const { network, configPath, transport, report: reportToConsole, signal } = options;

  const logLevel = (options.logLevel in LEVEL_ORDER
    ? options.logLevel as LogLevelStr
    : "info");
  const leveledConsole = createLeveledReport(reportToConsole, logLevel);

  if (options.cleanState) {
    leveledConsole(`daemon: --clean requested — deleting feeder state for network=${network}`);
    await cleanFeederState(network, leveledConsole);
    leveledConsole(`daemon: clean complete`);
  }

  // Mutable report — starts as leveled console, gets wrapped after fileLogger ready.
  // File always receives the full line (with level prefix intact for analysis).
  let report = leveledConsole;

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

  // ------------------------------------------------------------------
  // 1b. Bootstrap artifact check — fast-fail with actionable hint.
  // ------------------------------------------------------------------
  if (!await checkBootstrapArtifacts(config, network, report)) return 1;

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
  
  // After fileLogger is ready, wrap so the file gets all lines (unfiltered)
  // while the console keeps the level filter applied above.
  report = fileLogger.getReportingFn(leveledConsole);
  
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
    "dia_bridge";
  const metrics = metricsEnabled
    ? await createMetrics({
        namespace: metricsNamespace,
        defaultLabels: {
          destination_chain: "cardano",
          network,
          source_chain_id: String(source.chainId),
        },
      })
    : noopMetrics;

  // ------------------------------------------------------------------
  // 4. Health state (mutated by the pipeline as it runs).
  // ------------------------------------------------------------------
  const healthState: HealthState = {
    lastRegistryPollMs: 0,
    lastConfirmedMs: 0,
    maxStalenessMs: 5 * 60_000, // overwritten below after infra config is resolved
    maxLastConfirmedAgeMs: 0,
  };

  // ------------------------------------------------------------------
  // 5. Price cache.
  // ------------------------------------------------------------------
  const priceCache = createPriceCache();
  // Latest-intent cache feeds the cron service. Updated on every
  // enriched intent (filtered or dispatched) so cron has the freshest
  // payload to re-submit when the on-chain pair goes stale.
  const latestIntents = createLatestIntentCache();
  const chainRuntime = createChainRuntimeState();
  const intentRuntime = new Map<string, IntentRuntimeEntry>();

  // ------------------------------------------------------------------
  // 6. HTTP API server — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const { host: apiHost, port: apiPort } = resolveApiAddr(config.infrastructure?.api);
  const apiServer = createApiServer({
    host: apiHost,
    port: apiPort,
    config,
    db,
    metrics,
    priceCache,
    chainRuntime,
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
  const confirmations    = BigInt(infra.block_scanner?.confirmations             ?? 6);
  // Spectra-parity gap recovery (Etapa B.1). Switches the HTTP scanner
  // into a fast catch-up mode (5000-block chunks, no scan_interval sleep
  // between chunks) whenever `head - cursor > max_block_gap`. Defaults
  // preserve current behaviour for installations that have not opted in.
  const backwardSync     = infra.block_scanner?.backward_sync === true;
  const maxBlockGap      = BigInt(infra.block_scanner?.max_block_gap             ?? 5000);
  const dedupCapacity    = infra.event_processor?.dedup_cache_size               ?? 4096;
  const dedupTtlMs       = parseDurationMs(infra.event_processor?.dedup_cache_ttl, 60 * 60_000);
  const reconnectMs      = parseDurationMs(infra.event_monitor?.reconnect_interval, 5_000);
  const maxReconnects    = infra.event_monitor?.max_reconnect_attempts           ?? 60;
  const maxStalenessMs   = parseDurationMs(infra.health_check?.max_processing_lag, 5 * 60_000);
  const maxLastConfirmedAgeMs = parseDurationMs(
    config.infrastructure?.api?.readiness?.max_last_confirmed_age,
    0,
  );
  const retryDelayMs = parseDurationMs(infra.worker_pool?.retry_delay, 0);
  if (retryDelayMs === 0) {
    throw new Error(
      "daemon: infrastructure.worker_pool.retry_delay is required (no silent default).",
    );
  }
  const maxRetries = infra.worker_pool?.max_retries;
  if (maxRetries === undefined) {
    throw new Error(
      "daemon: infrastructure.worker_pool.max_retries is required (no silent default).",
    );
  }
  const inflightTimeoutMs = infra.worker_pool?.inflight_timeout_ms;
  if (inflightTimeoutMs === undefined) {
    throw new Error(
      "daemon: infrastructure.worker_pool.inflight_timeout_ms is required (no silent default).",
    );
  }
  const cardanoConfirmationDepth = infra.cardano?.confirmation_depth ?? 1;

  // Alerting thresholds — validated as required at config load. The
  // values come from `infrastructure.<network>.yaml::alerting` and are
  // the canonical source mirrored by `monitoring/alerts.yml`. See the
  // README "Thresholds and alerts" section for the full table.
  const alerting = infra.alerting;
  if (!alerting) {
    throw new Error(
      "daemon: infrastructure.alerting block is required (see infrastructure.<network>.yaml).",
    );
  }
  const receiverBalanceLowLovelace = BigInt(alerting.receiver_balance_low_lovelace!);

  healthState.maxStalenessMs = maxStalenessMs;
  healthState.maxLastConfirmedAgeMs = maxLastConfirmedAgeMs;

  // ------------------------------------------------------------------
  // 8. Router registry.
  // ------------------------------------------------------------------
  const routerRegistry = createRouterRegistry(config.routers);
  report(`daemon: router registry loaded (${routerRegistry.all.length} router(s))`);

  // ------------------------------------------------------------------
  // 9. Oracle intent bridge + queue manager.
  // ------------------------------------------------------------------
  // Bridge internals (UTxO fetches, Lucid calls) and write-client step
  // logs are debug-level — too verbose for normal operation.
  const debugReport = (line: string) => report(`[debug] ${line}`);

  const bridge: OracleIntentBridge = dryRun
    ? makeDryRunBridge(report)
    : createRealOracleIntentBridge({
        log: debugReport,
        confirmationDepth: cardanoConfirmationDepth,
      });

  const retryPolicy = createDefaultRetryPolicy({ maxRetries, delayMs: retryDelayMs });

  const queueManager = createQueueManager({
    clientFactory: (clientStatePath, protocolStatePath) =>
      createCardanoWriteClient(clientStatePath, protocolStatePath, {
        bridge,
        log: debugReport,
        onStep: (intentHash, symbol, step, txHash) => {
          const runtime = intentRuntime.get(intentHash);
          if (step === "submitted" && txHash && runtime && runtime.submittedAtMs === undefined) {
            runtime.submittedAtMs = Date.now();
            metrics.transactionsSubmitted.inc({ symbol, client_id: runtime.clientId });
            metrics.processingToSubmissionSeconds.observe(
              { symbol, client_id: runtime.clientId },
              (runtime.submittedAtMs - runtime.observedAtMs) / 1_000,
            );
            void db.insertTransactionLog({
              intentHash,
              cardanoTxHash: txHash,
              routerId: runtime.routerId,
              destinationIndex: runtime.destinationIndex,
              clientStatePath: runtime.clientStatePath,
              status: "submitted",
              submittedAtMs: runtime.submittedAtMs,
            });
          }
          if (step !== "tx_start") {
            void fileLogger.logIntentStep({
              ts: new Date().toISOString(), level: "info",
              intentHash, symbol, step, message: step,
              meta: txHash ? { txHash } : undefined,
            });
          }
          void fileLogger.logTransactionEvent({
            ts: new Date().toISOString(),
            event: step, intentHash, symbol,
            txHash,
          });
        },
        onTransaction: async (entry) => {
          await fileLogger.logTransactionEvent({
            ts: entry.ts,
            event: entry.status === "confirmed" ? "tx_confirmed" : "tx_failed",
            intentHash: entry.intentHash,
            symbol: entry.symbol,
            txHash: entry.txHash || undefined,
            isCreate: entry.isCreate,
            total_ms: entry.total_ms,
            errorCode: entry.errorCode,
            errorMessage: entry.errorMessage,
            batch: entry.batch,
          });
          await fileLogger.logTransaction(entry);
        },
      }),
    inflightTimeoutMs,
    retryPolicy,
  });

  const coalesceWindowMs = parseDurationMs(infra.event_processor?.coalesce_window, 2_000);
  const maxIntentAgeRaw  = infra.event_processor?.max_intent_age;
  const maxIntentAgeMs   = maxIntentAgeRaw ? parseDurationMs(maxIntentAgeRaw, 0) || undefined : undefined;
  const maxBatchSize = parsePositiveInteger(infra.event_processor?.max_batch_size);
  const sizeFallbackEnabled = infra.event_processor?.size_fallback_enabled === true;

  const coalescerManager = createCoalescerManager({
    queueManager,
    coalesceWindowMs,
    maxIntentAgeMs,
    maxBatchSize,
    sizeFallbackEnabled,
    onResult: async (result: SubmitResult, req: SubmitRequest) => {
      const nowMs = Date.now();
      const clientId = clientIdFromStatePath(req.destination.client_state_path);
      const runtime = intentRuntime.get(result.intentHash);
      if (result.ok) {
        healthState.lastConfirmedMs = nowMs;
        const { routerId, destinationIndex, enriched } = req;
        const { symbol, price, timestamp } = enriched.fullIntent;
        const batchSize = result.batch?.size ?? 1;
        const batchMember = result.batch?.members.find((member) => member.intentHash === result.intentHash);
        metrics.transactionsConfirmed.inc({ symbol, client_id: clientId });
        if (runtime?.submittedAtMs !== undefined) {
          metrics.submissionToConfirmationSeconds.observe(
            { symbol, client_id: clientId },
            (nowMs - runtime.submittedAtMs) / 1_000,
          );
        }
        if (runtime) {
          metrics.endToEndLatencySeconds.observe(
            { symbol, client_id: clientId },
            (nowMs - runtime.observedAtMs) / 1_000,
          );
        }
        priceCache.set(
          { routerId, destinationIndex, symbol },
          {
            symbol,
            price,
            timestamp,
            intentHash: result.intentHash,
            cardanoTxHash: result.cardanoTxHash,
            confirmedAtDepth: cardanoConfirmationDepth,
            updatedAtMs: nowMs,
          },
        );
        metrics.cardanoOracleLastConfirmedTimestampSeconds.set(
          { symbol, client_id: clientId },
          Number(timestamp),
        );
        metrics.cardanoPairIsCreate.set(
          { symbol, client_id: clientId },
          (batchMember?.action ?? result.pairAction) === "mint" ? 1 : 0,
        );

        // Post-confirm balance gauges. The bridge captures these by
        // re-querying chain state after the new UTxOs settle (see
        // capturePostConfirmState in lib-bridge/index.ts). Each field is
        // optional — emit only when defined so a chain provider hiccup
        // does not surface as a misleading 0-value gauge.
        const postState = result.postState;
        if (postState?.receiverBalanceLovelace !== undefined) {
          metrics.cardanoReceiverBalanceLovelace.set(
            { client_id: clientId },
            Number(postState.receiverBalanceLovelace),
          );
          if (postState.receiverBalanceLovelace < receiverBalanceLowLovelace) {
            metrics.cardanoReceiverTopupWarnings.inc({ client_id: clientId });
          }
        }
        if (postState?.receiverAccruedLovelace !== undefined) {
          metrics.cardanoReceiverAccruedLovelace.set(
            { client_id: clientId },
            Number(postState.receiverAccruedLovelace),
          );
        }
        if (postState?.paymentHookAccruedLovelace !== undefined) {
          metrics.cardanoPaymentHookAccruedLovelace.set(
            {},
            Number(postState.paymentHookAccruedLovelace),
          );
        }
        if (postState?.adminWalletLovelace !== undefined) {
          metrics.cardanoAdminWalletLovelace.set(
            {},
            Number(postState.adminWalletLovelace),
          );
        }

        void db.updateTransactionLog(result.intentHash, result.cardanoTxHash, {
          status: "confirmed",
          confirmedAtMs: nowMs,
        });
        if (result.batch && result.batch.size > 1) {
          await fileLogger.logIntentStep({
            ts: new Date().toISOString(),
            level: "info",
            intentHash: result.intentHash,
            symbol,
            step: "batched",
            message: `Intent confirmed inside a batch of ${result.batch.size} intents`,
            meta: {
              cardanoTxHash: result.cardanoTxHash,
              batchSize: result.batch.size,
              batchMembers: result.batch.members,
              pairUnit: batchMember?.pairUnit ?? result.pairUnit,
              pairAction: batchMember?.action ?? result.pairAction,
            },
          });
        }
        await fileLogger.logIntentStep({
          ts: new Date().toISOString(),
          level: "info",
          intentHash: result.intentHash,
          symbol,
          step: "confirm",
          message:
            batchSize > 1
              ? `Cardano batch transaction confirmed`
              : `Cardano transaction confirmed`,
          meta: {
            cardanoTxHash: result.cardanoTxHash,
            pairUnit: batchMember?.pairUnit ?? result.pairUnit,
            pairAction: batchMember?.action ?? result.pairAction,
            batchSize,
          },
        });
        intentRuntime.delete(result.intentHash);
      } else {
        const symbol = req.enriched.fullIntent.symbol;
        const batchSize = result.batch?.size ?? 1;
        metrics.transactionsFailed.inc({
          symbol,
          client_id: clientId,
          error_code: result.code,
        });
        if (result.code === "TxDroppedFromChain") {
          metrics.transactionsReorg.inc({ symbol, client_id: clientId });
        }
        report(
          `[error] daemon: TRANSACTION FAILED — code=${result.code} intentHash=${result.intentHash} ` +
          `symbol=${symbol} batchSize=${batchSize} error="${result.error.message}"`,
        );
        report(`[warn] daemon: REMEDIATION — ${result.remediation}`);
        void db.insertTransactionLog({
          intentHash: result.intentHash,
          cardanoTxHash: "",
          routerId: req.routerId,
          destinationIndex: req.destinationIndex,
          clientStatePath: req.destination.client_state_path,
          status: "failed",
          submittedAtMs: Date.now(),
        });
        await fileLogger.logIntentStep({
          ts: new Date().toISOString(),
          level: "error",
          intentHash: result.intentHash,
          symbol,
          step: "failed",
          message: `Cardano transaction failed: ${result.error.message}`,
          meta: {
            code: result.code,
            remediation: result.remediation,
            error: result.error.message,
            batchSize,
            batchMembers: result.batch?.members,
          },
        });
        intentRuntime.delete(result.intentHash);
      }
    },
    onSupersede: async (superseded: SubmitRequest, by: SubmitRequest) => {
      await fileLogger.logIntentStep({
        ts: new Date().toISOString(), level: "info",
        intentHash: superseded.intentHash,
        symbol: superseded.enriched.fullIntent.symbol,
        step: "superseded",
        message: `Superseded by newer intent`,
        meta: { supersededByHash: by.intentHash },
      });
    },
    onLaneEvent: async (event) => {
      await fileLogger.logLaneEvent({
        ts: new Date().toISOString(),
        lane: event.lane,
        event: event.kind,
        symbol: event.symbol,
        intentHash: event.intentHash,
        supersededByHash: event.supersededByHash,
        bufferSize: event.bufferSize,
        fromState: event.fromState,
        toState: event.toState,
      });
    },
  });

  // ------------------------------------------------------------------
  // 9.4. Cron service — Spectra parity. Re-submits the latest known
  //      intent for any cron-enabled destination whose on-chain pair
  //      has gone stale beyond its `time_threshold`. The service runs
  //      alongside the scan pipeline; when disabled it is a no-op.
  // ------------------------------------------------------------------
  const cronEnabled = config.infrastructure?.cron_service?.enabled === true;
  const cronTickIntervalMs = parseDurationMs(
    config.infrastructure?.cron_service?.tick_interval,
    30_000,
  );
  const cronHandle = startCronService({
    enabled: cronEnabled,
    tickIntervalMs: cronTickIntervalMs,
    routers: config.routers,
    latestIntents,
    priceCache,
    submit: (req) => queueManager.submit(req),
    metrics,
    log: report,
    signal,
  });
  // Keep the handle reachable from the daemon-level shutdown path; not
  // strictly required because the signal aborts the loop, but the
  // reference prevents the linter from flagging an unused binding.
  void cronHandle;

  // ------------------------------------------------------------------
  // 9.5. Startup reconciliation — sync local pair-state files with the
  //      live on-chain pair UTxOs for every Cardano destination. Runs
  //      once before the scan pipeline starts. Failures are logged as
  //      warnings; they do not abort startup.
  // ------------------------------------------------------------------
  if (!dryRun) {
    await reconcileAllDestinations({ config, log: report });
  }

  // ------------------------------------------------------------------
  // 10. Source pipeline.
  // ------------------------------------------------------------------
  const checkpointPath = defaultCheckpointPath(network);
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
    const observedAtMs = Date.now();
    healthState.lastRegistryPollMs = observedAtMs;
    metrics.eventsDetected.inc({ scanner_type: transport }, batch.events.length);
    chainRuntime.set({
      chainId: source.chainId,
      scannerType: transport,
      headBlock: batch.toBlock,
    });
    metrics.scannerLastBlock.set(
      { chain_id: String(source.chainId), scanner_type: transport },
      Number(batch.toBlock),
    );

    for (const event of batch.events) {
      await processOneEvent({
        event,
        observedAtMs,
        scannerType: transport,
        dedupCache,
        enricher,
        routerRegistry,
        priceCache,
        latestIntents,
        coalescerManager,
        fileLogger,
        db,
        intentRuntime,
        network,
        dryRun,
        report,
        metrics,
      });
    }
    await db.setLastProcessedBlock(source.chainId, source.registryContractId, batch.toBlock);
    metrics.scannerBlockLag.set({ chain_id: String(source.chainId) }, 0);
  };

  report(
    `daemon: starting scan pipeline transport=${transport} chain_id=${source.chainId} ` +
    `registry=${source.registryAddress} dry_run=${dryRun} ` +
    `blockRange=${blockRange} scanIntervalMs=${scanIntervalMs} dedupCapacity=${dedupCapacity} ` +
    `reconnectMs=${reconnectMs} maxReconnects=${maxReconnects}`,
  );

  // Adapter that maps the daemon's FeederMetrics onto the scanner's
  // minimal sink shape — keeps src/source/ independent of the metrics
  // package and lets the scanner emit per-tick gauges + RPC error
  // counters during the loop (not only on terminal failure).
  const scannerMetrics: ScannerMetricsSink = {
    setLastBlock: (labels, block) => metrics.scannerLastBlock.set(labels, block),
    setBlockLag: (labels, lag) => metrics.scannerBlockLag.set(labels, lag),
    incRpcError: (labels) => metrics.scannerRpcErrors.inc(labels),
    incBackfillBlocks: (labels, blocks) => metrics.scannerBackfillBlocks.inc(labels, blocks),
    incBackfillChunks: (labels) => metrics.scannerBackfillChunks.inc(labels),
  };

  try {
    switch (transport) {
      case "http":
        await runHttpTransport({ source, checkpoint, handleBatch, signal, report,
          chainId: source.chainId, scannerMetrics,
          startBlock, blockRange, scanIntervalMs, confirmations,
          backwardSync, maxBlockGap });
        break;
      case "ws":
        await runWsTransport({ source, checkpoint, handleBatch, network, signal, report,
          chainId: source.chainId, scannerMetrics,
          reconnectIntervalMs: reconnectMs, maxReconnects });
        break;
    }
    report("daemon: scan pipeline exited cleanly.");
    return 0;
  } catch (err) {
    // Inner scanner already incremented the precise RPC error category;
    // this outer increment captures terminal pipeline failures (any
    // error that escapes the scanner unhandled — never duplicates a
    // network/timeout/protocol bucket from the inner emit).
    metrics.scannerRpcErrors.inc({
      chain_id: String(source.chainId),
      error_type: "pipeline_failure",
    });
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
  observedAtMs: number;
  scannerType: "http" | "ws";
  dedupCache: ReturnType<typeof createDedupCache>;
  enricher: (event: ExtractedEvent) => Promise<EnrichedIntent>;
  routerRegistry: ReturnType<typeof createRouterRegistry>;
  priceCache: ReturnType<typeof createPriceCache>;
  latestIntents: LatestIntentCache;
  coalescerManager: CoalescerManager;
  fileLogger: FileLogger;
  db: Db;
  intentRuntime: Map<string, IntentRuntimeEntry>;
  network: string;
  dryRun: boolean;
  report: (line: string) => void;
  metrics: FeederMetrics;
};

async function processOneEvent(inputs: ProcessOneEventInputs): Promise<void> {
  const {
    event, observedAtMs, scannerType, dedupCache, enricher, routerRegistry,
    priceCache, latestIntents, coalescerManager, fileLogger, db, intentRuntime, dryRun, report, metrics,
  } = inputs;

  if (!dedupCache.add(event.intentHash)) {
    metrics.eventsDuplicate.inc();
    return;
  }

  let enriched: EnrichedIntent;
  try {
    enriched = await enricher(event);
  } catch (err) {
    metrics.eventsInvalid.inc({ reason: "enrichment" });
    report(`daemon: enrichment failed for ${event.intentHash}: ${(err as Error).message}`);
    return;
  }

  metrics.intentsScanned.inc({ symbol: enriched.fullIntent.symbol, scanner_type: scannerType });
  metrics.scanToProcessingSeconds.observe(
    { symbol: enriched.fullIntent.symbol },
    Math.max(0, Date.now() - observedAtMs) / 1_000,
  );
  metrics.priceAgeSeconds.observe(
    { symbol: enriched.fullIntent.symbol },
    Math.max(0, Date.now() / 1_000 - Number(enriched.fullIntent.timestamp)),
  );

  const transformed = identityTransformer(enriched);
  const output = routeIntent(routerRegistry, priceCache, "IntentRegistered", transformed);

  for (const { routerId, reason } of output.conditionFiltered) {
    metrics.intentsFiltered.inc({
      symbol: enriched.fullIntent.symbol,
      router_id: routerId,
      reason: "condition",
    });
    report(`[debug] daemon: condition-filtered router=${routerId} reason="${reason}"`);
  }
  for (const { routerId, destinationIndex, verdict } of output.policyFiltered) {
    // Even though the router policy filtered this intent, the cron
    // service may later resubmit it when the on-chain pair goes stale.
    // Update the latest-intent cache so cron has the freshest payload.
    latestIntents.set(
      { routerId, destinationIndex, symbol: enriched.fullIntent.symbol },
      { routerId, destinationIndex, symbol: enriched.fullIntent.symbol, enriched, intentHash: event.intentHash },
    );
    if (!verdict.allowed && verdict.reason === "price_deviation") {
      metrics.priceDeviationPercent.observe(
        { symbol: enriched.fullIntent.symbol },
        verdict.deviationPct,
      );
    }
    const reason = verdict.allowed ? "policy" : verdict.reason;
    metrics.intentsFiltered.inc({
      symbol: enriched.fullIntent.symbol,
      router_id: routerId,
      reason,
    });
    report(`[debug] daemon: policy-filtered router=${routerId} dest=${destinationIndex}`);
  }

  for (const dispatch of output.dispatched) {
    metrics.intentsRouted.inc({
      symbol: enriched.fullIntent.symbol,
      router_id: dispatch.routerId,
    });

    // Keep the latest-intent cache in sync for the cron service. For
    // dispatched intents the priceCache will eventually carry this
    // intentHash post-confirm; cron compares the two and skips when
    // they match (outcome="skipped_already_fresh").
    latestIntents.set(
      {
        routerId: dispatch.routerId,
        destinationIndex: dispatch.destinationIndex,
        symbol: enriched.fullIntent.symbol,
      },
      {
        routerId: dispatch.routerId,
        destinationIndex: dispatch.destinationIndex,
        symbol: enriched.fullIntent.symbol,
        enriched,
        intentHash: event.intentHash,
      },
    );

    const cardano = dispatch.destination.cardano;
    if (!cardano) {
      report(
        `[warn] daemon: skipping router=${dispatch.routerId} dest=${dispatch.destinationIndex} — no cardano block in destination config`,
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

    // 3. preflight — fast checks before the intent occupies a queue slot
    const preflight = runPreflight({ enriched, intentHash: event.intentHash });
    if (!preflight.ok) {
      report(
        `[warn] daemon: preflight rejected router=${dispatch.routerId} ` +
        `code=${preflight.code} intentHash=${event.intentHash} reason="${preflight.reason}"`,
      );
      await fileLogger.logIntentStep({
        ts: new Date().toISOString(),
        level: "warn",
        intentHash: event.intentHash,
        symbol: enriched.fullIntent.symbol,
        step: "preflight_rejected",
        message: preflight.reason,
        meta: { code: preflight.code, remediation: preflight.remediation },
      });
      metrics.intentsFiltered.inc({
        symbol: enriched.fullIntent.symbol,
        router_id: dispatch.routerId,
        reason: preflight.code,
      });
      continue;
    }

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

    // 3. hand off to coalescer (supersession + accumulation window)
    await fileLogger.logIntentStep({
      ts: new Date().toISOString(),
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "queued",
      message: `Intent accepted by coalescer`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex, clientStatePath: cardano.client_state_path },
    });

    await db.upsertProcessedEvent({
      intentHash: event.intentHash,
      chainId: Number(enriched.fullIntent.chainId),
      blockNumber: event.blockNumber,
      txHash: event.txHash,
      logIndex: event.logIndex,
      symbol: enriched.fullIntent.symbol,
      price: enriched.fullIntent.price.toString(),
      timestamp: enriched.fullIntent.timestamp.toString(),
      signer: enriched.fullIntent.signer,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
      processedAtMs: Date.now(),
    });

    intentRuntime.set(event.intentHash, {
      observedAtMs,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
      clientStatePath: cardano.client_state_path,
      clientId: clientIdFromStatePath(cardano.client_state_path),
      symbol: enriched.fullIntent.symbol,
    });

    coalescerManager.accept(req);
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
  /** Source chain id — used as the `chain_id` label on scanner metrics. */
  chainId: number;
  /** Adapter that maps `FeederMetrics` onto the scanner's minimal sink shape. */
  scannerMetrics: ScannerMetricsSink;
  // HTTP
  startBlock?: bigint;
  blockRange?: bigint;
  scanIntervalMs?: number;
  confirmations?: bigint;
  /** Spectra-parity gap recovery — see Etapa B.1. */
  backwardSync?: boolean;
  /** Block gap threshold above which backfill mode activates. */
  maxBlockGap?: bigint;
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
      metrics: inputs.scannerMetrics,
      chainId: inputs.chainId,
      backwardSync: inputs.backwardSync,
      maxBlockGap: inputs.maxBlockGap,
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
    metrics: inputs.scannerMetrics,
    chainId: inputs.chainId,
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
      return {
        txHash: "dry-run-tx-hash",
        receiverUnit: "dry-run-receiver-unit",
        pairUnit: "dry-run-pair-unit",
        isCreate: false,
      };
    },
    async submitOracleUpdateBatch(params) {
      report(
        `daemon: [dry-run bridge] submitOracleUpdateBatch intents=${params.updates.length} ` +
        `client=${params.clientStatePath}`,
      );
      return {
        txHash: "dry-run-tx-hash",
        receiverUnit: "dry-run-receiver-unit",
        entries: params.updates.map((update) => ({
          intentHash: update.intentHash,
          pairUnit: `dry-run-pair-unit:${update.enriched.fullIntent.symbol}`,
          isCreate: false,
        })),
      };
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
 * Resolve the API listen address.
 */
function resolveApiAddr(apiConfig?: InfrastructureConfig["api"]): { host: string; port: number } {
  if (apiConfig?.host || apiConfig?.port) {
    return {
      host: apiConfig.host?.trim() || "0.0.0.0",
      port: apiConfig.port ?? 8080,
    };
  }

  const raw = apiConfig?.listen_addr?.trim() ?? process.env.API_LISTEN_ADDR?.trim() ?? ":8080";
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
