// Admin-gated teardown for a single client's Receiver: burns the Receiver NFT
// and recovers the UTxO's locked min-ADA back to the admin wallet in one tx
// (spend + mint Burn redeemers fire in lockstep).
//
// Precondition: the Receiver datum must be fully drained — `balance_lovelace ==
// 0 && accrued_to_hook_lovelace == 0`. The on-chain spend rejects a non-zero
// datum, so we check it up front to fail fast instead of paying for a tx the
// validator would reject. Drain first with `receiver:withdraw` (returns the
// client's balance) then `settle` (sweeps accrued fees to the hook).
//
// Requires a config signer: both redeemers demand a `config_admins` signature,
// so the wallet must be a configured admin.

import path from "node:path";
import { stepId, getCliConfig } from "../core/config.js";

import {
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  readClientState,
  readConfigState,
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
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  waitForOutRefGone,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { assertPaymentKeyHashIsConfigSigner } from "../preflight/index.js";
import {
  buildReceiverBurnSpendRedeemer,
  buildSingletonMintBurnRedeemer,
} from "../core/redeemers.js";

/**
 * Burns a client's Receiver NFT and recovers the locked min-ADA back to the
 * admin wallet. Two redeemers fire in lockstep, mirroring `pair:burn`:
 *
 *   - `receiver.spend(Burn)` consumes the Receiver UTxO with no
 *     continuation output carrying the NFT.
 *   - `receiver.mint(Burn)` burns the matching Receiver NFT (quantity `-1`).
 *
 * Both sides require a `config_admins` signature, so the tx is admin-gated
 * end-to-end. The on-chain spend additionally forbids any continuation
 * output that carries the NFT and requires the datum value fields to be
 * zeroed (`balance_lovelace == 0 && accrued_to_hook_lovelace == 0`). We
 * enforce that precondition up front with a clear error so the operator is
 * told to drain first (run `receiver:withdraw` then `settle`) instead of
 * paying for a tx the validator would reject.
 */
export async function receiverBurn(args: {
  protocolStatePath: string;
  clientStatePath: string;
  buildOnly: boolean;
}): Promise<ClientStateArtifact> {
  reportProgress("Loading protocol and client state");
  const protocol = await readConfigState(path.resolve(args.protocolStatePath));
  const client = await readClientState(path.resolve(args.clientStatePath));

  if (!client.receiver) {
    throw new Error("Receiver burn requires a client state artifact produced by receiver bootstrap. Nothing to burn.");
  }
  if (!client.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  if (!client.compiledScripts?.receiverMintPolicy) {
    throw new Error("receiverMintPolicy compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(client.compiledScripts.receiverValidator);
  const receiverMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.receiverMintPolicy);

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
        "Receiver burn requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );

  reportProgress("Finding Receiver UTxO");
  const receiverUnit = client.receiver.receiverUnit;
  const receiverValidatorAddress = client.receiver.receiverValidatorAddress;
  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    receiverValidatorAddress,
    receiverUnit,
    "receiver",
  );

  // Precondition (enforced before building): the on-chain spend `Burn`
  // rejects any UTxO with non-zero value fields, so burn can never be a
  // backdoor around the client withdraw or the fee settle. Read the live
  // datum so the guard reflects on-chain state, not stale artifact state.
  const liveReceiverState = decodeReceiverDatum(
    requireInlineDatum(currentReceiverUtxo, "receiver"),
  );
  const balanceLovelace = BigInt(liveReceiverState.balanceLovelace);
  const accruedToHookLovelace = BigInt(liveReceiverState.accruedToHookLovelace);
  if (balanceLovelace !== 0n || accruedToHookLovelace !== 0n) {
    throw new Error(
      `Receiver burn requires a fully-drained Receiver: balance_lovelace == 0 && accrued_to_hook_lovelace == 0 ` +
        `(found balance=${balanceLovelace}, accrued=${accruedToHookLovelace}). ` +
        `Run receiver:withdraw to drain the balance to 0, then settle to flush accrued fees to the payment hook, before burning.`,
    );
  }

  reportProgress(
    `Burning Receiver NFT ${receiverUnit} and recovering ${currentReceiverUtxo.assets.lovelace} lovelace.`,
  );

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "receiver",
          label: "receiver",
          outRef: client.referenceScripts?.client?.receiver
            ? {
                txHash: client.referenceScripts.client.receiver.txHash,
                outputIndex: client.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  // The receiver spend and mint share the same compiled script (the policy
  // id IS the validator hash), so a single missing reference script means we
  // must attach both the spending validator and the minting policy inline.
  const referenceScriptMissing = isAnyReferenceScriptMissing(missingReferenceScripts);
  if (referenceScriptMissing) {
    reportProgress(
      "Reference script for receiver is missing on-chain; attaching the receiver validator and mint policy inline.",
    );
  }

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .readFrom([configUtxo])
      .collectFrom([currentReceiverUtxo], buildReceiverBurnSpendRedeemer())
      .mintAssets({ [receiverUnit]: -1n }, buildSingletonMintBurnRedeemer())
      .addSignerKey(walletDefaults.paymentKeyHash);
    if (referenceScriptMissing) {
      txBuilder = txBuilder
        .attach.SpendingValidator(receiverValidator)
        .attach.MintingPolicy(receiverMintPolicy);
    }
    if (referenceScriptUtxos.length > 0) {
      txBuilder = txBuilder.readFrom(referenceScriptUtxos);
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
      label: "receiver burn transaction",
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
      label: "receiver burn",
    });

    await waitForOutRefGone({
      lucid,
      outRef: currentReceiverUtxo,
      label: "receiver",
      txHash: submittedTxHash,
    });
  }

  // The on-chain Receiver UTxO is destroyed and its NFT supply is now zero.
  // Clear the live `receiver` coordinates and the cached datum CBOR so no
  // off-chain caller re-submits stale state pointing at a burned UTxO.
  const { receiver: _removedReceiver, ...clientWithoutReceiver } = client;
  void _removedReceiver;
  const burnedClient: ClientStateArtifact = {
    ...clientWithoutReceiver,
    datum: { ...client.datum, receiverCbor: "" },
    transactions: appendTransactionRecord(client.transactions, {
      step: stepId("receiver:burn"),
      submittedTxHash,
      confirmed,
    }),
  };

  return burnedClient;
}

function reportProgress(message: string): void {
  console.error(`[receiver:burn] ${message}`);
}
