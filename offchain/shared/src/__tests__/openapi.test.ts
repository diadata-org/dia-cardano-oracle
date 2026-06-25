// Shared OpenAPI builder + Swagger UI helpers — the generic machinery both the
// feeder and the indexer build their API surface on.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Type } from "@sinclair/typebox";

import {
  buildOpenApiDocument,
  errorResponseSchema,
  type RouteDescriptor,
} from "../openapi.js";
import { loadSwaggerAssets, publicAssetPath, renderDocsHtml } from "../docs.js";

const routes: readonly RouteDescriptor[] = [
  {
    method: "GET",
    path: "/v1/health",
    kind: "health",
    summary: "Liveness + chain tip.",
    responseSchema: Type.Object({ ok: Type.Boolean() }),
  },
  {
    method: "GET",
    path: "/v1/pairs/{symbol}",
    kind: "pair-by-symbol",
    summary: "One pair's latest on-chain value.",
    params: Type.Object({ symbol: Type.String({ description: "URL-encoded, e.g. BTC%2FUSD" }) }),
    responseSchema: Type.Object({ symbol: Type.String() }),
  },
];

describe("buildOpenApiDocument", () => {
  it("produces a 3.0.x doc with the caller's title and every route path", () => {
    const doc = buildOpenApiDocument(routes, {
      baseConfig: { title: "DIA Cardano Oracle Indexer API", version: "9.9.9" },
    }) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };

    assert.match(doc.openapi, /^3\.0\./);
    assert.equal(doc.info.title, "DIA Cardano Oracle Indexer API");
    assert.equal(doc.info.version, "9.9.9");
    assert.ok("/v1/health" in doc.paths);
    assert.ok("/v1/pairs/{symbol}" in doc.paths);
  });

  it("turns path-param object properties into required path parameters", () => {
    const doc = buildOpenApiDocument(routes) as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string; required: boolean }> }>>;
    };
    const op = doc.paths["/v1/pairs/{symbol}"]!.get!;
    const symbolParam = op.parameters?.find((p) => p.name === "symbol");
    assert.ok(symbolParam);
    assert.equal(symbolParam!.in, "path");
    assert.equal(symbolParam!.required, true);
  });

  it("documents the shared error body on routes that take params", () => {
    const doc = buildOpenApiDocument(routes) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const responses = doc.paths["/v1/pairs/{symbol}"]!.get!.responses;
    assert.ok("404" in responses);
    assert.ok("500" in responses);
    // errorResponseSchema is the { error: string } body.
    assert.equal((errorResponseSchema as { type?: string }).type, "object");
  });
});

describe("Swagger UI docs helpers", () => {
  it("locates and loads the vendored assets from the shared package", () => {
    const assets = loadSwaggerAssets();
    assert.ok(assets, "vendored swagger-ui assets should be present under public/");
    assert.ok(assets!.has(publicAssetPath("swagger-ui-bundle.js")));
    assert.ok(assets!.has(publicAssetPath("swagger-ui.css")));
  });

  it("renders a Swagger UI page that points at the given spec URL and title", () => {
    const html = renderDocsHtml("/v1/openapi.json", true, "DIA Cardano Oracle Indexer API");
    assert.match(html, /SwaggerUIBundle/);
    assert.match(html, /\/v1\/openapi\.json/);
    assert.match(html, /DIA Cardano Oracle Indexer API/);
  });

  it("falls back to a plain page when assets are unavailable", () => {
    const html = renderDocsHtml("/v1/openapi.json", false, "X API");
    assert.doesNotMatch(html, /SwaggerUIBundle/);
    assert.match(html, /\/v1\/openapi\.json/);
  });
});
