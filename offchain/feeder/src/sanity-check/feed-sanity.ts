import {
  computePriceDeviationPct,
  parseDeviationPct,
  parseDurationMs,
} from "../router/policy.js";

/** The push-policy knobs of one router destination (raw config strings). */
export type FeedDestinationConfig = {
  price_deviation?: string;
  time_threshold?: string;
  max_staleness?: string;
};

/**
 * Map a router destination's push-policy config to the sanity-check thresholds,
 * mirroring the policy modes: the freshness ceiling is the same bound the feeder
 * guarantees an on-chain refresh within. `graceSec` absorbs confirmation/clock skew
 * so a value read mid-heartbeat is not a false WARN.
 */
/** Numeric encoding of the verdict for the `feed_sanity_status` gauge. */
export function sanityStatusCode(status: SanityStatus): 0 | 1 | 2 {
  return status === "PASS" ? 0 : status === "WARN" ? 1 : 2;
}

export type ChainUtxo = { assets?: Record<string, bigint>; datum?: string | null };

type DecodedPairDatum = {
  pairId: string;
  price: string;
  timestamp: string;
  nonce: string;
};

/**
 * Read every live Pair UTxO at the pair validator address and key the decoded
 * value by its symbol. The chain access (`utxosAt`) and datum decoder are
 * injected so this is reusable by the CLI command and the in-feeder loop alike,
 * and testable without a live chain. Skips UTxOs without a datum or without a
 * pair NFT, and any datum that fails to decode.
 */
export async function readOnChainPairs(args: {
  utxosAt: (address: string) => Promise<ChainUtxo[]>;
  decodePairDatum: (datum: string) => DecodedPairDatum;
  pairValidatorAddress: string;
  pairPolicyId: string;
}): Promise<Map<string, OnChainReading>> {
  const utxos = await args.utxosAt(args.pairValidatorAddress);
  const readings = new Map<string, OnChainReading>();
  for (const utxo of utxos) {
    if (!utxo.datum) continue;
    const carriesPairNft = Object.keys(utxo.assets ?? {}).some((unit) =>
      unit.startsWith(args.pairPolicyId),
    );
    if (!carriesPairNft) continue;
    let decoded: DecodedPairDatum;
    try {
      decoded = args.decodePairDatum(utxo.datum);
    } catch {
      continue;
    }
    const symbol = Buffer.from(decoded.pairId.replace(/^0x/, ""), "hex").toString("utf8");
    readings.set(symbol, {
      price: BigInt(decoded.price),
      timestampSec: BigInt(decoded.timestamp),
      nonce: BigInt(decoded.nonce),
    });
  }
  return readings;
}

export type RawSourceIntent = {
  symbol: string;
  price: bigint;
  timestampSec: bigint;
};

/** Reduce a window of DIA intents to the newest one per symbol (the source reference). */
export function pickLatestIntentPerSymbol(
  intents: RawSourceIntent[],
): Map<string, SourceReading> {
  const latest = new Map<string, SourceReading>();
  for (const intent of intents) {
    const current = latest.get(intent.symbol);
    if (!current || intent.timestampSec > current.timestampSec) {
      latest.set(intent.symbol, {
        price: intent.price,
        timestampSec: intent.timestampSec,
      });
    }
  }
  return latest;
}

export type FeedSanityDeps = {
  readOnChain: (symbol: string) => Promise<OnChainReading | null>;
  readLatestSource: (symbol: string) => Promise<SourceReading | null>;
  thresholdsFor: (symbol: string) => FeedSanityThresholds;
};

/**
 * Evaluate every configured feed: read its on-chain Pair value and its latest DIA
 * source value, then judge it against that feed's thresholds. Readers are injected so
 * the orchestration is testable without a live chain / registry.
 */
export async function runFeedSanityChecks(
  symbols: string[],
  deps: FeedSanityDeps,
): Promise<FeedSanityResult[]> {
  const results: FeedSanityResult[] = [];
  for (const symbol of symbols) {
    const [onChain, source] = await Promise.all([
      deps.readOnChain(symbol),
      deps.readLatestSource(symbol),
    ]);
    results.push(
      evaluateFeedSanity({ symbol, onChain, source }, deps.thresholdsFor(symbol)),
    );
  }
  return results;
}

export type FeedSanityReportJson = {
  network: string;
  generatedAtSec: number;
  total: number;
  pass: number;
  warn: number;
  fail: number;
  feeds: FeedSanityResult[];
};

