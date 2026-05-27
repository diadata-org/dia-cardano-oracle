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
  readPairState,
  type ClientStateArtifact,
  type PairStateArtifact,
} from "../core/state.js";
import { isAnyReferenceScriptMissing, loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
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
  buildPairBurnRedeemer,
  buildPairMintBurnRedeemer,
} from "../core/redeemers.js";

import type { MintingPolicy, SpendingValidator, UTxO } from "@lucid-evolution/lucid";

// ---------------------------------------------------------------------------
// Shared burn primitive
// ---------------------------------------------------------------------------

/**
 * Build, sign, submit, and confirm the burn tx for one specific Pair UTxO.
 *
 * Used by both `pairBurn` (single named pair) and `pairDedup` (mass cleanup
 * of duplicate pair UTxOs found on-chain). Callers that already hold a
 * reference to the exact UTxO pass it here to bypass `findSingleUtxoAtUnit`.
 *
 * @returns the submitted txHash, or `undefined` when `buildOnly` is true.
 */
export async function burnSpecificPairUtxo(args: {
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>;
  wallet: { getUtxos(): Promise<UTxO[]> };
  walletUtxos: UTxO[];
  paymentKeyHash: string;
  configUtxo: UTxO;
  pairUtxo: UTxO;
  pairUnit: string;
  pairValidator: SpendingValidator;
  pairMintPolicy: MintingPolicy;
  client: ClientStateArtifact;
  buildOnly: boolean;
  label?: string;
}): Promise<string | undefined> {
  const { lucid, wallet, walletUtxos, paymentKeyHash, configUtxo, pairUtxo, pairUnit,
    pairValidator, pairMintPolicy, client, buildOnly, label = "pair burn" } = args;

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "pair",
          label: "pair_state spend",
          outRef: client.referenceScripts?.client?.pair
            ? {
                txHash: client.referenceScripts.client.pair.txHash,
                outputIndex: client.referenceScripts.client.pair.outputIndex,
              }
            : null,
        },
        {
          key: "pairMint",
          label: "pair mint",
          outRef: client.referenceScripts?.client?.pairMint
            ? {
                txHash: client.referenceScripts.client.pairMint.txHash,
                outputIndex: client.referenceScripts.client.pairMint.outputIndex,
              }
            : null,
        },
      ] as const,
      (msg) => console.error(`[${label}] ${msg}`),
    );

  let txBuilder = lucid
    .newTx()
    .readFrom([configUtxo])
    .collectFrom([pairUtxo], buildPairBurnRedeemer())
    .mintAssets({ [pairUnit]: -1n }, buildPairMintBurnRedeemer())
    .addSignerKey(paymentKeyHash);

  if (isAnyReferenceScriptMissing(missingReferenceScripts)) {
    if (missingReferenceScripts.pair) {
      txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
    }
    if (missingReferenceScripts.pairMint) {
      txBuilder = txBuilder.attach.MintingPolicy(pairMintPolicy);
    }
  }
  txBuilder = txBuilder.readFrom(referenceScriptUtxos);

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, (msg) => console.error(`[${label}] ${msg}`));
  logEffectiveOutputs(txSignBuilder, (msg) => console.error(`[${label}] ${msg}`));

  if (buildOnly) {
    console.error(`[${label}] Build-only: unsigned hash = ${txSignBuilder.toHash()}`);
    return undefined;
  }

  const signedTx = await txSignBuilder.sign.withWallet().complete();
  const submittedTxHash = await signedTx.submit();
  console.error(`[${label}] Submitted: ${submittedTxHash}`);

  const confirmed = await awaitTxConfirmation({
    lucid,
    txHash: submittedTxHash,
    reportProgress: (msg) => console.error(`[${label}] ${msg}`),
    label,
  });

  if (!confirmed) {
    throw new Error(`Transaction ${submittedTxHash} was submitted but confirmation was not observed.`);
  }

  await waitForWalletSettlement({
    wallet,
    previousUtxos: walletUtxos,
    spentUtxos: [pairUtxo],
    label,
    requireChangeWhenNoSpentUtxos: false,
  });

  await waitForOutRefGone({ lucid, outRef: pairUtxo, label: "pair" });

  return submittedTxHash;
}

// ---------------------------------------------------------------------------
// High-level command
// ---------------------------------------------------------------------------

/**
 * Burns the Pair NFT of an existing pair and recovers the locked min-ADA
 * back to the admin wallet. Two redeemers fire in lockstep:
 *
 *   - `pair_state.spend(BurnPair)` consumes the Pair UTxO with no
 *     continuation output.
 *   - `pair_state.mint(BurnPairs)` burns the matching Pair NFT (quantity
 *     `-1`).
 *
 * Both validators require a `config_admins` signature, so the tx is
 * admin-gated end-to-end. There is no coordinator interaction on this
 * path — no oracle update is being applied.
 *
 * Once confirmed, the on-chain Pair NFT supply for `pair_token_name`
 * drops to zero. A future `update` for the same symbol will
 * mint a fresh Pair NFT under `MintPairs`, which is itself admin-gated
 * and replay-protected by `PairDatum.nonce`.
 */
export async function pairBurn(args: {
  protocolStatePath: string;
  clientStatePath: string;
  pairStatePath: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress("Loading protocol, client and pair state");
  const protocol = await readConfigState(path.resolve(args.protocolStatePath));
  const client = await readClientState(path.resolve(args.clientStatePath));
  const pair = await readPairState(path.resolve(args.pairStatePath));

  if (!pair.pairState) {
    throw new Error("Pair state does not have pairState. Nothing to burn.");
  }
  if (!client.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run client:init first.");
  }
  if (!client.compiledScripts?.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run client:init first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
  const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);

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
        "Pair burn requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    configUtxo.address,
    protocol.scripts.configValidatorAddress,
  );

  reportProgress("Finding Pair UTxO");
  const pairUnit = pair.pair.pairUnit;
  const pairValidatorAddress = pair.pair.pairValidatorAddress;
  const currentPairUtxo = await findSingleUtxoAtUnit(
    lucid,
    pairValidatorAddress,
    pairUnit,
    "pair",
  );

  reportProgress(`Burning Pair NFT ${pairUnit} and recovering ${currentPairUtxo.assets.lovelace} lovelace.`);

  const submittedTxHash = await burnSpecificPairUtxo({
    lucid,
    wallet,
    walletUtxos,
    paymentKeyHash: walletDefaults.paymentKeyHash,
    configUtxo,
    pairUtxo: currentPairUtxo,
    pairUnit,
    pairValidator,
    pairMintPolicy,
    client,
    buildOnly: args.buildOnly,
    label: "pair:burn",
  });

  // The on-chain Pair UTxO is destroyed. We keep `pairState` in the
  // artifact for audit (last-known price/timestamp/nonce) and clear
  // `datum.pairCbor` so no off-chain caller mistakenly re-submits the
  // stale datum. A subsequent `update` for the same symbol
  // will mint a fresh Pair NFT under `MintPairs` (admin-gated) and
  // rebuild `pairState` from a new signed intent.
  const burnedPair: PairStateArtifact = {
    ...pair,
    datum: { pairCbor: "" },
    transactions: appendTransactionRecord(pair.transactions, {
      step: stepId("pair:burn"),
      submittedTxHash: submittedTxHash ?? null,
      confirmed: submittedTxHash != null,
    }),
  };

  return burnedPair;
}

function reportProgress(message: string): void {
  console.error(`[pair:burn] ${message}`);
}
