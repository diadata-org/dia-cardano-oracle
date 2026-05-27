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

  it("skips destinations without an extractable single-symbol filter", async () => {
    const router: RouterConfig = {
      id: "router-multi",
      name: "Multi",
      type: "event",
      enabled: true,
      triggers: {
        events: ["IntentRegistered"],
        // Multi-symbol "in" filter — cron can't pick one symbol to resubmit.
        conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] }],
      },
      processing: { datasource: "enrichment" } as RouterConfig["processing"],
      destinations: [
        { cardano: FAKE_CARDANO, cron: true, time_threshold: "30s" } as unknown as RouterConfig["destinations"][number],
      ],
    };

    const { options, submits, cronCalls } = makeOptions({
      routers: { "router-multi": router },
    });

    await runOneTick(options);

    assert.equal(submits.length, 0);
    assert.equal(cronCalls.length, 0);
  });
});
