import path from "node:path";
import { stepId, getCliConfig } from "../core/config.js";

import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  hasCompletedStep,
  readConfigState,
  type ConfigStateArtifact,
  type ClientStateArtifact,
} from "../core/state.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { getNetworkNow } from "../core/network-time.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  findSingleUtxoAtUnit,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
  writeJsonFile,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertSettleManifestMatchesSingleClientReceiver,
  assertSettleReceiverAccruedPositive,
} from "../preflight/index.js";
import { buildSettleTx } from "../lib/transactions/build-settle.js";

type SettleResult = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  settledReceivers: Array<{
    clientId: string;
    receiverUnit: string;
    drainedLovelace: string;
  }>;
  totalSettledLovelace: string;
  transactions?: ConfigStateArtifact["transactions"];
};

export async function settleAccruedFees(args: {
  protocolStatePath: string;
  clientStatePath: string;
  buildOnly: boolean;
}): Promise<SettleResult> {
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const clientStatePath = path.resolve(args.clientStatePath);

  reportProgress(`Loading protocol state from ${protocolStatePath}`);
  const protocolState = await readConfigState(protocolStatePath);

  if (
    !protocolState.paymentHookState ||
    !protocolState.bootstrapRefs.paymentHook ||
    !hasCompletedStep(protocolState.transactions, stepId("payment-hook:bootstrap"))
  ) {
    throw new Error("Settle requires protocol state after PaymentHook bootstrap.");
  }

  reportProgress(`Loading client state from ${clientStatePath}`);
  const { client: clientState, protocol } = await readClientContext({
    clientStatePath,
    protocolStatePath,
  });

  if (!clientState.receiver) {
    throw new Error("Settle requires client state after Receiver bootstrap.");
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
    {
      unauthorizedMessage:
        "Settle requires a config signer. The configured wallet is not authorized.",
    },
  );

  // Fetch on-chain UTxOs
  const [currentConfigUtxo, currentReceiverUtxo, currentPaymentHookUtxo] =
    await Promise.all([
      findSingleUtxoAtUnit(
        lucid,
        protocol.scripts.configValidatorAddress,
        protocol.scripts.configUnit,
        "config",
      ),
      findSingleUtxoAtUnit(
        lucid,
        clientState.receiver.receiverValidatorAddress,
        clientState.receiver.receiverUnit,
        "receiver",
      ),
      findSingleUtxoAtUnit(
        lucid,
        protocol.scripts.paymentHookValidatorAddress!,
        protocol.scripts.paymentHookUnit!,
        "payment hook",
      ),
    ]);

  // Pre-flight: check accrued balance before handing off to the builder
  // (the builder also checks, but we want the CLI-specific error message here)
  const preflightAccrued = BigInt(
    clientState.receiver.receiverState?.accruedToHookLovelace ?? "0",
  );
  assertSettleReceiverAccruedPositive(
    preflightAccrued,
    clientState.receiver.receiverState?.accruedToHookLovelace ?? "0",
    clientState.receiver.receiverUnit,
  );

  assertSettleManifestMatchesSingleClientReceiver(
    [
      {
        receiverPolicyId: clientState.receiver.receiverPolicyId,
        receiverAssetName: clientState.receiver.receiverAssetName,
      },
    ],
    {
      receiverPolicyId: clientState.receiver.receiverPolicyId,
      receiverAssetName: clientState.receiver.receiverAssetName,
    },
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} settle transaction`);
  const networkNow = await getNetworkNow(lucid);

  const {
    txSignBuilder,
    accruedLovelace,
    nextReceiverState,
    nextPaymentHookState,
  } = await buildSettleTx(lucid, {
    networkNow,
    currentConfigUtxo,
    currentReceiverUtxo,
    currentPaymentHookUtxo,
    walletPaymentKeyHash: walletDefaults.paymentKeyHash,
    protocolState: protocol,
    clientState,
  });

  reportProgress(`Settling ${accruedLovelace} lovelace from receiver to payment hook`);
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
      label: "settle transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [],
      label: "settle",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  // --- Wait for UTxO replacement ---
  if (!args.buildOnly && confirmed) {
    await Promise.all([
      waitForUnitUtxoReplacement({
        lucid,
        address: clientState.receiver.receiverValidatorAddress,
        unit: clientState.receiver.receiverUnit,
        label: "receiver",
        previousOutRef: currentReceiverUtxo,
      }),
      waitForUnitUtxoReplacement({
        lucid,
        address: protocol.scripts.paymentHookValidatorAddress!,
        unit: protocol.scripts.paymentHookUnit!,
        label: "payment hook",
        previousOutRef: currentPaymentHookUtxo,
      }),
    ]);
  }

  // --- Persist updated state files ---
  if (!args.buildOnly && confirmed) {
    await writeJsonFile(protocolStatePath, {
      ...protocolState,
      wallet: { source, address: walletAddress },
      paymentHookState: nextPaymentHookState,
      datum: {
        ...protocolState.datum,
        paymentHookCbor: buildPaymentHookDatumCbor(nextPaymentHookState),
      },
      transactions: appendTransactionRecord(protocolState.transactions, {
        step: stepId("settle"),
        submittedTxHash,
        confirmed,
      }),
    });

      await writeJsonFile(clientStatePath, {
        ...clientState,
        wallet: { source, address: walletAddress },
        receiver: {
          ...clientState.receiver,
          receiverState: nextReceiverState,
        },
        datum: {
          ...clientState.datum,
        receiverCbor: buildReceiverDatumCbor(nextReceiverState),
      },
      transactions: appendTransactionRecord(clientState.transactions, {
        step: stepId("settle"),
        submittedTxHash,
        confirmed,
      }),
    });
  }

  return {
    wallet: { source, address: walletAddress },
    settledReceivers: [
      {
        clientId: clientState.clientId,
        receiverUnit: clientState.receiver.receiverUnit,
        drainedLovelace: accruedLovelace.toString(),
      },
    ],
    totalSettledLovelace: accruedLovelace.toString(),
    transactions: appendTransactionRecord(undefined, {
      step: stepId("settle"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[settle] ${message}`);
}
