// Admin-gated teardown for the singleton Config: burns the Config NFT and
// recovers the UTxO's locked min-ADA back to the admin wallet in one tx
// (spend + mint Burn redeemers fire in lockstep). This is the LAST teardown
// step of a full decommission — every receiver, pair, and the payment-hook
// must already be burned, since they reference the Config.
//
// No drain precondition: Config carries no value-bearing datum field beyond
// its min-ADA, so unlike receiver/payment-hook there is nothing to withdraw
// before burning.
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
  findSingleUtxoAtUnit,
  waitForOutRefGone,
  waitForWalletSettlement,
} from "../core/chain-helpers.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertConfigUtxoLivesAtValidatorAddress,
} from "../preflight/index.js";
import {
  buildConfigBurnSpendRedeemer,
  buildSingletonMintBurnRedeemer,
} from "../core/redeemers.js";

/**
 * Burns the singleton Config NFT and recovers the locked min-ADA back to the
 * admin wallet. This is the LAST teardown step of a full decommission. Two
 * redeemers fire in lockstep, mirroring `pair:burn`:
 *
 *   - `config_state.spend(Burn)` consumes the Config UTxO with no
 *     continuation output carrying the NFT.
 *   - `config_state.mint(Burn)` burns the Config NFT (quantity `-1`). The
 *     mint policy reads the config datum from the Config INPUT (the UTxO
 *     being spent), not a reference input.
 *
 * Both sides require a `config_admins` signature, so the tx is admin-gated
 * end-to-end. Config carries no value-bearing datum field beyond the
 * min-ADA, so unlike receiver/payment-hook there is no drain precondition.
 */
export async function configBurn(args: {
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<ConfigStateArtifact> {
  reportProgress("Loading protocol state");
  const state = await readConfigState(path.resolve(args.protocolStatePath));

  if (!state.scripts.configUnit) {
    throw new Error("Config burn requires a state artifact produced after config bootstrap. Nothing to burn.");
  }
  if (!state.compiledScripts?.configValidator) {
    throw new Error("configValidator compiled script not found. Run config:parameterize first.");
  }
  if (!state.compiledScripts?.configMintPolicy) {
    throw new Error("configMintPolicy compiled script not found. Run config:parameterize first.");
  }
  const configValidator = spendingValidatorFromCompiledScript(state.compiledScripts.configValidator);
  const configMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.configMintPolicy);

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
        "Config burn requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUnit = state.scripts.configUnit;
  const configValidatorAddress = state.scripts.configValidatorAddress;
  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    configValidatorAddress,
    configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    currentConfigUtxo.address,
    configValidatorAddress,
  );

  reportProgress(
    `Burning Config NFT ${configUnit} and recovering ${currentConfigUtxo.assets.lovelace} lovelace.`,
  );

  // The Config NFT is spent (collectFrom), so the mint policy reads the
  // config datum from the input. No `readFrom([configUtxo])` here — the
  // Config UTxO is the spend input, not a reference input.
  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "config",
          label: "config",
          outRef: state.referenceScripts?.global?.config
            ? {
                txHash: state.referenceScripts.global.config.txHash,
                outputIndex: state.referenceScripts.global.config.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  // The config spend and mint share the same compiled script (the policy id
  // IS the validator hash), so a single missing reference script means we
  // must attach both the spending validator and the minting policy inline.
  const referenceScriptMissing = isAnyReferenceScriptMissing(missingReferenceScripts);
  if (referenceScriptMissing) {
    reportProgress(
      "Reference script for config is missing on-chain; attaching the config validator and mint policy inline.",
    );
  }

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .collectFrom([currentConfigUtxo], buildConfigBurnSpendRedeemer())
      .mintAssets({ [configUnit]: -1n }, buildSingletonMintBurnRedeemer())
      .addSignerKey(walletDefaults.paymentKeyHash);
    if (referenceScriptMissing) {
      txBuilder = txBuilder
        .attach.SpendingValidator(configValidator)
        .attach.MintingPolicy(configMintPolicy);
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
      label: "config burn transaction",
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
      label: "config burn",
    });

    await waitForOutRefGone({
      lucid,
      outRef: currentConfigUtxo,
      label: "config",
      txHash: submittedTxHash,
    });
  }

  // The on-chain Config UTxO is destroyed and its NFT supply is now zero.
  // Clear the cached config datum CBOR so no off-chain caller re-submits
  // stale state pointing at a burned UTxO.
  const burnedState: ConfigStateArtifact = {
    ...state,
    wallet: { source, address: walletAddress },
    datum: { ...state.datum, configCbor: "" },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("config:burn"),
      submittedTxHash,
      confirmed,
    }),
  };

  return burnedState;
}

function reportProgress(message: string): void {
  console.error(`[config:burn] ${message}`);
}
