import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createApiServer } from "../server.js";
import { noopMetrics } from "../metrics.js";
import { createPriceCache } from "../../processor/price-cache.js";
import type { HealthState } from "../health.js";

// Pick an ephemeral port high enough to avoid collisions.
let portCounter = 19_100;
function nextPort(): number { return portCounter++; }

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

function makeState(overrides: Partial<HealthState> = {}): HealthState {
  return {
    lastRegistryPollMs: Date.now() - 10_000,
    lastSubmitMs: 0,
    maxStalenessMs: 300_000,
    ...overrides,
  };
}

describe("createApiServer", () => {
  it("/healthz returns 200 ok", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/healthz");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.status, "ok");
  });

  it("/readyz returns 200 when healthy", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState({ lastRegistryPollMs: Date.now() - 5_000 }),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/readyz");
    assert.equal(status, 200);
  });

  it("/readyz returns 503 when registry is stale", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState({ lastRegistryPollMs: 0 }),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/readyz");
    assert.equal(status, 503);
    const json = JSON.parse(body);
    assert.equal(json.status, "degraded");
  });

  it("/metrics returns 200 text/plain", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/metrics");
    assert.equal(status, 200);
  });

  it("/prices returns 200 with price data", async () => {
    const port = nextPort();
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100_000n, timestamp: 1_700_000_000n, intentHash: "0xabc", updatedAtMs: 1_000 },
    );
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: cache,
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/prices");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.count, 1);
    assert.equal(json.prices[0].symbol, "BTC/USD");
    assert.equal(json.prices[0].price, "100000");
  });

  it("unknown path returns 404", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/not-a-route");
    assert.equal(status, 404);
  });

  it("non-GET method returns 405", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});
