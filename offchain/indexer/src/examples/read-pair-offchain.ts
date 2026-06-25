// Off-chain integration example (indexer A6).
//
// How a Cardano dApp CONSUMES a DIA oracle feed:
//   1. Ask the indexer for a pair's current value + the exact UTxO ref.
//   2. Resolve that UTxO and include it as a REFERENCE INPUT in your own tx.
//
// Reference inputs are read-only: the oracle's value and NFT stay in place, so
// any number of dApps can read the same Pair UTxO in the same block. Your
// on-chain spending validator reads `price`/`timestamp` from the referenced
// inline datum and gates its spend on them (see the Aiken example, A7).
//
// This is illustrative — run it against a live indexer + provider (it reuses the
// feeder/CLI env conventions, so the same .env works):
//   INDEXER_URL=http://localhost:3001 SYMBOL=ARS/USDT CARDANO_NETWORK=Mainnet \
//   BLOCKFROST_API_URL_MAINNET=... BLOCKFROST_PROJECT_ID_MAINNET=... WALLET_SEED="..." \
//   npx tsx src/examples/read-pair-offchain.ts

import { Blockfrost, Lucid, type Network } from "@lucid-evolution/lucid";

/** The slice of the indexer's `GET /v1/pairs/{symbol}` response this uses. */
interface PairResponse {
  symbol: string;
  price: string;
  timestamp: string;
  ageSeconds: number;
  utxoRef: { txHash: string; outputIndex: number };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}.`);
  return value;
}

async function main(): Promise<void> {
  const indexerUrl = process.env.INDEXER_URL ?? "http://localhost:3001";
  const symbol = process.env.SYMBOL ?? "ARS/USDT";
  const network = (process.env.CARDANO_NETWORK ?? "Mainnet") as Network;
  const suffix = network === "Mainnet" ? "MAINNET" : "TESTNET";

  // 1) Ask the indexer for the pair's latest value + the UTxO to reference.
  //    The symbol contains a "/", so URL-encode it.
  const response = await fetch(`${indexerUrl}/v1/pairs/${encodeURIComponent(symbol)}`);
  if (!response.ok) {
    throw new Error(`Indexer returned ${response.status} for ${symbol}: ${await response.text()}`);
  }
  const pair = (await response.json()) as PairResponse;
  console.log(
    `${pair.symbol}: price=${pair.price} (age ${pair.ageSeconds}s) ` +
      `at ${pair.utxoRef.txHash}#${pair.utxoRef.outputIndex}`,
  );

  // A consumer would gate on freshness before trusting the value.
  const MAX_AGE_SECONDS = 3_600;
  if (pair.ageSeconds > MAX_AGE_SECONDS) {
    throw new Error(`Feed too stale (${pair.ageSeconds}s > ${MAX_AGE_SECONDS}s); refusing to consume.`);
  }

  // 2) Connect Lucid to the same network (your dApp's own provider + wallet).
  const lucid = await Lucid(
    new Blockfrost(required(`BLOCKFROST_API_URL_${suffix}`), required(`BLOCKFROST_PROJECT_ID_${suffix}`)),
    network,
  );
  lucid.selectWallet.fromSeed(required("WALLET_SEED"));

  // 3) Resolve the Pair UTxO by its ref and use it as a REFERENCE input.
  //    `.readFrom` includes it read-only — the oracle UTxO stays put.
  const [pairUtxo] = await lucid.utxosByOutRef([
    { txHash: pair.utxoRef.txHash, outputIndex: pair.utxoRef.outputIndex },
  ]);
  if (!pairUtxo) {
    throw new Error("Pair UTxO not found on-chain — the indexer ref may be a block stale; re-query.");
  }

  const ownAddress = await lucid.wallet().address();
  const tx = await lucid
    .newTx()
    .readFrom([pairUtxo]) // <- reference input: read-only; the price sits in pairUtxo.datum
    .pay.ToAddress(ownAddress, { lovelace: 2_000_000n })
    .complete();

  // In a real dApp the output above would lock funds at YOUR validator, whose
  // redeemer logic reads price/timestamp from the referenced Pair datum (A7).
  // Here we just demonstrate building a tx that references the live feed.
  console.log(`Built a tx referencing the ${symbol} feed (hash ${tx.toHash()}). Not submitting in the example.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
