import path from "node:path";
import { stepId, getCliConfig} from "../core/config.js";
import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  getDefaultConfigStatePath,
  hasCompletedStep,
  readConfigState,
  type ConfigStateArtifact,
} from "../core/state.js";
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { completeWithRetry } from "../core/tx-build.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPaymentHookDatumCbor,
  computeSpentWalletOutRefs,
  computeWalletChangeOutputs,
  decodePaymentHookDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
  type WalletChangeUtxo,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertPaymentHookWithdrawAmountPositive,
  assertPaymentHookWithdrawAmountValid,
} from "../preflight/index.js";

export { assertPaymentHookWithdrawAmountValid } from "../preflight/index.js";

/** The new protocol state to persist, plus the arbiter cache delta. The delta is
 *  a transient signing-pool concern (feeder arbitration) and is kept OUT of the
 *  persisted `artifact` so no stale out-ref ever lands in a state file. */
export type PaymentHookWithdrawResult = {
  artifact: ConfigStateArtifact;
  consumedOutRefs: string[];
  producedUtxos: WalletChangeUtxo[];
  /** Fee the built withdraw tx pays — the feeder meters admin-wallet refill cost. */
  feePaidLovelace: bigint;
};

export async function paymentHookWithdraw(args: {
  amountLovelace: string;
  statePath?: string;
  buildOnly: boolean;
  /** Arbitrated path (feeder): pin the wallet's fee/collateral coin selection to
   *  these already-reserved out-refs so the withdraw never draws a UTxO another
   *  lane reserved. The manual command omits it (uses the whole wallet). */
  reservedOutRefs?: string[];
}): Promise<PaymentHookWithdrawResult> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for payment-hook withdraw`);
  const statePath = path.resolve(args.statePath ?? getDefaultConfigStatePath());
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  if (
    !state.paymentHookState ||
    !state.bootstrapRefs.paymentHook ||
    !hasCompletedStep(state.transactions, stepId("payment-hook:bootstrap"))
  ) {
    throw new Error("Payment-hook withdraw requires a state artifact produced after payment-hook bootstrap.");
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  // Arbitrated path: pin coin selection to the reserved fee/collateral UTxOs so
  // the withdraw never draws an input another lane holds. The PaymentHook + Config
  // inputs are collected explicitly, so the pin only constrains the wallet's fee +
  // collateral pick. Cleared after the build.
  if (args.reservedOutRefs) {
    const reserved = new Set(args.reservedOutRefs);
    const pinned = walletUtxos.filter((u) => reserved.has(`${u.txHash}#${u.outputIndex}`));
    if (pinned.length < args.reservedOutRefs.length) {
      throw new Error("payment-hook withdraw: a reserved wallet UTxO is no longer live.");
    }
    lucid.overrideUTxOs(pinned);
  }
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    state.configState.validConfigSigners,
  );

  const [currentConfigUtxo, currentPaymentHookUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.configValidatorAddress,
      state.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      state.scripts.paymentHookValidatorAddress!,
      state.scripts.paymentHookUnit!,
      "payment hook",
    ),
  ]);
  if (!state.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found. Run payment-hook:parameterize first.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator);

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  assertPaymentHookWithdrawAmountPositive(amountLovelace);
  const currentPaymentHookState =
    currentPaymentHookUtxo.datum
      ? decodePaymentHookDatum(
          currentPaymentHookUtxo.datum,
          state.paymentHookState.withdrawAddress,
        )
      : state.paymentHookState;
  assertPaymentHookWithdrawAmountValid(
    amountLovelace,
    BigInt(currentPaymentHookState.accruedFeesLovelace),
  );

  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) - amountLovelace
    ).toString(),
    lifetimeWithdrawnLovelace: (
      BigInt(currentPaymentHookState.lifetimeWithdrawnLovelace) + amountLovelace
    ).toString(),
  };

  const paymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(2, [amountLovelace]),
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} payment-hook withdraw transaction`);
  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "paymentHook",
          label: "payment hook",
          outRef: state.referenceScripts?.global?.paymentHook
            ? {
                txHash: state.referenceScripts.global.paymentHook.txHash,
                outputIndex: state.referenceScripts.global.paymentHook.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  const referenceScriptMissing = isAnyReferenceScriptMissing(missingReferenceScript);
  if (referenceScriptMissing) {
    reportProgress(
      "Reference script for payment hook is missing on-chain; attaching the payment hook validator inline.",
    );
  }

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
      .collectFrom([currentPaymentHookUtxo], withdrawRedeemer)
      .addSignerKey(walletDefaults.paymentKeyHash)
      .pay.ToContract(
        state.scripts.paymentHookValidatorAddress!,
        { kind: "inline", value: paymentHookDatumCbor },
        {
          lovelace:
            BigInt(nextPaymentHookState.minUtxoLovelace) +
            BigInt(nextPaymentHookState.accruedFeesLovelace),
          [state.scripts.paymentHookUnit!]: 1n,
        },
      )
      .pay.ToAddress(currentPaymentHookState.withdrawAddress, {
        lovelace: amountLovelace,
      });
    if (referenceScriptMissing) {
      txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
    }
    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx, reportProgress);
  const { feeLovelace } = reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();
  // Arbiter cache delta: the wallet inputs this tx consumes + the change it pays
  // back. Computed from the built body (deterministic hash), then the coin-select
  // pin is cleared so confirmation reads see the whole wallet again.
  const consumedOutRefs = computeSpentWalletOutRefs(walletUtxos, txSignBuilder);
  const producedUtxos = computeWalletChangeOutputs(txSignBuilder, unsignedHash, walletAddress);
  if (args.reservedOutRefs) lucid.overrideUTxOs([]);
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "payment-hook withdraw transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      transaction: txSignBuilder,
      label: "payment-hook withdraw",
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.scripts.paymentHookValidatorAddress!,
      unit: state.scripts.paymentHookUnit!,
      label: "payment hook",
      previousOutRef: currentPaymentHookUtxo,
    });
  }

  return {
    artifact: {
      ...state,
      wallet: {
        source,
        address: walletAddress,
      },
      paymentHookState: nextPaymentHookState,
      datum: {
        ...state.datum,
        paymentHookCbor: paymentHookDatumCbor,
      },
      transactions: appendTransactionRecord(state.transactions, {
        step: stepId("payment-hook:withdraw"),
        submittedTxHash,
        confirmed,
      }),
    },
    consumedOutRefs,
    producedUtxos,
    feePaidLovelace: feeLovelace,
  };
}

function reportProgress(message: string): void {
  console.error(`[payment-hook:withdraw] ${message}`);
}
