import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateFeedSanity,
  deriveFeedThresholds,
  summarizeFeedSanity,
  runFeedSanityChecks,
  formatFeedSanityReport,
  pickLatestIntentPerSymbol,
  sanityStatusCode,
  readOnChainPairs,
  type FeedSanityResult,
  type FeedSanityDeps,
  type ChainUtxo,
} from "../feed-sanity.js";

describe("evaluateFeedSanity", () => {
  const thresholds = { priceDeviationPct: 0.5, freshnessSec: 600 };

  it("PASS when on-chain price matches the source and is fresh", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
      },
      thresholds,
    );

    assert.equal(result.status, "PASS");
    assert.equal(result.deviationPct, 0);
    assert.equal(result.stalenessSec, 0);
    assert.deepEqual(result.reasons, []);
  });

  it("PASS when price drift is within tolerance and fresh", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_300n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
      },
      thresholds,
    );

    // 0.3% < 0.5% tolerance.
    assert.equal(result.status, "PASS");
    assert.equal(result.deviationPct, 0.3);
    assert.deepEqual(result.reasons, []);
  });

  it("WARN when price drift exceeds tolerance but the feed is still fresh", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 101_000n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 100_000n, timestampSec: 1_000n, nonce: 6n },
      },
      thresholds,
    );

    // 1% > 0.5% tolerance, but staleness 0 <= 600s: an update is likely pending.
    assert.equal(result.status, "WARN");
    assert.equal(result.deviationPct, 1);
    assert.equal(result.stalenessSec, 0);
    assert.deepEqual(result.reasons, ["price_deviation_exceeds_tolerance"]);
  });

  it("WARN when the price matches but the on-chain value is stale past the freshness window", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 100_000n, timestampSec: 2_000n, nonce: 9n },
      },
      thresholds,
    );

    // price within tolerance, but 1000s lag > 600s freshness window.
    assert.equal(result.status, "WARN");
    assert.equal(result.stalenessSec, 1_000);
    assert.deepEqual(result.reasons, ["on_chain_stale"]);
  });

  it("FAIL when the price drifted past tolerance AND the value is stale", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 101_000n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 100_000n, timestampSec: 2_000n, nonce: 9n },
      },
      thresholds,
    );

    assert.equal(result.status, "FAIL");
    assert.equal(result.deviationPct, 1);
    assert.equal(result.stalenessSec, 1_000);
    assert.deepEqual(result.reasons, [
      "price_deviation_exceeds_tolerance",
      "on_chain_stale",
    ]);
  });

  it("FAIL when there is no on-chain Pair UTxO for a configured feed", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: null,
        source: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
      },
      thresholds,
    );

    assert.equal(result.status, "FAIL");
    assert.equal(result.deviationPct, undefined);
    assert.equal(result.stalenessSec, undefined);
    assert.deepEqual(result.reasons, ["no_onchain_pair"]);
  });

  it("WARN when no source intent is available to compare against", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
        source: null,
      },
      thresholds,
    );

    assert.equal(result.status, "WARN");
    assert.equal(result.deviationPct, undefined);
    assert.equal(result.stalenessSec, undefined);
    assert.deepEqual(result.reasons, ["no_source_intent"]);
  });

  it("WARN (not a deviation failure) when the source price is zero — not comparable", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
        source: { price: 0n, timestampSec: 1_000n, nonce: 6n },
      },
      thresholds,
    );

    assert.equal(result.status, "WARN");
    assert.equal(result.deviationPct, undefined);
    assert.deepEqual(result.reasons, ["source_price_zero"]);
  });

  it("PASS and clamps staleness to 0 when the on-chain value is ahead of the source snapshot", () => {
    const result = evaluateFeedSanity(
      {
        symbol: "BTC/USD",
        onChain: { price: 100_000n, timestampSec: 2_000n, nonce: 9n },
        source: { price: 100_000n, timestampSec: 1_000n, nonce: 5n },
      },
      thresholds,
    );

    assert.equal(result.status, "PASS");
    assert.equal(result.stalenessSec, 0);
    assert.deepEqual(result.reasons, []);
  });
});

describe("deriveFeedThresholds", () => {
  it("uses time_threshold as the freshness ceiling when it is set (OR-gate mode)", () => {
    const t = deriveFeedThresholds(
      { price_deviation: "0.5%", time_threshold: "10m" },
      { graceSec: 60 },
    );

    assert.equal(t.priceDeviationPct, 0.5);
    assert.equal(t.freshnessSec, 660); // 600s ceiling + 60s grace
  });

  it("uses max_staleness as the ceiling when time_threshold is off (deviation-only mode)", () => {
    const t = deriveFeedThresholds(
      { price_deviation: "0.5%", time_threshold: "0s", max_staleness: "30m" },
      { graceSec: 60 },
    );

    assert.equal(t.priceDeviationPct, 0.5);
    assert.equal(t.freshnessSec, 1860); // 1800s ceiling + 60s grace
  });

  it("has no freshness ceiling when neither time_threshold nor max_staleness is set", () => {
    const t = deriveFeedThresholds(
      { price_deviation: "0.5%" },
      { graceSec: 60 },
    );

    assert.equal(t.priceDeviationPct, 0.5);
    assert.equal(t.freshnessSec, Infinity); // can never FAIL on freshness
  });

  it("has no price tolerance when price_deviation is not configured", () => {
    const t = deriveFeedThresholds(
      { time_threshold: "10m" },
      { graceSec: 60 },
    );

    assert.equal(t.priceDeviationPct, Infinity); // can never FAIL on price drift
    assert.equal(t.freshnessSec, 660);
  });
});

