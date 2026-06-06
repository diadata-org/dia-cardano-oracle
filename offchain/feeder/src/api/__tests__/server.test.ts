import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApiServer } from "../server.js";
import { createChainRuntimeState } from "../chains.js";
import { noopMetrics } from "../metrics.js";
import { createPriceCache } from "../../processor/price-cache.js";
import type { HealthState } from "../health.js";
import type { ModularConfig } from "../../config/types.js";
import type {
  AlertLogRow,
  ChainStateRow,
  Db,
  PerformanceMetricRow,
  ProcessedEventRow,
  TransactionViewRow,
} from "../../persistence/index.js";

let portCounter = 19_100;
function nextPort(): number { return portCounter++; }

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

async function post(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
  const body = await res.text();
  return { status: res.status, body };
}

async function options(port: number, path: string): Promise<{ status: number; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "OPTIONS" });
  return { status: res.status, headers: res.headers };
}

function makeState(overrides: Partial<HealthState> = {}): HealthState {
  return {
    lastRegistryPollMs: Date.now() - 10_000,
    lastConfirmedMs: 0,
    maxStalenessMs: 300_000,
    ...overrides,
  };
}

function makeConfig(overrides: { corsEnabled?: boolean; debugEnabled?: boolean } = {}): ModularConfig {
  return {
    infrastructure: {
      database: { driver: "sqlite", path: "state/preview/feeder.sqlite" },
      source: {
        chain_id: 10050,
        name: "DIA Testnet",
        rpc_urls: ["https://testnet-rpc.diadata.org"],
      },
      api: {
        enabled: true,
        enable_cors: overrides.corsEnabled ?? false,
        debug_enabled: overrides.debugEnabled ?? false,
      },
    },
    chains: {
      "dia-testnet": {
        chain_id: 10050,
        name: "DIA Testnet",
        rpc_urls: ["https://testnet-rpc.diadata.org"],
        enabled: true,
      },
    },
    contracts: {},
    event_definitions: {},
    routers: {
      "router-a": {
        id: "router-a",
        name: "Router A",
        type: "event",
        enabled: true,
        private_key_env: "CARDANO_WALLET_SEED_TESTNET",
        triggers: {
          events: ["IntentRegistered"],
          conditions: [
            {
              field: "${enrichment.fullIntent.Symbol}",
              operator: "in",
              value: ["BTC/USD", "ETH/USD"],
            },
          ],
        },
        processing: { datasource: "enrichment" },
        destinations: [],
      },
    },
    parsedAbis: {
      events: {},
      contracts: {},
    } as ModularConfig["parsedAbis"],
  };
}

function makeDb(overrides: {
  symbolUpdates?: TransactionViewRow[];
  transactions?: TransactionViewRow[];
  chainStates?: ChainStateRow[];
  processedEvents?: ProcessedEventRow[];
  alerts?: AlertLogRow[];
  performanceMetrics?: PerformanceMetricRow[];
} = {}): Db {
  let ackId: number | null = null;
  return {
    async migrate() {},
    async upsertProcessedEvent(_row: ProcessedEventRow) {},
    async hasProcessedEvent() { return false; },
    async getProcessedEvent(hash) {
      return overrides.processedEvents?.find((e) => e.intentHash === hash) ?? null;
    },
    async listProcessedEvents() { return overrides.processedEvents ?? []; },
    async getLastProcessedBlock() { return null; },
    async initialiseChainState() {},
    async setLastProcessedBlock() {},
    async setLastScanBlock() {},
    async setChainHealth() {},
    async getChainState() { return null; },
    async insertTransactionLog() {},
    async updateTransactionLog() {},
    async getTransactionLog() { return []; },
    async listTransactions() { return overrides.transactions ?? []; },
    async listSymbolUpdates() { return overrides.symbolUpdates ?? []; },
    async getTransactionsByHash() { return overrides.transactions ?? []; },
    async listChainStates() { return overrides.chainStates ?? []; },
    async upsertContractSymbolUpdate() {},
    async getContractSymbolUpdate() { return null; },
    async listContractSymbolUpdates() { return []; },
    async recordPerformanceMetric() {},
    async queryPerformanceMetrics() { return overrides.performanceMetrics ?? []; },
    async recordAlert() { return 0; },
    async resolveAlert() {},
    async acknowledgeAlert(id) { ackId = id; },
    async listAlerts() { return overrides.alerts ?? []; },
    async getAlertById(id) { return (overrides.alerts ?? []).find((a) => a.id === id) ?? null; },
    async pruneOldRows() { return { processedEvents: 0, transactionLog: 0, alertLog: 0, performanceMetrics: 0 }; },
    async close() {},
    // Expose ackId for inspection.
    _ackId: () => ackId,
  } as Db & { _ackId: () => number | null };
}

