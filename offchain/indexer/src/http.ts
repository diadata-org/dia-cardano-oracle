// HTTP API — the consumer-facing surface over the index service.
//
// `node:http` only, no framework (same posture as the feeder API). The JSON v1
// routing is a pure `routeRequest(method, pathname, service)` returning a status
// + body, unit-tested against a fake service. `createIndexerServer` wires it
// onto a real server and adds the operational endpoints (Swagger UI, OpenAPI,
// Prometheus) using the SAME shared machinery the feeder serves — so the
// indexer's API surface is documented and interactive exactly like the feeder's.
//
// JSON API (all GET):
//   /v1/health                  provider reachable, chain tip, pair count
//   /v1/pairs                   every published pair (latest value + utxoRef)
//   /v1/pairs/{symbol}          one pair's latest on-chain value
//   /v1/pairs/{symbol}/utxo     just the TxIn to use as a reference input
//   /v1/clients/{clientId}      receiver balance + subscribed pairs
//   /v1/protocol/fees           the on-chain fee formula inputs (cost per update)
// Operational (all GET):
//   /v1/openapi.json            this spec, generated from the route table
//   /docs                       interactive Swagger UI
//   /metrics                    Prometheus exposition (provider request counts)
//   /public/*                   vendored Swagger UI assets
//
// `symbol` contains a slash (e.g. "BTC/USD") so it MUST be URL-encoded by the
// caller: /v1/pairs/BTC%2FUSD and /v1/pairs/BTC%2FUSD/utxo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { buildOpenApiDocument } from "@diadata-org/dia-cardano-oracle-shared/openapi";
import {
  loadSwaggerAssets,
  renderDocsHtml,
  PUBLIC_ASSET_PREFIX,
} from "@diadata-org/dia-cardano-oracle-shared/docs";

import { INDEXER_API_TITLE, indexerRoutes } from "./api/routes.js";
import type { IndexService } from "./index-service.js";

export interface RouteResult {
  status: number;
  body: unknown;
}

const notFound = (resource: string): RouteResult => ({ status: 404, body: { error: `${resource} not found` } });

/**
 * Pure request router: map a method + pathname to a status + JSON body using the
 * index service. No I/O beyond the service calls — fully fake-testable.
 */
export async function routeRequest(
  method: string,
  pathname: string,
  service: IndexService,
): Promise<RouteResult> {
  if (method !== "GET") {
    return { status: 405, body: { error: "Method not allowed; the indexer is read-only (GET only)." } };
  }

  const segments = pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] !== "v1") {
    return notFound("resource");
  }

  // /v1/health
  if (segments.length === 2 && segments[1] === "health") {
    return { status: 200, body: await service.health() };
  }

  // /v1/pairs ...
  if (segments[1] === "pairs") {
    if (segments.length === 2) {
      return { status: 200, body: { pairs: await service.listPairs() } };
    }
    const symbol = decodeURIComponent(segments[2]!);
    if (segments.length === 3) {
      const pair = await service.getPair(symbol);
      return pair ? { status: 200, body: pair } : notFound(`pair "${symbol}"`);
    }
    if (segments.length === 4 && segments[3] === "utxo") {
      const pair = await service.getPair(symbol);
      return pair ? { status: 200, body: pair.utxoRef } : notFound(`pair "${symbol}"`);
    }
    return notFound("resource");
  }

  // /v1/protocol/fees
  if (segments[1] === "protocol" && segments[2] === "fees" && segments.length === 3) {
    const fees = await service.getProtocolFees();
    if (!fees) return notFound("protocol fees (deployment not bootstrapped)");
    return {
      status: 200,
      body: {
        baseFeeLovelace: fees.baseFeeLovelace,
        perPairFeeLovelace: fees.perPairFeeLovelace,
        feeFormula: "base + N × perPair",
        exampleSinglePairFeeLovelace: fees.feeForPairs(1),
      },
    };
  }

  // /v1/clients
  if (segments[1] === "clients" && segments.length === 2) {
    return { status: 200, body: { clients: await service.listClients() } };
  }

  // /v1/clients/{clientId}
  if (segments[1] === "clients" && segments.length === 3) {
    const clientId = decodeURIComponent(segments[2]!);
    const client = await service.getClient(clientId);
    return client ? { status: 200, body: client } : notFound(`client "${clientId}"`);
  }

  return notFound("resource");
}

export interface IndexerServerOptions {
  service: IndexService;
  /** Structured log sink (defaults to console.error). */
  log?: (line: string) => void;
  /** Prometheus exposition text for `GET /metrics`. Omit to disable the
   *  endpoint (it then 404s). In production this is `metrics.getMetricsText`. */
  metricsText?: () => Promise<string>;
}

/** Prometheus exposition Content-Type (prom-client's default). */
const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Wire {@link routeRequest} onto a `node:http` server and add the operational
 * endpoints (OpenAPI, Swagger UI, Prometheus, static assets), built once at
 * startup — the same shape the feeder serves.
 */
export function createIndexerServer(options: IndexerServerOptions): Server {
  const log = options.log ?? ((line) => console.error(line));

  // Built once: the spec from the route table, the Swagger UI page, and the
  // vendored assets held in memory (reading them per-request would be wasteful).
  const openApiJson = JSON.stringify(
    buildOpenApiDocument(indexerRoutes, {
      baseConfig: {
        title: INDEXER_API_TITLE,
        description:
          "Read-only HTTP API over the live on-chain DIA oracle Pair/Receiver UTxOs. Generated from the in-code route table; cannot drift from the implementation.",
      },
    }),
    null,
    2,
  );
  const swaggerAssets = loadSwaggerAssets();
  const docsHtml = renderDocsHtml("/v1/openapi.json", swaggerAssets !== null, INDEXER_API_TITLE);

  const send = (res: ServerResponse, status: number, contentType: string, body: string): void => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = req.method ?? "GET";

    // Operational endpoints — served outside the JSON v1 router.
    if (method === "GET") {
      if (pathname === "/v1/openapi.json") return send(res, 200, "application/json", openApiJson + "\n");
      if (pathname === "/docs") return send(res, 200, "text/html; charset=utf-8", docsHtml);
      if (pathname === "/metrics") {
        if (!options.metricsText) return send(res, 404, "text/plain; charset=utf-8", "metrics are disabled\n");
        return send(res, 200, PROM_CONTENT_TYPE, await options.metricsText());
      }
      if (pathname.startsWith(PUBLIC_ASSET_PREFIX)) {
        const asset = swaggerAssets?.get(pathname);
        if (asset) return send(res, 200, asset.contentType, asset.body);
        // Unknown asset falls through to the JSON 404 below.
      }
    }

    // JSON v1 API.
    let result: RouteResult;
    try {
      result = await routeRequest(method, pathname, options.service);
    } catch (error) {
      // A provider/network failure mid-query maps to a 502.
      log(`indexer: ${method} ${pathname} failed — ${(error as Error).message}`);
      result = { status: 502, body: { error: "Upstream chain provider error; retry shortly." } };
    }
    send(res, result.status, "application/json", JSON.stringify(result.body, null, 2) + "\n");
  });
}
