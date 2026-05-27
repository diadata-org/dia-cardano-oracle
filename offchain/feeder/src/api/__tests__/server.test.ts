import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApiServer } from "../server.js";
import { createChainRuntimeState } from "../chains.js";
import { noopMetrics } from "../metrics.js";
import { createPriceCache } from "../../processor/price-cache.js";
import type { HealthState } from "../health.js";
import type { ModularConfig } from "../../config/types.js";
import type {
  ChainStateRow,
  Db,
  ProcessedEventRow,
  TransactionLogRow,
  TransactionViewRow,
} from "../../persistence/index.js";

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
    lastConfirmedMs: 0,
    maxStalenessMs: 300_000,
    ...overrides,
  };
}

function makeConfig(): ModularConfig {
  return {
    infrastructure: {
      database: { driver: "sqlite", path: "state/preview/feeder.sqlite" },
      source: {
        chain_id: 10050,
        name: "DIA Testnet",
        rpc_urls: ["https://testnet-rpc.diadata.org"],
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
} = {}): Db {
  return {
    async migrate() {},
    async upsertProcessedEvent(_row: ProcessedEventRow) {},
    async hasProcessedEvent() { return false; },
    async getLastProcessedBlock() { return null; },
    async setLastProcessedBlock() {},
    async insertTransactionLog(_row: TransactionLogRow) {},
    async updateTransactionLog() {},
    async getTransactionLog() { return []; },
    async listSymbolUpdates() { return overrides.symbolUpdates ?? []; },
    async getTransactionsByHash() { return overrides.transactions ?? []; },
    async listChainStates() { return overrides.chainStates ?? []; },
    async close() {},
  };
}

function makeTransactionViewRow(overrides: Partial<TransactionViewRow> = {}): TransactionViewRow {
  return {
    intentHash: "0xintent",
    sourceChainId: 10050,
    sourceBlockNumber: 1234n,
    sourceTxHash: "0xsource",
    sourceLogIndex: 0,
    symbol: "BTC/USD",
    price: "100000",
    timestamp: "1700000000",
    signer: "0xsigner",
    processedAtMs: 1_000,
    cardanoTxHash: "tx123",
    routerId: "router-a",
    destinationIndex: 0,
    clientStatePath: "state/preview/clients/client-a.json",
    status: "confirmed",
    submittedAtMs: 2_000,
    confirmedAtMs: 3_000,
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
          chainId: 10050,
          contractId: "registry",
          lastProcessedBlock: 1995n,
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
    const post = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    assert.equal(missing.status, 404);
    assert.equal(post.status, 405);
  });
});
