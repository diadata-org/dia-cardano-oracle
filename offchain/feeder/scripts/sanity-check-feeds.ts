// Per-feed sanity check.
//
// For every feed the active router publishes, compare the LIVE on-chain Pair
// value (price, timestamp) against the LATEST DIA `IntentRegistered` for the
// same symbol, and judge price accuracy + freshness against that feed's own
// push-policy thresholds. Writes a report under docs/milestones/evidence/.
//
// Usage (from offchain/feeder/, network from CARDANO_NETWORK):
//   npm run sanity:feeds -- [--blocks <n>] [--chunk <n>]
//
// Read-only: it queries the Cardano chain and the DIA registry and submits
// nothing. Everything (RPC, registry address, chain id, thresholds, grace) is
// read from config/env — no hardcoded values.

import {
  createPublicClient,
  http,
  type Hex,
  type Abi,
  type AbiEvent,
} from "viem";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModularConfig } from "../src/config/loader.js";
import { extractRouterSymbols } from "../src/router/symbols.js";
import {
  deriveFeedThresholds,
  runFeedSanityChecks,
  summarizeFeedSanity,
  formatFeedSanityReport,
  pickLatestIntentPerSymbol,
  readOnChainPairs,
  type FeedSanityDeps,
  type OnChainReading,
  type SourceReading,
  type RawSourceIntent,
} from "../src/sanity-check/feed-sanity.js";

import { getCliConfig } from "@diadata-org/dia-cardano-oracle-cli/core/config";
import { makeConfiguredLucidWithConfig } from "@diadata-org/dia-cardano-oracle-cli/core/lucid";
import { readClientContext } from "@diadata-org/dia-cardano-oracle-cli/core/artifact-context";
import { decodePairDatum } from "@diadata-org/dia-cardano-oracle-cli/core/chain-helpers";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FEEDER_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(FEEDER_ROOT, "..", "..");
const CONFIG_DIR = join(FEEDER_ROOT, "config");

