import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makePairStateMintingPolicy,
  makePairStateValidator,
  makeReceiverMintingPolicy,
  makeReceiverValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  buildReceiverDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import { normalizeHex } from "../core/dia-intent.js";

type ReceiverParameterizeInput = {
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  clientId: string;
  receiverAssetName: string;
  initialBalanceLovelace: string;
  minUtxoLovelace: string;
};

export async function parameterizeReceiverScripts(args: {
  inputPath: string;
  statePath?: string;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading receiver parameterization input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const state = await readConfigState(path.resolve(args.statePath ?? "state/preview/config-bootstrap.json"));

  if (!state.bootstrapRefs.paymentHook) {
    throw new Error("Receiver script parameterization requires protocol state after PaymentHook bootstrap.");
  }

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const configuredBootstrapRef = input.bootstrapRef ?? state.receiver?.bootstrapRef;
  const selectedBootstrapUtxo = configuredBootstrapRef
    ? findUtxoByOutRef(walletUtxos, configuredBootstrapRef, "receiver bootstrap")
    : selectBootstrapUtxo(walletUtxos, 0n, [
        state.bootstrapRefs.config,
        state.bootstrapRefs.paymentHook!,
      ]);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for receiver script parameterization. Inspect the wallet with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const receiverBootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Using wallet bootstrap UTxO ${receiverBootstrapRef.txHash}#${receiverBootstrapRef.outputIndex}`,
  );
  reportProgress("Deriving parameterized Receiver and Pair scripts offline");
  const configAssetName = splitUnit(state.scripts.configUnit).assetName;
  const receiverAssetName = normalizeHex(input.receiverAssetName, "receiverAssetName");
  const receiverMintPolicy = await makeReceiverMintingPolicy({
    bootstrapOutRef: receiverBootstrapRef,
    assetName: receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const receiverPolicyId = policyIdFromMintingPolicy(receiverMintPolicy);
  const receiverUnit = `${receiverPolicyId}${receiverAssetName}`;
  const receiverValidator = await makeReceiverValidator({
    bootstrapOutRef: receiverBootstrapRef,
    assetName: receiverAssetName,
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
  });
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  const pairPolicyId = policyIdFromMintingPolicy(
    await makePairStateMintingPolicy({
      configPolicyId: state.scripts.configPolicyId,
      configAssetName,
      receiverHash: receiverValidatorHash,
    }),
  );
  const pairValidator = await makePairStateValidator({
    configPolicyId: state.scripts.configPolicyId,
    configAssetName,
    receiverHash: receiverValidatorHash,
  });
  const receiverState = {
    balanceLovelace: toBigInt(input.initialBalanceLovelace, "initialBalanceLovelace").toString(),
    minUtxoLovelace: toBigInt(input.minUtxoLovelace, "minUtxoLovelace").toString(),
  };

  return {
    ...state,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: {
      ...state.scripts,
      pairPolicyId,
      pairValidatorHash: scriptHashFromValidator(pairValidator),
      pairValidatorAddress: scriptAddressFromValidator(pairValidator),
    },
    receiver: {
      clientId: input.clientId.trim(),
      bootstrapRef: receiverBootstrapRef,
      receiverAssetName,
      receiverPolicyId,
      receiverUnit,
      receiverValidatorHash,
      receiverValidatorAddress: scriptAddressFromValidator(receiverValidator),
      receiverState,
      receiverUtxo: {
        current: {
          txHash: "",
          outputIndex: 0,
        },
      },
    },
    datum: {
      ...state.datum,
      receiverCbor: buildReceiverDatumCbor(receiverState),
    },
    transaction: undefined,
  };
}

async function readInput(inputPath: string): Promise<ReceiverParameterizeInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ReceiverParameterizeInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:receiver:parameterize] ${message}`);
}