describe("summarizeFeedSanity", () => {
  it("counts feeds by status and keeps the per-feed results", () => {
    const results: FeedSanityResult[] = [
      { symbol: "A", status: "PASS", deviationPct: 0, stalenessSec: 0, reasons: [] },
      {
        symbol: "B",
        status: "WARN",
        deviationPct: 1,
        stalenessSec: 0,
        reasons: ["price_deviation_exceeds_tolerance"],
      },
      {
        symbol: "C",
        status: "FAIL",
        deviationPct: 2,
        stalenessSec: 999,
        reasons: ["price_deviation_exceeds_tolerance", "on_chain_stale"],
      },
    ];

    const summary = summarizeFeedSanity(results);

    assert.equal(summary.total, 3);
    assert.equal(summary.pass, 1);
    assert.equal(summary.warn, 1);
    assert.equal(summary.fail, 1);
    assert.equal(summary.results, results);
  });
});

describe("runFeedSanityChecks", () => {
  it("evaluates each symbol with its readers and thresholds", async () => {
    const deps: FeedSanityDeps = {
      readOnChain: async (s) =>
        s === "A" ? { price: 100n, timestampSec: 10n, nonce: 1n } : null,
      readLatestSource: async (s) =>
        s === "A"
          ? { price: 100n, timestampSec: 10n }
          : { price: 50n, timestampSec: 10n },
      thresholdsFor: () => ({ priceDeviationPct: 0.5, freshnessSec: 600 }),
    };

    const results = await runFeedSanityChecks(["A", "B"], deps);

    assert.equal(results.length, 2);
    assert.equal(results[0].symbol, "A");
    assert.equal(results[0].status, "PASS");
    assert.equal(results[1].symbol, "B");
    assert.equal(results[1].status, "FAIL"); // B has no on-chain Pair UTxO
    assert.deepEqual(results[1].reasons, ["no_onchain_pair"]);
  });
});

describe("formatFeedSanityReport", () => {
  it("renders a per-feed table and a machine-readable object", () => {
    const summary = summarizeFeedSanity([
      { symbol: "BTC/USD", status: "PASS", deviationPct: 0.1, stalenessSec: 30, reasons: [] },
      {
        symbol: "ETH/USD",
        status: "FAIL",
        deviationPct: 2,
        stalenessSec: 999,
        reasons: ["price_deviation_exceeds_tolerance", "on_chain_stale"],
      },
    ]);

    const { markdown, json } = formatFeedSanityReport(summary, {
      network: "Preview",
      generatedAtSec: 1000,
    });

    assert.match(markdown, /BTC\/USD/);
    assert.match(markdown, /ETH\/USD/);
    assert.match(markdown, /PASS/);
    assert.match(markdown, /FAIL/);
    assert.match(markdown, /1 PASS/); // count summary line
    assert.equal(json.network, "Preview");
    assert.equal(json.total, 2);
    assert.equal(json.fail, 1);
    assert.equal(json.feeds.length, 2);
  });
});

describe("pickLatestIntentPerSymbol", () => {
  it("keeps the newest intent per symbol", () => {
    const latest = pickLatestIntentPerSymbol([
      { symbol: "BTC/USD", price: 100n, timestampSec: 10n },
      { symbol: "BTC/USD", price: 110n, timestampSec: 20n },
      { symbol: "ETH/USD", price: 50n, timestampSec: 5n },
    ]);

    assert.equal(latest.size, 2);
    assert.equal(latest.get("BTC/USD")?.price, 110n);
    assert.equal(latest.get("BTC/USD")?.timestampSec, 20n);
    assert.equal(latest.get("ETH/USD")?.price, 50n);
  });
});

describe("sanityStatusCode", () => {
  it("encodes the status as 0 PASS / 1 WARN / 2 FAIL for the gauge", () => {
    assert.equal(sanityStatusCode("PASS"), 0);
    assert.equal(sanityStatusCode("WARN"), 1);
    assert.equal(sanityStatusCode("FAIL"), 2);
  });
});

describe("readOnChainPairs", () => {
  it("decodes pair UTxOs and keys them by symbol, skipping non-pair and datumless utxos", async () => {
    const POLICY = "abc123";
    const utxos: ChainUtxo[] = [
      { assets: { [`${POLICY}deadbeef`]: 1n, lovelace: 2_000_000n }, datum: "PAIR_BTC" },
      { assets: { lovelace: 5_000_000n }, datum: "OTHER" }, // no pair NFT → skip
      { assets: { [`${POLICY}cafe`]: 1n }, datum: null }, // no datum → skip
    ];
    const decodePairDatum = (d: string) => {
      if (d === "PAIR_BTC") {
        return {
          pairId: Buffer.from("BTC/USD").toString("hex"),
          price: "100",
          timestamp: "1000",
          nonce: "5",
        };
      }
      throw new Error(`unexpected datum decoded: ${d}`);
    };

    const readings = await readOnChainPairs({
      utxosAt: async () => utxos,
      decodePairDatum,
      pairValidatorAddress: "addr_test1xyz",
      pairPolicyId: POLICY,
    });

    assert.equal(readings.size, 1);
    assert.equal(readings.get("BTC/USD")?.price, 100n);
    assert.equal(readings.get("BTC/USD")?.timestampSec, 1000n);
    assert.equal(readings.get("BTC/USD")?.nonce, 5n);
  });
});
