// wallet-consolidate.ts — merge the configured wallet's fragmented pure-ADA
// UTxOs into ONE fat output.
//
// WHY
//   Every oracle update tx pays its Cardano network fee + collateral from the
//   updater/admin wallet and leaves change. Over a long run the wallet shatters
//   into many sub-collateral UTxOs (~1-2 ADA). Cardano collateral must be
//   covered by at most `max_collateral_inputs` UTxOs (3 on current networks), so
//   once every UTxO is smaller than the collateral target the builder can no
//   longer assemble collateral and EVERY script tx fails with
//   "Selected N inputs as collateral, but max collateral inputs is 3".
//
//   This is a plain pubkey->pubkey self-payment: it has NO script inputs, so it
//   needs NO collateral and builds even from an all-dust wallet. `collectFrom`
//   forces the selected dust UTxOs as inputs; the tx pays ONE explicit
//   collateral-sized output back to the wallet and lets the balancer return the
//   rest as a second change output. The wallet is left with exactly two clean
//   pure-ADA UTxOs: a DEDICATED COLLATERAL UTxO and the working balance.
//
//   Two UTxOs (not one) is deliberate. A script tx (oracle update batch, settle,
//   withdraw) needs a collateral UTxO that is DISTINCT from the regular inputs
//   it spends for fees/value. If the wallet collapses to a single UTxO, that
//   UTxO is taken as a regular input and nothing is left to back collateral, so
//   batch builds trap with "RuntimeError: unreachable". Keeping a dedicated
//   collateral UTxO guarantees collateral is always available.
//
//   It is the manual recovery tool and the primitive the daemon's
//   auto-consolidate uses.

import type { UTxO } from "@lucid-evolution/lucid";

import { getCliConfig } from "../core/config.js";
import { DEFAULT_COLLATERAL_LOVELACE } from "../core/constants.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { completeWithRetry } from "../core/tx-build.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import {
  computeSpentWalletOutRefs,
  computeWalletChangeOutputs,
  waitForWalletSettlement,
  type WalletChangeUtxo,
} from "../core/chain-helpers.js";

export type ConsolidateWalletResult = {
  source: "seed" | "private-key";
  address: string;
  totalUtxoCount: number;
  consolidatedUtxoCount: number;
  consolidatedLovelace: string;
  collateralLovelace: string;
  submittedTxHash: string | null;
  confirmed: boolean;
  /** Wallet inputs the tx spent (out-refs) — for the arbiter's cache delta. */
  consumedOutRefs: string[];
  /** Change the tx paid back to the wallet — for the arbiter's cache delta. */
  producedUtxos: WalletChangeUtxo[];
};

/** Pure-ADA UTxOs (single `lovelace` asset), smallest first — the dust is
 *  exactly what blocks collateral, so it is merged first. Token-bearing UTxOs
 *  are left untouched (collateral must be pure ADA). */
