// The indexer route table is the single source the OpenAPI document is built
// from — it documents exactly the surface the HTTP server serves.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOpenApiDocument } from "@diadata-org/dia-cardano-oracle-shared/openapi";

import { INDEXER_API_TITLE, indexerRoutes } from "../routes.js";

describe("indexerRoutes", () => {
  it("documents every served endpoint in the OpenAPI doc", () => {
    const doc = buildOpenApiDocument(indexerRoutes, { baseConfig: { title: INDEXER_API_TITLE } }) as {
      info: { title: string };
      paths: Record<string, Record<string, unknown>>;
    };

    assert.equal(doc.info.title, INDEXER_API_TITLE);
    for (const path of [
      "/v1/health",
      "/v1/pairs",
      "/v1/pairs/{symbol}",
      "/v1/pairs/{symbol}/utxo",
      "/v1/clients/{clientId}",
      "/v1/openapi.json",
      "/docs",
      "/metrics",
    ]) {
      assert.ok(path in doc.paths, `OpenAPI doc missing path "${path}"`);
    }
  });

  it("marks {symbol} as a required path parameter", () => {
    const doc = buildOpenApiDocument(indexerRoutes) as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required: boolean }> }>>;
    };
    const param = doc.paths["/v1/pairs/{symbol}"]!.get!.parameters?.find((p) => p.name === "symbol");
    assert.ok(param, "symbol path parameter should be documented");
    assert.equal(param!.required, true);
  });

  it("has unique route kinds", () => {
    const seen = new Set<string>();
    for (const route of indexerRoutes) {
      assert.ok(!seen.has(route.kind), `duplicate route kind "${route.kind}"`);
      seen.add(route.kind);
    }
  });
});
