import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ModularConfig } from "../config/types.js";
import type { Db } from "../persistence/index.js";
import type { PriceCache } from "../processor/price-cache.js";
import { livenessResult, readinessResult, type HealthState } from "./health.js";
import type { FeederMetrics } from "./metrics.js";
import { buildPriceResponse, buildPricesResponse } from "./prices.js";
import {
  buildChainStatusResponse,
  buildChainsResponse,
  type ChainRuntimeState,
} from "./chains.js";
import { buildSymbolsResponse, buildSymbolUpdatesResponse } from "./symbols.js";
import { buildTransactionResponse } from "./transactions.js";

export type ApiServerOptions = {
  host?: string;
  port?: number;
  config: ModularConfig;
  db: Db;
  metrics: FeederMetrics;
  priceCache: PriceCache;
  chainRuntime: ChainRuntimeState;
  healthState: HealthState;
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
  | { endpoint: "/api/v1/prices"; kind: "prices" }
  | { endpoint: "/api/v1/prices/:symbol"; kind: "price-by-symbol"; symbol: string }
  | { endpoint: "/api/v1/symbols"; kind: "symbols" }
  | { endpoint: "/api/v1/symbols/:symbol/updates"; kind: "symbol-updates"; symbol: string }
  | { endpoint: "/api/v1/transactions/:txHash"; kind: "transaction"; txHash: string }
  | { endpoint: "/api/v1/chains"; kind: "chains" }
  | { endpoint: "/api/v1/chains/:id/status"; kind: "chain-status"; chainIdOrKey: string };

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { config, db, metrics, priceCache, chainRuntime, healthState } = options;
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8080;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startedAtNs = process.hrtime.bigint();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const route = matchRoute(pathname);
    const endpoint = route?.endpoint ?? "unmatched";

    const finish = (status: number, body: string, contentType: string): void => {
      metrics.httpRequests.inc({ method, endpoint, status: String(status) });
      metrics.httpRequestDurationSeconds.observe(
        { method, endpoint },
        Number(process.hrtime.bigint() - startedAtNs) / 1_000_000_000,
      );
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    };

    const sendJson = (status: number, payload: unknown): void => {
      finish(status, JSON.stringify(payload), "application/json");
    };

    const sendText = (status: number, payload: string): void => {
      finish(status, payload, "text/plain; version=0.0.4; charset=utf-8");
    };

    if (method !== "GET") {
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

        case "prices":
          sendJson(200, buildPricesResponse(priceCache));
          return;

        case "price-by-symbol": {
          const body = buildPriceResponse(priceCache, route.symbol);
          if (!body) {
            sendJson(404, { error: `Unknown symbol "${route.symbol}"` });
            return;
          }
          sendJson(200, body);
          return;
        }

        case "symbols":
          sendJson(200, buildSymbolsResponse(config));
          return;

        case "symbol-updates": {
          const limit = parseLimit(url.searchParams.get("limit"));
          sendJson(200, await buildSymbolUpdatesResponse(db, route.symbol, limit));
          return;
        }

        case "transaction": {
          const body = await buildTransactionResponse(db, route.txHash);
          if (!body) {
            sendJson(404, { error: `Unknown transaction "${route.txHash}"` });
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
            sendJson(404, { error: `Unknown chain "${route.chainIdOrKey}"` });
            return;
          }
          sendJson(200, body);
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
  if (pathname === "/api/v1/prices") return { endpoint: "/api/v1/prices", kind: "prices" };
  if (pathname === "/api/v1/symbols") return { endpoint: "/api/v1/symbols", kind: "symbols" };
  if (pathname === "/api/v1/chains") return { endpoint: "/api/v1/chains", kind: "chains" };

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

  return null;
}

function parseLimit(raw: string | null): number {
  if (!raw) {
    return 50;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid limit "${raw}". Expected a positive integer.`);
  }
  return Math.min(value, 500);
}
