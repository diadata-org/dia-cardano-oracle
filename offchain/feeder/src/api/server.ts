import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ModularConfig } from "../config/types.js";
import type { Db } from "../persistence/index.js";
import type { PriceCache } from "../processor/price-cache.js";
import { livenessResult, readinessResult, type HealthState } from "./health.js";
import type { FeederMetrics } from "./metrics.js";
import type { UpdateWorkerStats } from "../worker/index.js";
import { buildPriceResponse, buildPricesResponse } from "./prices.js";
import {
  buildChainStatusResponse,
  buildChainsResponse,
  type ChainRuntimeState,
} from "./chains.js";
import { buildSymbolsResponse, buildSymbolUpdatesResponse } from "./symbols.js";
import { buildTransactionResponse, buildTransactionsResponse } from "./transactions.js";
import {
  buildStatusResponse,
  buildComponentsResponse,
} from "./status.js";
import {
  buildEventsResponse,
  buildEventNamesResponse,
  buildEventByHashResponse,
} from "./events.js";
import { buildAlertsResponse, buildAlertResponse } from "./alerts.js";
import { buildPerformanceResponse } from "./performance.js";
import { sanitizeLogLine } from "../utils/sanitize.js";

export type ApiServerOptions = {
  host?: string;
  port?: number;
  config: ModularConfig;
  db: Db;
  metrics: FeederMetrics;
  priceCache: PriceCache;
  chainRuntime: ChainRuntimeState;
  healthState: HealthState;
  /** Process start time in epoch-ms. Used to compute uptime_seconds. */
  startTimeMs?: number;
  /** Network name (e.g. "preview", "mainnet"). Used in /api/v1/status. */
  network?: string;
  /** When true, cron service is enabled. Used in /api/v1/status. */
  cronEnabled?: boolean;
  /** Returns per-router update pool stats for /api/v1/pools. Called at
   *  request time so the pools endpoint reflects live pool state. */
  getPoolStats?: () => UpdateWorkerStats[];
};

export type ApiServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
};

type RouteMatch =
  | { endpoint: "/health"; kind: "health" }
  | { endpoint: "/health/live"; kind: "health-live" }
  | { endpoint: "/health/ready"; kind: "health-ready" }
  | { endpoint: "/metrics"; kind: "metrics" }
  | { endpoint: "/debug"; kind: "debug" }
  | { endpoint: "/api/v1/prices"; kind: "prices" }
  | { endpoint: "/api/v1/prices/:symbol"; kind: "price-by-symbol"; symbol: string }
  | { endpoint: "/api/v1/symbols"; kind: "symbols" }
  | { endpoint: "/api/v1/symbols/:symbol/updates"; kind: "symbol-updates"; symbol: string }
  | { endpoint: "/api/v1/transactions"; kind: "transactions-list" }
  | { endpoint: "/api/v1/transactions/:txHash"; kind: "transaction"; txHash: string }
  | { endpoint: "/api/v1/chains"; kind: "chains" }
  | { endpoint: "/api/v1/chains/:id/status"; kind: "chain-status"; chainIdOrKey: string }
  | { endpoint: "/api/v1/status"; kind: "status" }
  | { endpoint: "/api/v1/status/components"; kind: "status-components" }
  | { endpoint: "/api/v1/events"; kind: "events" }
  | { endpoint: "/api/v1/events/names"; kind: "event-names" }
  | { endpoint: "/api/v1/events/:hash"; kind: "event-by-hash"; hash: string }
  | { endpoint: "/api/v1/alerts"; kind: "alerts" }
  | { endpoint: "/api/v1/alerts/:id"; kind: "alert-by-id"; id: string }
  | { endpoint: "/api/v1/alerts/:id/ack"; kind: "alert-ack"; id: string }
  | { endpoint: "/api/v1/performance"; kind: "performance" }
  | { endpoint: "/api/v1/pools"; kind: "pools" }
  | { endpoint: "/api/v1/pools/:router_id/tasks"; kind: "pool-tasks"; routerId: string };

// ---------------------------------------------------------------------------
// Rate limiter — simple token bucket: 60 req/min per remote address.
// ---------------------------------------------------------------------------

type RateLimitBucket = { count: number; resetAt: number };
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

