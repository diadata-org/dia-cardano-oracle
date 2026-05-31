import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runOneTick, type CronServiceOptions } from "../cron-service.js";
import { createLatestIntentCache } from "../latest-intent-cache.js";
import { createPriceCache } from "../../processor/price-cache.js";
import { noopMetrics, type FeederMetrics, type FeedCounter } from "../../api/metrics.js";
import type { RouterConfig, CardanoDestinationConfig } from "../../config/types.js";
import type { EnrichedIntent } from "../../source/types.js";
import type { SubmitRequest, SubmitResult } from "../../submitter/types.js";

const FAKE_ENRICHED = {
  fullIntent: {
    symbol: "BTC/USD",
    price: 1n,
    timestamp: 1n,
    expiry: 1n,
    nonce: 1n,
    signer: "0x",
    signature: "0x",
    intentHash: "0x",
  },
} as unknown as EnrichedIntent;

const FAKE_CARDANO: CardanoDestinationConfig = {
  network: "Preview",
  client_state_path: "state/preview/clients/client-a.json",
  protocol_state_path: "state/preview/config-bootstrap.json",
};

function makeRouter(symbol: string, cron: boolean, timeThreshold?: string): RouterConfig {
  return {
    id: "router-a",
    name: "Router A",
    type: "event",
    enabled: true,
    triggers: {
      events: ["IntentRegistered"],
      conditions: [{ field: "event.symbol", operator: "in", value: [symbol] }],
    },
    processing: { datasource: "enrichment" } as RouterConfig["processing"],
    destinations: [
      {
        cardano: FAKE_CARDANO,
        cron,
        time_threshold: timeThreshold,
      } as unknown as RouterConfig["destinations"][number],
    ],
  };
}

function makeCronCounter(): { counter: FeedCounter; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  return {
    counter: {
      inc: (labels) => {
        if (labels) calls.push(labels);
      },
    },
    calls,
  };
}

