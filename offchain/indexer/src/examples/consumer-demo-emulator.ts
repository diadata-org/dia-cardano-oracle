// End-to-end consumption demo — emulator.
//
// Runs on a Lucid in-memory emulator. It proves the full loop a Cardano dApp
// uses to consume a DIA feed:
//
//   1. A Pair UTxO is published on-chain (NFT + inline PairDatum, price = P).
//   2. The INDEXER (index service over the chain) is queried for the pair →
//      returns its latest price + the exact UTxO ref to reference.
//   3. Funds are locked at the example consumer validator with a min-price.
//   4. A spend that REFERENCES the Pair UTxO is built:
//        - min_price ≤ P  → the validator accepts  → tx SUCCEEDS
//        - min_price >  P  → the validator rejects  → tx FAILS
//
// The validator reads the price straight from OUR oracle's datum and gates on
// it, authenticated by the Pair NFT. Run via examples/run-consumer-demo-emulator.sh
// (which compiles the validator first). The on-chain counterpart against the real
// deployed pair is consumer-demo-onchain.ts / run-consumer-demo-onchain.sh.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Constr,
  Data,
  Emulator,
  Lucid,
  applyDoubleCborEncoding,
  generateEmulatorAccount,
  mintingPolicyToId,
  scriptFromNative,
  validatorToAddress,
  type Script,
} from "@lucid-evolution/lucid";

import { buildPairDatumCbor } from "@diadata-org/dia-cardano-oracle-cli/core/chain-helpers";
import { pairAssetNameFromPairIdHex } from "@diadata-org/dia-cardano-oracle-cli/core/dia-intent";

import { createIndexService } from "../index-service.js";
import { symbolToPairId } from "../pair-codec.js";
import type { ChainReader, IndexerUtxo } from "../chain-reader.js";
import type { Registry } from "../registry.js";

type LucidInstance = Awaited<ReturnType<typeof Lucid>>;

const SYMBOL = "BTC/USD";
const FEED_PRICE = 65_000_000_000n; // the price published on-chain in the demo

// ---------------------------------------------------------------------------
// Load the compiled example consumer validator from the Aiken blueprint.
// ---------------------------------------------------------------------------

function loadConsumerValidator(): Script {
  const path =
    process.env.PLUTUS_JSON ??
    fileURLToPath(new URL("../../../../contracts/aiken/plutus.json", import.meta.url));
  const blueprint = JSON.parse(readFileSync(path, "utf8")) as {
    validators: Array<{ title: string; compiledCode: string }>;
  };
  const spend = blueprint.validators.find((v) =>
    v.title === "example_oracle_consumer.example_oracle_consumer.spend",
  );
  if (!spend) {
    throw new Error(
      `example_oracle_consumer not found in ${path}. Run \`aiken build\` in contracts/aiken first.`,
    );
  }
  return { type: "PlutusV3", script: applyDoubleCborEncoding(spend.compiledCode) };
}

// ---------------------------------------------------------------------------
// An index service backed by the emulator (the indexer's real query logic).
// ---------------------------------------------------------------------------

