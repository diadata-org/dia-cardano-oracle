// End-to-end consumption demo — on-chain (real network).
//
// The on-chain counterpart of consumer-demo-emulator.ts. It proves the SAME loop
// a Cardano dApp uses to consume a DIA feed, but against the REAL deployed pair
// on the configured network (Preview / Mainnet):
//
//   1. Read the live pair FROM THE INDEXER over HTTP — the real consumption path:
//        GET {INDEXER_URL}/v1/pairs/{symbol} → price + pairPolicyId + utxoRef.
//   2. Lock funds at the example consumer validator with a min-price, then build
//      a spend that REFERENCES the pair's UTxO:
//        - min_price > live price → the validator REJECTS → spend fails to build.
//        - min_price < live price → the validator ACCEPTS → spend confirms.
//
// Network, provider and wallet all come from the environment, exactly like the
// CLI and feeder (CARDANO_NETWORK / CARDANO_PROVIDER / BLOCKFROST_* /
// CARDANO_WALLET_SEED_*) — it reuses the CLI's makeConfiguredLucid +
// selectConfiguredWallet. The indexer URL is INDEXER_URL (default
// http://localhost:3001); the symbol is DEMO_SYMBOL (default BTC/USD).
//
// Cost note: the REJECTED run locks a small amount (LOCK_LOVELACE) that then
// stays at the consumer script — it can only be spent once the live price rises
// to/above that min-price. On Preview that is free faucet ADA. The ACCEPTED run
// returns its locked ADA to the wallet.
//
// Run via examples/run-consumer-demo-onchain.sh (compiles the validator first).
// Requires the indexer running and a funded wallet on the configured network.

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  Constr,
  Data,
  applyDoubleCborEncoding,
  validatorToAddress,
  type Network,
  type Script,
  type UTxO,
} from "@lucid-evolution/lucid";

import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "@diadata-org/dia-cardano-oracle-cli/core/lucid";

import { readIndexerConfig } from "../config.js";

type LucidInstance = Awaited<ReturnType<typeof makeConfiguredLucid>>;

const SYMBOL = process.env.DEMO_SYMBOL ?? "BTC/USD";
const INDEXER_URL = (process.env.INDEXER_URL ?? "http://localhost:3001").replace(/\/+$/, "");
/** ADA locked per attempt (lovelace). The rejected attempt strands this amount. */
const LOCK_LOVELACE = 5_000_000n;

/** The subset of the indexer's pair response this demo needs. */
type IndexerPair = {
  symbol: string;
  pairId: string;
  pairPolicyId: string;
  price: string;
  utxoRef: { txHash: string; outputIndex: number };
};

async function fetchPairFromIndexer(symbol: string): Promise<IndexerPair> {
  const url = `${INDEXER_URL}/v1/pairs/${encodeURIComponent(symbol)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`indexer ${url} → ${response.status} ${response.statusText} (is the indexer running?)`);
  }
  return (await response.json()) as IndexerPair;
}

function loadConsumerValidator(): Script {
  const path =
    process.env.PLUTUS_JSON ??
    fileURLToPath(new URL("../../../../contracts/aiken/plutus.json", import.meta.url));
  const blueprint = JSON.parse(readFileSync(path, "utf8")) as {
    validators: Array<{ title: string; compiledCode: string }>;
  };
  const spend = blueprint.validators.find(
    (v) => v.title === "example_oracle_consumer.example_oracle_consumer.spend",
  );
  if (!spend) {
    throw new Error(`example_oracle_consumer not found in ${path}. Run \`aiken build\` in contracts/aiken first.`);
  }
  return { type: "PlutusV3", script: applyDoubleCborEncoding(spend.compiledCode) };
}

/** A signed transaction — structural so we need not name Lucid's deep types. */
type SignedTx = { toHash(): string; submit(): Promise<string> };

const MAX_SUBMIT_ATTEMPTS = 4;
const RETRY_DELAY_MS = 8_000;
/** How long to wait for a submitted tx to appear on-chain before treating the
 *  submit as not-landed and rebuilding. Preview blocks land in ~20-40 s. */
