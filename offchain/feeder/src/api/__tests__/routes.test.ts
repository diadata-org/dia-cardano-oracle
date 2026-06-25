// Route-table ↔ dispatch consistency + OpenAPI generator unit tests.
//
// The route table in `routes.ts` is metadata that drives the generated
// OpenAPI document, while `server.ts` does the actual routing via a
// `switch (route.kind)`. These two must never silently diverge: a documented
// route with no handler 404s in practice, and a handler with no table entry is
// invisible in /docs.
//
// This suite enforces the bidirectional match by parsing the `case "kind":`
// labels out of the server source and comparing them against the table.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apiRoutes } from "../routes.js";
import { buildOpenApiDocument } from "@diadata-org/dia-cardano-oracle-shared/openapi";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(join(HERE, "..", "server.ts"), "utf8");

/** Dispatch kinds that intentionally have NO route-table entry: internal
 *  static-asset serving that backs /docs but is not part of the public API
 *  surface documented in the spec. */
const DISPATCH_ONLY_KINDS = new Set(["public-asset"]);

/** Extract the discriminants from the `case "..."` labels in the big dispatch
 *  switch. We slice from the switch statement to its end so we don't pick up
 *  unrelated string literals. */
function dispatchKinds(): Set<string> {
  const start = SERVER_SRC.indexOf("switch (route.kind)");
  assert.ok(start >= 0, "could not find dispatch switch in server.ts");
  const region = SERVER_SRC.slice(start);
  const kinds = new Set<string>();
  for (const m of region.matchAll(/case\s+"([^"]+)":/g)) {
    kinds.add(m[1]!);
  }
  return kinds;
}

describe("route table ↔ dispatch consistency", () => {
  it("every route.kind in the table has a matching dispatch branch", () => {
    const dispatch = dispatchKinds();
    for (const route of apiRoutes) {
      assert.ok(
        dispatch.has(route.kind),
        `route "${route.method} ${route.path}" (kind="${route.kind}") has no case in the server.ts switch`,
      );
    }
  });

  it("every dispatch branch is described in the route table", () => {
    const dispatch = dispatchKinds();
    const tableKinds = new Set(apiRoutes.map((r) => r.kind));
    for (const kind of dispatch) {
      if (DISPATCH_ONLY_KINDS.has(kind)) continue;
      assert.ok(
        tableKinds.has(kind),
        `dispatch handles kind="${kind}" but routes.ts has no descriptor for it`,
      );
    }
  });

  it("route kinds are unique", () => {
    const seen = new Set<string>();
    for (const route of apiRoutes) {
      assert.ok(!seen.has(route.kind), `duplicate route kind "${route.kind}"`);
      seen.add(route.kind);
    }
  });
});

describe("buildOpenApiDocument", () => {
  it("produces a 3.0.x document with info and paths", () => {
    const doc = buildOpenApiDocument(apiRoutes) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, unknown>>;
    };
    assert.match(doc.openapi, /^3\.0\./);
    assert.ok(doc.info.title.length > 0);
    assert.ok(doc.info.version.length > 0);
    assert.ok(Object.keys(doc.paths).length > 0);
  });

  it("includes every table path (in OpenAPI {param} form)", () => {
    const doc = buildOpenApiDocument(apiRoutes) as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const route of apiRoutes) {
      assert.ok(
        route.path in doc.paths,
        `OpenAPI doc missing path "${route.path}"`,
      );
      const item = doc.paths[route.path]!;
      assert.ok(
        route.method.toLowerCase() in item,
        `OpenAPI path "${route.path}" missing method "${route.method}"`,
      );
    }
  });

  it("emits path parameters as required and query parameters with correct location", () => {
    const doc = buildOpenApiDocument(apiRoutes) as {
      paths: Record<string, Record<string, { parameters?: { name: string; in: string; required?: boolean }[] }>>;
    };
    // /api/v1/prices/{symbol} has a path param "symbol".
    const op = doc.paths["/api/v1/prices/{symbol}"]!["get"]!;
    const symbolParam = op.parameters?.find((p) => p.name === "symbol");
    assert.ok(symbolParam, "symbol path param missing");
    assert.equal(symbolParam!.in, "path");
    assert.equal(symbolParam!.required, true);

    // /api/v1/events has a "limit" query param (optional).
    const eventsOp = doc.paths["/api/v1/events"]!["get"]!;
    const limitParam = eventsOp.parameters?.find((p) => p.name === "limit");
    assert.ok(limitParam, "limit query param missing");
    assert.equal(limitParam!.in, "query");
    assert.equal(limitParam!.required ?? false, false);
  });

  it("attaches a JSON response schema for routes that declare one", () => {
    const doc = buildOpenApiDocument(apiRoutes) as {
      paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
    };
    const op = doc.paths["/api/v1/prices"]!["get"]!;
    const ok = op.responses["200"]!;
    assert.ok(ok.content?.["application/json"], "prices 200 should have a JSON schema");
  });

  it("honours baseConfig overrides", () => {
    const doc = buildOpenApiDocument(apiRoutes, {
      baseConfig: {
        title: "Custom Title",
        version: "9.9.9",
        servers: [{ url: "https://feeder.example" }],
      },
    }) as { info: { title: string; version: string }; servers?: { url: string }[] };
    assert.equal(doc.info.title, "Custom Title");
    assert.equal(doc.info.version, "9.9.9");
    assert.equal(doc.servers?.[0]?.url, "https://feeder.example");
  });

  it("merges multiple methods on the same path into one path item", () => {
    const merged = buildOpenApiDocument([
      { method: "GET", path: "/x", kind: "x-get", summary: "get x" },
      { method: "POST", path: "/x", kind: "x-post", summary: "post x" },
    ]) as { paths: Record<string, Record<string, unknown>> };
    assert.deepEqual(Object.keys(merged.paths["/x"]!).sort(), ["get", "post"]);
  });
});
