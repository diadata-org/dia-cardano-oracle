// HTTP API server — /healthz, /readyz, /metrics, /prices.
//
// Uses only Node's built-in `node:http` module; no external framework.
// The surface is intentionally tiny: four read-only GET routes.
//
// Spectra equivalent: `pkg/api/server.go`.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { livenessResult, readinessResult, type HealthState } from "./health.js";
import { buildPricesResponse } from "./prices.js";
import type { FeederMetrics } from "./metrics.js";
import type { PriceCache } from "../processor/price-cache.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiServerOptions = {
  /** Host to bind. Defaults to "0.0.0.0". */
  host?: string;
  /** Port to listen on. Defaults to 8080. */
  port?: number;
  metrics: FeederMetrics;
  priceCache: PriceCache;
  /** Mutable state box — the feeder daemon updates this as it runs. */
  healthState: HealthState;
};

export type ApiServer = {
  /** Start listening. Resolves when the server is bound. */
  start(): Promise<void>;
  /** Stop accepting connections. */
  stop(): Promise<void>;
  readonly port: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { metrics, priceCache, healthState } = options;
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8080;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method Not Allowed" }));
      return;
    }

    try {
      if (url === "/healthz") {
        const body = livenessResult();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      if (url === "/readyz") {
        const body = readinessResult(healthState);
        const statusCode = body.status === "ok" ? 200 : 503;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      if (url === "/metrics") {
        const text = await metrics.getMetricsText();
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        res.end(text);
        return;
      }

      if (url === "/prices") {
        const body = buildPricesResponse(priceCache);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
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
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },

    get port() {
      return port;
    },
  };
}
