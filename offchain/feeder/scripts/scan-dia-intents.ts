// Scan DIA testnet for active IntentRegistered symbols.
//
// Usage (from offchain/feeder/):
//   npx tsx scripts/scan-dia-intents.ts [--blocks <n>] [--top <n>] [--chunk <n>]
//
// Flags:
//   --blocks  Number of past blocks to scan. Default: 2000 (~8 h on DIA testnet).
//   --top     How many symbols to show in the ranked output. Default: 10.
//   --chunk   getLogs batch size (blocks per request). Default: 500.
//
// How it works:
//   IntentRegistered has `symbol` as an indexed string param. Indexed dynamic
//   types are stored as keccak256(value) in the topic — the original string is
//   NOT recoverable from the topic alone. So the script:
//     1. Fetches all IntentRegistered logs in the window.
//     2. Groups logs by topic[2] (the symbol hash) to find unique symbols.
//     3. Calls getIntent(intentHash) exactly ONCE per unique symbol hash to
//        recover the actual symbol string.
//     4. Reports the ranked table and the YAML snippet for the router config.

import {
  createPublicClient,
  http,
  type Hex,
  type AbiEvent,
  type AbiFunction,
} from "viem";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

// Render a seconds interval as a compact human string (s / m / h / d).
function fmtInterval(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "n/a";
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${(sec / 60).toFixed(1)}m`;
  if (sec < 129600) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

// ---------------------------------------------------------------------------
// Source coordinates by network (CARDANO_NETWORK env). Same DIA registry the
// feeder scans; addresses mirror config/contracts.yaml. Mainnet = chain 1050,
// Testnet = chain 10050. Defaults to Testnet when CARDANO_NETWORK is unset.
// ---------------------------------------------------------------------------

const COORDS =
  (process.env.CARDANO_NETWORK ?? "Preview").toLowerCase() === "mainnet"
    ? {
        rpc: "https://rpc.diadata.org",
        chainId: 1050,
        registry: "0x5612599CF48032d7428399d5Fcb99eDcc75c06A7" as const,
      }
    : {
        rpc: "https://testnet-rpc.diadata.org",
        chainId: 10050,
        registry: "0xF8c614A483A0427A13512F52ac72A576678bE317" as const,
      };

const RPC_URL  = COORDS.rpc;
const CHAIN_ID = COORDS.chainId;
const REGISTRY = COORDS.registry;

const EVENT_ABI: AbiEvent = {
  type: "event",
  name: "IntentRegistered",
  anonymous: false,
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "symbol",     type: "string",  indexed: true  },
    { name: "price",      type: "uint256", indexed: true  },
    { name: "timestamp",  type: "uint256", indexed: false },
    { name: "signer",     type: "address", indexed: false },
  ],
};

const GET_INTENT_ABI: AbiFunction = {
  type: "function",
  name: "getIntent",
  stateMutability: "view",
  inputs:  [{ name: "intentHash", type: "bytes32" }],
  outputs: [
    {
      name: "intent",
      type: "tuple",
      components: [
        { name: "intentType", type: "string"  },
        { name: "version",    type: "string"  },
        { name: "chainId",    type: "uint256" },
        { name: "nonce",      type: "uint256" },
        { name: "expiry",     type: "uint256" },
        { name: "symbol",     type: "string"  },
        { name: "price",      type: "uint256" },
        { name: "timestamp",  type: "uint256" },
        { name: "source",     type: "string"  },
        { name: "signature",  type: "bytes"   },
        { name: "signer",     type: "address" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseFlag(flag: string, fallback: number): number {
  const arg = process.argv.find(a => a.startsWith(`--${flag}=`) || a === `--${flag}`);
  if (!arg) return fallback;
  const next = process.argv[process.argv.indexOf(arg) + 1];
  const raw = arg.includes("=") ? arg.split("=")[1] : next;
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const BLOCK_WINDOW = parseFlag("blocks", 2000);
const TOP_N        = parseFlag("top",    10);
const CHUNK_SIZE   = parseFlag("chunk",  500);

// ---------------------------------------------------------------------------
// viem client
// ---------------------------------------------------------------------------

const client = createPublicClient({
  transport: http(RPC_URL),
  chain: {
    id: CHAIN_ID,
    name: "DIA Testnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("DIA testnet — IntentRegistered symbol scanner");
  console.log(`Registry : ${REGISTRY}`);
  console.log(`RPC      : ${RPC_URL}`);
  console.log(`Window   : last ${BLOCK_WINDOW} blocks, chunk ${CHUNK_SIZE}`);
  console.log("");

  const head = await client.getBlockNumber();
  const from = head - BigInt(BLOCK_WINDOW);
  console.log(`Block range: ${from} → ${head}`);

  // Average block time over the window, to convert block spans to seconds.
  const [headBlk, fromBlk] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: from }),
  ]);
  const blockTimeSec =
    Number(headBlk.timestamp - fromBlk.timestamp) / Number(head - from);
  console.log(`Avg block time: ${blockTimeSec.toFixed(2)} s`);

  // Fetch logs in chunks to stay within RPC limits.
  const allLogs: Array<{ topics: readonly Hex[]; blockNumber: bigint }> = [];
  let cursor = from;
  while (cursor <= head) {
    const to = cursor + BigInt(CHUNK_SIZE) - 1n < head
      ? cursor + BigInt(CHUNK_SIZE) - 1n
      : head;
    process.stdout.write(`  getLogs ${cursor}…${to} ... `);
    const chunk = await client.getLogs({
      address: REGISTRY,
      event: EVENT_ABI,
      fromBlock: cursor,
      toBlock: to,
    });
    process.stdout.write(`${chunk.length} events\n`);
    for (const log of chunk) {
      allLogs.push({
        topics: log.topics,
        blockNumber: log.blockNumber ?? 0n,
      });
    }
    cursor = to + 1n;
  }

  console.log(`\nTotal events: ${allLogs.length}`);
  if (allLogs.length === 0) {
    console.log("No IntentRegistered events in this window. Try a larger --blocks value.");
    return;
  }

  // Group by symbol topic (topics[2] = keccak256 of the symbol string).
  // All logs for the same symbol have identical topics[2] regardless of price.
  type SymbolGroup = {
    sampleHash: Hex;    // one intentHash to call getIntent with
    count: number;
    firstBlock: bigint;
    lastBlock: bigint;
  };
  const bySymbolTopic = new Map<Hex, SymbolGroup>();

  for (const log of allLogs) {
    const symbolTopic = log.topics[2] as Hex;
    const intentHash  = log.topics[1] as Hex;
    if (!bySymbolTopic.has(symbolTopic)) {
      bySymbolTopic.set(symbolTopic, {
        sampleHash: intentHash,
        count: 0,
        firstBlock: log.blockNumber,
        lastBlock: 0n,
      });
    }
    const g = bySymbolTopic.get(symbolTopic)!;
    g.count++;
    if (log.blockNumber < g.firstBlock) g.firstBlock = log.blockNumber;
    if (log.blockNumber > g.lastBlock) g.lastBlock = log.blockNumber;
  }

  console.log(`Unique symbol hashes: ${bySymbolTopic.size}`);
  console.log("Resolving symbol names via getIntent (one call per unique symbol)...\n");

  // Recover actual symbol strings via getIntent.
  const resolved: Array<{
    symbol: string;
    count: number;
    firstBlock: bigint;
    lastBlock: bigint;
    avgIntervalSec: number;
  }> = [];
  let idx = 0;
  for (const [, { sampleHash, count, firstBlock, lastBlock }] of bySymbolTopic) {
    idx++;
    process.stdout.write(`  [${idx}/${bySymbolTopic.size}] getIntent(${sampleHash.slice(0, 10)}…) → `);
    try {
      const intent = await client.readContract({
        address: REGISTRY,
        abi: [GET_INTENT_ABI],
        functionName: "getIntent",
        args: [sampleHash],
      }) as { symbol: string };
      const symbol = intent.symbol;
      // Average seconds between consecutive updates of this symbol, over the
      // span it was actually active in the window (block span × block time).
      const spanBlocks = Number(lastBlock - firstBlock);
      const avgIntervalSec =
        count > 1 && spanBlocks > 0
          ? (spanBlocks * blockTimeSec) / (count - 1)
          : Number.POSITIVE_INFINITY;
      resolved.push({ symbol, count, firstBlock, lastBlock, avgIntervalSec });
      process.stdout.write(`${symbol} (${count} intents, ~${fmtInterval(avgIntervalSec)})\n`);
    } catch (err) {
      process.stdout.write(`ERROR — ${(err as Error).message.slice(0, 60)}\n`);
    }
  }

  // Rank by intent count descending.
  resolved.sort((a, b) => b.count - a.count);

  const bar = "=".repeat(72);
  const sep = "-".repeat(72);
  console.log(`\n${bar}`);
  console.log(`TOP ${TOP_N} SYMBOLS  (last ${BLOCK_WINDOW} blocks, ${allLogs.length} total intents)`);
  console.log(bar);
  console.log(`${"#".padEnd(4)} ${"SYMBOL".padEnd(28)} ${"INTENTS".padStart(7)}  ${"AVG UPD".padStart(8)}  LAST BLOCK`);
  console.log(sep);
  const top = resolved.slice(0, TOP_N);
  for (let i = 0; i < top.length; i++) {
    const { symbol, count, avgIntervalSec, lastBlock } = top[i]!;
    console.log(`${String(i + 1).padEnd(4)} ${symbol.padEnd(28)} ${String(count).padStart(7)}  ${fmtInterval(avgIntervalSec).padStart(8)}  ${lastBlock}`);
  }
  console.log(bar);
  console.log(`Total unique symbols found in window: ${resolved.length}`);

  // ----- Persist a reproducible evidence artifact (named by run-id) -----
  const network = (process.env.CARDANO_NETWORK ?? "preview").toLowerCase();
  let runId = "";
  try {
    const runs = readdirSync(join(REPO_ROOT, "offchain", "state"))
      .filter((d) => d.startsWith(`${network}_run_`))
      .sort();
    if (runs.length) runId = runs[runs.length - 1]!.replace(`${network}_run_`, "");
  } catch { /* no state dir — fall back to a date stamp */ }
  const stamp = runId || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let outDir = join(REPO_ROOT, "docs", "milestones", "evidence", `pair-selection-${network}-${stamp}`);
  if (existsSync(outDir)) {
    let n = 1;
    while (existsSync(`${outDir}-${String(n).padStart(2, "0")}`)) n++;
    outDir = `${outDir}-${String(n).padStart(2, "0")}`;
  }
  mkdirSync(outDir, { recursive: true });

  const md: string[] = [
    `# Oracle Pair Selection — ${network} (scan ${stamp})`,
    "",
    "> Auto-generated by `scripts/scan-dia-intents.ts`. Lists the symbols DIA actually",
    `> emits on the ${network} registry, ranked by intent count, with the average interval`,
    "> between updates. Pick the router's symbol list from this table.",
    "",
    "## Scan",
    "",
    `- Network: \`${network}\` (chain ${CHAIN_ID})`,
    `- Registry: \`${REGISTRY}\``,
    `- RPC: \`${RPC_URL}\``,
    `- Window: last ${BLOCK_WINDOW} blocks (\`${from}\` → \`${head}\`)`,
    `- Avg block time: ${blockTimeSec.toFixed(2)} s`,
    `- Total intents: ${allLogs.length} across ${resolved.length} unique symbols`,
    "",
    `## Symbols available on DIA ${network} (ranked)`,
    "",
    "| # | Symbol | Intents | Avg update | Last block |",
    "|---|--------|--------:|-----------:|-----------:|",
    ...resolved.map(
      (r, i) =>
        `| ${i + 1} | \`${r.symbol}\` | ${r.count} | ${fmtInterval(r.avgIntervalSec)} | ${r.lastBlock} |`,
    ),
    "",
    `## Suggested router symbol list (top ${TOP_N} by volume)`,
    "",
    "```yaml",
    "        value:",
    ...top.map((r) => `          - "${r.symbol}"`),
    "```",
    "",
  ];
  writeFileSync(join(outDir, "pair-selection-scan.md"), md.join("\n"));
  writeFileSync(
    join(outDir, "scan.json"),
    JSON.stringify(
      {
        network,
        chainId: CHAIN_ID,
        registry: REGISTRY,
        rpc: RPC_URL,
        windowBlocks: BLOCK_WINDOW,
        fromBlock: from.toString(),
        headBlock: head.toString(),
        blockTimeSec,
        totalIntents: allLogs.length,
        symbols: resolved.map((r) => ({
          symbol: r.symbol,
          intents: r.count,
          avgIntervalSec: Number.isFinite(r.avgIntervalSec) ? r.avgIntervalSec : null,
          firstBlock: r.firstBlock.toString(),
          lastBlock: r.lastBlock.toString(),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\n[scan] artifact written: ${outDir.replace(REPO_ROOT + "/", "")}/`);
}

main().catch((err: unknown) => {
  console.error("\nFatal:", (err as Error).message);
  process.exit(1);
});
