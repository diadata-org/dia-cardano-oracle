// Fund-pool-wallet CLI tx.
//
// A plain ADA payment from the main signer wallet to a pool wallet's address,
// used by the feeder to keep its pool wallets topped up (the main is the only
// wallet that self-funds, being the on-chain PaymentHook withdraw target). It is
// an ordinary wallet payment — no script, no datum — mirroring `deposit:fund`,
// signed by the main wallet rather than the globally-configured one.
//
// It pays one output per `outputLovelaces` entry, so a single funding tx lands
// the pool already shaped into its working + collateral pieces (the feeder plans
// those via `planShapeOutputs`) — a freshly funded pool is usable immediately,
// with no second split tx. The "when / which pieces" decision lives in the
// feeder; this module only builds and submits the chosen transfer.

import { makeConfiguredLucid } from "../core/lucid.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { completeWithRetry } from "../core/tx-build.js";
import {
  computeSpentWalletOutRefs,
  computeWalletChangeOutputs,
  waitForWalletSettlement,
  type WalletChangeUtxo,
} from "../core/chain-helpers.js";

/** Signing key for the funding source (the main wallet). */
export type FundPoolWalletSigner = {
  kind: "seed" | "privateKey";
  value: string;
};

/** Outcome of a funding tx, including the wallet UTxO delta so a caller that
 *  arbitrates the main wallet can refresh its UTxO cache on release. */
export type FundPoolWalletResult = {
  toAddress: string;
  submittedTxHash: string | null;
  confirmed: boolean;
  /** Main-wallet inputs the tx spent (out-refs). */
  consumedOutRefs: string[];
  /** Change the tx paid back to the main wallet. */
  producedUtxos: WalletChangeUtxo[];
};

function reportProgress(message: string): void {
  console.error(`[fund-pool-wallet] ${message}`);
}

/**
 * Pay `outputLovelaces` (one UTxO per entry) from the main wallet (`signer`) to a
 * pool wallet at `toAddress`, so the pool lands already shaped into lanes +
 * collateral. Returns the submitted tx hash + confirmation flag; `buildOnly`
 * stops before signing for dry assembly.
 */
export async function fundPoolWallet(args: {
  signer: FundPoolWalletSigner;
  toAddress: string;
  outputLovelaces: bigint[];
  /** When set, coin selection is pinned to these main-wallet out-refs so the tx
   *  never picks a UTxO another lane reserved (the feeder arbitrates the main). */
  reservedOutRefs?: string[];
  buildOnly?: boolean;
}): Promise<FundPoolWalletResult> {
  if (args.outputLovelaces.length === 0) {
    throw new Error("fund-pool-wallet: outputLovelaces must not be empty.");
  }
  if (args.outputLovelaces.some((v) => v <= 0n)) {
    throw new Error("fund-pool-wallet: outputLovelaces must all be positive.");
  }

  reportProgress(`Connecting and selecting the main wallet (kind=${args.signer.kind})`);
  const lucid = await makeConfiguredLucid();
  if (args.signer.kind === "seed") {
    lucid.selectWallet.fromSeed(args.signer.value);
  } else {
    lucid.selectWallet.fromPrivateKey(args.signer.value);
  }
  const wallet = lucid.wallet();
  const sourceAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();

  if (args.reservedOutRefs) {
    const reserved = new Set(args.reservedOutRefs);
    const pinned = walletUtxos.filter((u) => reserved.has(`${u.txHash}#${u.outputIndex}`));
    if (pinned.length < args.reservedOutRefs.length) {
      throw new Error("fund-pool-wallet: a reserved main-wallet UTxO is no longer live.");
    }
    lucid.overrideUTxOs(pinned);
  }

  const totalLovelace = args.outputLovelaces.reduce((acc, v) => acc + v, 0n);
  reportProgress(
    `Paying ${totalLovelace} lovelace to pool wallet ${args.toAddress} as ${args.outputLovelaces.length} UTxO(s)`,
  );
  // One plain ADA output per shape piece, no datum — an ordinary wallet-to-wallet
  // transfer that lands the pool already split into lanes + collateral.
  const txSignBuilder = await completeWithRetry(() => {
    let tx = lucid.newTx();
    for (const lovelace of args.outputLovelaces) {
      tx = tx.pay.ToAddress(args.toAddress, { lovelace });
    }
    return tx;
  }, reportProgress);

  const txHash = txSignBuilder.toHash();
  const consumedOutRefs = computeSpentWalletOutRefs(walletUtxos, txSignBuilder);
  const producedUtxos = computeWalletChangeOutputs(txSignBuilder, txHash, sourceAddress);
  // Release any pin now the build is done, so the confirmation + settlement
  // reads below query the live provider rather than the frozen reserved subset.
  lucid.overrideUTxOs([]);

  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  let submittedTxHash: string | null = null;
  let confirmed = false;
  if (!args.buildOnly) {
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "fund pool wallet transaction",
    });
    if (!confirmed) {
      throw new Error(`Transaction ${submittedTxHash} was submitted but confirmation was not observed.`);
    }
    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      transaction: txSignBuilder,
      label: "fund pool wallet",
    });
  }
  return { toAddress: args.toAddress, submittedTxHash, confirmed, consumedOutRefs, producedUtxos };
}
