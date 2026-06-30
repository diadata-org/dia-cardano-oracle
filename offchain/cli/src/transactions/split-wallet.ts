// Split-wallet CLI tx.
//
// A plain pubkey->pubkey self-payment that breaks a wallet's UTxOs into the
// parallel-friendly profile the feeder's arbiter needs: it consumes the exact
// UTxOs the planner chose (`consumeOutRefs`) and pays a list of explicit outputs
// (`outputLovelaces`) back to the wallet's own address; the balancer returns the
// remainder as change. With no script inputs it needs NO collateral and builds
// even from an all-large wallet.
//
// It is the planner-driven generalisation of the old single-output consolidate:
// where consolidate merged dust into one collateral + working UTxO, split
// produces N working + M collateral pieces so a SINGLE wallet can back many
// concurrent lanes. The "which UTxOs / which outputs" decision lives in the
// feeder's pure `wallet-shape.ts`; this module only builds and submits the plan,
// signed by the specific wallet the feeder arbitrates (not the global one).

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

/** Signing key for the wallet being split. */
export type SplitWalletSigner = {
  kind: "seed" | "privateKey";
  value: string;
};

/** Outcome of a split tx, including the wallet UTxO delta so the arbitrating
 *  caller can refresh its UTxO cache on release. */
export type SplitWalletResult = {
  address: string;
  submittedTxHash: string | null;
  confirmed: boolean;
  /** Inputs the tx spent (out-refs). */
  consumedOutRefs: string[];
  /** The split pieces the tx paid back to the wallet (profile + change). */
  producedUtxos: WalletChangeUtxo[];
  /** Fee the built tx pays — the feeder meters wallet-shaping cost from it. */
  feePaidLovelace: bigint;
};

function reportProgress(message: string): void {
  console.error(`[split-wallet] ${message}`);
}

/**
 * Consume `consumeOutRefs` from the `signer` wallet and pay `outputLovelaces`
 * back to its own address, splitting it toward the arbiter's target profile.
 * Returns the submitted tx hash + confirmation flag; `buildOnly` stops before
 * signing for dry assembly.
 */
export async function splitWallet(args: {
  signer: SplitWalletSigner;
  consumeOutRefs: string[];
  outputLovelaces: bigint[];
  buildOnly?: boolean;
}): Promise<SplitWalletResult> {
  if (args.consumeOutRefs.length === 0) {
    throw new Error("split-wallet: consumeOutRefs must not be empty.");
  }
  if (args.outputLovelaces.length === 0) {
    throw new Error("split-wallet: outputLovelaces must not be empty.");
  }
  if (args.outputLovelaces.some((v) => v <= 0n)) {
    throw new Error("split-wallet: outputLovelaces must all be positive.");
  }

  reportProgress(`Connecting and selecting the wallet to split (kind=${args.signer.kind})`);
  const lucid = await makeConfiguredLucid();
  if (args.signer.kind === "seed") {
    lucid.selectWallet.fromSeed(args.signer.value);
  } else {
    lucid.selectWallet.fromPrivateKey(args.signer.value);
  }
  const wallet = lucid.wallet();
  const address = await wallet.address();
  const walletUtxos = await wallet.getUtxos();

  // Pin coin selection to exactly the planned inputs: `collectFrom` forces them
  // in and `overrideUTxOs` forbids the balancer from drawing any other UTxO
  // (which another lane may have reserved).
  const wanted = new Set(args.consumeOutRefs);
  const pinned = walletUtxos.filter((u) => wanted.has(`${u.txHash}#${u.outputIndex}`));
  if (pinned.length < args.consumeOutRefs.length) {
    throw new Error("split-wallet: a planned input UTxO is no longer live.");
  }
  lucid.overrideUTxOs(pinned);

  reportProgress(
    `Splitting ${pinned.length} UTxO(s) at ${address} into ${args.outputLovelaces.length} output(s)`,
  );
  // Force the planned inputs and lay out one explicit output per planned piece;
  // the balancer returns the leftover as change. No script inputs => no
  // collateral required to BUILD this.
  const txSignBuilder = await completeWithRetry(() => {
    let tx = lucid.newTx().collectFrom(pinned);
    for (const lovelace of args.outputLovelaces) {
      tx = tx.pay.ToAddress(address, { lovelace });
    }
    return tx;
  }, reportProgress);

  const txHash = txSignBuilder.toHash();
  const consumedOutRefs = computeSpentWalletOutRefs(walletUtxos, txSignBuilder);
  const producedUtxos = computeWalletChangeOutputs(txSignBuilder, txHash, address);
  // Release the pin so the confirmation + settlement reads below query the live
  // provider rather than the frozen reserved subset.
  lucid.overrideUTxOs([]);

  const { feeLovelace } = reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
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
      label: "split wallet transaction",
    });
    if (!confirmed) {
      throw new Error(`Transaction ${submittedTxHash} was submitted but confirmation was not observed.`);
    }
    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      transaction: txSignBuilder,
      label: "split wallet",
    });
  }
  return { address, submittedTxHash, confirmed, consumedOutRefs, producedUtxos, feePaidLovelace: feeLovelace };
}
