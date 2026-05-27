import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRouterRegistry } from "../registry.js";
import { routeIntent } from "../router.js";
import { createPriceCache } from "../../processor/price-cache.js";
import type { RouterConfig } from "../../config/types.js";
import type { EnrichedIntent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INTENT_HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol: string, price = 100_000n): EnrichedIntent {
  return {
    event: {
      intentHash: INTENT_HASH,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price,
      timestamp: 1_700_000_000n,
      signer: SIGNER,
      blockNumber: 1n,
      txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0,
    },
    fullIntent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: 10050n,
      nonce: 1n,
      expiry: 9_999_999_999n,
      symbol,
      price,
      timestamp: 1_700_000_000n,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRouter(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    id: "r1",
    name: "Test Router",
    type: "oracle",
    enabled: true,
    triggers: {
      events: ["IntentRegistered"],
      conditions: [],
    },
    processing: { datasource: "enrichment" },
    destinations: [
      {
        cardano: {
          network: "Preview",
          client_state_path: "state/preview/clients/client-a.json",
          protocol_state_path: "state/preview/config-bootstrap.json",
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RouterRegistry
// ---------------------------------------------------------------------------

describe("createRouterRegistry", () => {
  it("excludes disabled routers", () => {
    const registry = createRouterRegistry({
      r1: makeRouter({ id: "r1", enabled: true }),
      r2: makeRouter({ id: "r2", enabled: false }),
    });
    assert.equal(registry.size, 1);
    assert.equal(registry.all[0].id, "r1");
  });

  it("forEvent returns routers subscribed to that event", () => {
    const registry = createRouterRegistry({
      r1: makeRouter({ id: "r1", triggers: { events: ["IntentRegistered"] } }),
      r2: makeRouter({ id: "r2", triggers: { events: ["OtherEvent"] } }),
    });
    assert.equal(registry.forEvent("IntentRegistered").length, 1);
    assert.equal(registry.forEvent("OtherEvent").length, 1);
    assert.equal(registry.forEvent("Unknown").length, 0);
  });

  it("one router can subscribe to multiple events", () => {
    const registry = createRouterRegistry({
      r1: makeRouter({ id: "r1", triggers: { events: ["A", "B"] } }),
    });
    assert.equal(registry.forEvent("A").length, 1);
    assert.equal(registry.forEvent("B").length, 1);
  });

  it("returns empty all for empty config", () => {
    const registry = createRouterRegistry({});
    assert.equal(registry.size, 0);
    assert.deepEqual(registry.all, []);
  });
});

// ---------------------------------------------------------------------------
// routeIntent — condition evaluation
// ---------------------------------------------------------------------------

describe("routeIntent — no conditions", () => {
  it("dispatches when router has no conditions", () => {
    const registry = createRouterRegistry({ r1: makeRouter() });
    const result = routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD"));
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.dispatched[0].routerId, "r1");
    assert.equal(result.conditionFiltered.length, 0);
  });

  it("returns empty dispatch for unknown event", () => {
    const registry = createRouterRegistry({ r1: makeRouter() });
    const result = routeIntent(registry, createPriceCache(), "UnknownEvent", makeEnriched("BTC/USD"));
    assert.equal(result.dispatched.length, 0);
  });
});

describe("routeIntent — eq condition", () => {
  it("passes when field matches", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "eq", value: "BTC/USD" }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    const result = routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD"));
    assert.equal(result.dispatched.length, 1);
    assert.equal(result.conditionFiltered.length, 0);
  });

  it("filters when field does not match", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "eq", value: "ETH/USD" }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    const result = routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD"));
    assert.equal(result.dispatched.length, 0);
    assert.equal(result.conditionFiltered.length, 1);
    assert.match(result.conditionFiltered[0].reason, /condition failed/);
  });
});

describe("routeIntent — in condition", () => {
  it("passes when field is in list", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "in", value: ["BTC/USD", "ETH/USD"] }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD")).dispatched.length, 1);
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("ADA/USD")).dispatched.length, 0);
  });

  it("accepts DIA/Spectra fullIntent field paths", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "in", value: ["BTC/USD"] }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD")).dispatched.length, 1);
  });
});

describe("routeIntent — neq / not_in conditions", () => {
  it("neq passes when field is not equal", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "neq", value: "ETH/USD" }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD")).dispatched.length, 1);
  });

  it("not_in filters when field is in the exclusion list", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "not_in", value: ["BTC/USD"] }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD")).dispatched.length, 0);
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("ETH/USD")).dispatched.length, 1);
  });
});

describe("routeIntent — gt / lt conditions on numeric fields", () => {
  it("gt passes when field is greater than value", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Price}", operator: "gt", value: 50_000 }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD", 100_000n)).dispatched.length, 1);
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD", 1_000n)).dispatched.length, 0);
  });
});

describe("routeIntent — contains condition", () => {
  it("passes when field contains substring", () => {
    const router = makeRouter({
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "${enrichment.fullIntent.Symbol}", operator: "contains", value: "USD" }],
      },
    });
    const registry = createRouterRegistry({ r1: router });
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/USD")).dispatched.length, 1);
    assert.equal(routeIntent(registry, createPriceCache(), "IntentRegistered", makeEnriched("BTC/EUR")).dispatched.length, 0);
  });
});

describe("routeIntent — policy gating", () => {
  it("populates policyFiltered when time_threshold blocks", () => {
    const router = makeRouter({
      destinations: [
        {
          time_threshold: "1h",
          cardano: {
            network: "Preview",
            client_state_path: "state/preview/clients/client-a.json",
            protocol_state_path: "state/preview/config-bootstrap.json",
          },
        },
      ],
    });
    const registry = createRouterRegistry({ r1: router });
    const cache = createPriceCache({ now: () => 0 });
    // Pre-populate the cache so time_threshold kicks in immediately
    cache.set(
      { routerId: "r1", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 0n, intentHash: "0xold", updatedAtMs: 0 },
    );
    // Only 1 second later — well within 1h threshold
    const result = routeIntent(registry, cache, "IntentRegistered", makeEnriched("BTC/USD"), () => 1_000);
    assert.equal(result.dispatched.length, 0);
    assert.equal(result.policyFiltered.length, 1);
    assert.equal("reason" in result.policyFiltered[0].verdict && result.policyFiltered[0].verdict.reason, "time_threshold");
  });
});