const CONFIRM_TIMEOUT_MS = 90_000;

/** Submit-time errors that are NOT a real failure: a stale provider UTxO view
 *  (the picked input was already spent), an already-included re-submit, or a
 *  transient network blip. All are recoverable by rebuilding from fresh state. */
const RETRIABLE_SUBMIT =
  /already been included|inputs are spent|badinputsutxo|valuenotconserved|fetch failed|timed? ?out|socket hang up|network error|too many requests|service unavailable|bad gateway|gateway timeout/i;

const shortMsg = (e: unknown): string =>
  ((e as Error)?.message ?? String(e)).split("\n")[0]!.slice(0, 160);

/** Resolve true if `hash` confirms within `ms`, false on timeout — never hangs.
 *  (awaitTx alone polls forever, which is what froze the earlier run.) */
function confirmedWithin(lucid: LucidInstance, hash: string, ms: number): Promise<boolean> {
  return Promise.race([
    lucid.awaitTx(hash).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/**
 * Build → sign → submit → confirm, with the feeder's stale-input reconcile: a
 * recoverable submit error (stale UTxO view / already-included / transient) is
 * verified by confirming the hash on-chain; if it did not land, refetch + rebuild
 * and retry. `buildAndSign` errors (e.g. a validator REJECTING a spend at
 * `.complete()`) propagate immediately — those are not retried.
 */
async function submitWithRetry(
  lucid: LucidInstance,
  buildAndSign: () => Promise<SignedTx>,
  label: string,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt += 1) {
    const signed = await buildAndSign();
    const hash = signed.toHash();
    try {
      await signed.submit();
      log(`   ${label}: submitted ${hash} — awaiting confirmation…`);
    } catch (error) {
      lastError = error;
      if (!RETRIABLE_SUBMIT.test((error as Error)?.message ?? "")) throw error;
      log(`   ${label}: submit said "${shortMsg(error)}" — checking whether it landed…`);
    }
    if (await confirmedWithin(lucid, hash, CONFIRM_TIMEOUT_MS)) return hash;
    if (attempt < MAX_SUBMIT_ATTEMPTS) {
      log(`   ${label}: not confirmed — refetching wallet + rebuilding (attempt ${attempt + 1}/${MAX_SUBMIT_ATTEMPTS})…`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `${label}: could not confirm after ${MAX_SUBMIT_ATTEMPTS} attempts` +
      (lastError ? ` (last: ${shortMsg(lastError)})` : ""),
  );
}

/** Lock LOCK_LOVELACE at the consumer with `minPrice`, then try to spend it
 *  referencing the live Pair UTxO. Returns true if the spend confirmed. */
async function attemptConsume(
  lucid: LucidInstance,
  validator: Script,
  consumerAddress: string,
  args: { pairPolicyId: string; pairId: string; minPrice: bigint; pairUtxo: UTxO; label: string },
): Promise<boolean> {
  const consumerDatum = Data.to(new Constr(0, [args.pairPolicyId, args.pairId, args.minPrice]));

  log(`   locking ${LOCK_LOVELACE} lovelace (${args.label})…`);
  const lockHash = await submitWithRetry(
    lucid,
    async () => {
      const tx = await lucid
        .newTx()
        .pay.ToContract(consumerAddress, { kind: "inline", value: consumerDatum }, { lovelace: LOCK_LOVELACE })
        .complete();
      return tx.sign.withWallet().complete();
    },
    "lock",
  );
  log(`   locked; tx ${lockHash}`);

  const locked = (await lucid.utxosAt(consumerAddress)).find((u) => u.txHash === lockHash);
  if (!locked) throw new Error("locked consumer UTxO not found after confirmation");

  try {
    const spendHash = await submitWithRetry(
      lucid,
      async () => {
        // `.complete()` runs the validator; a REJECT throws here and propagates
        // out of submitWithRetry (not retried) to the catch below.
        const tx = await lucid
          .newTx()
          .collectFrom([locked], Data.void())
          .readFrom([args.pairUtxo])
          .attach.SpendingValidator(validator)
          .complete();
        return tx.sign.withWallet().complete();
      },
      "spend",
    );
    log(`   spend ACCEPTED; tx ${spendHash}`);
    return true;
  } catch (error) {
    log(`   spend REJECTED: ${shortMsg(error)}`);
    return false;
  }
}

/** Two lock attempts + fees; warn below this so an underfunded wallet fails
 *  with a clear message instead of a cryptic build error mid-run. */
const MIN_WALLET_LOVELACE = LOCK_LOVELACE * 2n + 5_000_000n;

async function main(): Promise<void> {
  const network = readIndexerConfig(process.env).network as Network;
  const validator = loadConsumerValidator();
  const lucid = await makeConfiguredLucid();
  await selectConfiguredWallet(lucid);
  const consumerAddress = validatorToAddress(network, validator);

  // Preflight: show the wallet + its balance up front, so an empty/underfunded
  // wallet is obvious before any transaction is attempted.
  const walletAddress = await lucid.wallet().address();
  const walletUtxos = await lucid.wallet().getUtxos();
  const balance = walletUtxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  log(`Wallet ${walletAddress}`);
  log(`  balance: ${balance} lovelace (${Number(balance) / 1e6} ADA) across ${walletUtxos.length} UTxO(s)`);
  if (balance < MIN_WALLET_LOVELACE) {
    throw new Error(
      `wallet balance ${balance} lovelace is below the ~${MIN_WALLET_LOVELACE} needed for two locks + fees — ` +
        `fund ${walletAddress} (on Preview use the faucet) and re-run.`,
    );
  }

  log(`Consumer demo on ${network} — reading ${SYMBOL} from the indexer (${INDEXER_URL})…`);
  const pair = await fetchPairFromIndexer(SYMBOL);
  const price = BigInt(pair.price);
  log(
    `Indexer: ${pair.symbol} price=${price} ` +
      `utxo=${pair.utxoRef.txHash}#${pair.utxoRef.outputIndex} policy=${pair.pairPolicyId}`,
  );

  // Resolve the exact Pair UTxO the indexer pointed at, to reference-input it.
  const [pairUtxo] = await lucid.utxosByOutRef([
    { txHash: pair.utxoRef.txHash, outputIndex: pair.utxoRef.outputIndex },
  ]);
  if (!pairUtxo) {
    throw new Error(
      "could not resolve the Pair UTxO from the indexer ref — the feeder may have just updated the feed; re-run.",
    );
  }

  log("");
  log("1) Expecting REJECT — lock with min_price ABOVE the live price…");
  const rejected = await attemptConsume(lucid, validator, consumerAddress, {
    pairPolicyId: pair.pairPolicyId,
    pairId: pair.pairId,
    minPrice: price + 1n,
    pairUtxo,
    label: "min_price > price",
  });

  log("");
  log("2) Expecting ACCEPT — lock with min_price BELOW the live price…");
  const accepted = await attemptConsume(lucid, validator, consumerAddress, {
    pairPolicyId: pair.pairPolicyId,
    pairId: pair.pairId,
    minPrice: price - 1n,
    pairUtxo,
    label: "min_price < price",
  });

  log("");
  log("=== RESULT ===");
  log(`  min_price > live price → ${rejected ? "accepted ✗" : "REJECTED ✓"}`);
  log(`  min_price < live price → ${accepted ? "ACCEPTED ✓" : "rejected ✗"}`);
  const ok = !rejected && accepted;
  log(ok ? "DEMO PASSED — the validator consumed the live oracle price correctly." : "DEMO FAILED");
  if (!ok) process.exitCode = 1;
}

function log(line: string): void {
  console.log(line);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("");
  console.error(`DEMO ERROR — ${message}`);
  console.error(
    "  checklist: indexer reachable at INDEXER_URL · wallet funded on the configured network · " +
      "the pair's UTxO still current (re-run if the feeder just updated it).",
  );
  if (error instanceof Error && error.stack) console.error(`\n${error.stack}`);
  process.exitCode = 1;
});
