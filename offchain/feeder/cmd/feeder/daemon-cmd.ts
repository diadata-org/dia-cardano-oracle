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
//   API_LISTEN_ADDR          host:port — default "127.0.0.1:8080" (loopback).
//   METRICS_ENABLED          "true" to enable prom-client metrics.
//   METRICS_NAMESPACE        metric name prefix — default "dia_bridge".

import { access, rm, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { seedCheckpointIfNeeded } from "./checkpoint-seed.js";

import { createPublicClient, http, type PublicClient } from "viem";

import {
  loadModularConfig,
  validateModularConfig,
  type ModularConfig,
  type InfrastructureConfig,
  type RouterConfig,
  type ValidationIssue,
} from "../../src/config/index.js";
import { createRegistryEnricher, identityTransformer } from "../../src/pipeline/index.js";
import {
  createDedupCache,
  createEventWorkerPool,
  createPriceCache,
  type EventWorkerPool,
  type PriceCache,
} from "../../src/processor/index.js";
import {
  createLatestIntentCache,
  startCronService,
  type LatestIntentCache,
} from "../../src/cron/index.js";
import {
  composeAuthenticatedWsUrl,
  createDbCheckpoint,
  createHttpRegistryClient,
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
import { extractRouterSymbols } from "../../src/router/symbols.js";
import {
  createQueueManager,
  createCoalescerManager,
  createInflightTable,
  createSymbolInflightTracker,
  laneKey,
  nextWasmFailureCount,
  shouldExitOnWasmFailures,
  shouldAutoSettle,
  shouldAutoWithdraw,
  shouldAutoConsolidate,
  type CoalescerManager,
  type InflightTable,
} from "../../src/submitter/index.js";
import type { CardanoDestinationConfig } from "../../src/config/types.js";
import type { SubmitRequest, SubmitResult, RouterSigner } from "../../src/submitter/types.js";
import {
  isNoTransactionFailure,
  isTransactionRepresentative,
  routerIdsForTransaction,
} from "../../src/submitter/types.js";
import {
  buildRouterIdentity,
  clientIdFromStatePath,
  type RouterRuntimeIdentity,
} from "../../src/runtime/identity.js";
import { clientLabels, routerMembershipLabels } from "../../src/api/metric-labels.js";
import { seedDropdownSeriesFromConfig } from "../../src/metrics/seed-dropdown-series.js";
import { submissionStateForStep, submissionStateForLaneEvent, coalescerStateForLaneEvent } from "../../src/metrics/submission-state.js";
import {
  createUpdateWorkerPoolManager,
  type UpdateWorkerPoolManager,
} from "../../src/worker/index.js";
import type { OracleIntentBridge } from "../../src/lib-bridge/index.js";
import { createRealOracleIntentBridge } from "../../src/lib-bridge/index.js";
import { reconcileAllDestinations } from "../../src/lib-bridge/reconcile.js";
import { resolveRunStateDir, STATE_ROOT } from "@diadata-org/dia-cardano-oracle-cli/core/run-state";
import { createCardanoWriteClient } from "../../src/submitter/cardano-write-client.js";
import {
  createApiServer,
  createChainRuntimeState,
  createMetrics,
  noopMetrics,
  wrapWithPersistence,
  resolveProviderRoles,
  createProviderHealthRecorder,
  probeProvider,
  type FeederMetrics,
  type HealthState,
} from "../../src/api/index.js";
import { getCliConfig } from "@diadata-org/dia-cardano-oracle-cli/core/config";
import { makeConfiguredLucidWithConfig, setProviderCallObserver } from "@diadata-org/dia-cardano-oracle-cli/core/lucid";
import { isTxOnChain } from "@diadata-org/dia-cardano-oracle-cli/core/tx-onchain-check";
import { recoverSubmittedTx } from "../../src/submitter/recover-submitted-tx.js";
import { readClientContext } from "@diadata-org/dia-cardano-oracle-cli/core/artifact-context";
import { decodePairDatum } from "@diadata-org/dia-cardano-oracle-cli/core/datum-decoders";
import {
  deriveFeedThresholds,
  runFeedSanityChecks,
  readOnChainPairs,
  sanityStatusCode,
  type FeedSanityDeps,
} from "../../src/sanity-check/feed-sanity.js";
import { createDb, type Db, type DbConfig } from "../../src/persistence/index.js";
import { instrumentDb } from "../../src/persistence/db-metrics.js";
import { createFileLogger, type FileLogger } from "../../src/logger/file-logger.js";
import { runPreflight } from "../../src/submitter/preflight.js";
import { createDefaultRetryPolicy } from "../../src/submitter/retry-policy.js";
import { sanitizeLogLine } from "../../src/utils/sanitize.js";
import {
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_BLOCK_RANGE,
  DEFAULT_START_BLOCK,
  DEFAULT_CONFIRMATIONS,
  DEFAULT_MAX_BLOCK_GAP,
  DEFAULT_DEDUP_CACHE_SIZE,
  DEFAULT_DEDUP_CACHE_TTL_MS,
  DEFAULT_RECONNECT_INTERVAL_MS,
  DEFAULT_MAX_RECONNECTS,
  DEFAULT_MAX_STALENESS_MS,
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_PARALLEL_WORKER_COUNT,
  DEFAULT_PARALLEL_QUEUE_SIZE,
  DEFAULT_PARALLEL_TIMEOUT_MS,
  DEFAULT_UPDATE_WORKER_MAX_WORKERS,
  DEFAULT_UPDATE_WORKER_QUEUE_SIZE,
  DEFAULT_UPDATE_WORKER_TIMEOUT_MS,
  DEFAULT_CRON_TICK_INTERVAL_MS,
  DEFAULT_ALIGNED_HEARTBEAT,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  DEFAULT_PROVIDER_PROBE_TIMEOUT_MS,
  DEFAULT_FEED_SANITY_INTERVAL_MS,
  DEFAULT_FEED_SANITY_GRACE_SECONDS,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  API_WILDCARD_HOST,
  METRICS_NAMESPACE,
  DEFAULT_WASM_FATAL_CONSECUTIVE_FAILURES,
  WASM_FATAL_EXIT_CODE,
  CARDANO_NETWORK_MAGIC,
} from "../../src/config/constants.js";

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

type IntentRuntimeEntry = RouterRuntimeIdentity & {
  observedAtMs: number;
  symbol: string;
  submittedAtMs?: number;
};

/**
 * Resolve a per-router Cardano signer for every enabled router, keyed by
 * router id. Each router declares either `private_key_env` (the name of an
 * env var holding the seed/key — the recommended form) or an inline
 * `private_key` (discouraged). The resolved value's kind is inferred from
 * the env var name: a name containing `PRIVATE_KEY` yields a raw private
 * key, any other name (e.g. `…_WALLET_SEED_…`) yields a mnemonic seed.
 *
 * Fails loud: a router whose `private_key_env` names an env var that is
 * absent or empty throws at startup, rather than silently falling back to
 * a different (possibly wrong) signer. Routers with neither field — which
 * the config validator already rejects — are skipped, leaving the bridge
 * to use its global env default defensively.
 */
function resolveRouterSigners(
  routers: RouterConfig[],
  report: (line: string) => void,
): Map<string, RouterSigner> {
  const signers = new Map<string, RouterSigner>();
  for (const router of routers) {
    if (router.private_key_env) {
      const value = process.env[router.private_key_env]?.trim();
      if (!value) {
        throw new Error(
          `Router "${router.id}": private_key_env "${router.private_key_env}" is not set ` +
          `(or empty) in the environment. Set it before starting the daemon.`,
        );
      }
      const kind: RouterSigner["kind"] = router.private_key_env.includes("PRIVATE_KEY")
        ? "privateKey"
        : "seed";
      signers.set(router.id, { kind, value });
      report(`daemon: router "${router.id}" signer resolved from ${router.private_key_env} (kind=${kind})`);
    } else if (router.private_key) {
      signers.set(router.id, { kind: "privateKey", value: router.private_key });
      report(`daemon: router "${router.id}" signer resolved from inline private_key (kind=privateKey)`);
    }
  }
  return signers;
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

/** Inputs for the pure auto-merge trigger decision. All chain-derived values
 *  come from one `snapshotBalances` probe; the lock/lane facts come from the
 *  shared in-flight table and the daemon's merge-in-progress set. */
export type AutoMergeDecisionInput = {
  /** Receiver `balanceLovelace` from the latest snapshot. Undefined when the
   *  receiver query failed — we then cannot evaluate the low-balance arm. */
  receiverBalanceLovelace?: bigint;
  /** Summed clean pending deposits from the latest snapshot. Undefined when
   *  the deposit query failed or the client has no deposit address. */
  depositPendingLovelace?: bigint;
  /** `alerting.receiver_balance_low_lovelace` — always present (validated). */
  receiverBalanceLowLovelace: bigint;
  /** `alerting.deposit_pending_merge_lovelace` — optional; undefined disables
   *  the pending-high arm of the trigger. */
  depositPendingMergeLovelace?: bigint;
  /**
   * True when a merge task for this lane is already enqueued or running. This
   * is a DEDUP guard, not a safety lock: a merge spans many refresh ticks
   * (build → submit → confirm), so without it the daemon would stack a fresh
   * merge task every tick. Mutual exclusion against oracle updates is handled
   * structurally by the lane queue (the merge runs on the same serial lane),
   * not by this flag.
   */
  mergeInProgress: boolean;
};

export type AutoMergeDecision =
  | { merge: true; reason: "receiver_balance_low" | "deposit_pending_high" }
  | { merge: false; reason: "no_pending" | "below_threshold" | "merge_in_progress" };

/**
 * Pure decision: should the daemon submit a `deposit:merge` for this lane on
 * this tick?
 *
 * A merge runs when there ARE clean pending deposits to fold in AND either:
 *   - the Receiver balance is below `receiver_balance_low_lovelace` (top up a
 *     starving Receiver from its accumulated deposits), OR
 *   - pending deposits have reached `deposit_pending_merge_lovelace` (fold a
 *     meaningful pile in before it grows unbounded),
 * AND a merge is not already enqueued/running for this lane (dedup only).
 *
 * The merge never races an oracle update on the same Receiver UTxO because it
 * is dispatched onto the SAME serial lane queue the client's updates use — the
 * queue runs one entry at a time per lane, so an update and a merge are
 * mutually exclusive by construction. This decision therefore no longer
 * inspects an in-flight lock; it only decides WHETHER a merge is due.
 *
 * Kept pure (no chain, no locks, no I/O) so the trigger logic is unit-tested
 * in isolation from the live submission path.
 */
export function shouldAutoMergeDeposits(input: AutoMergeDecisionInput): AutoMergeDecision {
  // Dedup guard first: a merge spans many ticks, so skip if one is already
  // enqueued/running for this lane. Safety (no overlap with updates) is the
  // lane queue's job, not this flag's.
  if (input.mergeInProgress) return { merge: false, reason: "merge_in_progress" };

  // Nothing clean to merge → no-op (also avoids a guaranteed-to-throw
  // `depositMerge` call when there are zero eligible deposits).
  const pending = input.depositPendingLovelace ?? 0n;
  if (pending <= 0n) return { merge: false, reason: "no_pending" };

  // Arm 1 — Receiver is starving: fold deposits in to keep updates funded.
  if (
    input.receiverBalanceLovelace !== undefined &&
    input.receiverBalanceLovelace < input.receiverBalanceLowLovelace
  ) {
    return { merge: true, reason: "receiver_balance_low" };
  }

  // Arm 2 — pending pile has reached the configured merge threshold.
  if (
    input.depositPendingMergeLovelace !== undefined &&
    pending >= input.depositPendingMergeLovelace
  ) {
    return { merge: true, reason: "deposit_pending_high" };
  }

  return { merge: false, reason: "below_threshold" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Delete all feeder-generated state in the ACTIVE run dir (resolved via
 * RUN_ID / newest / flat fallback) so the next run starts clean. Never touches
 * CLI bootstrap state files: config-bootstrap.json, clients/<name>.json. A
 * different deployment's run dir is left untouched.
 *
 * Deleted (<run> = state/<network>_run_<id>/, or flat state/<network>/):
 *   <run>/logs/                    (all log streams)
 *   <run>/feeder.sqlite*           (SQLite DB + WAL files)
 *   <run>/clients/*\/pairs/*.json  (feeder-written pair state)
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
    // Every line passes through sanitizeLogLine before reaching the base
    // writer so newline/tab/CR injection from interpolated event data
    // (intentHash, error messages, symbols, paths) cannot fabricate fake
    // log lines downstream. Single chokepoint for all call sites.
    const safe = sanitizeLogLine(line);
    let msgLevel: LogLevelStr = "info";
    let stripped = safe;
    for (const lv of Object.keys(LEVEL_ORDER) as LogLevelStr[]) {
      const tag = `[${lv}] `;
      if (safe.startsWith(tag)) {
        msgLevel = lv;
        stripped = safe.slice(tag.length);
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
  stateBase = STATE_ROOT,
): Promise<void> {
  // Clean the ACTIVE run dir (RUN_ID / newest / flat fallback), so a reset
  // never wipes a different deployment's run dir. `stateBase` lets tests point
  // at a temp root.
  const base = resolveRunStateDir(network as CardanoNetwork, stateBase);

  const targets: string[] = [
    `${base}/logs`,
    `${base}/feeder.sqlite`,
    `${base}/feeder.sqlite-shm`,
    `${base}/feeder.sqlite-wal`,
  ];

  // Pair state files: <run>/clients/*/pairs/*.json
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

export async function checkBootstrapStateFiles(
  config: ModularConfig,
  network: string,
  report: (line: string) => void,
  stateBase = STATE_ROOT,
): Promise<boolean> {
  const bootstrapPath = path.join(
    resolveRunStateDir(network as CardanoNetwork, stateBase),
    "config-bootstrap.json",
  );
  if (!await fileExists(bootstrapPath)) {
    report(`daemon: missing bootstrap state file: ${bootstrapPath}`);
    report(`daemon: hint → deploy with the CLI (run-all / protocol-init) so ${bootstrapPath} exists, then 'init router'.`);
    return false;
  }
  for (const [routerId, router] of Object.entries(config.routers)) {
    for (const dest of router.destinations) {
      if (dest.cardano) {
        const clientPath = dest.cardano.client_state_path;
        if (!await fileExists(clientPath)) {
          report(`daemon: router "${routerId}": missing client state: ${clientPath}`);
          report(`daemon: hint → npm run feeder:dev -- init router`);
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Read the deposit dust floor from a CLI-produced protocol state file
 * (`config-bootstrap.json::configState.depositMinLovelace`, set at the CLI's
 * `protocol:init`). This is the single source shared with the CLI's
 * `deposit:*` commands; the daemon passes it to the bridge so the
 * deposit-pending probe counts exactly the deposits the CLI sweep would.
 * Throws a clear, actionable error when the file or the field is absent —
 * there is no hardcoded fallback.
 */
export async function readDepositMinLovelace(bootstrapStatePath: string): Promise<bigint> {
  try {
    const protocolState = JSON.parse(await readFile(bootstrapStatePath, "utf8")) as {
      configState?: { depositMinLovelace?: string };
    };
    const floor = protocolState.configState?.depositMinLovelace;
    if (floor === undefined) {
      throw new Error("configState.depositMinLovelace is missing");
    }
    return BigInt(floor);
  } catch (err) {
    throw new Error(
      `daemon: cannot read configState.depositMinLovelace from ${bootstrapStatePath} ` +
        `(${(err as Error).message}). It is set at the CLI's protocol:init.`,
    );
  }
}

/**
 * Read the opportunistic-fold cap from a CLI-produced protocol state file
 * (`config-bootstrap.json::configState.depositMaxPerUpdateFold`, set at the
 * CLI's `protocol:init`). This is the SAME source the CLI's update builders
 * use; the daemon passes it to the bridge so an oracle update folds at most
 * this many clean side-deposits into the same tx. Throws a clear, actionable
 * error when the file or the field is absent — no hardcoded fallback.
 */
export async function readDepositMaxPerUpdateFold(bootstrapStatePath: string): Promise<number> {
  try {
    const protocolState = JSON.parse(await readFile(bootstrapStatePath, "utf8")) as {
      configState?: { depositMaxPerUpdateFold?: string };
    };
    const cap = protocolState.configState?.depositMaxPerUpdateFold;
    if (cap === undefined) {
      throw new Error("configState.depositMaxPerUpdateFold is missing");
    }
    return Number(cap);
  } catch (err) {
    throw new Error(
      `daemon: cannot read configState.depositMaxPerUpdateFold from ${bootstrapStatePath} ` +
      `(${(err as Error).message}). It is set at the CLI's protocol:init.`,
    );
  }
}

type PersistedPairStateFile = {
  pairState?: {
    price?: string;
    timestamp?: string;
    nonce?: string;
    intentHash?: string;
    intent?: {
      symbol?: string;
      price?: string;
      timestamp?: string;
      nonce?: string;
    };
  };
  transactions?: Array<{ submittedTxHash?: string; confirmed?: boolean }>;
};

async function hydratePriceCacheFromPairStateFiles(args: {
  config: ModularConfig;
  priceCache: PriceCache;
  metrics: FeederMetrics;
  confirmationDepth: number;
  log: (line: string) => void;
}): Promise<{ hydrated: number; maxUpdatedAtMs: number }> {
  const { config, priceCache, metrics, confirmationDepth, log } = args;
  let hydrated = 0;
  let maxUpdatedAtMs = 0;

  for (const router of Object.values(config.routers)) {
    if (!router.enabled) continue;
    const routerSymbols = new Set(extractRouterSymbols(router));
    if (routerSymbols.size === 0) continue;

    for (let destinationIndex = 0; destinationIndex < router.destinations.length; destinationIndex++) {
      const dest = router.destinations[destinationIndex];
      if (!dest?.cardano) continue;

      const clientStatePath = dest.cardano.client_state_path;
      const clientId = clientIdFromStatePath(clientStatePath);
      const pairsDir = path.join(
        path.dirname(clientStatePath),
        path.basename(clientStatePath, ".json"),
        "pairs",
      );

      let files: string[];
      try {
        files = (await readdir(pairsDir)).filter((file) => file.endsWith(".json"));
      } catch {
        continue;
      }

      for (const file of files) {
        const pairPath = path.join(pairsDir, file);
        try {
          const [raw, fileStat] = await Promise.all([
            readFile(pairPath, "utf8"),
            stat(pairPath),
          ]);
          const parsed = JSON.parse(raw) as PersistedPairStateFile;
          const pairState = parsed.pairState;
          const symbol = pairState?.intent?.symbol;
          if (!symbol || !routerSymbols.has(symbol)) continue;

          const priceRaw = pairState.price ?? pairState.intent?.price;
          const timestampRaw = pairState.timestamp ?? pairState.intent?.timestamp;
          const nonceRaw = pairState.nonce ?? pairState.intent?.nonce;
          const intentHashRaw = pairState.intentHash;
          if (!priceRaw || !timestampRaw || !intentHashRaw) continue;

          const lastConfirmedTx = [...(parsed.transactions ?? [])]
            .reverse()
            .find((tx) => tx.confirmed === true && tx.submittedTxHash);
          const intentHash = intentHashRaw.startsWith("0x") ? intentHashRaw : `0x${intentHashRaw}`;
          const updatedAtMs = Math.max(1, Math.floor(fileStat.mtimeMs));

          priceCache.set(
            { routerId: router.id, destinationIndex, symbol },
            {
              symbol,
              price: BigInt(priceRaw),
              timestamp: BigInt(timestampRaw),
              nonce: nonceRaw !== undefined && nonceRaw !== null ? BigInt(nonceRaw) : undefined,
              intentHash,
              cardanoTxHash: lastConfirmedTx?.submittedTxHash,
              confirmedAtDepth: confirmationDepth,
              updatedAtMs,
              clientId,
              customerId: router.customer_id,
              network: dest.cardano.network,
            },
          );
          metrics.cardanoOracleLastConfirmedTimestampSeconds.set(
            { symbol, ...clientLabels({ clientId, customerId: router.customer_id }), router_id: router.id },
            Number(timestampRaw),
          );
          hydrated++;
          maxUpdatedAtMs = Math.max(maxUpdatedAtMs, updatedAtMs);
        } catch (err) {
          log(`price-cache: skipped ${pairPath} during startup hydrate — ${(err as Error).message}`);
        }
      }
    }
  }

  log(`price-cache: hydrated ${hydrated} confirmed pair state entr${hydrated === 1 ? "y" : "ies"} from disk`);
  return { hydrated, maxUpdatedAtMs };
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
  // Load + validate config.
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
  // Bootstrap state-file check — fast-fail with actionable hint.
  // ------------------------------------------------------------------
  if (!await checkBootstrapStateFiles(config, network, report)) return 1;

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
  // Database.
  // ------------------------------------------------------------------
  const dbConfig = resolveDbConfig(network);
  let db = await createDb(dbConfig);
  await db.migrate();
  // Ensure chain_state row exists for this network before checkpoint reads it.
  await db.initialiseChainState({
    chainId: source.chainId,
    chainName: network,
    contractId: source.registryContractId,
  });
  report(`daemon: database driver=${dbConfig.driver} ready`);

  // ------------------------------------------------------------------
  // Crash recovery — mark any pending/submitted rows from a
  //     previous run as failed. Pending rows never reached the chain;
  //     submitted rows may have been in-flight when the process died.
  //     Both are marked failed so the event-driven flow can re-process
  //     them when fresh intents arrive.
  // ------------------------------------------------------------------
  const [crashPending, crashSubmitted] = await Promise.all([
    db.listTransactions({ status: "pending" }),
    db.listTransactions({ status: "submitted" }),
  ]);
  for (const row of crashPending) {
    report(`daemon: crash recovery: marking pending tx ${row.intentHash} as failed`);
    await db.updateTransactionLog(row.intentHash, {
      status: "failed",
      errorCode: "CrashRecovery",
      errorMessage: "daemon restarted with pending transaction",
      failedAtMs: Date.now(),
    });
  }
  // A `submitted` tx was broadcast but unconfirmed when the previous process
  // died. Ask the chain before judging it: one that actually landed is recorded
  // as confirmed (so the count/uptime reflect reality); one the chain does not
  // show is failed so the event flow re-processes it (an already-on-chain
  // re-submit is cleanly dropped as NonMonotonicNonce).
  let crashConfirmed = 0;
  for (const row of crashSubmitted) {
    const confirmed = await recoverSubmittedTx(row.cardanoTxHash, (txHash) =>
      isTxOnChain({ txHash }),
    );
    if (confirmed) {
      crashConfirmed++;
      report(`daemon: crash recovery: submitted tx ${row.intentHash} is on-chain — recording as confirmed`);
      await db.updateTransactionLog(row.intentHash, {
        status: "confirmed",
        confirmedAtMs: Date.now(),
      });
    } else {
      report(`daemon: crash recovery: submitted tx ${row.intentHash} not found on-chain — marking failed`);
      await db.updateTransactionLog(row.intentHash, {
        status: "failed",
        errorCode: "CrashRecovery",
        errorMessage: "daemon restarted; submitted tx not found on-chain at recovery",
        failedAtMs: Date.now(),
      });
    }
  }
  if (crashPending.length + crashSubmitted.length > 0) {
    report(
      `daemon: crash recovery complete — pending→failed=${crashPending.length} ` +
      `submitted: confirmed=${crashConfirmed} failed=${crashSubmitted.length - crashConfirmed}`,
    );
  }

  // ------------------------------------------------------------------
  // File logger — structured JSON logs per intent/transaction.
  // ------------------------------------------------------------------
  const logDir = process.env.FEEDER_LOG_DIR?.trim() ?? path.join(resolveRunStateDir(network), "logs");
  const fileLogger: FileLogger = await createFileLogger(logDir);
  
  // After fileLogger is ready, wrap so the file gets all lines (unfiltered)
  // while the console keeps the level filter applied above.
  report = fileLogger.getReportingFn(leveledConsole);
  
  report(`daemon: file logger ready at ${logDir}`);

  // ------------------------------------------------------------------
  // Metrics — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const metricsEnabledYaml = config.infrastructure?.metrics?.enabled;
  const metricsEnabled =
    metricsEnabledYaml !== undefined
      ? metricsEnabledYaml
      : process.env.METRICS_ENABLED?.trim().toLowerCase() === "true";
  const metricsNamespace =
    config.infrastructure?.metrics?.namespace ??
    process.env.METRICS_NAMESPACE?.trim() ??
    METRICS_NAMESPACE;
  const baseMetrics = metricsEnabled
    ? await createMetrics({
        namespace: metricsNamespace,
        defaultLabels: {
          destination_chain: "cardano",
          network,
          source_chain_id: String(source.chainId),
          // Active per-run state dir basename (e.g. "preview_run_20260608-040304").
          // A registry default label, so EVERY metric carries it and alert
          // remediation commands can template the full state path via
          // {{ $labels.run_dir }} instead of a manual <id> placeholder.
          run_dir: path.basename(resolveRunStateDir(network)),
        },
      })
    : noopMetrics;
  // Wrap the live counters so transaction/intent lifecycle increments ALSO
  // persist to performance_metrics, backing the /api/v1/performance endpoint.
  // Persistence failures are throttled-logged (R10.B.9), never fatal. Skipped
  // for noopMetrics (metrics disabled) — nothing to persist.
  const metrics = metricsEnabled ? wrapWithPersistence(db, baseMetrics, report) : baseMetrics;
  // Per-provider request accounting: the CLI provider wrapper reports every
  // Cardano API request (each retry attempt) here, so provider_requests_total
  // reflects real quota consumption and the quota_exceeded outcome surfaces the
  // Blockfrost 402 wall before it freezes the run.
  setProviderCallObserver((event) =>
    metrics.bridgeProviderRequests.inc({
      provider: event.provider,
      method: event.method,
      outcome: event.outcome,
    }),
  );
  // Count + time every data operation from here on (db_operations_total /
  // db_operation_duration_seconds). The few startup ops above (crash recovery)
  // run once and stay un-instrumented, which is fine for a steady-state load metric.
  db = instrumentDb(db, metrics);

  // Crash-recovery attempts from the startup sweep above (counted now that the
  // metrics registry exists).
  if (crashPending.length + crashSubmitted.length > 0) {
    metrics.bridgeRecoveryAttempts.inc(
      { component: "daemon", reason: "crash_recovery" },
      crashPending.length + crashSubmitted.length,
    );
  }

  // ------------------------------------------------------------------
  // Health state (mutated by the pipeline as it runs).
  // ------------------------------------------------------------------
  const healthState: HealthState = {
    lastRegistryPollMs: 0,
    lastConfirmedMs: 0,
    maxStalenessMs: 5 * 60_000, // overwritten below after infra config is resolved
    maxLastConfirmedAgeMs: 0,
  };

  // ------------------------------------------------------------------
  // Price cache.
  // ------------------------------------------------------------------
  const priceCache = createPriceCache();
  // Latest-intent cache feeds the cron service. Updated on every
  // enriched intent (filtered or dispatched) so cron has the freshest
  // payload to re-submit when the on-chain pair goes stale.
  const latestIntents = createLatestIntentCache();
  const chainRuntime = createChainRuntimeState();
  const intentRuntime = new Map<string, IntentRuntimeEntry>();

  // ------------------------------------------------------------------
  // HTTP API server — YAML wins over env, env is fallback.
  // ------------------------------------------------------------------
  const { host: apiHost, port: apiPort } = resolveApiAddr(config.infrastructure?.api);
  // The update pool manager is created later (depends on coalescerManager).
  // We use a deferred ref so the API server can read pool stats at request time.
  let updatePoolManagerRef: UpdateWorkerPoolManager | undefined;
  const apiServer = createApiServer({
    host: apiHost,
    port: apiPort,
    config,
    db,
    metrics,
    priceCache,
    chainRuntime,
    healthState,
    getPoolStats: () => updatePoolManagerRef?.listAllStats() ?? [],
  });
  await apiServer.start();
  report(`daemon: API server listening on ${apiHost}:${apiPort}`);

  // ------------------------------------------------------------------
  // Resolve all YAML knobs before any subsystem that needs them.
  // ------------------------------------------------------------------
  const infra: InfrastructureConfig =
    config.infrastructure ?? ({} as InfrastructureConfig);
  const scanIntervalMs   = parseDurationMs(infra.block_scanner?.scan_interval,   DEFAULT_SCAN_INTERVAL_MS);
  const blockRange       = BigInt(infra.block_scanner?.block_range               ?? DEFAULT_BLOCK_RANGE);
  const startBlock       = BigInt(infra.source?.start_block                      ?? DEFAULT_START_BLOCK);
  const confirmations    = BigInt(infra.block_scanner?.confirmations             ?? DEFAULT_CONFIRMATIONS);
  // Gap recovery: when backward_sync=true, the HTTP scanner re-syncs from
  // last_processed_block using large chunks (backfill_chunk_blocks) and skips
  // scan_interval between chunks until caught up. Defaults preserve current
  // behaviour for installations that have not opted in.
  const backwardSync     = infra.block_scanner?.backward_sync === true;
  const maxBlockGap      = BigInt(infra.block_scanner?.max_block_gap             ?? DEFAULT_MAX_BLOCK_GAP);
  const dedupCapacity    = infra.event_processor?.dedup_cache_size               ?? DEFAULT_DEDUP_CACHE_SIZE;
  const dedupTtlMs       = parseDurationMs(infra.event_processor?.dedup_cache_ttl, DEFAULT_DEDUP_CACHE_TTL_MS);
  const reconnectMs      = parseDurationMs(infra.event_monitor?.reconnect_interval, DEFAULT_RECONNECT_INTERVAL_MS);
  const maxReconnects    = infra.event_monitor?.max_reconnect_attempts           ?? DEFAULT_MAX_RECONNECTS;
  const maxStalenessMs   = parseDurationMs(infra.health_check?.max_processing_lag, DEFAULT_MAX_STALENESS_MS);
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
  const cardanoConfirmationDepth = infra.cardano?.confirmation_depth ?? DEFAULT_CONFIRMATION_DEPTH;

  // Deposit floor — a deposit tx-build param (CLI domain) read from the
  // protocol state's config-bootstrap.json::configState.depositMinLovelace
  // (set at the CLI's protocol:init, the single source shared with the CLI's
  // `deposit:*` commands). The floor is passed to the bridge so the
  // deposit-pending probe counts exactly the deposits the CLI sweep would.
  // The per-merge cap (configState.depositMaxPerMerge) is enforced inside the
  // CLI's `depositMerge` (which the auto-merge path delegates to), so the
  // daemon does not re-apply it here.
  // The deposit config lives in the ACTIVE run dir's config-bootstrap.json — the
  // same file the router destinations read (protocol_state_path) and where the
  // logger/DB live. Resolve it via resolveRunStateDir so RUN_ID / newest-run
  // selection stays consistent across the daemon (not a hardcoded flat path).
  const depositBootstrapPath = path.join(resolveRunStateDir(network), "config-bootstrap.json");
  const depositMinLovelace = await readDepositMinLovelace(depositBootstrapPath);
  // Opportunistic-fold cap — how many clean side-deposits an oracle update may
  // absorb into the same tx. A deposit tx-build param read from the same
  // protocol state (configState.depositMaxPerUpdateFold, set at the CLI's
  // protocol:init); passed to the bridge so the update path folds best-effort
  // with a pure-update fallback. The standalone auto-merge below still handles
  // bulk sweeps via configState.depositMaxPerMerge.
  const depositMaxPerUpdateFold = await readDepositMaxPerUpdateFold(depositBootstrapPath);

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
  // Auto-merge threshold — sum of pending side-deposits at/above which the
  // daemon folds them into the Receiver via `deposit:merge`. This YAML key
  // (`alerting.deposit_pending_merge_lovelace`) is optional: when absent the
  // pending-deposits-high arm of the auto-merge trigger is disabled (the
  // low-Receiver-balance arm still fires). Tolerated-undefined per the
  // feature spec — never default to a hardcoded value.
  const depositPendingMergeLovelace =
    alerting.deposit_pending_merge_lovelace !== undefined
      ? BigInt(alerting.deposit_pending_merge_lovelace)
      : undefined;

  // Automatic fee-loop maintenance thresholds. Each is optional: when absent the
  // matching automatic step is DISABLED (never defaulted). Each sits BEYOND its
  // paired alert (enforced by the threshold-drift test) so the alert fires first.
  //   - auto_settle_lovelace            > settle_overdue_lovelace
  //   - auto_withdraw_lovelace          > payment_hook_withdraw_ready_lovelace
  //   - auto_consolidate_below_lovelace < admin_wallet_min_collateral_lovelace
  const autoSettleLovelace =
    alerting.auto_settle_lovelace !== undefined
      ? BigInt(alerting.auto_settle_lovelace)
      : undefined;
  const autoWithdrawLovelace =
    alerting.auto_withdraw_lovelace !== undefined
      ? BigInt(alerting.auto_withdraw_lovelace)
      : undefined;
  const autoConsolidateBelowLovelace =
    alerting.auto_consolidate_below_lovelace !== undefined
      ? BigInt(alerting.auto_consolidate_below_lovelace)
      : undefined;
  // Dedicated collateral UTxO size the auto-consolidate leaves behind. Reuse the
  // collateral floor (`admin_wallet_min_collateral_lovelace`) when set so the
  // consolidated collateral UTxO clears the AdminWalletFragmented threshold;
  // fall back to lucid's 5 ADA default otherwise.
  const collateralUtxoLovelace =
    alerting.admin_wallet_min_collateral_lovelace !== undefined
      ? BigInt(alerting.admin_wallet_min_collateral_lovelace)
      : 5_000_000n;

  const maxQueueSize = infra.health_check?.max_queue_size;

  healthState.maxStalenessMs = maxStalenessMs;
  healthState.maxLastConfirmedAgeMs = maxLastConfirmedAgeMs;
  if (maxQueueSize !== undefined) {
    healthState.maxQueueSize = maxQueueSize;
  }

  // ------------------------------------------------------------------
  // Router registry.
  // ------------------------------------------------------------------
  const routerRegistry = createRouterRegistry(config.routers);
  report(`daemon: router registry loaded (${routerRegistry.all.length} router(s))`);

  // Resolve each router's Cardano signer from its `private_key_env` (or the
  // inline `private_key` fallback) ONCE at startup. Multi-client deployments
  // give each router its own signing key; single-client deployments point
  // every router at the same CARDANO_WALLET_SEED_<NETWORK> env var, which
  // resolves to one shared signer. A named-but-absent env var is a hard
  // startup error (fail loud) rather than a silent fallback to the wrong key.
  const routerSigners = resolveRouterSigners(routerRegistry.all, report);

  // routerId -> customer id. Validation makes customer_id required, so the
  // runtime does not carry compatibility fallbacks here.
  const routerCustomers = new Map<string, string>(
    routerRegistry.all.map((r) => [r.id, r.customer_id]),
  );

  // ------------------------------------------------------------------
  // Oracle intent bridge + queue manager.
  // ------------------------------------------------------------------
  // Bridge internals (UTxO fetches, Lucid calls) and write-client step
  // logs are debug-level — too verbose for normal operation.
  const debugReport = (line: string) => report(`[debug] ${line}`);

  const bridge: OracleIntentBridge = dryRun
    ? makeDryRunBridge(report)
    : createRealOracleIntentBridge({
        log: debugReport,
        confirmationDepth: cardanoConfirmationDepth,
        depositMinLovelace,
        depositMaxPerUpdateFold,
      });

  const retryPolicy = createDefaultRetryPolicy({ maxRetries, delayMs: retryDelayMs });

  // Shared in-flight table — the per-(receiverUnit) exclusive-lock map the
  // submission queue stamps on every successful submit. Passing it in (rather
  // than letting the queue manager build a private one) lets the auto-merge
  // path below consult the SAME locks: a deposit merge spends the same
  // Receiver UTxO as an oracle update, so it must never run while an update is
  // in-flight on that Receiver. See `shouldAutoMergeDeposits` + the auto-merge
  // tick for how the lock is honoured.
  const inflightTable: InflightTable = createInflightTable();

  // Shared per-(router, destination, symbol) in-flight tracker — distinct from
  // the receiverUnit lock above. The coalescer marks a pair when its batch
  // flushes and clears it once the result resolves; the cron consults it so it
  // never re-submits a pair whose event-driven submission is still pending
  // (which the chain would reject as NonMonotonicNonce). TTL = inflight_timeout_ms,
  // the same safeguard window the receiver locks use.
  const symbolInflight = createSymbolInflightTracker({ ttlMs: inflightTimeoutMs });

  // One serial submission lane per client deployment (Receiver). Map each lane
  // key to its client/customer so the per-client queue-depth and submission-state
  // gauges can be labelled with the identities users already see in the filters.
  const laneIdentity = new Map<string, { client_id: string; customer_id: string }>();
  for (const r of Object.values(config.routers)) {
    if (!r.enabled) continue;
    for (const d of r.destinations) {
      if (!d?.cardano) continue;
      laneIdentity.set(laneKey(d.cardano), {
        client_id: clientIdFromStatePath(d.cardano.client_state_path),
        customer_id: r.customer_id,
      });
    }
  }

  const queueManager = createQueueManager({
    inflightTable,
    clientFactory: (clientStatePath, protocolStatePath) =>
      createCardanoWriteClient(clientStatePath, protocolStatePath, {
        bridge,
        log: debugReport,
        onStep: (intentHash, symbol, step, txHash) => {
          const runtime = intentRuntime.get(intentHash);
          // Per-client submission phase (building/submitting/awaiting-confirmation).
          const phase = submissionStateForStep(step);
          if (phase !== null && runtime) {
            metrics.submissionState.set(clientLabels(runtime), phase);
          }
          if (step === "submitted" && txHash && runtime && runtime.submittedAtMs === undefined) {
            runtime.submittedAtMs = Date.now();
            metrics.transactionsSubmitted.inc({ symbol, ...clientLabels(runtime), router_id: runtime.routerId });
            metrics.bridgeIntentsSubmitted.inc({ symbol, ...clientLabels(runtime), router_id: runtime.routerId });
            metrics.processingToSubmissionSeconds.observe(
              { symbol, ...clientLabels(runtime), router_id: runtime.routerId },
              (runtime.submittedAtMs - runtime.observedAtMs) / 1_000,
            );
            // onStep is a synchronous void callback (the write-client does
            // not await it), so we cannot block here. But a lost insert
            // breaks the transaction audit trail (a submitted tx with no
            // DB record), so the rejection MUST be handled: attach .catch()
            // instead of `void`-suppressing the floating promise. We log
            // and continue — the tx is already on-chain and monotonicity
            // protects the price; the gap is in observability, not funds.
            db.insertTransactionLog({
              intentHash,
              cardanoTxHash: txHash,
              routerId: runtime.routerId,
              clientId: runtime.clientId,
              customerId: runtime.customerId,
              destinationIndex: runtime.destinationIndex,
              destinationChainName: "",
              destinationContractAddress: "",
              symbol: runtime.symbol,
              price: "",
              timestamp: 0,
              status: "submitted",
              submittedAtMs: runtime.submittedAtMs,
              createdAtMs: runtime.submittedAtMs,
            }).catch((err: unknown) => {
              report(
                `[error] daemon: transaction_log insert (submitted) failed for ` +
                `intentHash=${sanitizeLogLine(intentHash)} — ${sanitizeLogLine((err as Error).message)}`,
              );
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
    onRetry: () => {
      metrics.workerTaskRetries.inc({ pool_type: "update" });
    },
  });

  const coalesceWindowMs = parseDurationMs(infra.event_processor?.coalesce_window, DEFAULT_COALESCE_WINDOW_MS);
  const maxIntentAgeRaw  = infra.event_processor?.max_intent_age;
  const maxIntentAgeMs   = maxIntentAgeRaw ? parseDurationMs(maxIntentAgeRaw, 0) || undefined : undefined;
  const maxBatchSize = parsePositiveInteger(infra.event_processor?.max_batch_size);
  const sizeFallbackEnabled = infra.event_processor?.size_fallback_enabled === true;
  const parallelMode        = infra.event_processor?.enable_parallel_mode === true;
  const parallelWorkerCount = parsePositiveInteger(infra.event_processor?.parallel_worker_count) ?? DEFAULT_PARALLEL_WORKER_COUNT;
  const parallelQueueSize   = parsePositiveInteger(infra.event_processor?.parallel_queue_size) ?? DEFAULT_PARALLEL_QUEUE_SIZE;
  const parallelTimeoutMs   = parseDurationMs(infra.event_processor?.parallel_timeout, DEFAULT_PARALLEL_TIMEOUT_MS);

  // Persistent lucid WASM-build failure guard. Counts CONSECUTIVE WASM-
  // signature failures observed in onResult — i.e. AFTER the worker pool's own
  // retries are exhausted for that task, so a single transient blip the retries
  // clear never increments it. Any successful submission resets it to 0. Once
  // the count reaches the threshold the daemon self-exits with a distinct,
  // non-zero code so the supervisor (Docker restart: unless-stopped, or
  // scripts/run-feeder-supervised.sh) restarts with a fresh WASM module; state
  // persists in the DB and resumes. The common transient glitch is handled
  // upstream by the CLI tx-build's completeWithRetry + the worker-pool retries.
  const wasmFatalThreshold = (() => {
    const raw = process.env.WASM_FATAL_CONSECUTIVE_FAILURES?.trim();
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_WASM_FATAL_CONSECUTIVE_FAILURES;
  })();
  let consecutiveWasmFailures = 0;

  const coalescerManager = createCoalescerManager({
    queueManager,
    coalesceWindowMs,
    maxIntentAgeMs,
    maxBatchSize,
    sizeFallbackEnabled,
    symbolInflight,
    onResult: async (result: SubmitResult, req: SubmitRequest) => {
      const nowMs = Date.now();
      const clientId = clientIdFromStatePath(req.destination.client_state_path);
      const runtime = intentRuntime.get(result.intentHash);
      if (result.ok) {
        // Any successful submission clears the persistent-WASM-failure streak.
        consecutiveWasmFailures = nextWasmFailureCount(consecutiveWasmFailures, {
          ok: true,
        });
        healthState.lastConfirmedMs = nowMs;
        const { routerId, destinationIndex, enriched } = req;
        const { symbol, price, timestamp } = enriched.fullIntent;
        const batchSize = result.batch?.size ?? 1;
        const batchMember = result.batch?.members.find((member) => member.intentHash === result.intentHash);
        const customerId = routerCustomers.get(routerId)!;
        const labels = clientLabels({ clientId, customerId });
        // Per-pair (per-symbol) series also carry router_id: on a shared lane
        // each symbol belongs to exactly one router (disjoint symbol sets are
        // enforced at config load), so the dashboard Router filter can scope
        // them. The tx-level series below keep `labels` (no router_id) — one
        // batch tx can mix several routers on one lane.
        const symbolLabels = { ...labels, router_id: routerId };
        metrics.transactionsConfirmed.inc({ symbol, ...symbolLabels });
        metrics.bridgeIntentsConfirmed.inc({ symbol, ...symbolLabels });

        // Tx-level metrics — counted once per TRANSACTION, not per symbol.
        // onResult fires once per intent, so a batch of N pairs fires N times
        // with the same cardanoTxHash; the first batch member is the stateless
        // representative that emits the tx-scoped metrics exactly once. A
        // single (non-batch) confirmation is its own representative.
        metrics.txPairMembership.inc({
          ...routerMembershipLabels({ clientId, customerId, routerId }),
          destination_index: String(destinationIndex),
          symbol,
          outcome: "confirmed",
        });
        if (isTransactionRepresentative(result)) {
          for (const memberRouterId of routerIdsForTransaction(
            result,
            routerId,
            (intentHash) => intentRuntime.get(intentHash)?.routerId,
          )) {
            metrics.transactionRouterMembership.inc({
              ...routerMembershipLabels({
                clientId,
                customerId: routerCustomers.get(memberRouterId)!,
                routerId: memberRouterId,
              }),
              outcome: "confirmed",
            });
          }
          metrics.transactionsTotal.inc({ ...labels, outcome: "confirmed" });
          metrics.transactionPairs.observe({ ...labels, outcome: "confirmed" }, batchSize);
          if (runtime?.submittedAtMs !== undefined) {
            metrics.txProcessingToSubmissionSeconds.observe(
              labels,
              (runtime.submittedAtMs - runtime.observedAtMs) / 1_000,
            );
            metrics.txSubmissionToConfirmationSeconds.observe(
              labels,
              (nowMs - runtime.submittedAtMs) / 1_000,
            );
          }
          if (runtime) {
            metrics.txEndToEndSeconds.observe(
              labels,
              (nowMs - runtime.observedAtMs) / 1_000,
            );
          }
        }
        if (result.feePaidLovelace !== undefined) {
          metrics.bridgeTransactionFeeLovelace.observe(
            { symbol, ...symbolLabels },
            Number(result.feePaidLovelace),
          );
        }
        if (runtime?.submittedAtMs !== undefined) {
          metrics.submissionToConfirmationSeconds.observe(
            { symbol, ...symbolLabels },
            (nowMs - runtime.submittedAtMs) / 1_000,
          );
        }
        if (runtime) {
          metrics.endToEndLatencySeconds.observe(
            { symbol, ...symbolLabels },
            (nowMs - runtime.observedAtMs) / 1_000,
          );
        }
        priceCache.set(
          { routerId, destinationIndex, symbol },
          {
            symbol,
            price,
            timestamp,
            nonce: enriched.fullIntent.nonce,
            intentHash: result.intentHash,
            cardanoTxHash: result.cardanoTxHash,
            confirmedAtDepth: cardanoConfirmationDepth,
            updatedAtMs: nowMs,
            clientId,
            customerId,
            network: req.destination.network,
          },
        );
        metrics.cardanoOracleLastConfirmedTimestampSeconds.set(
          { symbol, ...symbolLabels },
          Number(timestamp),
        );
        metrics.cardanoPairIsCreate.set(
          { symbol, ...symbolLabels },
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
            {
              client_id: clientId,
              receiver_address: postState.receiverAddress ?? "",
              deposit_address: postState.depositAddress ?? "",
            },
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

        // Await + catch: this is the confirmation update. A lost write
        // leaves a tx stuck in "submitted" in the DB forever even though
        // it confirmed on-chain — false-positive for stale-tx alerts and
        // reconciliation. We are in an async handler so we can await.
        await db
          .updateTransactionLog(result.intentHash, {
            cardanoTxHash: result.cardanoTxHash,
            status: "confirmed",
            confirmedAtMs: nowMs,
          })
          .catch((err: unknown) => {
            report(
              `[error] daemon: transaction_log update (confirmed) failed for ` +
              `intentHash=${sanitizeLogLine(result.intentHash)} — ${sanitizeLogLine((err as Error).message)}`,
            );
          });

        // Per-(client, symbol) rollup: the latest confirmed value on the
        // client's pair contract. `contract_address` = the client's pair
        // validator address (the Cardano destination-contract analogue);
        // `last_nonce` lets a restart rehydrate the cron's nonce baseline.
        if (result.pairValidatorAddress) {
          await db
            .upsertContractSymbolUpdate({
              chainId: CARDANO_NETWORK_MAGIC[network],
              contractAddress: result.pairValidatorAddress,
              symbol,
              lastIntentHash: result.intentHash,
              lastCardanoTxHash: result.cardanoTxHash,
              lastPrice: price.toString(),
              lastNonce: enriched.fullIntent.nonce.toString(),
              lastTimestamp: Number(timestamp),
              lastUpdateMs: nowMs,
              lastConfirmedAtDepth: cardanoConfirmationDepth,
              updateCount: 1,
              totalFeePaidLovelace: result.feePaidLovelace,
            })
            .catch((err: unknown) => {
              report(
                `[error] daemon: contract_symbol_updates upsert failed for ` +
                `symbol=${sanitizeLogLine(symbol)} — ${sanitizeLogLine((err as Error).message)}`,
              );
            });
        }
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
        const customerId = routerCustomers.get(req.routerId)!;
        const labels = clientLabels({ clientId, customerId });
        // Per-pair (per-symbol) series carry router_id (see the confirmed path);
        // tx-level series below keep `labels` only.
        const symbolLabels = { ...labels, router_id: req.routerId };
        // A NonMonotonicNonce result means the feeder DECLINED to submit (a
        // newer intent already won on chain) — no tx was broadcast and no fee
        // was paid. It is a correct no-op, not a failure, so it is counted in
        // `intentsSuperseded` and kept out of the failure counters/log.
        if (isNoTransactionFailure(result)) {
          metrics.intentsSuperseded.inc({
            symbol,
            ...symbolLabels,
            reason: result.code,
          });
        } else {
          metrics.transactionsFailed.inc({
            symbol,
            ...symbolLabels,
            error_code: result.code,
          });
          metrics.bridgeIntentsFailed.inc({
            symbol,
            ...symbolLabels,
            reason: result.code,
          });
        }

        // Tx-level failure metrics — counted once per TRANSACTION. Condemned/
        // superseded intents the feeder declined to submit (no tx, no fee) are
        // correct no-ops and excluded; a real batch failure shares one
        // representative (the first batch member) so it counts once.
        if (!isNoTransactionFailure(result)) {
          metrics.txPairMembership.inc({
            ...routerMembershipLabels({ clientId, customerId, routerId: req.routerId }),
            destination_index: String(req.destinationIndex),
            symbol,
            outcome: "failed",
          });
          if (isTransactionRepresentative(result)) {
            for (const memberRouterId of routerIdsForTransaction(
              result,
              req.routerId,
              (intentHash) => intentRuntime.get(intentHash)?.routerId,
            )) {
              metrics.transactionRouterMembership.inc({
                ...routerMembershipLabels({
                  clientId,
                  customerId: routerCustomers.get(memberRouterId)!,
                  routerId: memberRouterId,
                }),
                outcome: "failed",
              });
            }
            metrics.transactionsTotal.inc({ ...labels, outcome: "failed" });
            metrics.transactionPairs.observe({ ...labels, outcome: "failed" }, batchSize);
          }
        }
        if (result.code === "TxDroppedFromChain") {
          metrics.transactionsReorg.inc({ symbol, ...symbolLabels });
        }
        if (isNoTransactionFailure(result)) {
          // No tx broadcast, no fee — a newer intent already won on chain.
          // Logged at info level so it never reads as a transaction failure.
          report(
            `[info] daemon: intent superseded (no tx) — code=${result.code} intentHash=${sanitizeLogLine(result.intentHash)} ` +
            `symbol=${sanitizeLogLine(symbol)} batchSize=${batchSize}`,
          );
        } else {
          report(
            `[error] daemon: TRANSACTION FAILED — code=${result.code} intentHash=${sanitizeLogLine(result.intentHash)} ` +
            `symbol=${sanitizeLogLine(symbol)} batchSize=${batchSize} error="${sanitizeLogLine(result.error.message)}"`,
          );
          report(`[warn] daemon: REMEDIATION — ${sanitizeLogLine(result.remediation)}`);
        }
        // Await + catch: a lost failure-insert means the system has no
        // record an intent was even attempted — failure metrics and
        // post-mortem reconciliation go blind. We are in an async handler.
        await db
          .insertTransactionLog({
            intentHash: result.intentHash,
            cardanoTxHash: "",
            routerId: req.routerId,
            clientId,
            customerId,
            destinationIndex: req.destinationIndex,
            destinationChainName: "",
            destinationContractAddress: "",
            symbol: req.enriched.fullIntent.symbol,
            price: req.enriched.fullIntent.price.toString(),
            timestamp: Number(req.enriched.fullIntent.timestamp),
            status: "failed",
            errorCode: result.code,
            errorMessage: result.error.message,
            failedAtMs: Date.now(),
            createdAtMs: Date.now(),
          })
          .catch((err: unknown) => {
            report(
              `[error] daemon: transaction_log insert (failed) failed for ` +
              `intentHash=${sanitizeLogLine(result.intentHash)} — ${sanitizeLogLine((err as Error).message)}`,
            );
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

        // Persistent lucid WASM-build failure guard. This task has already
        // exhausted the worker-pool retries (onResult fires post-retry), so a
        // WASM-signature failure here is one the in-process rebuild could not
        // clear. Count consecutive WASM failures; any non-WASM failure leaves
        // the streak unchanged (handled by the normal retry/alert path). Once
        // the streak reaches the threshold the WASM module is presumed
        // genuinely corrupted — only a fresh PROCESS gets a fresh WASM module,
        // so log FATAL and self-exit for the supervisor to restart us.
        consecutiveWasmFailures = nextWasmFailureCount(consecutiveWasmFailures, {
          ok: false,
          error: result.error,
        });
        if (shouldExitOnWasmFailures(consecutiveWasmFailures, wasmFatalThreshold)) {
          report(
            `[error] daemon: FATAL — ${consecutiveWasmFailures} consecutive lucid WASM ` +
            `build failures (threshold=${wasmFatalThreshold}). The in-process rebuild ` +
            `could not clear it, so the WASM module is presumed corrupted. Exiting with ` +
            `code ${WASM_FATAL_EXIT_CODE} so the supervisor restarts the daemon with a ` +
            `fresh WASM module; state persists in the DB and resumes on restart.`,
          );
          process.exit(WASM_FATAL_EXIT_CODE);
        }
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
      // Two independent per-client gauges from the lane lifecycle: the coalescer
      // state (idle/accumulating/in-flight) and the submit-pipeline entry/idle
      // (the finer building/submitting/awaiting phases come from onStep above).
      const laneOwner = laneIdentity.get(event.lane);
      if (laneOwner) {
        const subPhase = submissionStateForLaneEvent(event.kind);
        if (subPhase !== null) metrics.submissionState.set(laneOwner, subPhase);
        const coPhase = coalescerStateForLaneEvent(event.kind);
        if (coPhase !== null) metrics.coalescerState.set(laneOwner, coPhase);
      }
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
  // Update worker pool manager — per-router task concurrency.
  //       Mirrors Spectra's Bridge.getOrCreateOraclePool(routerID).
  //       Tasks are update requests routed through the coalescer;
  //       all Cardano submission remains serial via the lane queue.
  // ------------------------------------------------------------------
  const updateWorkerMaxWorkers   = parsePositiveInteger(infra.worker_pool?.max_workers) ?? DEFAULT_UPDATE_WORKER_MAX_WORKERS;
  const updateWorkerQueueSize    = parsePositiveInteger(infra.worker_pool?.task_queue_size) ?? DEFAULT_UPDATE_WORKER_QUEUE_SIZE;
  const updateWorkerTimeoutMs    = parseDurationMs(infra.worker_pool?.task_timeout, DEFAULT_UPDATE_WORKER_TIMEOUT_MS);

  const updatePoolManager: UpdateWorkerPoolManager = createUpdateWorkerPoolManager({
    maxWorkers: updateWorkerMaxWorkers,
    taskQueueSize: updateWorkerQueueSize,
    taskTimeoutMs: updateWorkerTimeoutMs,
    onTask: async (_routerId, task) => {
      for (const req of task.requests) {
        coalescerManager.accept(req);
      }
      // A lane task that ran to completion — the submission worker pool that is
      // actually active (the parallel event pool is opt-in and off by default).
      metrics.workerTasksCompleted.inc({ pool_type: "update" });
    },
    onTaskError: () => {
      metrics.workerTasksFailed.inc({ pool_type: "update" });
    },
    log: report,
  });
  updatePoolManagerRef = updatePoolManager;

  // ------------------------------------------------------------------
  // Startup reconciliation + cache hydrate — sync local pair-state
  //       files with live on-chain UTxOs, then seed priceCache before
  //       cron/alerting read it.
  // ------------------------------------------------------------------
  if (!dryRun) {
    await reconcileAllDestinations({ config, log: report });
  }
  const hydratedPriceCache = await hydratePriceCacheFromPairStateFiles({
    config,
    priceCache,
    metrics,
    confirmationDepth: cardanoConfirmationDepth,
    log: report,
  });
  if (hydratedPriceCache.maxUpdatedAtMs > 0) {
    healthState.lastConfirmedMs = hydratedPriceCache.maxUpdatedAtMs;
  }

  // Populate the Grafana filter dropdowns (Customer/Client/Router/Symbol) from
  // config at boot, at value 0, so they are not empty before the first
  // confirmation; the live confirm path increments these same series.
  seedDropdownSeriesFromConfig(config, metrics);
  report("metrics: seeded dashboard filter series from config (value 0)");

  // ------------------------------------------------------------------
  // Cron service — Spectra parity. Re-submits the latest known
  //      intent for any cron-enabled destination whose on-chain pair
  //      has gone stale beyond its `time_threshold`. The service runs
  //      alongside the scan pipeline; when disabled it is a no-op.
  // ------------------------------------------------------------------
  const cronEnabled = config.infrastructure?.cron_service?.enabled === true;
  const cronTickIntervalMs = parseDurationMs(
    config.infrastructure?.cron_service?.tick_interval,
    DEFAULT_CRON_TICK_INTERVAL_MS,
  );
  const cronHandle = startCronService({
    enabled: cronEnabled,
    tickIntervalMs: cronTickIntervalMs,
    alignedHeartbeat:
      config.infrastructure?.cron_service?.aligned_heartbeat ?? DEFAULT_ALIGNED_HEARTBEAT,
    routers: config.routers,
    latestIntents,
    priceCache,
    submit: (req) => {
      // Cron re-submissions don't pass through `processOneEvent`, so they have
      // no `intentRuntime` entry. Without one, the submitted-insert and the
      // latency observations (both runtime-gated) are skipped, and the
      // post-confirm `updateTransactionLog` fails with "no row" — the tx
      // confirms on-chain but never lands in `transaction_log` or the latency
      // histograms. Stamp the identity here so a cron update is recorded exactly
      // like a live one. `observedAtMs = now` makes processing→submission
      // measure the coalesce wait (the only "processing" a re-submission has).
      if (!intentRuntime.has(req.intentHash)) {
        intentRuntime.set(req.intentHash, {
          ...buildRouterIdentity({
            customerId: routerCustomers.get(req.routerId)!,
            routerId: req.routerId,
            destinationIndex: req.destinationIndex,
            cardano: req.destination,
          }),
          observedAtMs: Date.now(),
          symbol: req.enriched.fullIntent.symbol,
        });
      }
      return coalescerManager.accept(req);
    },
    isInFlight: (routerId, destinationIndex, symbol) =>
      symbolInflight.has(routerId, destinationIndex, symbol),
    metrics,
    log: report,
    signal,
  });
  // Keep the handle reachable from the daemon-level shutdown path; not
  // strictly required because the signal aborts the loop, but the
  // reference prevents the linter from flagging an unused binding.
  void cronHandle;

  // Refresh healthState.workerQueueDepth from the queue manager so the
  // /health/ready max_queue_size check works in BOTH sequential and
  // parallel modes. In parallel mode the EventWorkerPool also writes
  // this field on every onStats tick; both writers are safe because
  // the readiness handler only reads (single-threaded JS).
  const healthCheckIntervalMs = parseDurationMs(
    infra.health_check?.check_interval,
    DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  );
  let queueDepthTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => {
      healthState.workerQueueDepth = queueManager.totalPending();
      // Submission (update) worker pool gauges — this pool ALWAYS runs, so its
      // worker metrics populate in sequential mode too, not only when the
      // opt-in parallel event pool is enabled. Summed across per-router pools.
      let active = 0;
      let capacity = 0;
      for (const s of updatePoolManager.listAllStats()) {
        active += s.activeWorkers;
        capacity += s.maxWorkers;
      }
      metrics.activeWorkers.set({ pool_type: "update" }, active);
      metrics.workerPoolSize.set({ pool_type: "update" }, capacity);
      metrics.workerQueueSize.set({ pool_type: "update" }, queueManager.totalPending());

      // Per-client queue depths: the coalescer buffer (intents accumulating before
      // a flush) and the serial submit queue (tasks waiting their turn). Iterate
      // every configured lane so idle clients report 0, not a stale last value.
      const buffered = coalescerManager.bufferedByLane();
      const pending = queueManager.pendingByLane();
      for (const [lane, owner] of laneIdentity) {
        metrics.coalescerBuffered.set(owner, buffered[lane] ?? 0);
        metrics.submitQueuePending.set(owner, pending[lane] ?? 0);
      }
    },
    healthCheckIntervalMs,
  );
  // Seed an initial sample so readiness has a value before the first tick.
  healthState.workerQueueDepth = queueManager.totalPending();
  signal?.addEventListener("abort", () => {
    if (queueDepthTimer) {
      clearInterval(queueDepthTimer);
      queueDepthTimer = null;
    }
  }, { once: true });

  // ------------------------------------------------------------------
  // Balance refresh — keep the wallet/contract balance gauges current
  //       INDEPENDENTLY of oracle-update traffic. A balance dashboard must
  //       show the real numbers even when no update is flowing (e.g. the
  //       Receiver is empty), so we poll chain on the cron cadence rather
  //       than only at post-confirmation. Read-only; never submits.
  // ------------------------------------------------------------------
  const balanceRefreshDests: Array<{
    clientStatePath: string;
    protocolStatePath: string;
    cardano: CardanoDestinationConfig;
  }> = [];
  {
    const seenDest = new Set<string>();
    for (const router of Object.values(config.routers)) {
      if (!router.enabled) continue;
      for (const dest of router.destinations) {
        if (!dest.cardano) continue;
        const key = laneKey(dest.cardano);
        if (seenDest.has(key)) continue;
        seenDest.add(key);
        balanceRefreshDests.push({
          clientStatePath: dest.cardano.client_state_path,
          protocolStatePath: dest.cardano.protocol_state_path,
          cardano: dest.cardano,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Deposit auto-merge — fold each client's pending side-deposits into
  //       its Receiver balance on the same cadence as the balance refresh.
  //       Safe-by-default: only when NOT dry-run and only for destinations
  //       that have a deposit address.
  //
  //       The merge spends the SAME Receiver UTxO as an oracle update, so it
  //       MUST never run concurrently with one. We get that for free by
  //       dispatching the merge onto the SAME serial lane queue the client's
  //       updates use (`queueManager.enqueueLaneTask(dest, …)`): the queue
  //       runs one entry at a time per lane, so an in-flight update finishes
  //       before the merge body starts, and any update enqueued during the
  //       merge waits for the merge to finish. Mutual exclusion is structural,
  //       not a best-effort lock check.
  // ------------------------------------------------------------------
  // Per-lane dedup guard. A merge spans many refresh ticks (build → submit →
  // confirm) and may sit queued behind an in-flight update, so without this we
  // would enqueue a fresh merge task every tick. It is NOT a safety lock — the
  // lane queue provides mutual exclusion; this only collapses duplicates.
  const mergeInProgress = new Set<string>();

  // Dedup guards for the automatic fee-loop maintenance tasks, mirroring
  // `mergeInProgress`. Each spans many ticks (build → submit → confirm); the
  // guard collapses duplicate enqueues. Mutual exclusion is the lane queue's
  // job. Settle is per-lane (per Receiver); withdraw (one PaymentHook) and
  // consolidate (one shared admin wallet) are process-wide, so a boolean each.
  const settleInProgress = new Set<string>();
  let withdrawInProgress = false;
  let consolidateInProgress = false;

  // Log each client's deposit address exactly once (the first refresh that
  // resolves it) so operators can see / hand it out — a client funds its
  // Receiver by paying ADA there with a plain wallet payment, no CLI needed.
  // The address is a derived chain value (not in config), so it is surfaced
  // from the snapshot rather than read from YAML.
  const loggedDepositAddrs = new Set<string>();

  async function maybeAutoMergeDeposits(
    dest: { clientStatePath: string; protocolStatePath: string; cardano: CardanoDestinationConfig },
    snapshot: { depositPendingLovelace?: bigint; receiverBalanceLovelace?: bigint; receiverUnit?: string; depositAddress?: string; clientId?: string },
  ): Promise<void> {
    const lane = laneKey(dest.cardano);
    const clientId = snapshot.clientId ?? dest.clientStatePath;
    const decision = shouldAutoMergeDeposits({
      receiverBalanceLovelace: snapshot.receiverBalanceLovelace,
      depositPendingLovelace: snapshot.depositPendingLovelace,
      receiverBalanceLowLovelace,
      depositPendingMergeLovelace,
      mergeInProgress: mergeInProgress.has(lane),
    });
    if (!decision.merge) {
      // A merge already enqueued/running for this lane is the only actionable
      // skip worth logging; the common "nothing to do" cases stay debug-level
      // to avoid log spam each tick.
      if (decision.reason === "merge_in_progress") {
        report(`[debug] auto-merge: skip client=${clientId} reason=${decision.reason}`);
      }
      return;
    }

    // Hold the dedup guard from now until the merge task settles so no second
    // task is enqueued for this lane while this one is queued/running.
    mergeInProgress.add(lane);
    report(
      `auto-merge: enqueueing merge on lane client=${clientId} reason=${decision.reason} ` +
      `pending=${snapshot.depositPendingLovelace ?? 0n} receiverBalance=${snapshot.receiverBalanceLovelace ?? "?"} ` +
      `addr=${snapshot.depositAddress ?? "?"}`,
    );

    // Dispatch the merge onto the SAME serial lane the client's updates use.
    // The body runs only when the lane is free (no update mid-submission) and
    // blocks any later update on this lane until it finishes — hard mutual
    // exclusion on the shared Receiver UTxO, by construction of the queue. No
    // separate in-flight lock is needed: the lane queue IS the lock, and the
    // bridge merge builds, submits, and awaits confirmation before resolving,
    // so the lane stays held for the whole build→submit→confirm lifecycle. We
    // do not await the returned promise here so the refresh tick is not
    // blocked; the dedup guard and lane queue keep subsequent ticks correct.
    void queueManager
      .enqueueLaneTask(dest.cardano, async () => {
        const merged = await bridge.mergeDeposits({
          clientStatePath: dest.clientStatePath,
          protocolStatePath: dest.protocolStatePath,
        });
        report(
          `auto-merge: done client=${clientId} confirmed=${merged.confirmed} txHash=${merged.txHash ?? "(none)"}`,
        );
      })
      .catch((err) => {
        // Non-fatal — log and retry on the next tick. A common cause is a race
        // where the deposits were already swept, or a transient provider error.
        report(`[warn] auto-merge: failed client=${clientId} — ${sanitizeLogLine((err as Error).message)}`);
      })
      .finally(() => {
        mergeInProgress.delete(lane);
      });
  }

  // Automatic fee-loop maintenance — settle / withdraw / consolidate. Each
  // mirrors maybeAutoMergeDeposits: a pure decision, a dedup guard, and a
  // fire-and-forget lane task that builds → submits → confirms. They run on the
  // SAME serial lane as updates, so they never race an update on that Receiver.
  // The alert for each fires FIRST (lower/earlier threshold); these only act
  // once the condition develops past the `auto_*` threshold.

  async function maybeAutoSettle(
    dest: { clientStatePath: string; protocolStatePath: string; cardano: CardanoDestinationConfig },
    snapshot: { receiverAccruedLovelace?: bigint; clientId?: string },
  ): Promise<void> {
    const lane = laneKey(dest.cardano);
    const clientId = snapshot.clientId ?? dest.clientStatePath;
    const decision = shouldAutoSettle({
      receiverAccruedLovelace: snapshot.receiverAccruedLovelace,
      autoSettleLovelace,
      inProgress: settleInProgress.has(lane),
    });
    if (!decision.act) return;
    settleInProgress.add(lane);
    report(
      `auto-settle: enqueueing settle client=${clientId} accrued=${snapshot.receiverAccruedLovelace ?? "?"} ` +
      `threshold=${autoSettleLovelace}`,
    );
    void queueManager
      .enqueueLaneTask(dest.cardano, async () => {
        const res = await bridge.settle({
          clientStatePath: dest.clientStatePath,
          protocolStatePath: dest.protocolStatePath,
        });
        report(`auto-settle: done client=${clientId} confirmed=${res.confirmed} txHash=${res.txHash ?? "(none)"}`);
      })
      .catch((err) => {
        report(`[warn] auto-settle: failed client=${clientId} — ${sanitizeLogLine((err as Error).message)}`);
      })
      .finally(() => {
        settleInProgress.delete(lane);
      });
  }

  async function maybeAutoWithdraw(
    dest: { clientStatePath: string; protocolStatePath: string; cardano: CardanoDestinationConfig },
    snapshot: { paymentHookAccruedLovelace?: bigint },
  ): Promise<void> {
    const decision = shouldAutoWithdraw({
      paymentHookAccruedLovelace: snapshot.paymentHookAccruedLovelace,
      autoWithdrawLovelace,
      inProgress: withdrawInProgress,
    });
    if (!decision.act) return;
    withdrawInProgress = true;
    report(
      `auto-withdraw: enqueueing payment-hook withdraw amount=${decision.amountLovelace} ` +
      `threshold=${autoWithdrawLovelace}`,
    );
    // The withdraw spends the single shared PaymentHook + admin-wallet UTxOs. We
    // run it on this dest's lane so it serializes against that client's updates;
    // the process-wide `withdrawInProgress` guard keeps it single-flight across
    // all lanes.
    void queueManager
      .enqueueLaneTask(dest.cardano, async () => {
        const res = await bridge.withdrawFromPaymentHook({
          protocolStatePath: dest.protocolStatePath,
          amountLovelace: decision.amountLovelace,
        });
        report(`auto-withdraw: done confirmed=${res.confirmed} txHash=${res.txHash ?? "(none)"}`);
      })
      .catch((err) => {
        report(`[warn] auto-withdraw: failed — ${sanitizeLogLine((err as Error).message)}`);
      })
      .finally(() => {
        withdrawInProgress = false;
      });
  }

  async function maybeAutoConsolidate(
    dest: { cardano: CardanoDestinationConfig },
    snapshot: { adminWalletMaxUtxoLovelace?: bigint },
  ): Promise<void> {
    const decision = shouldAutoConsolidate({
      adminWalletMaxUtxoLovelace: snapshot.adminWalletMaxUtxoLovelace,
      autoConsolidateBelowLovelace,
      inProgress: consolidateInProgress,
    });
    if (!decision.act) return;
    consolidateInProgress = true;
    report(
      `auto-consolidate: enqueueing wallet consolidate largestUtxo=${snapshot.adminWalletMaxUtxoLovelace ?? "?"} ` +
      `threshold=${autoConsolidateBelowLovelace} collateral=${collateralUtxoLovelace}`,
    );
    // Consolidate spends ONLY admin-wallet UTxOs (a plain self-payment, no
    // script, no collateral needed to build), but every update also spends
    // wallet UTxOs for fees, so we run it on a lane and keep it single-flight
    // process-wide to avoid colliding with an in-flight build.
    void queueManager
      .enqueueLaneTask(dest.cardano, async () => {
        const res = await bridge.consolidateWallet({ collateralLovelace: collateralUtxoLovelace });
        report(`auto-consolidate: done confirmed=${res.confirmed} txHash=${res.txHash ?? "(none)"}`);
      })
      .catch((err) => {
        report(`[warn] auto-consolidate: failed — ${sanitizeLogLine((err as Error).message)}`);
      })
      .finally(() => {
        consolidateInProgress = false;
      });
  }

  // Cardano API provider health — primary (the lucid build/submit provider) vs
  // secondary (confirmation/reorg redundancy), keyed off CARDANO_PROVIDER so the
  // critical alert always tracks whichever provider actually builds.
  const providerRoles = resolveProviderRoles(process.env.CARDANO_PROVIDER);
  const providerHealth = createProviderHealthRecorder(metrics);
  // Endpoints for the secondary liveness probe, resolved once. Tolerate a
  // missing config (e.g. dry-run) by skipping the probe instead of crashing.
  let providerProbeConfig:
    | { koiosApiUrl?: string; blockfrostApiUrl?: string; blockfrostProjectId?: string }
    | undefined;
  try {
    const cli = getCliConfig();
    providerProbeConfig = {
      koiosApiUrl: cli.koiosApiUrl,
      blockfrostApiUrl: cli.blockfrostApiUrl,
      blockfrostProjectId: cli.blockfrostProjectId,
    };
  } catch {
    providerProbeConfig = undefined;
  }

  async function refreshBalanceGauges(): Promise<void> {
    let primaryOk = false;
    for (const dest of balanceRefreshDests) {
      try {
        const b = await bridge.snapshotBalances(dest);
        primaryOk = true;
        const clientId = b.clientId ?? dest.clientStatePath;
        // Surface the per-client deposit address once so operators can hand it
        // to the client. Logged on the first refresh that resolves it.
        if (b.depositAddress && !loggedDepositAddrs.has(b.depositAddress)) {
          loggedDepositAddrs.add(b.depositAddress);
          report(`deposit-address: client=${clientId} addr=${b.depositAddress}`);
        }
        if (b.receiverBalanceLovelace !== undefined) {
          metrics.cardanoReceiverBalanceLovelace.set(
            {
              client_id: clientId,
              receiver_address: b.receiverAddress ?? "",
              deposit_address: b.depositAddress ?? "",
            },
            Number(b.receiverBalanceLovelace),
          );
        }
        if (b.receiverAccruedLovelace !== undefined) {
          metrics.cardanoReceiverAccruedLovelace.set({ client_id: clientId }, Number(b.receiverAccruedLovelace));
        }
        if (b.paymentHookAccruedLovelace !== undefined) {
          metrics.cardanoPaymentHookAccruedLovelace.set({}, Number(b.paymentHookAccruedLovelace));
        }
        if (b.adminWalletLovelace !== undefined) {
          metrics.cardanoAdminWalletLovelace.set({}, Number(b.adminWalletLovelace));
        }
        if (b.adminWalletMaxUtxoLovelace !== undefined) {
          metrics.cardanoAdminWalletMaxUtxoLovelace.set({}, Number(b.adminWalletMaxUtxoLovelace));
        }
        // Deposit-pending gauge — emit only when the deposit query succeeded
        // (depositPendingLovelace defined). The address may be present even
        // when the query failed, so guard on the lovelace field.
        if (b.depositPendingLovelace !== undefined) {
          metrics.cardanoDepositPendingLovelace.set(
            { client_id: clientId, deposit_address: b.depositAddress ?? "" },
            Number(b.depositPendingLovelace),
          );
        }
        // Automatic fee-loop maintenance — all run off this same snapshot so we
        // never double-probe chain. Each is gated by its own threshold + dedup
        // guard and dispatched as a serial lane task.
        await maybeAutoMergeDeposits(dest, b);
        await maybeAutoSettle(dest, b);
        await maybeAutoWithdraw(dest, b);
        await maybeAutoConsolidate(dest, b);
      } catch (err) {
        report(`balance-refresh: ${dest.clientStatePath} failed: ${(err as Error).message}`);
      }
    }
    // PRIMARY provider health — passive: lucid uses it for the snapshot above,
    // so any success in this pass means it is reachable. Drives readiness +
    // the PrimaryProviderDown alert (e.g. a Blockfrost 402 quota wall freezes
    // every build → no success → the last-ok gauge ages → alert).
    providerHealth.record("primary", providerRoles.primary, primaryOk);
    healthState.primaryProviderHealthy = primaryOk;
    // SECONDARY provider health — active liveness probe, since it is only called
    // on demand (confirmation/reorg) and "idle" can't be told from "down".
    if (providerProbeConfig) {
      const secondaryOk = await probeProvider(providerRoles.secondary, {
        ...providerProbeConfig,
        timeoutMs: DEFAULT_PROVIDER_PROBE_TIMEOUT_MS,
      });
      providerHealth.record("secondary", providerRoles.secondary, secondaryOk);
    }
  }

  let balanceRefreshTimer: ReturnType<typeof setInterval> | null = null;
  if (!dryRun && balanceRefreshDests.length > 0) {
    // Seed once at startup so the gauges populate before the first scrape,
    // then refresh on the cron cadence (cron_service.tick_interval).
    void refreshBalanceGauges();
    balanceRefreshTimer = setInterval(() => {
      void refreshBalanceGauges();
    }, cronTickIntervalMs);
    signal?.addEventListener("abort", () => {
      if (balanceRefreshTimer) {
        clearInterval(balanceRefreshTimer);
        balanceRefreshTimer = null;
      }
    }, { once: true });
  }

  // ------------------------------------------------------------------
  // Feed sanity — periodic on-chain-vs-DIA-source accuracy/freshness
  //       check on its OWN clock (`feed_sanity.interval`), independent of the
  //       cron tick and the balance refresh. Per feed it reads the LIVE Pair
  //       UTxO (verify the real chain), compares it to the latest DIA intent
  //       the feeder has seen in memory, and publishes `feed_sanity_status`
  //       (0 ok / 1 suspect / 2 broken) which the FeedAccuracyFail alert
  //       watches. The same logic is runnable on demand via `npm run sanity:feeds`.
  // ------------------------------------------------------------------
  const feedSanityCfg = infra.feed_sanity;
  const feedSanityGraceSec = feedSanityCfg?.freshness_grace_seconds ?? DEFAULT_FEED_SANITY_GRACE_SECONDS;
  const feedSanityDests: Array<{
    routerId: string;
    destinationIndex: number;
    customerId: string;
    symbols: string[];
    cardano: CardanoDestinationConfig;
    thresholds: ReturnType<typeof deriveFeedThresholds>;
  }> = [];
  if (feedSanityCfg?.enabled) {
    for (const router of Object.values(config.routers)) {
      if (!router.enabled) continue;
      const symbols = extractRouterSymbols(router);
      router.destinations.forEach((dest, destinationIndex) => {
        if (!dest.cardano) return;
        feedSanityDests.push({
          routerId: router.id,
          destinationIndex,
          customerId: router.customer_id,
          symbols,
          cardano: dest.cardano,
          thresholds: deriveFeedThresholds(
            {
              price_deviation: dest.price_deviation,
              time_threshold: dest.time_threshold,
              max_staleness: dest.max_staleness,
            },
            { graceSec: feedSanityGraceSec },
          ),
        });
      });
    }
  }

  async function refreshFeedSanity(): Promise<void> {
    let lucid: Awaited<ReturnType<typeof makeConfiguredLucidWithConfig>>;
    try {
      lucid = await makeConfiguredLucidWithConfig(getCliConfig());
    } catch (err) {
      report(`feed-sanity: lucid init failed: ${(err as Error).message}`);
      return;
    }
    for (const dest of feedSanityDests) {
      try {
        const { client } = await readClientContext({
          clientStatePath: dest.cardano.client_state_path,
          protocolStatePath: dest.cardano.protocol_state_path,
        });
        const pairValidatorAddress = client.scripts.pairValidatorAddress;
        const pairPolicyId = client.scripts.pairPolicyId;
        if (!pairValidatorAddress || !pairPolicyId) continue;

        const onChain = await readOnChainPairs({
          utxosAt: (address) => lucid.utxosAt(address),
          decodePairDatum,
          pairValidatorAddress,
          pairPolicyId,
        });

        const clientId = clientIdFromStatePath(dest.cardano.client_state_path);
        const deps: FeedSanityDeps = {
          readOnChain: async (symbol) => onChain.get(symbol) ?? null,
          readLatestSource: async (symbol) => {
            const latest = latestIntents.get({
              routerId: dest.routerId,
              destinationIndex: dest.destinationIndex,
              symbol,
            });
            if (!latest) return null;
            return {
              price: latest.enriched.fullIntent.price,
              timestampSec: latest.enriched.fullIntent.timestamp,
            };
          },
          thresholdsFor: () => dest.thresholds,
        };

        const results = await runFeedSanityChecks(dest.symbols, deps);
        const labels = clientLabels({ clientId, customerId: dest.customerId });
        for (const result of results) {
          metrics.feedSanityStatus.set(
            { ...labels, symbol: result.symbol },
            sanityStatusCode(result.status),
          );
        }
      } catch (err) {
        report(`feed-sanity: ${dest.cardano.client_state_path} failed: ${(err as Error).message}`);
      }
    }
  }

  let feedSanityTimer: ReturnType<typeof setInterval> | null = null;
  if (!dryRun && feedSanityDests.length > 0) {
    const feedSanityIntervalMs = parseDurationMs(feedSanityCfg?.interval, DEFAULT_FEED_SANITY_INTERVAL_MS);
    void refreshFeedSanity();
    feedSanityTimer = setInterval(() => {
      void refreshFeedSanity();
    }, feedSanityIntervalMs);
    signal?.addEventListener("abort", () => {
      if (feedSanityTimer) {
        clearInterval(feedSanityTimer);
        feedSanityTimer = null;
      }
    }, { once: true });
  }

  // ------------------------------------------------------------------
  // Source pipeline.
  // ------------------------------------------------------------------
  // DB checkpoint: scanner position lives in chain_state.last_scan_block.
  // No JSON file; chain_state row was created by initialiseChainState above.
  const checkpoint = createDbCheckpoint({
    db,
    chainId: source.chainId,
    contractId: source.registryContractId,
  });
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

  // Block-timestamp resolver shared by HTTP and WS scanners. Populates
  // ExtractedEvent.blockTimestamp from the block header, which is what
  // makes intent_to_registration_seconds and registration_to_scan_seconds
  // emit non-zero values. Uses the HTTP RPC even when the active scanner
  // is WS — block-header lookups are cheap and avoid a second WS client.
  const blockTimestampResolver = async (blockNumber: bigint): Promise<bigint> => {
    const block = await enricherClient.getBlock({ blockNumber, includeTransactions: false });
    return block.timestamp;
  };

  // Event worker pool — created only when enable_parallel_mode=true.
  // Workers process events concurrently but all Cardano submissions
  // still go through the serial coalescer+queue path (lane safety).
  let eventWorkerPool: EventWorkerPool | null = null;
  if (parallelMode) {
    eventWorkerPool = createEventWorkerPool({
      workerCount: parallelWorkerCount,
      queueSize: parallelQueueSize,
      processingTimeoutMs: parallelTimeoutMs,
      onEvent: async (event) => {
        await processOneEvent({
          event,
          observedAtMs: Date.now(),
          scannerType: transport,
          dedupCache,
          enricher,
          routerRegistry,
          routerSigners,
          routerCustomers,
          priceCache,
          latestIntents,
          coalescerManager,
          updatePoolManager,
          fileLogger,
          db,
          intentRuntime,
          network,
          dryRun,
          report,
          metrics,
        });
      },
      onStats: (stats) => {
        metrics.activeWorkers.set({ pool_type: "event" }, stats.activeWorkers);
        metrics.workerQueueSize.set({ pool_type: "event" }, stats.queueLength);
        healthState.workerQueueDepth = stats.queueLength;
      },
      log: report,
    });
    eventWorkerPool.start();
    metrics.workerPoolSize.set({ pool_type: "event" }, parallelWorkerCount);
    report(
      `daemon: event worker pool started workers=${parallelWorkerCount} queue=${parallelQueueSize} timeoutMs=${parallelTimeoutMs}`,
    );
  }

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

    if (parallelMode && eventWorkerPool) {
      // Parallel mode: submit each event to the pool. Dropped events are
      // explicitly accounted for so the block can still be checkpointed.
      for (const event of batch.events) {
        const accepted = eventWorkerPool.submit(event);
        if (!accepted) {
          metrics.workerTasksDropped.inc({ pool_type: "event" });
          report(
            `[warn] daemon: event worker queue full — dropped intentHash=${event.intentHash} block=${event.blockNumber}`,
          );
        }
      }
    } else {
      // Sequential mode (default): process events in order.
      for (const event of batch.events) {
        await processOneEvent({
          event,
          observedAtMs,
          scannerType: transport,
          dedupCache,
          enricher,
          routerRegistry,
          routerSigners,
          routerCustomers,
          priceCache,
          latestIntents,
          coalescerManager,
          updatePoolManager,
          fileLogger,
          db,
          intentRuntime,
          network,
          dryRun,
          report,
          metrics,
        });
      }
    }
    await db.setLastProcessedBlock(source.chainId, source.registryContractId, batch.toBlock);
    metrics.scannerBlockLag.set({ chain_id: String(source.chainId) }, 0);
  };

  report(
    `daemon: starting scan pipeline transport=http+ws chain_id=${source.chainId} ` +
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
    // TODO: wire to a Prometheus gauge once the metric is defined
    setTransportUp: () => {},
  };

  try {
    // Both HTTP and WS run concurrently — HTTP is the reliable baseline,
    // WS is the real-time fast path. The dedup cache absorbs events that
    // arrive on both transports simultaneously.
    const transportPromises: Promise<void>[] = [
      runHttpTransport({ source, checkpoint, handleBatch, signal, report,
        chainId: source.chainId, scannerMetrics,
        startBlock, blockRange, scanIntervalMs, confirmations,
        backwardSync, maxBlockGap,
        getBlockTimestamp: blockTimestampResolver }),
    ];

    // WS is optional — skip silently when no ws_url is configured.
    const wsUrl = source.wsUrl ?? config.infrastructure?.source?.ws_url;
    if (wsUrl) {
      transportPromises.push(
        runWsTransport({ source, checkpoint, handleBatch, network, signal, report,
          chainId: source.chainId, scannerMetrics,
          reconnectIntervalMs: reconnectMs, maxReconnects,
          getBlockTimestamp: blockTimestampResolver }).catch((err) => {
          // WS failure logs but does not kill the HTTP baseline.
          scannerMetrics.setTransportUp({ chain_id: String(source.chainId), transport: "ws" }, 0);
          report(`daemon: WS transport failed — ${(err as Error).message} — continuing on HTTP`);
        }),
      );
      scannerMetrics.setTransportUp({ chain_id: String(source.chainId), transport: "ws" }, 1);
    } else {
      report(`daemon: no ws_url configured — running HTTP transport only`);
    }

    scannerMetrics.setTransportUp({ chain_id: String(source.chainId), transport: "http" }, 1);
    await Promise.all(transportPromises);
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
    if (queueDepthTimer) {
      clearInterval(queueDepthTimer);
      queueDepthTimer = null;
    }
    await updatePoolManager.stopAll();
    if (eventWorkerPool) {
      await eventWorkerPool.stop();
    }
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
  /** Per-router Cardano signer, keyed by router id. Resolved once at
   *  startup; attached to each SubmitRequest so the bridge signs with the
   *  router's own key. */
  routerSigners: Map<string, RouterSigner>;
  /** Router id -> customer_id (the router's owner). Used to stamp the runtime
   *  identity once, so downstream metrics/logs read `customerId` off the entry
   *  instead of looking it up again. */
  routerCustomers: Map<string, string>;
  priceCache: ReturnType<typeof createPriceCache>;
  latestIntents: LatestIntentCache;
  coalescerManager: CoalescerManager;
  updatePoolManager: UpdateWorkerPoolManager;
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
    event, observedAtMs, scannerType, dedupCache, enricher, routerRegistry, routerSigners, routerCustomers,
    priceCache, latestIntents, coalescerManager, updatePoolManager, fileLogger, db, intentRuntime, dryRun, report, metrics,
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
    report(`daemon: enrichment failed for ${sanitizeLogLine(event.intentHash)}: ${sanitizeLogLine((err as Error).message)}`);
    return;
  }

  metrics.intentsScanned.inc({ symbol: enriched.fullIntent.symbol, scanner_type: scannerType });
  metrics.bridgeIntentsScanned.inc({ symbol: enriched.fullIntent.symbol, scanner_type: scannerType });
  // 6-phase latency — phases 1 and 2 require a non-zero blockTimestamp.
  if (event.blockTimestamp > 0n) {
    const blockTs = Number(event.blockTimestamp);
    const intentTs = Number(enriched.fullIntent.timestamp);
    metrics.intentToRegistrationSeconds.observe(
      { symbol: enriched.fullIntent.symbol },
      Math.max(0, blockTs - intentTs),
    );
    metrics.registrationToScanSeconds.observe(
      { symbol: enriched.fullIntent.symbol },
      Math.max(0, observedAtMs / 1_000 - blockTs),
    );
  }
  metrics.scanToProcessingSeconds.observe(
    { symbol: enriched.fullIntent.symbol },
    Math.max(0, Date.now() - observedAtMs) / 1_000,
  );

  const transformed = identityTransformer(enriched);
  const output = routeIntent(routerRegistry, priceCache, "IntentRegistered", transformed);

  // Source-data age — recorded ONLY for symbols this feeder actually routes (the
  // intent matched at least one router), not every symbol the scanner sees. The
  // DIA source feed carries hundreds of symbols we do not use; counting their age
  // would flood the price-age panel and fire PriceAgeHigh for pairs we never
  // publish. Scoping to routed symbols keeps the metric / panel / alert about the
  // data the oracle actually consumes.
  // Source-data age per (router, symbol): recorded for every router this intent
  // routed to (dispatched or policy-filtered), so the dashboard Router filter
  // scopes it. A symbol maps to one router per lane, but the same symbol may feed
  // routers on different clients, so it can be recorded under more than one.
  {
    const priceAge = Math.max(0, Date.now() / 1_000 - Number(enriched.fullIntent.timestamp));
    const ageRouterIds = new Set<string>([
      ...output.dispatched.map((d) => d.routerId),
      ...output.policyFiltered.map((p) => p.routerId),
    ]);
    for (const ageRouterId of ageRouterIds) {
      metrics.priceAgeSeconds.observe(
        { symbol: enriched.fullIntent.symbol, router_id: ageRouterId },
        priceAge,
      );
    }
  }

  for (const { routerId, reason } of output.conditionFiltered) {
    metrics.intentsFiltered.inc({
      symbol: enriched.fullIntent.symbol,
      router_id: routerId,
      reason: "condition",
    });
    report(`[debug] daemon: condition-filtered router=${routerId} reason="${reason}"`);
  }
  for (const { routerId, destinationIndex, verdict, deviationPct } of output.policyFiltered) {
    // Even though the router policy filtered this intent, the cron
    // service may later resubmit it when the on-chain pair goes stale.
    // Update the latest-intent cache so cron has the freshest payload.
    latestIntents.set(
      { routerId, destinationIndex, symbol: enriched.fullIntent.symbol },
      { routerId, destinationIndex, symbol: enriched.fullIntent.symbol, enriched, intentHash: event.intentHash },
    );
    if (deviationPct !== undefined) {
      metrics.priceDeviationPercent.observe(
        { symbol: enriched.fullIntent.symbol, router_id: routerId },
        deviationPct,
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
    metrics.bridgeIntentsProcessed.inc({
      symbol: enriched.fullIntent.symbol,
      customer_id: dispatch.customerId,
    });
    if (dispatch.deviationPct !== undefined) {
      metrics.priceDeviationPercent.observe(
        { symbol: enriched.fullIntent.symbol, router_id: dispatch.routerId },
        dispatch.deviationPct,
      );
    }

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
    
    // enriched (await to ensure order)
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
    
    // routed (passed filters)
    await fileLogger.logIntentStep({
      ts: now,
      level: "info",
      intentHash: event.intentHash,
      symbol: enriched.fullIntent.symbol,
      step: "routed",
      message: `Intent passed all filters`,
      meta: { routerId: dispatch.routerId, destinationIndex: dispatch.destinationIndex },
    });

    // preflight — fast checks before the intent occupies a queue slot
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
      signer: routerSigners.get(dispatch.routerId),
    };

    // hand off to coalescer (supersession + accumulation window)
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
      txHash: event.txHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      routerId: dispatch.routerId,
      destinationIndex: dispatch.destinationIndex,
      status: "processed",
      processedAtMs: Date.now(),
    });

    intentRuntime.set(event.intentHash, {
      ...buildRouterIdentity({
        customerId: routerCustomers.get(dispatch.routerId)!,
        routerId: dispatch.routerId,
        destinationIndex: dispatch.destinationIndex,
        cardano,
      }),
      observedAtMs,
      symbol: enriched.fullIntent.symbol,
    });

    // Route through the update worker pool (Spectra parity: getOrCreateOraclePool).
    // The pool's onTask callback calls coalescerManager.accept(). If the queue is
    // full, the task is dropped and accounted via metrics; the lane remains safe
    // because only the coalescer+queue touch the Cardano write client.
    const updatePool = updatePoolManager.getOrCreatePool(dispatch.routerId);
    const submitted = updatePool.submit({ routerId: dispatch.routerId, requests: [req] });
    if (!submitted) {
      metrics.workerTasksDropped.inc({ pool_type: "update" });
      report(
        `[warn] daemon: update pool queue full router=${dispatch.routerId} — dropped intentHash=${event.intentHash}`,
      );
    } else {
      // Start the pool lazily on first submission.
      updatePool.start();
    }
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
  /** When true, enables fast catch-up from last_processed_block using backfill chunks. */
  backwardSync?: boolean;
  /** Block gap threshold above which backfill mode activates. */
  maxBlockGap?: bigint;
  // WS
  reconnectIntervalMs?: number;
  maxReconnects?: number;
  /** Block-timestamp resolver shared by both transports. Required for the
   *  intent_to_registration / registration_to_scan latency phases to emit
   *  non-zero values. */
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>;
};

async function runHttpTransport(inputs: TransportInputs): Promise<void> {
  const client: RegistryClient = createHttpRegistryClient(inputs.source);
  try {
    await runHttpScanner({
      client,
      eventAbi: inputs.source.eventAbi,
      checkpoint: inputs.checkpoint,
      startBlock: inputs.startBlock ?? DEFAULT_START_BLOCK,
      blockRange: inputs.blockRange ?? DEFAULT_BLOCK_RANGE,
      scanIntervalMs: inputs.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      confirmations: inputs.confirmations ?? DEFAULT_CONFIRMATIONS,
      onBatch: inputs.handleBatch,
      log: inputs.report,
      signal: inputs.signal,
      metrics: inputs.scannerMetrics,
      chainId: inputs.chainId,
      backwardSync: inputs.backwardSync,
      maxBlockGap: inputs.maxBlockGap,
      getBlockTimestamp: inputs.getBlockTimestamp,
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
    reconnectIntervalMs: inputs.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS,
    maxReconnects: inputs.maxReconnects ?? DEFAULT_MAX_RECONNECTS,
    log: inputs.report,
    signal: inputs.signal,
    metrics: inputs.scannerMetrics,
    chainId: inputs.chainId,
    getBlockTimestamp: inputs.getBlockTimestamp,
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
    async snapshotBalances() {
      // Dry-run never touches chain; report no balances (gauges stay absent).
      return {};
    },
    async mergeDeposits(params) {
      // Dry-run never submits; the auto-merge path is gated off in dry-run
      // anyway, so this is only here to satisfy the interface.
      report(
        `daemon: [dry-run bridge] mergeDeposits client=${params.clientStatePath} (no-op)`,
      );
      return { txHash: null, confirmed: false };
    },
    async settle(params) {
      report(`daemon: [dry-run bridge] settle client=${params.clientStatePath} (no-op)`);
      return { txHash: null, confirmed: false };
    },
    async withdrawFromPaymentHook(params) {
      report(
        `daemon: [dry-run bridge] withdrawFromPaymentHook amount=${params.amountLovelace} (no-op)`,
      );
      return { txHash: null, confirmed: false };
    },
    async consolidateWallet(params) {
      report(
        `daemon: [dry-run bridge] consolidateWallet collateral=${params.collateralLovelace} (no-op)`,
      );
      return { txHash: null, confirmed: false };
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

  const defaultPath = path.join(resolveRunStateDir(network), "feeder.sqlite");
  const filePath = process.env[`DATABASE_PATH_${suffix}`]?.trim() ?? defaultPath;
  return { driver: "sqlite", path: filePath };
}

/**
 * Resolve the API listen address.
 */
function resolveApiAddr(apiConfig?: InfrastructureConfig["api"]): { host: string; port: number } {
  if (apiConfig?.host || apiConfig?.port) {
    return {
      host: apiConfig.host?.trim() || DEFAULT_API_HOST,
      port: apiConfig.port ?? DEFAULT_API_PORT,
    };
  }

  const raw = apiConfig?.listen_addr?.trim() ?? process.env.API_LISTEN_ADDR?.trim() ?? `:${DEFAULT_API_PORT}`;
  const colonIdx = raw.lastIndexOf(":");
  const host = colonIdx > 0 ? raw.slice(0, colonIdx) : colonIdx === 0 ? API_WILDCARD_HOST : DEFAULT_API_HOST;
  const port = parseInt(raw.slice(colonIdx + 1), 10) || DEFAULT_API_PORT;
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
