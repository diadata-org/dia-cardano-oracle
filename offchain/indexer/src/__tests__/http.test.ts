import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { routeRequest } from "../http.js";
import type { ClientInfo, IndexHealth, IndexService, Pair, ProtocolFees } from "../index-service.js";

const FEES: ProtocolFees = {
  baseFeeLovelace: "600000",
  perPairFeeLovelace: "250000",
  feeForPairs: (n: number) => (600000 + n * 250000).toString(),
};

const BTC: Pair = {
  symbol: "BTC/USD",
  pairId: "4254432f555344",
  pairPolicyId: "b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f",
  price: "65000000000",
  timestamp: "1700000000",
  nonce: "1",
  signer: "cd".repeat(20),
  intentHash: "ab".repeat(32),
  minUtxoLovelace: "2000000",
  utxoRef: { txHash: "11".repeat(32), outputIndex: 0 },
  ageSeconds: 60,
  clientId: "client-test-01",
};

const CLIENT: ClientInfo = {
  clientId: "client-test-01",
  receiverBalanceLovelace: "8000000",
  accruedToHookLovelace: "500000",
  subscribedPairs: ["BTC/USD"],
};

const HEALTH: IndexHealth = { tip: { slot: 1000, height: 50, hash: "ab".repeat(32) }, pairCount: 1 };

function fakeService(overrides: Partial<IndexService> = {}): IndexService {
  return {
    listPairs: async () => [BTC],
    getPair: async (symbol) => (symbol === "BTC/USD" ? BTC : null),
    listClients: async () => [CLIENT],
    getClient: async (id) => (id === "client-test-01" ? CLIENT : null),
    getProtocolFees: async () => FEES,
    health: async () => HEALTH,
    ...overrides,
  };
}

describe("routeRequest", () => {
  it("GET /v1/health → 200 health", async () => {
    assert.deepEqual(await routeRequest("GET", "/v1/health", fakeService()), { status: 200, body: HEALTH });
  });

  it("GET /v1/pairs → 200 { pairs }", async () => {
    assert.deepEqual(await routeRequest("GET", "/v1/pairs", fakeService()), { status: 200, body: { pairs: [BTC] } });
  });

  it("GET /v1/pairs/{symbol} (URL-encoded) → 200 pair", async () => {
    const r = await routeRequest("GET", "/v1/pairs/BTC%2FUSD", fakeService());
    assert.equal(r.status, 200);
    assert.equal((r.body as Pair).symbol, "BTC/USD");
  });

  it("GET /v1/pairs/{symbol}/utxo → 200 utxoRef only", async () => {
    assert.deepEqual(await routeRequest("GET", "/v1/pairs/BTC%2FUSD/utxo", fakeService()), {
      status: 200,
      body: { txHash: "11".repeat(32), outputIndex: 0 },
    });
  });

  it("GET an unknown pair → 404", async () => {
    const r = await routeRequest("GET", "/v1/pairs/DOGE%2FUSD", fakeService());
    assert.equal(r.status, 404);
  });

  it("GET an unknown pair's utxo → 404", async () => {
    const r = await routeRequest("GET", "/v1/pairs/DOGE%2FUSD/utxo", fakeService());
    assert.equal(r.status, 404);
  });

  it("GET /v1/protocol/fees → 200 fee params + formula + worked example", async () => {
    const r = await routeRequest("GET", "/v1/protocol/fees", fakeService());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      baseFeeLovelace: "600000",
      perPairFeeLovelace: "250000",
      feeFormula: "base + N × perPair",
      exampleSinglePairFeeLovelace: "850000",
    });
  });

  it("GET /v1/protocol/fees → 404 when the deployment is not bootstrapped", async () => {
    const r = await routeRequest("GET", "/v1/protocol/fees", fakeService({ getProtocolFees: async () => null }));
    assert.equal(r.status, 404);
  });

  it("GET /v1/clients → 200 { clients }", async () => {
    assert.deepEqual(await routeRequest("GET", "/v1/clients", fakeService()), { status: 200, body: { clients: [CLIENT] } });
  });

  it("GET /v1/clients/{id} → 200 client", async () => {
    const r = await routeRequest("GET", "/v1/clients/client-test-01", fakeService());
    assert.deepEqual(r.body, CLIENT);
  });

  it("GET an unknown client → 404", async () => {
    assert.equal((await routeRequest("GET", "/v1/clients/nope", fakeService())).status, 404);
  });

  it("a non-GET method → 405", async () => {
    assert.equal((await routeRequest("POST", "/v1/pairs", fakeService())).status, 405);
  });

  it("an unknown path → 404", async () => {
    assert.equal((await routeRequest("GET", "/v1/nope", fakeService())).status, 404);
    assert.equal((await routeRequest("GET", "/", fakeService())).status, 404);
  });
});
