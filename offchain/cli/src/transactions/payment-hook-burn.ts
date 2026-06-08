// Admin-gated teardown for the global PaymentHook: burns the PaymentHook NFT
// and recovers the UTxO's locked min-ADA back to the admin wallet in one tx
// (spend + mint Burn redeemers fire in lockstep).
//
// Precondition: the hook datum must be fully drained — `accrued_fees_lovelace
// == 0`. The on-chain spend rejects a non-zero balance, so we check it up
// front to fail fast instead of paying for a tx the validator would reject.
// Drain first with `payment-hook:withdraw` (sends accrued fees to the
// withdraw address).
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
  decodePaymentHookDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  waitForOutRefGone,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import { assertPaymentKeyHashIsConfigSigner } from "../preflight/index.js";
import {
  buildPaymentHookBurnSpendRedeemer,
  buildSingletonMintBurnRedeemer,
} from "../core/redeemers.js";

/**
 * Burns the global PaymentHook NFT and recovers the locked min-ADA back to
 * the admin wallet. Two redeemers fire in lockstep, mirroring `pair:burn`:
 *
 *   - `payment_hook.spend(Burn)` consumes the PaymentHook UTxO with no
 *     continuation output carrying the NFT.
 *   - `payment_hook.mint(Burn)` burns the matching Hook NFT (quantity `-1`).
 *
 * Both sides require a `config_admins` signature, so the tx is admin-gated
 * end-to-end. The on-chain spend additionally forbids any continuation
 * output carrying the NFT and requires `accrued_fees_lovelace == 0`. We
 * enforce that precondition up front with a clear error so the operator is
 * told to drain first (run `payment-hook:withdraw`) instead of paying for a
 * tx the validator would reject.
 */
export async function paymentHookBurn(args: {
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress("Loading protocol state");
  const state = await readConfigState(path.resolve(args.protocolStatePath));

  if (!state.paymentHookState || !state.scripts.paymentHookUnit || !state.scripts.paymentHookValidatorAddress) {
    throw new Error("Payment-hook burn requires a state artifact produced after payment-hook bootstrap. Nothing to burn.");
  }
  if (!state.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found. Run payment-hook:parameterize first.");
  }
  if (!state.compiledScripts?.paymentHookMintPolicy) {
    throw new Error("paymentHookMintPolicy compiled script not found. Run payment-hook:parameterize first.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(state.compiledScripts.paymentHookValidator);
  const paymentHookMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.paymentHookMintPolicy);

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
    state.configState.validConfigSigners,
    {
      unauthorizedMessage:
        "Payment-hook burn requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );

  reportProgress("Finding PaymentHook UTxO");
  const paymentHookUnit = state.scripts.paymentHookUnit;
  const paymentHookValidatorAddress = state.scripts.paymentHookValidatorAddress;
  const currentPaymentHookUtxo = await findSingleUtxoAtUnit(
    lucid,
    paymentHookValidatorAddress,
    paymentHookUnit,
    "payment hook",
  );

  // Precondition (enforced before building): the on-chain spend `Burn`
  // rejects any UTxO with non-zero accrued fees, so burn can never be a
  // backdoor around the payment-hook withdraw. Read the live datum so the
  // guard reflects on-chain state, not stale artifact state.
  const liveHookState = decodePaymentHookDatum(
    requireInlineDatum(currentPaymentHookUtxo, "payment hook"),
    state.paymentHookState.withdrawAddress,
  );
  const accruedFeesLovelace = BigInt(liveHookState.accruedFeesLovelace);
  if (accruedFeesLovelace !== 0n) {
    throw new Error(
      `Payment-hook burn requires a fully-drained hook: accrued_fees_lovelace == 0 (found ${accruedFeesLovelace}). ` +
        `Run payment-hook:withdraw to drain accrued fees to the withdraw address before burning.`,
    );
  }

  reportProgress(
    `Burning PaymentHook NFT ${paymentHookUnit} and recovering ${currentPaymentHookUtxo.assets.lovelace} lovelace.`,
  );

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
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

  // The hook spend and mint share the same compiled script (the policy id IS
  // the validator hash), so a single missing reference script means we must
  // attach both the spending validator and the minting policy inline.
  const referenceScriptMissing = isAnyReferenceScriptMissing(missingReferenceScripts);
  if (referenceScriptMissing) {
    reportProgress(
      "Reference script for payment hook is missing on-chain; attaching the payment hook validator and mint policy inline.",
    );
  }

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .readFrom([configUtxo])
      .collectFrom([currentPaymentHookUtxo], buildPaymentHookBurnSpendRedeemer())
      .mintAssets({ [paymentHookUnit]: -1n }, buildSingletonMintBurnRedeemer())
      .addSignerKey(walletDefaults.paymentKeyHash);
    if (referenceScriptMissing) {
      txBuilder = txBuilder
        .attach.SpendingValidator(paymentHookValidator)
        .attach.MintingPolicy(paymentHookMintPolicy);
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
      label: "payment-hook burn transaction",
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
      label: "payment-hook burn",
    });

    await waitForOutRefGone({
      lucid,
      outRef: currentPaymentHookUtxo,
      label: "payment hook",
      txHash: submittedTxHash,
    });
  }

  // The on-chain PaymentHook UTxO is destroyed and its NFT supply is now
  // zero. Clear the live hook state + cached datum CBOR so no off-chain
  // caller re-submits stale state pointing at a burned UTxO. We keep the
  // `paymentHookRef` in `configState` untouched: tearing down the hook
  // happens as part of a full decommission where `config:burn` follows.
  const burnedState: ConfigStateArtifact = {
    ...state,
    wallet: { source, address: walletAddress },
    paymentHookState: null,
    datum: { ...state.datum, paymentHookCbor: "" },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("payment-hook:burn"),
      submittedTxHash,
      confirmed,
    }),
  };

  return burnedState;
}

function reportProgress(message: string): void {
  console.error(`[payment-hook:burn] ${message}`);
}