export function createRateLimiter() {
  const buckets = new Map<string, RateLimitBucket>();

  return function isAllowed(remoteAddress: string): boolean {
    const now = Date.now();
    let bucket = buckets.get(remoteAddress);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      buckets.set(remoteAddress, bucket);
    }

    if (bucket.count >= RATE_LIMIT_MAX) {
      return false;
    }
    bucket.count++;
    return true;
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { config, db, metrics, priceCache, chainRuntime, healthState } = options;
  const host = options.host ?? config.infrastructure?.api?.host ?? "127.0.0.1";
  const port = options.port ?? config.infrastructure?.api?.port ?? 8080;
  const startTimeMs = options.startTimeMs ?? Date.now();
  const network = options.network ?? "unknown";
  const cronEnabled = options.cronEnabled ?? (config.infrastructure?.cron_service?.enabled ?? false);
  const corsEnabled = config.infrastructure?.api?.enable_cors === true;
  const debugEnabled = config.infrastructure?.api?.debug_enabled === true;

  const rateLimiter = createRateLimiter();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startedAtNs = process.hrtime.bigint();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const route = matchRoute(pathname);
    const endpoint = route?.endpoint ?? "unmatched";

    const setCorsHeaders = (): void => {
      if (corsEnabled) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      }
    };

    const finish = (status: number, body: string, contentType: string): void => {
      metrics.httpRequests.inc({ method, endpoint, status: String(status) });
      metrics.httpRequestDurationSeconds.observe(
        { method, endpoint },
        Number(process.hrtime.bigint() - startedAtNs) / 1_000_000_000,
      );
      setCorsHeaders();
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    };

    const sendJson = (status: number, payload: unknown): void => {
      finish(status, JSON.stringify(payload), "application/json");
    };

    const sendText = (status: number, payload: string): void => {
      finish(status, payload, "text/plain; version=0.0.4; charset=utf-8");
    };

    // CORS preflight.
    if (method === "OPTIONS" && corsEnabled) {
      setCorsHeaders();
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate limiting.
    if (!rateLimiter(remoteAddress)) {
      sendJson(429, { error: "Too Many Requests" });
      return;
    }

    // Alert ack is POST — allow it before the GET-only gate.
    const isAlertAck = route?.kind === "alert-ack";

    if (method !== "GET" && !(isAlertAck && method === "POST")) {
      sendJson(405, { error: "Method Not Allowed" });
      return;
    }

    try {
      if (!route) {
        sendJson(404, { error: "Not Found" });
        return;
      }

      switch (route.kind) {
        case "health":
        case "health-live":
          sendJson(200, livenessResult());
          return;

        case "health-ready": {
          const body = readinessResult(healthState);
          sendJson(body.status === "ok" ? 200 : 503, body);
          return;
        }

        case "metrics": {
          sendText(200, await metrics.getMetricsText());
          return;
        }

        case "debug": {
          if (!debugEnabled) {
            sendJson(404, { error: "Not Found" });
            return;
          }
          sendJson(200, { status: "debug", note: "debug mode enabled" });
          return;
        }

        case "prices":
          sendJson(200, buildPricesResponse(priceCache));
          return;

        case "price-by-symbol": {
          const body = buildPriceResponse(priceCache, route.symbol);
          if (!body) {
            sendJson(404, { error: `Unknown symbol "${sanitizeLogLine(route.symbol)}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "symbols":
          sendJson(200, buildSymbolsResponse(config));
          return;

        case "symbol-updates": {
          if (route.symbol.length > 64) {
            sendJson(400, { error: "path parameter too long" });
            return;
          }
          const limit = parseLimit(url.searchParams.get("limit"));
          sendJson(200, await buildSymbolUpdatesResponse(db, route.symbol, limit));
          return;
        }

        case "transactions-list": {
          const listLimit = parseLimit(url.searchParams.get("limit"));
          const status = url.searchParams.get("status") ?? undefined;
          const symbol = url.searchParams.get("symbol") ?? undefined;
          const routerId = url.searchParams.get("router_id") ?? undefined;
          const rows = await db.listTransactions({ status, symbol, routerId, limit: listLimit });
          sendJson(200, buildTransactionsResponse(rows));
          return;
        }

        case "transaction": {
          if (route.txHash.length > 64) {
            sendJson(400, { error: "path parameter too long" });
            return;
          }
          const body = await buildTransactionResponse(db, route.txHash);
          if (!body) {
            sendJson(404, { error: `Unknown transaction "${sanitizeLogLine(route.txHash)}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "chains":
          sendJson(200, await buildChainsResponse(config, db, chainRuntime));
          return;

        case "chain-status": {
          const body = await buildChainStatusResponse(config, db, chainRuntime, route.chainIdOrKey);
          if (!body) {
            sendJson(404, { error: `Unknown chain "${sanitizeLogLine(route.chainIdOrKey)}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "status": {
          const chainStates = await db.listChainStates();
          const body = buildStatusResponse({
            config,
            db,
            uptime: Date.now() - startTimeMs,
            network,
            cronEnabled,
            chainStates,
          });
          sendJson(200, body);
          return;
        }

        case "status-components": {
          const chainStates = await db.listChainStates();
          const body = buildComponentsResponse({ config, db, chainStates });
          sendJson(200, body);
          return;
        }

        case "events": {
          const evLimit = parseLimit(url.searchParams.get("limit"));
          const evStatus = url.searchParams.get("status") ?? undefined;
          const fromBlockRaw = url.searchParams.get("from_block");
          const fromBlock = fromBlockRaw !== null ? BigInt(fromBlockRaw) : undefined;
          const rows = await db.listProcessedEvents({ limit: evLimit, status: evStatus, fromBlock });
          sendJson(200, buildEventsResponse(rows));
          return;
        }

        case "event-names":
          sendJson(200, buildEventNamesResponse());
          return;

        case "event-by-hash": {
          if (route.hash.length > 64) {
            sendJson(400, { error: "path parameter too long" });
            return;
          }
          const row = await db.getProcessedEvent(route.hash);
          const body = buildEventByHashResponse(row);
          if (!body) {
            sendJson(404, { error: `Unknown event "${sanitizeLogLine(route.hash)}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "alerts": {
          const activeRaw = url.searchParams.get("active");
          const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;
          const alertLimit = parseLimit(url.searchParams.get("limit"));
          const rows = await db.listAlerts({ active, limit: alertLimit });
          sendJson(200, buildAlertsResponse(rows));
          return;
        }

        case "alert-by-id": {
          const alertId = parseInt(route.id, 10);
          if (isNaN(alertId)) {
            sendJson(400, { error: "Invalid alert id" });
            return;
          }
          // listAlerts does not accept an id filter; fetch recent alerts and find by id.
          const all = await db.listAlerts({ limit: 1000 });
          const row = all.find((r) => r.id === alertId) ?? null;
          const body = buildAlertResponse(row);
          if (!body) {
            sendJson(404, { error: `Unknown alert "${alertId}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "alert-ack": {
          if (method !== "POST") {
            sendJson(405, { error: "Method Not Allowed" });
            return;
          }
          const ackId = parseInt(route.id, 10);
          if (isNaN(ackId)) {
            sendJson(400, { error: "Invalid alert id" });
            return;
          }
          await db.acknowledgeAlert(ackId);
          sendJson(200, { acknowledged: true, id: ackId });
          return;
        }

        case "performance": {
          const metricName = url.searchParams.get("metric_name") ?? undefined;
          const sinceRaw = url.searchParams.get("since");
          const untilRaw = url.searchParams.get("until");
          const perfLimit = parseLimit(url.searchParams.get("limit"));
          const since = sinceRaw !== null ? Number(sinceRaw) : undefined;
          const until = untilRaw !== null ? Number(untilRaw) : undefined;
          const rows = await db.queryPerformanceMetrics({ metricName, since, until, limit: perfLimit });
          sendJson(200, buildPerformanceResponse(rows));
          return;
        }

        case "pools": {
          const allStats = options.getPoolStats?.() ?? [];
          const pools = allStats.map((s) => ({
            router_id: s.routerId,
            active_workers: s.activeWorkers,
            max_workers: s.maxWorkers,
            pending_count: s.pendingCount,
            queue_capacity: s.queueCapacity,
          }));
          sendJson(200, { pools });
          return;
        }

        case "pool-tasks": {
          const allStats = options.getPoolStats?.() ?? [];
          const poolStats = allStats.find((s) => s.routerId === route.routerId);
          sendJson(200, {
            router_id: route.routerId,
            active_workers: poolStats?.activeWorkers ?? 0,
            max_workers: poolStats?.maxWorkers ?? 0,
            pending_count: poolStats?.pendingCount ?? 0,
            queue_capacity: poolStats?.queueCapacity ?? 0,
            tasks: [],
          });
          return;
        }
      }
    } catch (error) {
      sendJson(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
    },

    stop() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },

    get port() {
      return port;
    },
  };
}

function matchRoute(pathname: string): RouteMatch | null {
  if (pathname === "/health") return { endpoint: "/health", kind: "health" };
  if (pathname === "/health/live") return { endpoint: "/health/live", kind: "health-live" };
  if (pathname === "/health/ready") return { endpoint: "/health/ready", kind: "health-ready" };
  if (pathname === "/metrics") return { endpoint: "/metrics", kind: "metrics" };
  if (pathname === "/debug") return { endpoint: "/debug", kind: "debug" };
  if (pathname === "/api/v1/prices") return { endpoint: "/api/v1/prices", kind: "prices" };
  if (pathname === "/api/v1/symbols") return { endpoint: "/api/v1/symbols", kind: "symbols" };
  if (pathname === "/api/v1/chains") return { endpoint: "/api/v1/chains", kind: "chains" };
  if (pathname === "/api/v1/transactions") return { endpoint: "/api/v1/transactions", kind: "transactions-list" };
  if (pathname === "/api/v1/status") return { endpoint: "/api/v1/status", kind: "status" };
  if (pathname === "/api/v1/status/components") return { endpoint: "/api/v1/status/components", kind: "status-components" };
  if (pathname === "/api/v1/events") return { endpoint: "/api/v1/events", kind: "events" };
  if (pathname === "/api/v1/events/names") return { endpoint: "/api/v1/events/names", kind: "event-names" };
  if (pathname === "/api/v1/alerts") return { endpoint: "/api/v1/alerts", kind: "alerts" };
  if (pathname === "/api/v1/performance") return { endpoint: "/api/v1/performance", kind: "performance" };
  if (pathname === "/api/v1/pools") return { endpoint: "/api/v1/pools", kind: "pools" };

  const priceMatch = /^\/api\/v1\/prices\/(.+)$/.exec(pathname);
  if (priceMatch) {
    return {
      endpoint: "/api/v1/prices/:symbol",
      kind: "price-by-symbol",
      symbol: decodeURIComponent(priceMatch[1]!),
    };
  }

  const symbolUpdatesMatch = /^\/api\/v1\/symbols\/(.+)\/updates$/.exec(pathname);
  if (symbolUpdatesMatch) {
    return {
      endpoint: "/api/v1/symbols/:symbol/updates",
      kind: "symbol-updates",
      symbol: decodeURIComponent(symbolUpdatesMatch[1]!),
    };
  }

  const transactionMatch = /^\/api\/v1\/transactions\/(.+)$/.exec(pathname);
  if (transactionMatch) {
    return {
      endpoint: "/api/v1/transactions/:txHash",
      kind: "transaction",
      txHash: decodeURIComponent(transactionMatch[1]!),
    };
  }

  const chainStatusMatch = /^\/api\/v1\/chains\/(.+)\/status$/.exec(pathname);
  if (chainStatusMatch) {
    return {
      endpoint: "/api/v1/chains/:id/status",
      kind: "chain-status",
      chainIdOrKey: decodeURIComponent(chainStatusMatch[1]!),
    };
  }

  const eventByHashMatch = /^\/api\/v1\/events\/(.+)$/.exec(pathname);
  if (eventByHashMatch) {
    return {
      endpoint: "/api/v1/events/:hash",
      kind: "event-by-hash",
      hash: decodeURIComponent(eventByHashMatch[1]!),
    };
  }

  const alertAckMatch = /^\/api\/v1\/alerts\/(\d+)\/ack$/.exec(pathname);
  if (alertAckMatch) {
    return {
      endpoint: "/api/v1/alerts/:id/ack",
      kind: "alert-ack",
      id: alertAckMatch[1]!,
    };
  }

  const alertByIdMatch = /^\/api\/v1\/alerts\/(\d+)$/.exec(pathname);
  if (alertByIdMatch) {
    return {
      endpoint: "/api/v1/alerts/:id",
      kind: "alert-by-id",
      id: alertByIdMatch[1]!,
    };
  }

  const poolTasksMatch = /^\/api\/v1\/pools\/(.+)\/tasks$/.exec(pathname);
  if (poolTasksMatch) {
    return {
      endpoint: "/api/v1/pools/:router_id/tasks",
      kind: "pool-tasks",
      routerId: decodeURIComponent(poolTasksMatch[1]!),
    };
  }

  return null;
}

export function parseLimit(raw: string | null): number {
  if (!raw) {
    return 50;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid limit "${raw}". Expected a positive integer.`);
  }
  return Math.min(value, 500);
}