/** Render the run summary as a human markdown table + a machine-readable object. */
export function formatFeedSanityReport(
  summary: FeedSanitySummary,
  meta: { network: string; generatedAtSec: number },
): { markdown: string; json: FeedSanityReportJson } {
  const json: FeedSanityReportJson = {
    network: meta.network,
    generatedAtSec: meta.generatedAtSec,
    total: summary.total,
    pass: summary.pass,
    warn: summary.warn,
    fail: summary.fail,
    feeds: summary.results,
  };

  const cell = (n: number | undefined) =>
    n === undefined ? "—" : Number.isFinite(n) ? String(n) : "∞";

  const rows = summary.results.map(
    (r) =>
      `| ${r.symbol} | ${r.status} | ${cell(r.deviationPct)} | ${cell(r.stalenessSec)} | ${r.reasons.join(", ") || "—"} |`,
  );

  const markdown = [
    `# Feed sanity check — ${meta.network}`,
    "",
    `${summary.total} feeds: ${summary.pass} PASS · ${summary.warn} WARN · ${summary.fail} FAIL.`,
    "",
    "| Symbol | Status | Deviation % | Staleness (s) | Reasons |",
    "|--------|--------|-------------|---------------|---------|",
    ...rows,
    "",
  ].join("\n");

  return { markdown, json };
}

export type FeedSanitySummary = {
  total: number;
  pass: number;
  warn: number;
  fail: number;
  results: FeedSanityResult[];
};

export function summarizeFeedSanity(results: FeedSanityResult[]): FeedSanitySummary {
  return {
    total: results.length,
    pass: results.filter((r) => r.status === "PASS").length,
    warn: results.filter((r) => r.status === "WARN").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    results,
  };
}

export function deriveFeedThresholds(
  dest: FeedDestinationConfig,
  options: { graceSec: number },
): FeedSanityThresholds {
  const priceDeviationPct = parseDeviationPct(dest.price_deviation) ?? Infinity;

  const timeThresholdMs = parseDurationMs(dest.time_threshold);
  const maxStalenessMs = parseDurationMs(dest.max_staleness);

  let ceilingMs: number | undefined;
  if (timeThresholdMs && timeThresholdMs > 0) ceilingMs = timeThresholdMs;
  else if (maxStalenessMs && maxStalenessMs > 0) ceilingMs = maxStalenessMs;

  const freshnessSec =
    ceilingMs === undefined ? Infinity : ceilingMs / 1000 + options.graceSec;

  return { priceDeviationPct, freshnessSec };
}

export type SanityStatus = "PASS" | "WARN" | "FAIL";

export type OnChainReading = {
  price: bigint;
  timestampSec: bigint;
  nonce: bigint;
};

export type SourceReading = {
  price: bigint;
  timestampSec: bigint;
  nonce?: bigint;
};

export type FeedSanityInput = {
  symbol: string;
  onChain: OnChainReading | null;
  source: SourceReading | null;
};

export type FeedSanityThresholds = {
  /** Allowed |on-chain - source| / source price deviation, in percent. */
  priceDeviationPct: number;
  /** Allowed lag of the on-chain timestamp behind the latest source intent, in seconds. */
  freshnessSec: number;
};

export type FeedSanityResult = {
  symbol: string;
  status: SanityStatus;
  /** `|on-chain - source| / source * 100`; undefined when not comparable. */
  deviationPct: number | undefined;
  /** `source.timestamp - on-chain.timestamp`, seconds; undefined when not comparable. */
  stalenessSec: number | undefined;
  reasons: string[];
};

export function evaluateFeedSanity(
  input: FeedSanityInput,
  thresholds: FeedSanityThresholds,
): FeedSanityResult {
  const { symbol, onChain, source } = input;

  if (!onChain) {
    return {
      symbol,
      status: "FAIL",
      deviationPct: undefined,
      stalenessSec: undefined,
      reasons: ["no_onchain_pair"],
    };
  }
  if (!source) {
    return {
      symbol,
      status: "WARN",
      deviationPct: undefined,
      stalenessSec: undefined,
      reasons: ["no_source_intent"],
    };
  }

  const deviationPct = computePriceDeviationPct(source.price, onChain.price);
  // Lag of the on-chain value behind the latest source intent; the on-chain
  // value being ahead of our source snapshot is not staleness, so clamp to 0.
  const stalenessSec = Math.max(0, Number(source.timestampSec - onChain.timestampSec));

  // Three price states: ok (within tolerance), drifted (comparable but over),
  // or non-comparable (no source baseline — e.g. zero source price).
  const priceComparable = deviationPct !== undefined;
  const priceWithinTolerance =
    priceComparable && deviationPct <= thresholds.priceDeviationPct;
  const priceDrifted = priceComparable && !priceWithinTolerance;
  const fresh = stalenessSec <= thresholds.freshnessSec;

  const reasons: string[] = [];
  if (!priceComparable) reasons.push("source_price_zero");
  else if (priceDrifted) reasons.push("price_deviation_exceeds_tolerance");
  if (!fresh) reasons.push("on_chain_stale");

  // FAIL only on a confirmed misreport (price drifted) that is ALSO stale; a
  // non-comparable price never escalates to FAIL on its own.
  let status: SanityStatus;
  if (priceWithinTolerance && fresh) status = "PASS";
  else if (priceDrifted && !fresh) status = "FAIL";
  else status = "WARN";

  return { symbol, status, deviationPct, stalenessSec, reasons };
}