function parseFlag(flag: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`) || a === `--${flag}`);
  if (!arg) return fallback;
  const next = process.argv[process.argv.indexOf(arg) + 1];
  const raw = arg.includes("=") ? arg.split("=")[1] : next;
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BLOCK_WINDOW = parseFlag("blocks", 5000);
const CHUNK_SIZE = parseFlag("chunk", 500);

const network = (process.env.CARDANO_NETWORK ?? "Preview") as "Preview" | "Mainnet";
const networkTag = network.toLowerCase(); // preview | mainnet
const chainKey = networkTag === "mainnet" ? "dia-mainnet" : "dia-testnet";
const registryKey = networkTag === "mainnet" ? "intent-registry-mainnet" : "intent-registry-testnet";

// --- on-chain side: read every live Pair UTxO and key it by its symbol --------

async function buildOnChainReadings(args: {
  clientStatePath: string;
  protocolStatePath: string;
}): Promise<Map<string, OnChainReading>> {
  const { client } = await readClientContext({
    clientStatePath: args.clientStatePath,
    protocolStatePath: args.protocolStatePath,
  });
  const pairValidatorAddress = client.scripts.pairValidatorAddress;
  const pairPolicyId = client.scripts.pairPolicyId;
  if (!pairValidatorAddress || !pairPolicyId) {
    throw new Error("client state has no pair validator address / pair policy id — run receiver:parameterize");
  }

  const lucid = await makeConfiguredLucidWithConfig(getCliConfig());
  return readOnChainPairs({
    utxosAt: (address) => lucid.utxosAt(address),
    decodePairDatum,
    pairValidatorAddress,
    pairPolicyId,
  });
}

// --- source side: latest DIA IntentRegistered per symbol ----------------------

async function buildSourceReadings(args: {
  rpcUrl: string;
  chainId: number;
  registryAddress: Hex;
  abi: Abi;
}): Promise<Map<string, SourceReading>> {
  const eventAbi = args.abi.find(
    (f): f is AbiEvent => f.type === "event" && f.name === "IntentRegistered",
  );
  if (!eventAbi) throw new Error(`${registryKey} ABI has no IntentRegistered event`);

  const viemClient = createPublicClient({
    transport: http(args.rpcUrl),
    chain: {
      id: args.chainId,
      name: `DIA ${networkTag}`,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [args.rpcUrl] } },
    },
  });

  const head = await viemClient.getBlockNumber();
  const from = head - BigInt(BLOCK_WINDOW);

  // Newest log per symbol-hash (topics[2]); price is indexed, timestamp is in data.
  const bySymbolHash = new Map<Hex, { intentHash: Hex; price: bigint; timestampSec: bigint }>();
  let cursor = from;
  while (cursor <= head) {
    const to = cursor + BigInt(CHUNK_SIZE) - 1n < head ? cursor + BigInt(CHUNK_SIZE) - 1n : head;
    const logs = await viemClient.getLogs({
      address: args.registryAddress,
      event: eventAbi,
      fromBlock: cursor,
      toBlock: to,
    });
    for (const log of logs) {
      const symbolHash = log.topics[2] as Hex;
      const intentHash = log.topics[1] as Hex;
      const a = log.args as { price?: bigint; timestamp?: bigint };
      if (a.price === undefined || a.timestamp === undefined) continue;
      const current = bySymbolHash.get(symbolHash);
      if (!current || a.timestamp > current.timestampSec) {
        bySymbolHash.set(symbolHash, { intentHash, price: a.price, timestampSec: a.timestamp });
      }
    }
    cursor = to + 1n;
  }

  // Recover the symbol string for each hash via getIntent (one call per symbol).
  const rawIntents: RawSourceIntent[] = [];
  for (const [, { intentHash, price, timestampSec }] of bySymbolHash) {
    const intent = (await viemClient.readContract({
      address: args.registryAddress,
      abi: args.abi,
      functionName: "getIntent",
      args: [intentHash],
    })) as { symbol: string };
    rawIntents.push({ symbol: intent.symbol, price, timestampSec });
  }
  return pickLatestIntentPerSymbol(rawIntents);
}

// --- output -------------------------------------------------------------------

function resolveOutDir(): string {
  // An evidence packager can pin the output into its pack dir.
  const override = process.env.SANITY_OUT_DIR;
  if (override) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  let runId = "";
  try {
    const runs = readdirSync(join(REPO_ROOT, "offchain", "state"))
      .filter((d) => d.startsWith(`${networkTag}_run_`))
      .sort();
    if (runs.length) runId = runs[runs.length - 1]!.replace(`${networkTag}_run_`, "");
  } catch {
    /* no state dir — fall back to a date stamp below */
  }
  const stamp = runId || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let outDir = join(REPO_ROOT, "docs", "milestones", "evidence", `feed-sanity-${networkTag}-${stamp}`);
  if (existsSync(outDir)) {
    let n = 1;
    while (existsSync(`${outDir}-${String(n).padStart(2, "0")}`)) n++;
    outDir = `${outDir}-${String(n).padStart(2, "0")}`;
  }
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const config = await loadModularConfig({ baseDir: CONFIG_DIR, network });

  const router = Object.values(config.routers).find(
    (r) => r.enabled && r.destinations.some((d) => d.cardano),
  );
  if (!router) throw new Error(`no enabled router with a cardano destination for ${network}`);
  const dest = router.destinations.find((d) => d.cardano)!;
  const cardano = dest.cardano!;
  const symbols = extractRouterSymbols(router);

  const graceSec = config.infrastructure?.feed_sanity?.freshness_grace_seconds;
  if (graceSec === undefined) {
    throw new Error("missing feed_sanity.freshness_grace_seconds in the infrastructure config");
  }
  const thresholds = deriveFeedThresholds(
    {
      price_deviation: dest.price_deviation,
      time_threshold: dest.time_threshold,
      max_staleness: dest.max_staleness,
    },
    { graceSec },
  );

  const registry = config.contracts[registryKey];
  if (!registry) throw new Error(`contracts.yaml has no ${registryKey} entry`);
  const chain = config.chains[chainKey];
  if (!chain) throw new Error(`chains.yaml has no ${chainKey} entry`);

  console.log(`Feed sanity check — ${network}`);
  console.log(`Router   : ${router.id} (${symbols.length} feeds)`);
  console.log(`Registry : ${registry.address}`);
  console.log(`Window   : last ${BLOCK_WINDOW} blocks\n`);

  const [onChain, source] = await Promise.all([
    buildOnChainReadings({
      clientStatePath: resolve(FEEDER_ROOT, cardano.client_state_path),
      protocolStatePath: resolve(FEEDER_ROOT, cardano.protocol_state_path),
    }),
    buildSourceReadings({
      rpcUrl: chain.rpc_urls[0]!,
      chainId: chain.chain_id,
      registryAddress: registry.address as Hex,
      abi: JSON.parse(registry.abi) as Abi,
    }),
  ]);

  const deps: FeedSanityDeps = {
    readOnChain: async (s) => onChain.get(s) ?? null,
    readLatestSource: async (s) => source.get(s) ?? null,
    thresholdsFor: () => thresholds,
  };

  const results = await runFeedSanityChecks(symbols, deps);
  const summary = summarizeFeedSanity(results);
  const generatedAtSec = Math.floor(Date.now() / 1000);
  const { markdown, json } = formatFeedSanityReport(summary, { network, generatedAtSec });

  const outDir = resolveOutDir();
  writeFileSync(join(outDir, "feed-sanity.md"), markdown);
  writeFileSync(join(outDir, "feed-sanity.json"), JSON.stringify(json, null, 2));

  console.log(markdown);
  console.log(`[sanity] report written: ${outDir.replace(REPO_ROOT + "/", "")}/`);

  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error("\nFatal:", (err as Error).message);
  process.exit(1);
});
