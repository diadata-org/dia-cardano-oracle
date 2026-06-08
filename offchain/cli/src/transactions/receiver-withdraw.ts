import path from "node:path";
import { stepId, getCliConfig} from "../core/config.js";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
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
  getDefaultClientStatePath,
  type ClientStateArtifact,
} from "../core/state.js";
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { completeWithRetry } from "../core/tx-build.js";
import { readClientContext } from "../core/artifact-context.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  addressToPlutusData,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertReceiverWithdrawAmountPositive,
  assertReceiverWithdrawAmountValid,
} from "../preflight/index.js";

export { assertReceiverWithdrawAmountValid } from "../preflight/index.js";

export async function receiverWithdraw(args: {
  amountLovelace: string;
  recipientAddress?: string;
  statePath?: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress(`Using amountLovelace=${args.amountLovelace} for receiver withdraw`);
  const statePath = path.resolve(args.statePath ?? getDefaultClientStatePath());
  reportProgress(`Loading client state from ${statePath}`);
  const { client: state, protocol } = await readClientContext({
    clientStatePath: statePath,
    protocolStatePath: args.protocolStatePath,
  });

  if (!state.receiver) {
    throw new Error("Receiver withdraw requires a client state artifact produced by receiver bootstrap.");
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
  );

  const [currentConfigUtxo, currentReceiverUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      protocol.scripts.configValidatorAddress,
      protocol.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      state.receiver.receiverValidatorAddress,
      state.receiver.receiverUnit,
      "receiver",
    ),
  ]);
  if (!state.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);

  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  assertReceiverWithdrawAmountPositive(amountLovelace);
  const recipientAddress = args.recipientAddress?.trim().length
    ? args.recipientAddress.trim()
    : walletAddress;
  const currentReceiverState =
    currentReceiverUtxo.datum
      ? decodeReceiverDatum(currentReceiverUtxo.datum)
      : state.receiver.receiverState;
  assertReceiverWithdrawAmountValid(
    amountLovelace,
    BigInt(currentReceiverState.balanceLovelace),
  );

  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - amountLovelace
    ).toString(),
  };

  const receiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);
  const withdrawRedeemer = Data.to(
    new Constr<PlutusData>(3, [
      amountLovelace,
      addressToPlutusData(recipientAddress),
    ]),
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} receiver withdraw transaction`);
  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "receiver",
          label: "receiver",
          outRef: state.referenceScripts?.client?.receiver
            ? {
                txHash: state.referenceScripts.client.receiver.txHash,
                outputIndex: state.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  const referenceScriptMissing = isAnyReferenceScriptMissing(missingReferenceScript);
  if (referenceScriptMissing) {
    reportProgress(
      "Reference script for receiver is missing on-chain; attaching the receiver validator inline.",
    );
  }

  const receiver = state.receiver;
  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .readFrom([currentConfigUtxo, ...referenceScriptUtxos])
      .collectFrom([currentReceiverUtxo], withdrawRedeemer)
      .addSignerKey(walletDefaults.paymentKeyHash)
      .pay.ToContract(
        receiver.receiverValidatorAddress,
        { kind: "inline", value: receiverDatumCbor },
        {
          lovelace:
            BigInt(nextReceiverState.minUtxoLovelace) +
            BigInt(nextReceiverState.balanceLovelace) +
            BigInt(nextReceiverState.accruedToHookLovelace),
          [receiver.receiverUnit]: 1n,
        },
      )
      .pay.ToAddress(recipientAddress, { lovelace: amountLovelace });
    if (referenceScriptMissing) {
      txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
    }
    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx, reportProgress);
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();
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
      label: "receiver withdraw transaction",
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
      label: "receiver withdraw",
    });
  }

  if (!args.buildOnly && confirmed) {
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.receiver.receiverValidatorAddress,
      unit: state.receiver.receiverUnit,
      label: "receiver",
      previousOutRef: currentReceiverUtxo,
    });
  }

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    receiver: {
      ...state.receiver,
      receiverState: nextReceiverState,
    },
    datum: {
      ...state.datum,
      receiverCbor: receiverDatumCbor,
    },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("receiver:withdraw"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[receiver:withdraw] ${message}`);
}