function makeTransactionViewRow(overrides: Partial<TransactionViewRow> = {}): TransactionViewRow {
  return {
    id: 1,
    intentHash: "0xintent",
    cardanoTxHash: "tx123",
    routerId: "router-a",
    destinationIndex: 0,
    destinationChainName: "DIA Testnet",
    destinationContractAddress: "0xcontract",
    symbol: "BTC/USD",
    price: "100000",
    timestamp: 1_700_000_000,
    status: "confirmed",
    retryCount: 0,
    maxRetries: 3,
    submittedAtMs: 2_000,
    confirmedAtMs: 3_000,
    createdAtMs: 1_000,
    ...overrides,
  };
}

function makeProcessedEventRow(overrides: Partial<ProcessedEventRow> = {}): ProcessedEventRow {
  return {
    intentHash: "0xhash123",
    eventName: "IntentRegistered",
    txHash: "0xtx",
    logIndex: 0,
    blockNumber: 100n,
    routerId: "router-a",
    destinationIndex: 0,
    status: "processed",
    processedAtMs: 1_000,
    ...overrides,
  };
}

function makeAlertRow(overrides: Partial<AlertLogRow> = {}): AlertLogRow {
  return {
    id: 1,
    alertName: "OraclePairStale",
    severity: "warning",
    message: "Pair BTC/USD stale",
    labelsJson: JSON.stringify({ symbol: "BTC/USD" }),
    firedAtMs: 1_000,
    acknowledged: false,
    ...overrides,
  };
}