function makeOptions(overrides: Partial<CronServiceOptions> = {}): {
  options: CronServiceOptions;
  submits: SubmitRequest[];
  cronCalls: Array<Record<string, string>>;
} {
  const submits: SubmitRequest[] = [];
  const { counter: cronCounter, calls: cronCalls } = makeCronCounter();
  const metrics: FeederMetrics = { ...noopMetrics, cronResubmissions: cronCounter };
  return {
    options: {
      enabled: true,
      tickIntervalMs: 30_000,
      routers: {},
      latestIntents: createLatestIntentCache(),
      priceCache: createPriceCache(),
      submit: async (req) => {
        submits.push(req);
        return { ok: true, cardanoTxHash: "tx", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" } as SubmitResult;
      },
      metrics,
      log: () => {},
      ...overrides,
    },
    submits,
    cronCalls,
  };
}

describe("runOneTick", () => {
  it("emits skipped_uninitialised when no on-chain confirm has happened yet", async () => {
    const router = makeRouter("BTC/USD", true, "30s");
    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
      now: () => 1_700_000_000_000,
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls.length, 1);
    assert.equal(cronCalls[0]!.outcome, "skipped_uninitialised");
  });

  it("emits skipped_no_intent when priceCache has data but the latestIntent cache is empty", async () => {
    const router = makeRouter("BTC/USD", true, "30s");
    const now = 1_700_000_000_000;
    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      {
        symbol: "BTC/USD",
        price: 100n,
        timestamp: 1n,
        intentHash: "0xconfirmed",
        cardanoTxHash: "tx-old",
        updatedAtMs: now - 60_000,
      },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
      priceCache,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls[0]!.outcome, "skipped_no_intent");
  });

  it("emits skipped_already_fresh when the cached intent matches the confirmed one", async () => {
    const router = makeRouter("BTC/USD", true, "30s");
    const now = 1_700_000_000_000;
    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xsame", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );
    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xsame" },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
      priceCache,
      latestIntents,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls[0]!.outcome, "skipped_already_fresh");
  });

  it("submits when time_threshold elapsed and a newer cached intent exists", async () => {
    const router = makeRouter("BTC/USD", true, "30s");
    const now = 1_700_000_000_000;
    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xold", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );
    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew" },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
      priceCache,
      latestIntents,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 1);
    assert.equal(submits[0]!.intentHash, "0xnew");
    assert.equal(submits[0]!.routerId, "router-a");
    assert.equal(cronCalls[0]!.outcome, "submitted");
  });

  it("does NOT submit when within the time_threshold window", async () => {
    const router = makeRouter("BTC/USD", true, "5m");
    const now = 1_700_000_000_000;
    const priceCache = createPriceCache({ now: () => now - 10_000 }); // 10s ago, well inside 5min
    priceCache.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xold", cardanoTxHash: "tx", updatedAtMs: now - 10_000 },
    );
    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew" },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
      priceCache,
      latestIntents,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls.length, 0, "no counter emit when within window");
  });

  it("skips destinations where cron is false (opt-in only)", async () => {
    const router = makeRouter("BTC/USD", false, "30s");
    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-a": router },
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls.length, 0);
  });

  it("emits one tick per symbol for multi-symbol in-list routers", async () => {
    const now = 1_700_000_000_000;
    const router: RouterConfig = {
      id: "router-multi",
      name: "Multi",
      type: "event",
      enabled: true,
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] }],
      },
      processing: { datasource: "enrichment" } as RouterConfig["processing"],
      destinations: [
        { cardano: FAKE_CARDANO, cron: true, time_threshold: "30s" } as unknown as RouterConfig["destinations"][number],
      ],
    };

    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-multi", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xold-btc", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );
    priceCache.set(
      { routerId: "router-multi", destinationIndex: 0, symbol: "ETH/USD" },
      { symbol: "ETH/USD", price: 200n, timestamp: 1n, intentHash: "0xold-eth", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );

    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-multi", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-multi", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew-btc" },
    );
    latestIntents.set(
      { routerId: "router-multi", destinationIndex: 0, symbol: "ETH/USD" },
      { routerId: "router-multi", destinationIndex: 0, symbol: "ETH/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew-eth" },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-multi": router },
      priceCache,
      latestIntents,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 2, "one submit per symbol");
    const intentHashes = submits.map((s) => s.intentHash).sort();
    assert.deepEqual(intentHashes, ["0xnew-btc", "0xnew-eth"]);
    assert.equal(cronCalls.filter((c) => c.outcome === "submitted").length, 2);
  });

  it("emits one tick per symbol for enrichment.fullIntent.Symbol in-list routers", async () => {
    const now = 1_700_000_000_000;
    const router: RouterConfig = {
      id: "router-enriched",
      name: "Enriched",
      type: "event",
      enabled: true,
      triggers: {
        events: ["IntentRegistered"],
        conditions: [
          { field: "${enrichment.fullIntent.Symbol}", operator: "in", value: ["BTC/USD", "ETH/USD"] },
        ],
      },
      processing: { datasource: "enrichment" } as RouterConfig["processing"],
      destinations: [
        { cardano: FAKE_CARDANO, cron: true, time_threshold: "30s" } as unknown as RouterConfig["destinations"][number],
      ],
    };

    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-enriched", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xold-btc", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );
    priceCache.set(
      { routerId: "router-enriched", destinationIndex: 0, symbol: "ETH/USD" },
      { symbol: "ETH/USD", price: 200n, timestamp: 1n, intentHash: "0xold-eth", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );

    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-enriched", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-enriched", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew-btc" },
    );
    latestIntents.set(
      { routerId: "router-enriched", destinationIndex: 0, symbol: "ETH/USD" },
      { routerId: "router-enriched", destinationIndex: 0, symbol: "ETH/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew-eth" },
    );

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-enriched": router },
      priceCache,
      latestIntents,
      now: () => now,
    });

    await runOneTick(options);

    assert.equal(submits.length, 2, "one submit per symbol from enrichment.fullIntent.Symbol");
    const symbols = submits.map((s) => s.enriched.fullIntent.symbol).sort();
    // NOTE: FAKE_ENRICHED has symbol "BTC/USD" but we distinguish by intentHash
    const intentHashes = submits.map((s) => s.intentHash).sort();
    assert.deepEqual(intentHashes, ["0xnew-btc", "0xnew-eth"]);
    assert.equal(cronCalls.filter((c) => c.outcome === "submitted").length, 2);
    void symbols; // suppress unused-variable lint
  });

  it("skips routers with no extractable symbol", async () => {
    const router: RouterConfig = {
      id: "router-no-symbol",
      name: "NoSym",
      type: "event",
      enabled: true,
      triggers: {
        events: ["IntentRegistered"],
        // No symbol condition at all
        conditions: [],
      },
      processing: { datasource: "enrichment" } as RouterConfig["processing"],
      destinations: [
        { cardano: FAKE_CARDANO, cron: true, time_threshold: "30s" } as unknown as RouterConfig["destinations"][number],
      ],
    };

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-no-symbol": router },
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls.length, 0);
  });

  it("catches and logs submit errors (fire-and-forget)", async () => {
    const router = makeRouter("BTC/USD", true, "30s");
    const now = 1_700_000_000_000;
    const priceCache = createPriceCache({ now: () => now - 60_000 });
    priceCache.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { symbol: "BTC/USD", price: 100n, timestamp: 1n, intentHash: "0xold", cardanoTxHash: "tx", updatedAtMs: now - 60_000 },
    );
    const latestIntents = createLatestIntentCache({ now: () => now });
    latestIntents.set(
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD" },
      { routerId: "router-a", destinationIndex: 0, symbol: "BTC/USD", enriched: FAKE_ENRICHED, intentHash: "0xnew" },
    );

    const logLines: string[] = [];
    let resolveSubmit!: () => void;
    const submitPromise = new Promise<void>((resolve) => { resolveSubmit = resolve; });

    const { options } = makeOptions({
      routers: { "router-a": router },
      priceCache,
      latestIntents,
      now: () => now,
      log: (line) => logLines.push(line),
      submit: async (_req) => {
        await submitPromise;
        throw new Error("submission-network-error");
      },
    });

    // runOneTick completes synchronously (fire-and-forget)
    await runOneTick(options);

    // Resolve the submit to trigger the rejection handler
    resolveSubmit();
    // Wait a microtask tick for the .catch handler to run
    await new Promise((r) => setTimeout(r, 0));

    const errorLog = logLines.find((l) => l.includes("submit failed"));
    assert.ok(errorLog, "error should be logged by the catch handler");
    assert.ok(errorLog!.includes("submission-network-error"), "error message forwarded");
  });

  it("includes customer label in cron metric when router.customer is set", async () => {
    const now = 1_700_000_000_000;
    const router: RouterConfig = {
      id: "router-a",
      name: "Router A",
      type: "event",
      enabled: true,
      customer: "acme-corp",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD"] }],
      },
      processing: { datasource: "enrichment" } as RouterConfig["processing"],
      destinations: [
        { cardano: FAKE_CARDANO, cron: true, time_threshold: "30s" } as unknown as RouterConfig["destinations"][number],
      ],
    };

    const { options, cronCalls } = makeOptions({
      routers: { "router-a": router },
      now: () => now,
    });

    await runOneTick(options);

    // skipped_uninitialised but the labels should include customer
    assert.equal(cronCalls.length, 1);
    assert.equal(cronCalls[0]!.customer, "acme-corp");
  });
});