export function selectConsolidationUtxos(utxos: UTxO[], maxInputs: number): UTxO[] {
  const pureAda = utxos
    .filter((u) => Object.keys(u.assets).length === 1 && u.assets.lovelace !== undefined)
    .sort((a, b) => {
      const av = a.assets.lovelace ?? 0n;
      const bv = b.assets.lovelace ?? 0n;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  return pureAda.slice(0, Math.max(2, maxInputs));
}

export async function consolidateWallet(args: {
  maxInputs: number;
  buildOnly: boolean;
  collateralLovelace?: bigint;
  /** Arbitrated per-wallet path: sign with this wallet instead of the configured
   *  one. The feeder passes its pool wallet's signer; the manual command omits it. */
  signer?: { kind: "seed" | "privateKey"; value: string };
  /** Arbitrated per-wallet path: consume exactly these (already-reserved) dust
   *  out-refs instead of selecting them here. The feeder reserves them through the
   *  arbiter first so a consolidate never collides with a concurrent build. */
  reservedOutRefs?: string[];
}): Promise<ConsolidateWalletResult> {
  const collateralLovelace = args.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE;
  const lucid = await makeConfiguredLucid();
  let source: "seed" | "private-key";
  if (args.signer) {
    if (args.signer.kind === "seed") {
      lucid.selectWallet.fromSeed(args.signer.value);
      source = "seed";
    } else {
      lucid.selectWallet.fromPrivateKey(args.signer.value);
      source = "private-key";
    }
  } else {
    source = await selectConfiguredWallet(lucid);
  }
  const wallet = lucid.wallet();
  const [address, allUtxos] = await Promise.all([wallet.address(), wallet.getUtxos()]);

  const pureAdaCount = allUtxos.filter(
    (u) => Object.keys(u.assets).length === 1 && u.assets.lovelace !== undefined,
  ).length;
  if (pureAdaCount < 1) {
    throw new Error(
      `wallet:consolidate found no pure-ADA UTxOs at ${address}. Nothing to consolidate.`,
    );
  }

  // Arbitrated path: consume exactly the reserved out-refs (pinned so coin
  // selection draws nothing else). Manual path: pick the dust here.
  let selected: UTxO[];
  if (args.reservedOutRefs) {
    const wanted = new Set(args.reservedOutRefs);
    selected = allUtxos.filter((u) => wanted.has(`${u.txHash}#${u.outputIndex}`));
    if (selected.length < args.reservedOutRefs.length) {
      throw new Error("wallet:consolidate: a reserved UTxO is no longer live.");
    }
    lucid.overrideUTxOs(selected);
  } else {
    selected = selectConsolidationUtxos(allUtxos, args.maxInputs);
  }
  const consolidatedLovelace = selected.reduce((acc, u) => acc + (u.assets.lovelace ?? 0n), 0n);
  // Need enough to fund the dedicated collateral UTxO + a viable change output
  // + fee. Require a comfortable margin above the collateral amount.
  if (consolidatedLovelace < collateralLovelace + 3_000_000n) {
    throw new Error(
      `wallet:consolidate selected ${consolidatedLovelace} lovelace, too little to leave a ` +
        `${collateralLovelace}-lovelace collateral UTxO plus change. Fund the wallet first.`,
    );
  }

  reportProgress(
    `Consolidating ${selected.length} pure-ADA UTxO(s) totalling ${consolidatedLovelace} lovelace ` +
      `at ${address} into a ${collateralLovelace}-lovelace collateral UTxO + change ` +
      `(network=${getCliConfig().cardanoNetwork})`,
  );

  // `collectFrom` forces every selected UTxO as an input. One explicit output
  // is the DEDICATED COLLATERAL UTxO; the balancer returns the remainder as a
  // second change output. Result: two clean pure-ADA UTxOs (collateral +
  // working balance). No script inputs => no collateral required to BUILD this.
  const txSignBuilder = await completeWithRetry(
    () =>
      lucid
        .newTx()
        .collectFrom(selected)
        .pay.ToAddress(address, { lovelace: collateralLovelace }),
    reportProgress,
  );
  const txHash = txSignBuilder.toHash();
  const consumedOutRefs = computeSpentWalletOutRefs(allUtxos, txSignBuilder);
  const producedUtxos = computeWalletChangeOutputs(txSignBuilder, txHash, address);
  // Release any pin now the build is done, so confirmation + settlement reads hit
  // the live provider rather than the frozen reserved subset.
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
      label: "wallet consolidate transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }
    await waitForWalletSettlement({
      wallet,
      previousUtxos: selected,
      transaction: txSignBuilder,
      label: "wallet consolidate",
    });
  }

  return {
    source,
    address,
    totalUtxoCount: allUtxos.length,
    consolidatedUtxoCount: selected.length,
    consolidatedLovelace: consolidatedLovelace.toString(),
    collateralLovelace: collateralLovelace.toString(),
    submittedTxHash,
    confirmed,
    consumedOutRefs,
    producedUtxos,
  };
}

function reportProgress(message: string): void {
  console.error(`[wallet:consolidate] ${message}`);
}
