// Fund-pool-wallet CLI tx.
//
// A plain ADA payment from the main signer wallet to a pool wallet's address,
// used by the feeder to keep its pool wallets topped up (the main is the only
// wallet that self-funds, being the on-chain PaymentHook withdraw target). It is
// an ordinary wallet payment — no script, no datum — mirroring `deposit:fund`,
// signed by the main wallet rather than the globally-configured one.
//
// The "when / how much" decision lives in the feeder's pure `pool-funding.ts`;
// this module only builds and submits the chosen transfer.

import { makeConfiguredLucid } from "../core/lucid.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { completeWithRetry } from "../core/tx-build.js";
import { waitForWalletSettlement } from "../core/chain-helpers.js";

/** Signing key for the funding source (the main wallet). */
export type FundPoolWalletSigner = {
  kind: "seed" | "privateKey";
  value: string;
};

function reportProgress(message: string): void {
  console.error(`[fund-pool-wallet] ${message}`);
}

/**
 * Send `amountLovelace` from the main wallet (`signer`) to a pool wallet at
 * `toAddress`. Returns the submitted tx hash + confirmation flag; `buildOnly`
 * stops before signing for dry assembly.
 */
export async function fundPoolWallet(args: {
  signer: FundPoolWalletSigner;
  toAddress: string;
  amountLovelace: bigint;
  buildOnly?: boolean;
}): Promise<{ toAddress: string; submittedTxHash: string | null; confirmed: boolean }> {
  if (args.amountLovelace <= 0n) {
    throw new Error(`fund-pool-wallet: amountLovelace must be positive, got ${args.amountLovelace}.`);
  }

  reportProgress(`Connecting and selecting the main wallet (kind=${args.signer.kind})`);
  const lucid = await makeConfiguredLucid();
  if (args.signer.kind === "seed") {
    lucid.selectWallet.fromSeed(args.signer.value);
  } else {
    lucid.selectWallet.fromPrivateKey(args.signer.value);
  }
  const wallet = lucid.wallet();
  const walletUtxos = await wallet.getUtxos();

  reportProgress(`Paying ${args.amountLovelace} lovelace to pool wallet ${args.toAddress}`);
  // A plain ADA output, no datum — an ordinary wallet-to-wallet transfer.
  const txSignBuilder = await completeWithRetry(
    () => lucid.newTx().pay.ToAddress(args.toAddress, { lovelace: args.amountLovelace }),
    reportProgress,
  );

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
  return { toAddress: args.toAddress, submittedTxHash, confirmed };
}
