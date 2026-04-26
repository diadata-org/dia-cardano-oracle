import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makePaymentHookMintingPolicy,
  makePaymentHookValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  buildPaymentHookDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import { normalizeHex } from "../core/dia-intent.js";

type PaymentHookParameterizeInput = {
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  paymentHookAssetName: string;
  withdrawAddress?: string;
  minUtxoLovelace: string;
};

export async function parameterizePaymentHookScripts(args: {
  inputPath: string;
  statePath?: string;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading payment-hook parameterization input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const configuredBootstrapRef = input.bootstrapRef ?? state.bootstrapRefs.paymentHook ?? undefined;
  const selectedBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "payment-hook bootstrap")
    : selectBootstrapUtxo(walletUtxos, 0n, [state.bootstrapRefs.config]);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for payment-hook script parameterization. Inspect the wallet with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const paymentHookBootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Using wallet bootstrap UTxO ${paymentHookBootstrapRef.txHash}#${paymentHookBootstrapRef.outputIndex}`,
  );
  reportProgress("Deriving parameterized PaymentHook scripts offline");
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const paymentHookAssetName = normalizeHex(input.paymentHookAssetName, "paymentHookAssetName");
  const paymentHookMintPolicy = await makePaymentHookMintingPolicy({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookPolicyId = policyIdFromMintingPolicy(paymentHookMintPolicy);
  const paymentHookUnit = `${paymentHookPolicyId}${paymentHookAssetName}`;
  const paymentHookValidator = await makePaymentHookValidator({
    bootstrapOutRef: paymentHookBootstrapRef,
    assetName: paymentHookAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    coordinatorCredentialHash: state.scripts.coordinatorHash,
  });
  const paymentHookState = {
    withdrawAddress: input.withdrawAddress?.trim().length
      ? input.withdrawAddress.trim()
      : walletAddress,
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    bootstrapRefs: {
      ...state.bootstrapRefs,
      paymentHook: paymentHookBootstrapRef,
    },
    scripts: {
      ...state.scripts,
      paymentHookPolicyId,
      paymentHookUnit,
      paymentHookValidatorHash: scriptHashFromValidator(paymentHookValidator),
      paymentHookValidatorAddress: scriptAddressFromValidator(paymentHookValidator),
    },
    paymentHookState,
    paymentHookUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    datum: {
      ...state.datum,
      paymentHookCbor: buildPaymentHookDatumCbor(paymentHookState),
      receiverCbor: state.datum.receiverCbor,
    },
    transaction: undefined,
  };
}

async function readInput(inputPath: string): Promise<PaymentHookParameterizeInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PaymentHookParameterizeInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:payment-hook:parameterize] ${message}`);
}
