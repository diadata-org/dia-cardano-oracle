import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  makeConfigStateMintingPolicy,
  makeConfigStateValidator,
  makeCoordinatorValidator,
  makeReferenceHolderValidator,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  scriptRewardAddress,
} from "../core/contracts.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "../core/lucid.js";
import { readConfigState, type ConfigStateArtifact } from "../core/state.js";
import {
  buildConfigDatumCbor,
  findUtxoByOutRef,
  selectBootstrapUtxo,
  splitUnit,
  toBigInt,
} from "../core/chain-helpers.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
} from "../core/dia-intent.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";

type ConfigParameterizeInput = {
  bootstrapRef?: {
    txHash: string;
    outputIndex: number;
  };
  configAssetName: string;
  validConfigSigners?: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: number | string;
    verifyingContract: string;
  };
  protocolFeeLovelace: string;
  minUtxoLovelace: string;
};

export async function parameterizeConfigScripts(args: {
  inputPath: string;
  statePath?: string;
}): Promise<ConfigStateArtifact> {
  reportProgress(`Loading config parameterization input from ${path.resolve(args.inputPath)}`);
  const input = await readInput(path.resolve(args.inputPath));
  const previousState = args.statePath
    ? await readConfigState(path.resolve(args.statePath))
    : null;

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const minUtxoLovelace = toBigInt(input.minUtxoLovelace, "minUtxoLovelace");
  const selectedBootstrapUtxo = input.bootstrapRef
    ? findUtxoByOutRef(walletUtxos, input.bootstrapRef, "config bootstrap")
    : selectBootstrapUtxo(walletUtxos);
  if (!selectedBootstrapUtxo) {
    throw new Error(
      "No suitable pure ADA wallet UTxO is available for config script parameterization. Inspect the wallet with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const bootstrapRef = {
    txHash: selectedBootstrapUtxo.txHash,
    outputIndex: selectedBootstrapUtxo.outputIndex,
  };
  reportProgress(`Using wallet bootstrap UTxO ${bootstrapRef.txHash}#${bootstrapRef.outputIndex}`);
  reportProgress("Deriving parameterized Config and Coordinator scripts offline");
  const configAssetName = normalizeHex(input.configAssetName, "configAssetName");
  const configMintPolicy = await makeConfigStateMintingPolicy({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const configPolicyId = policyIdFromMintingPolicy(configMintPolicy);
  const configUnit = `${configPolicyId}${configAssetName}`;
  const configValidator = await makeConfigStateValidator({
    bootstrapOutRef: bootstrapRef,
    assetName: configAssetName,
  });
  const coordinatorValidator = await makeCoordinatorValidator({
    configPolicyId,
    configAssetName: splitUnit(configUnit).assetName,
  });
  const coordinatorHash = scriptHashFromValidator(coordinatorValidator);
  const configState = {
    validConfigSigners:
      input.validConfigSigners?.map((value) => normalizeHex(value, "validConfigSigners[]")) ??
      [walletDefaults.paymentKeyHash],
    authorizedDiaPublicKeys: input.authorizedDiaPublicKeys.map((value) =>
      normalizeHex(value, "authorizedDiaPublicKeys[]"),
    ),
    domain: {
      name: input.domain.name.trim(),
      version: input.domain.version.trim(),
      sourceChainId: toBigInt(input.domain.sourceChainId, "domain.sourceChainId").toString(),
      verifyingContract: normalizeEthereumAddressHex(
        input.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    },
    protocolFeeLovelace: toBigInt(input.protocolFeeLovelace, "protocolFeeLovelace").toString(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
    minUtxoLovelace: minUtxoLovelace.toString(),
  };

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    referenceHolderAddress:
      previousState?.referenceHolderAddress ??
      scriptAddressFromValidator(await makeReferenceHolderValidator()),
    bootstrapRefs: {
      config: bootstrapRef,
      paymentHook: previousState?.bootstrapRefs.paymentHook ?? null,
    },
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash: scriptHashFromValidator(configValidator),
      configValidatorAddress: scriptAddressFromValidator(configValidator),
      pairPolicyId: previousState?.scripts.pairPolicyId ?? null,
      pairValidatorHash: previousState?.scripts.pairValidatorHash ?? null,
      pairValidatorAddress: previousState?.scripts.pairValidatorAddress ?? null,
      coordinatorHash,
      coordinatorRewardAddress: scriptRewardAddress(coordinatorHash),
      paymentHookPolicyId: previousState?.scripts.paymentHookPolicyId ?? null,
      paymentHookUnit: previousState?.scripts.paymentHookUnit ?? null,
      paymentHookValidatorHash: previousState?.scripts.paymentHookValidatorHash ?? null,
      paymentHookValidatorAddress: previousState?.scripts.paymentHookValidatorAddress ?? null,
    },
    configState,
    configUtxo: {
      current: {
        txHash: "",
        outputIndex: 0,
      },
    },
    paymentHookState: previousState?.paymentHookState ?? null,
    paymentHookUtxo: previousState?.paymentHookUtxo ?? null,
    referenceScripts: previousState?.referenceScripts,
    datum: {
      configCbor: buildConfigDatumCbor(configState),
      paymentHookCbor: previousState?.datum.paymentHookCbor ?? "",
      receiverCbor: previousState?.datum.receiverCbor ?? "",
    },
    transaction: undefined,
  };
}

async function readInput(inputPath: string): Promise<ConfigParameterizeInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigParameterizeInput;
}

function reportProgress(message: string): void {
  console.error(`[preview:config:parameterize] ${message}`);
}
