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
  computeSpentWalletOutRefs,
  computeWalletChangeOutputs,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
  writeJsonFile,
  type WalletChangeUtxo,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertSettleManifestMatchesClientReceivers,
  assertSettleReceiverAccruedPositive,
} from "../preflight/index.js";
import {
  buildSettleTx,
  type SettleClientInput,
} from "../lib/transactions/build-settle.js";

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
  /** Wallet inputs the tx spent + change produced — the arbiter's cache delta
   *  (only meaningful on the arbitrated `reservedOutRefs` path). */
  consumedOutRefs: string[];
  producedUtxos: WalletChangeUtxo[];
};

/**
 * Drain the accrued fees of one or more client Receivers into the shared
 * payment hook in a single transaction.
 *
 * `clientStatePaths` lists every client whose Receiver is settled in this tx
 * (>= 1). The on-chain coordinator validates the resulting `SettleManifest`
 * for non-empty + unique receivers whose drained sum equals the payment-hook
 * accrued delta; this off-chain path mirrors that by loading each client,
 * fetching its Receiver UTxO, summing the accrued, and building one
 * multi-receiver transaction. Each settled client state is persisted with its
 * accrued cleared, and the protocol state is persisted with the hook credited
 * the total.
 */
export async function settleAccruedFees(args: {
  protocolStatePath: string;
  clientStatePaths: string[];
  buildOnly: boolean;
  /** Arbitrated path (feeder): pin the wallet's fee/collateral coin selection to
   *  these already-reserved out-refs so the settle never draws a UTxO another
   *  lane reserved. The manual command omits it (uses the whole wallet). */
  reservedOutRefs?: string[];
}): Promise<SettleResult> {
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const clientStatePaths = args.clientStatePaths.map((p) => path.resolve(p));

  if (clientStatePaths.length === 0) {
    throw new Error("Settle requires at least one --client-state.");
  }
  const uniquePaths = new Set(clientStatePaths);
  if (uniquePaths.size !== clientStatePaths.length) {
    throw new Error("Settle received the same --client-state more than once.");
  }

  reportProgress(`Loading protocol state from ${protocolStatePath}`);
  const protocolState = await readConfigState(protocolStatePath);

  if (
    !protocolState.paymentHookState ||
    !protocolState.bootstrapRefs.paymentHook ||
    !hasCompletedStep(protocolState.transactions, stepId("payment-hook:bootstrap"))
  ) {
    throw new Error("Settle requires protocol state after PaymentHook bootstrap.");
  }

  reportProgress(
    `Loading ${clientStatePaths.length} client state${clientStatePaths.length === 1 ? "" : "s"}`,
  );
  const clientContexts = await Promise.all(
    clientStatePaths.map(async (clientStatePath) => {
      const { client: clientState, protocol } = await readClientContext({
        clientStatePath,
        protocolStatePath,
      });
      if (!clientState.receiver) {
        throw new Error(
          `Settle requires client state after Receiver bootstrap (${clientStatePath}).`,
        );
      }
      return { clientStatePath, clientState, protocol };
    }),
  );
  // Every client is validated against the same protocol state file; use the
  // first one's resolved protocol view for shared scripts / config.
  const protocol = clientContexts[0]!.protocol;

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  // Arbitrated path: pin coin selection to the reserved fee/collateral UTxOs so
  // the settle never draws an input another lane holds. The script inputs
  // (Receiver / Config / PaymentHook) are collected explicitly, so the pin only
  // constrains the wallet's fee + collateral pick. Cleared after the build.
  if (args.reservedOutRefs) {
    const reserved = new Set(args.reservedOutRefs);
    const pinned = walletUtxos.filter((u) => reserved.has(`${u.txHash}#${u.outputIndex}`));
    if (pinned.length < args.reservedOutRefs.length) {
      throw new Error("settle: a reserved wallet UTxO is no longer live.");
    }
    lucid.overrideUTxOs(pinned);
  }
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
    {
      unauthorizedMessage:
        "Settle requires a config signer. The configured wallet is not authorized.",
    },
  );

  // Fetch on-chain UTxOs: the shared config + payment hook once, and each
  // client's Receiver UTxO.
  const [currentConfigUtxo, currentPaymentHookUtxo] = await Promise.all([
    findSingleUtxoAtUnit(
      lucid,
      protocol.scripts.configValidatorAddress,
      protocol.scripts.configUnit,
      "config",
    ),
    findSingleUtxoAtUnit(
      lucid,
      protocol.scripts.paymentHookValidatorAddress!,
      protocol.scripts.paymentHookUnit!,
      "payment hook",
    ),
  ]);

  const settleClients: Array<
    SettleClientInput & { clientStatePath: string }
  > = await Promise.all(
    clientContexts.map(async ({ clientStatePath, clientState }) => {
      const currentReceiverUtxo = await findSingleUtxoAtUnit(
        lucid,
        clientState.receiver!.receiverValidatorAddress,
        clientState.receiver!.receiverUnit,
        `receiver ${clientState.clientId}`,
      );
      return { clientStatePath, clientState, currentReceiverUtxo };
    }),
  );

  // Pre-flight: each receiver must have accrued > 0 (the builder also checks,
  // but we want the CLI-specific error message here), and the total must be
  // positive across all receivers. Accrued is read from the on-chain Receiver
  // datum (the authoritative value) rather than the client state file, which
  // can lag after a single oracle update that does not rewrite the client
  // receiver state.
  let totalAccruedPreflight = 0n;
  for (const { clientState, currentReceiverUtxo } of settleClients) {
    const onChainReceiverState = decodeReceiverDatum(
      requireInlineDatum(currentReceiverUtxo, `receiver ${clientState.clientId}`),
    );
    const accrued = BigInt(onChainReceiverState.accruedToHookLovelace);
    assertSettleReceiverAccruedPositive(
      accrued,
      onChainReceiverState.accruedToHookLovelace,
      clientState.receiver!.receiverUnit,
    );
    totalAccruedPreflight += accrued;
  }
  if (totalAccruedPreflight <= 0n) {
    throw new Error("Nothing to settle: total accrued across receivers is zero.");
  }

  // Pre-flight: the coordinator manifest we are about to build must be
  // non-empty, unique, and 1:1 with the loaded client receivers.
  assertSettleManifestMatchesClientReceivers(
    settleClients.map(({ clientState }) => ({
      receiverPolicyId: clientState.receiver!.receiverPolicyId,
      receiverAssetName: clientState.receiver!.receiverAssetName,
    })),
    settleClients.map(({ clientState }) => ({
      receiverPolicyId: clientState.receiver!.receiverPolicyId,
      receiverAssetName: clientState.receiver!.receiverAssetName,
    })),
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} settle transaction`);
  const networkNow = await getNetworkNow(lucid);

  const { txSignBuilder, totalAccruedLovelace, receivers, nextPaymentHookState } =
    await buildSettleTx(lucid, {
      networkNow,
      currentConfigUtxo,
      currentPaymentHookUtxo,
      walletPaymentKeyHash: walletDefaults.paymentKeyHash,
      protocolState: protocol,
      clients: settleClients.map(({ clientState, currentReceiverUtxo }) => ({
        clientState,
        currentReceiverUtxo,
      })),
    });

  reportProgress(
    `Settling ${totalAccruedLovelace} lovelace from ${receivers.length} receiver${
      receivers.length === 1 ? "" : "s"
    } to payment hook`,
  );
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
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
      transaction: txSignBuilder,
      label: "settle",
    });
  }

  // --- Wait for UTxO replacement (each receiver + the hook) ---
  if (!args.buildOnly && confirmed) {
    await Promise.all([
      ...settleClients.map(({ clientState, currentReceiverUtxo }) =>
        waitForUnitUtxoReplacement({
          lucid,
          address: clientState.receiver!.receiverValidatorAddress,
          unit: clientState.receiver!.receiverUnit,
          label: `receiver ${clientState.clientId}`,
          previousOutRef: currentReceiverUtxo,
        }),
      ),
      waitForUnitUtxoReplacement({
        lucid,
        address: protocol.scripts.paymentHookValidatorAddress!,
        unit: protocol.scripts.paymentHookUnit!,
        label: "payment hook",
        previousOutRef: currentPaymentHookUtxo,
      }),
    ]);
  }

  // --- Persist updated state files (protocol + each client) ---
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

    await Promise.all(
      receivers.map((entry, index) => {
        const { clientStatePath, clientState } = settleClients[index]!;
        return writeJsonFile(clientStatePath, {
          ...clientState,
          wallet: { source, address: walletAddress },
          receiver: {
            ...clientState.receiver!,
            receiverState: entry.nextReceiverState,
          },
          datum: {
            ...clientState.datum,
            receiverCbor: buildReceiverDatumCbor(entry.nextReceiverState),
          },
          transactions: appendTransactionRecord(clientState.transactions, {
            step: stepId("settle"),
            submittedTxHash,
            confirmed,
          }),
        });
      }),
    );
  }

  return {
    wallet: { source, address: walletAddress },
    settledReceivers: receivers.map((entry) => ({
      clientId: entry.clientState.clientId,
      receiverUnit: entry.receiver.receiverUnit,
      drainedLovelace: entry.accruedLovelace.toString(),
    })),
    totalSettledLovelace: totalAccruedLovelace.toString(),
    transactions: appendTransactionRecord(undefined, {
      step: stepId("settle"),
      submittedTxHash,
      confirmed,
    }),
    consumedOutRefs,
    producedUtxos,
  };
}

function reportProgress(message: string): void {
  console.error(`[settle] ${message}`);
}