describe("createApiServer", () => {
  it("/health and /health/live return 200", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const health = await get(port, "/health");
    const live = await get(port, "/health/live");
    assert.equal(health.status, 200);
    assert.equal(live.status, 200);
  });

  it("/health/ready returns 503 when registry is stale", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState({ lastRegistryPollMs: 0 }),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/health/ready");
    assert.equal(status, 503);
  });

  it("/api/v1/prices and /api/v1/prices/:symbol return cached prices", async () => {
    const port = nextPort();
    const cache = createPriceCache({ now: () => 1_000 });
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      {
        symbol: "BTC/USD",
        price: 100_000n,
        timestamp: 1_700_000_000n,
        intentHash: "0xabc",
        cardanoTxHash: "tx123",
        confirmedAtDepth: 3,
        updatedAtMs: 1_000,
      },
    );
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: cache,
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const all = await get(port, "/api/v1/prices");
    const one = await get(port, "/api/v1/prices/BTC%2FUSD");
    assert.equal(all.status, 200);
    assert.equal(one.status, 200);
    assert.equal(JSON.parse(all.body).prices[0].confirmedAtDepth, 3);
    assert.equal(JSON.parse(one.body).prices[0].symbol, "BTC/USD");
  });

  it("/api/v1/symbols returns configured router symbols", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/symbols");
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body).symbols, ["BTC/USD", "ETH/USD"]);
  });

  it("/api/v1/symbols/:symbol/updates returns joined DB rows", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ symbolUpdates: [makeTransactionViewRow()] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/symbols/BTC%2FUSD/updates?limit=1");
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).updates[0].cardanoTxHash, "tx123");
  });

  it("/api/v1/transactions/:txHash aggregates transaction updates", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({
        transactions: [
          makeTransactionViewRow({ symbol: "BTC/USD", intentHash: "0x1" }),
          makeTransactionViewRow({ symbol: "ETH/USD", intentHash: "0x2" }),
        ],
      }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/transactions/tx123");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.updateCount, 2);
    assert.equal(json.updates[0].symbol, "BTC/USD");
  });

  it("/api/v1/chains and /api/v1/chains/:id/status return runtime + persisted chain state", async () => {
    const port = nextPort();
    const chainRuntime = createChainRuntimeState();
    chainRuntime.set({ chainId: 10050, scannerType: "http", headBlock: 2000n });
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({
        chainStates: [{
          id: 1,
          chainId: 10050,
          chainName: "DIA Testnet",
          contractId: "registry",
          lastProcessedBlock: 1995n,
          lastScanBlock: 1995n,
          isHealthy: true,
          errorCount: 0,
          updatedAtMs: 4_000,
        }],
      }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime,
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const list = await get(port, "/api/v1/chains");
    const one = await get(port, "/api/v1/chains/dia-testnet/status");
    assert.equal(list.status, 200);
    assert.equal(one.status, 200);
    assert.equal(JSON.parse(list.body).chains[0].blockLag, "5");
    assert.equal(JSON.parse(one.body).scannerType, "http");
  });

  it("unknown path returns 404 and non-GET returns 405", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const missing = await get(port, "/not-a-route");
    const postRes = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal(postRes.status, 405);
  });

  // ---------------------------------------------------------------------------
  // R2.1 — Status endpoints
  // ---------------------------------------------------------------------------

  it("/api/v1/status returns uptime and network info", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
      startTimeMs: Date.now() - 5_000,
      network: "preview",
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/status");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.status, "ok");
    assert.equal(json.network, "preview");
    assert.ok(json.uptime_seconds >= 4, "uptime_seconds should be >= 4");
  });

  it("/api/v1/status/components returns component array", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/status/components");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.ok(Array.isArray(json), "Response should be an array");
    assert.ok(json.length > 0, "Should have at least one component");
    assert.ok("name" in json[0], "Component should have a name field");
  });

  // ---------------------------------------------------------------------------
  // R2.2 — Events endpoints
  // ---------------------------------------------------------------------------

  it("/api/v1/events returns processed events list", async () => {
    const port = nextPort();
    const event = makeProcessedEventRow();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ processedEvents: [event] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/events");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.count, 1);
    assert.equal(json.events[0].intentHash, "0xhash123");
  });

  it("/api/v1/events/names returns event name list", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/events/names");
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body).names, ["IntentRegistered"]);
  });

  it("/api/v1/events/:hash returns single event or 404", async () => {
    const port = nextPort();
    const event = makeProcessedEventRow({ intentHash: "0xhash123" });
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ processedEvents: [event] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const found = await get(port, "/api/v1/events/0xhash123");
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.body).intentHash, "0xhash123");

    const notFound = await get(port, "/api/v1/events/0xmissing");
    assert.equal(notFound.status, 404);
  });

  // ---------------------------------------------------------------------------
  // R2.3 — Transactions list
  // ---------------------------------------------------------------------------

  it("/api/v1/transactions returns transaction list", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ transactions: [makeTransactionViewRow()] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/transactions");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.ok("count" in json, "Response should have count field");
    assert.ok("transactions" in json, "Response should have transactions field");
  });

  // ---------------------------------------------------------------------------
  // R2.5 — Alerts endpoints
  // ---------------------------------------------------------------------------

  it("/api/v1/alerts returns alerts list", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ alerts: [makeAlertRow()] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/alerts");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.count, 1);
    assert.equal(json.alerts[0].alertName, "OraclePairStale");
  });

  it("/api/v1/alerts/:id returns single alert or 404", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ alerts: [makeAlertRow({ id: 1 })] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const found = await get(port, "/api/v1/alerts/1");
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.body).id, 1);

    const notFound = await get(port, "/api/v1/alerts/9999");
    assert.equal(notFound.status, 404);
  });

  it("POST /api/v1/alerts/:id/ack acknowledges an alert", async () => {
    const port = nextPort();
    const db = makeDb({ alerts: [makeAlertRow({ id: 5 })] });
    const server = createApiServer({
      port,
      config: makeConfig(),
      db,
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await post(port, "/api/v1/alerts/5/ack");
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).acknowledged, true);
    assert.equal(JSON.parse(body).id, 5);
  });

  it("GET /api/v1/alerts/:id/ack returns 405", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/api/v1/alerts/1/ack");
    assert.equal(status, 405);
  });

  // ---------------------------------------------------------------------------
  // R2.6 — Performance endpoint
  // ---------------------------------------------------------------------------

  it("/api/v1/performance returns performance metrics", async () => {
    const port = nextPort();
    const metric: PerformanceMetricRow = {
      id: 1,
      metricName: "transactions_submitted_total",
      metricValue: 42,
      labelsJson: "{}",
      recordedAtMs: 1_000,
    };
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb({ performanceMetrics: [metric] }),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/performance");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.count, 1);
    assert.equal(json.metrics[0].metricName, "transactions_submitted_total");
  });

  // ---------------------------------------------------------------------------
  // R2.4 — Pools stubs
  // ---------------------------------------------------------------------------

  it("/api/v1/pools returns empty pools stub", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/pools");
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body).pools, []);
  });

  it("/api/v1/pools/:router_id/tasks returns stub with router_id", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/pools/router-a/tasks");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.router_id, "router-a");
    assert.deepEqual(json.tasks, []);
  });

  it("/api/v1/pools returns live pool stats when getPoolStats is provided", async () => {
    const port = nextPort();
    const fakeStats = [
      { routerId: "router-btc", activeWorkers: 1, maxWorkers: 4, pendingCount: 2, queueCapacity: 128 },
    ];
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
      getPoolStats: () => fakeStats,
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/api/v1/pools");
    assert.equal(status, 200);
    const json = JSON.parse(body);
    assert.equal(json.pools.length, 1);
    assert.equal(json.pools[0].router_id, "router-btc");
    assert.equal(json.pools[0].active_workers, 1);
    assert.equal(json.pools[0].max_workers, 4);
    assert.equal(json.pools[0].pending_count, 2);
    assert.equal(json.pools[0].queue_capacity, 128);
  });

  // ---------------------------------------------------------------------------
  // R2.9 — /debug endpoint gating
  // ---------------------------------------------------------------------------

  it("/debug returns 404 when debug_enabled is false", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig({ debugEnabled: false }),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await get(port, "/debug");
    assert.equal(status, 404);
  });

  it("/debug returns 200 when debug_enabled is true", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig({ debugEnabled: true }),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status, body } = await get(port, "/debug");
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).status, "debug");
  });

  // ---------------------------------------------------------------------------
  // R5.2 — Path parameter length cap
  // ---------------------------------------------------------------------------

  it("returns 400 when symbol path param exceeds 64 chars", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const longParam = "A".repeat(65);
    const { status } = await get(port, `/api/v1/symbols/${longParam}/updates`);
    assert.equal(status, 400);
  });

  it("returns 400 when txHash path param exceeds 64 chars", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const longHash = "a".repeat(65);
    const { status } = await get(port, `/api/v1/transactions/${longHash}`);
    assert.equal(status, 400);
  });

  // ---------------------------------------------------------------------------
  // R5.4 — CORS headers
  // ---------------------------------------------------------------------------

  it("adds CORS headers when enable_cors is true", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig({ corsEnabled: true }),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("handles OPTIONS preflight when enable_cors is true", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig({ corsEnabled: true }),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const { status } = await options(port, "/api/v1/status");
    assert.equal(status, 204);
  });

  // ---------------------------------------------------------------------------
  // B4 — OpenAPI / Redoc docs (offline)
  // ---------------------------------------------------------------------------

  it("/api/v1/openapi.json returns a valid OpenAPI doc covering known routes", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const doc = await res.json();
    assert.match(doc.openapi, /^3\.0\./);
    assert.ok(doc.info && typeof doc.info.title === "string");
    assert.ok(doc.paths && typeof doc.paths === "object");
    // A representative sample of known routes must be documented.
    for (const path of [
      "/health",
      "/api/v1/prices",
      "/api/v1/prices/{symbol}",
      "/api/v1/transactions",
      "/api/v1/alerts/{id}/ack",
      "/api/v1/openapi.json",
      "/docs",
    ]) {
      assert.ok(path in doc.paths, `openapi doc missing path ${path}`);
    }
    // The ack route must expose the POST method.
    assert.ok("post" in doc.paths["/api/v1/alerts/{id}/ack"], "ack route should be POST");
  });

  it("/docs returns 200 HTML referencing the spec and the bundled Redoc asset", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await fetch(`http://127.0.0.1:${port}/docs`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /\/api\/v1\/openapi\.json/);
    // Offline: references the locally-served bundle, never a CDN.
    assert.match(body, /\/public\/redoc\.standalone\.js/);
    assert.doesNotMatch(body, /https?:\/\/[^"']*redoc/i);
  });

  it("/public/redoc.standalone.js serves the vendored bundle (no network)", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await fetch(`http://127.0.0.1:${port}/public/redoc.standalone.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.ok(body.length > 10_000, "bundle should be a substantial JS file");
    assert.match(body, /Redoc/, "bundle should expose the Redoc global");
  });

  it("an arbitrary /public/* path is not served (only the vendored asset)", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    const res = await get(port, "/public/../package.json");
    assert.equal(res.status, 404);
  });

  // ---------------------------------------------------------------------------
  // R5.4 — Rate limiting
  // ---------------------------------------------------------------------------

  it("returns 429 after exceeding rate limit", async () => {
    const port = nextPort();
    const server = createApiServer({
      port,
      config: makeConfig(),
      db: makeDb(),
      metrics: noopMetrics,
      priceCache: createPriceCache(),
      chainRuntime: createChainRuntimeState(),
      healthState: makeState(),
    });
    await server.start();
    after(() => server.stop());

    // The rate limit is 60 req/min. Make 61 rapid requests.
    const results: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      results.push(res.status);
    }

    assert.ok(results.includes(429), "Should get at least one 429 after exceeding rate limit");
  });
});
