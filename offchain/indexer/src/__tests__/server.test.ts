// createIndexerServer integration — the operational endpoints (OpenAPI, Swagger
// UI, Prometheus, vendored assets) served alongside the JSON v1 API. Runs a real
// server on an ephemeral port and fetches over loopback; fully offline.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createIndexerServer } from "../http.js";
import type { ClientInfo, IndexHealth, IndexService, Pair } from "../index-service.js";

const HEALTH: IndexHealth = { tip: { slot: 1, height: 2, hash: "ab".repeat(32) }, pairCount: 0 };

const service: IndexService = {
  listPairs: async () => [] as Pair[],
  getPair: async () => null,
  listClients: async (): Promise<ClientInfo[]> => [],
  getClient: async (): Promise<ClientInfo | null> => null,
  getProtocolFees: async () => null,
  health: async () => HEALTH,
};

let base: string;
let server: ReturnType<typeof createIndexerServer>;

before(async () => {
  server = createIndexerServer({
    service,
    log: () => {},
    metricsText: async () => "dia_bridge_provider_requests_total 0\n",
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("createIndexerServer operational endpoints", () => {
  it("GET /v1/openapi.json → a 3.0 doc titled for the indexer", async () => {
    const res = await fetch(`${base}/v1/openapi.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const doc = (await res.json()) as { openapi: string; info: { title: string }; paths: Record<string, unknown> };
    assert.match(doc.openapi, /^3\.0\./);
    assert.equal(doc.info.title, "DIA Cardano Oracle Indexer API");
    assert.ok("/v1/pairs/{symbol}" in doc.paths);
    assert.ok("/v1/clients" in doc.paths, "lists the clients endpoint");
    assert.ok("/v1/protocol/fees" in doc.paths, "documents the protocol fees endpoint");
  });

  it("GET /docs → Swagger UI HTML pointing at the spec", async () => {
    const res = await fetch(`${base}/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /SwaggerUIBundle/);
    assert.match(html, /\/v1\/openapi\.json/);
  });

  it("GET /metrics → Prometheus text", async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await res.text(), /dia_bridge_provider_requests_total/);
  });

  it("GET /public/swagger-ui.css → the vendored stylesheet", async () => {
    const res = await fetch(`${base}/public/swagger-ui.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  it("GET /v1/health → still serves the JSON v1 API", async () => {
    const res = await fetch(`${base}/v1/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await res.json(), HEALTH);
  });

  it("GET /metrics with metrics disabled → 404", async () => {
    const bare = createIndexerServer({ service, log: () => {} });
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    const { port } = bare.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => bare.close((e) => (e ? reject(e) : resolve())));
    }
  });
});