function emulatorChainReader(lucid: LucidInstance): ChainReader {
  return {
    async utxosAt(address: string): Promise<IndexerUtxo[]> {
      const utxos = await lucid.utxosAt(address);
      return utxos.map((u) => ({
        address: u.address,
        txHash: u.txHash,
        outputIndex: u.outputIndex,
        assets: u.assets,
        datum: u.datum ?? null,
      }));
    },
    async tip() {
      return { slot: 0, height: 0, hash: "emulator" };
    },
  };
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const consumerValidator = loadConsumerValidator();

  const account = generateEmulatorAccount({ lovelace: 100_000_000_000n });
  const emulator = new Emulator([account]);
  const lucid = await Lucid(emulator, "Preview");
  lucid.selectWallet.fromSeed(account.seedPhrase);
  const walletAddress = await lucid.wallet().address();

  const consumerAddress = validatorToAddress("Preview", consumerValidator);

  // Always-mintable native policy for the demo Pair NFT (stands in for the real
  // pair_state mint policy; the consumer only cares that the NFT exists under a
  // known policy id with asset name = blake2b_256(pair_id)).
  const mintPolicy = scriptFromNative({ type: "all", scripts: [] });
  const pairPolicyId = mintingPolicyToId(mintPolicy);
  const pairId = symbolToPairId(SYMBOL);
  const pairAssetName = pairAssetNameFromPairIdHex(pairId);
  const pairUnit = pairPolicyId + pairAssetName;

  const pairDatumCbor = buildPairDatumCbor({
    pairId,
    price: FEED_PRICE.toString(),
    timestamp: "1700000000",
    nonce: "1",
    intentHash: "ab".repeat(32),
    signer: "cd".repeat(20),
    minUtxoLovelace: "2000000",
  });

  // 1) Publish the Pair UTxO: mint the NFT and park it (with the inline
  //    PairDatum) at a holder address the indexer will scan.
  log("1. Publishing the Pair UTxO (mint NFT + inline PairDatum)…");
  const publishTx = await lucid
    .newTx()
    .mintAssets({ [pairUnit]: 1n })
    .attach.MintingPolicy(mintPolicy)
    .pay.ToAddressWithData(
      walletAddress,
      { kind: "inline", value: pairDatumCbor },
      { lovelace: 2_000_000n, [pairUnit]: 1n },
    )
    .complete();
  await (await publishTx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);

  // 2) Ask the INDEXER (index service over the emulator) for the pair.
  const registry: Registry = {
    network: "Preview",
    clients: [
      {
        clientId: "demo",
        pairPolicyId,
        pairValidatorAddress: walletAddress,
        receiverValidatorAddress: walletAddress,
        receiverUnit: "00",
      },
    ],
  };
  const indexer = createIndexService({ reader: emulatorChainReader(lucid), registry });
  const pair = await indexer.getPair(SYMBOL);
  if (!pair) throw new Error("indexer did not find the published pair");
  log(`2. Indexer reports ${pair.symbol}: price=${pair.price} at ${pair.utxoRef.txHash}#${pair.utxoRef.outputIndex}`);

  // Resolve the exact Pair UTxO the indexer pointed at (to reference-input it).
  const [pairUtxo] = await lucid.utxosByOutRef([
    { txHash: pair.utxoRef.txHash, outputIndex: pair.utxoRef.outputIndex },
  ]);
  if (!pairUtxo) throw new Error("could not resolve the pair UTxO from the indexer ref");

  // 3 + 4) Lock at the consumer and try to spend, referencing the feed.
  const passed = await attemptConsume(lucid, emulator, consumerValidator, consumerAddress, {
    pairPolicyId,
    pairId,
    minPrice: FEED_PRICE - 1n, // below the feed price → should SUCCEED
    pairUtxo,
    label: "min_price < feed price",
  });
  const rejected = await attemptConsume(lucid, emulator, consumerValidator, consumerAddress, {
    pairPolicyId,
    pairId,
    minPrice: FEED_PRICE + 1n, // above the feed price → should FAIL
    pairUtxo,
    label: "min_price > feed price",
  });

  log("");
  log("=== RESULT ===");
  log(`  spend with min_price < feed price → ${passed ? "ACCEPTED ✓" : "rejected ✗"}`);
  log(`  spend with min_price > feed price → ${rejected ? "accepted ✗" : "REJECTED ✓"}`);
  const ok = passed && !rejected;
  log(ok ? "DEMO PASSED — the validator consumed our oracle price correctly." : "DEMO FAILED");
  if (!ok) process.exitCode = 1;
}

/** Lock funds at the consumer with `minPrice`, then try to spend referencing the
 *  Pair UTxO. Returns true if the spend succeeded (validator accepted). */
async function attemptConsume(
  lucid: LucidInstance,
  emulator: Emulator,
  validator: Script,
  consumerAddress: string,
  args: {
    pairPolicyId: string;
    pairId: string;
    minPrice: bigint;
    pairUtxo: Awaited<ReturnType<LucidInstance["utxosByOutRef"]>>[number];
    label: string;
  },
): Promise<boolean> {
  const consumerDatum = Data.to(
    new Constr(0, [args.pairPolicyId, args.pairId, args.minPrice]),
  );

  // Lock funds at the consumer validator with this min-price.
  const lockTx = await lucid
    .newTx()
    .pay.ToContract(consumerAddress, { kind: "inline", value: consumerDatum }, { lovelace: 5_000_000n })
    .complete();
  await (await lockTx.sign.withWallet().complete()).submit();
  emulator.awaitBlock(1);

  const [locked] = await lucid.utxosAt(consumerAddress);
  if (!locked) throw new Error("locked consumer UTxO not found");

  log(`3. Trying to spend (${args.label})…`);
  try {
    const spendTx = await lucid
      .newTx()
      .collectFrom([locked], Data.void())
      .readFrom([args.pairUtxo])
      .attach.SpendingValidator(validator)
      .complete();
    await (await spendTx.sign.withWallet().complete()).submit();
    emulator.awaitBlock(1);
    return true;
  } catch (error) {
    log(`   → rejected: ${(error as Error).message.split("\n")[0]}`);
    return false;
  }
}

function log(line: string): void {
  console.log(line);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
