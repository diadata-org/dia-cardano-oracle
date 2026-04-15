import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Constr,
  applyParamsToScript,
  getAddressDetails,
  mintingPolicyToId,
  validatorToAddress,
  validatorToScriptHash,
  type MintingPolicy,
  type OutRef,
  type SpendingValidator,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { getBlueprintValidator } from "./blueprint.js";
import {
  normalizeEthereumAddressHex,
  normalizeHex,
} from "./dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "./lucid.js";
import { deriveConfiguredWalletDefaults } from "./wallet.js";

type ConfigBootstrapInput = {
  configAssetName: string;
  validConfigSigners?: string[];
  authorizedOraclePublicKeys?: string[];
  feeAddresses?: string[];
  feeAmount: string;
  domain: {
    name: string;
    version: string;
    sourceChainId: number | string;
    verifyingContract: string;
  };
  lovelace: string;
};

type ResolvedConfigBootstrapInput = Omit<
  ConfigBootstrapInput,
  "validConfigSigners" | "authorizedOraclePublicKeys" | "feeAddresses"
> & {
  validConfigSigners: string[];
  authorizedOraclePublicKeys: string[];
  feeAddresses: string[];
};

type ConfigBootstrapResult = {
  mode: "build-only" | "submit";
  inputPath: string;
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  configState: {
    validConfigSigners: string[];
    authorizedOraclePublicKeys: string[];
    feeAddresses: string[];
    feeAmount: string;
    domain: {
      name: string;
      version: string;
      sourceChainId: string;
      verifyingContract: string;
    };
    allowedPairs: Array<{
      tokenName: string;
      pairId: string;
    }>;
  };
  bootstrapUtxo: {
    txHash: string;
    outputIndex: number;
  };
  scripts: {
    configPolicyId: string;
    configUnit: string;
    configValidatorHash: string;
    configValidatorAddress: string;
    pairPolicyId: string;
    oracleReceiverHash: string;
    oracleReceiverAddress: string;
  };
  datum: {
    cbor: string;
  };
  transaction: {
    unsignedHash: string;
    unsignedCbor: string;
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

const CONFIG_NFT_TITLE = "config_nft.config_nft.mint";
const CONFIG_VALIDATOR_TITLE = "config_validator.config_validator.spend";
const PAIR_NFT_TITLE = "pair_nft.pair_nft.mint";
const ORACLE_RECEIVER_TITLE = "oracle_receiver.oracle_receiver.spend";

export async function configBootstrap(args: {
  inputPath: string;
  buildOnly: boolean;
}): Promise<ConfigBootstrapResult> {
  reportProgress(
    `Loading config bootstrap input from ${path.resolve(args.inputPath)}`,
  );
  const inputPath = path.resolve(args.inputPath);
  const input = await readConfigBootstrapInput(inputPath);

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletAddress = await wallet.address();
  const walletUtxos = await wallet.getUtxos();
  const walletDefaults = deriveConfiguredWalletDefaults({
    source,
    address: walletAddress,
  });
  const resolvedInput = resolveConfigBootstrapInput(input, walletDefaults);

  reportResolutionDefaults(input, resolvedInput, walletDefaults);

  const walletBootstrapUtxo = selectBootstrapUtxo(
    walletUtxos,
    BigInt(resolvedInput.lovelace),
  );

  if (!walletBootstrapUtxo) {
    throw new Error(
      "No suitable wallet UTxO is available for config bootstrap. Fund the configured Preview wallet and inspect it with 'npm run cli -- preview:wallet:utxos'.",
    );
  }

  const bootstrapOutRef: OutRef = {
    txHash: walletBootstrapUtxo.txHash,
    outputIndex: walletBootstrapUtxo.outputIndex,
  };
  reportProgress(
    `Selected wallet bootstrap UTxO ${bootstrapOutRef.txHash}#${bootstrapOutRef.outputIndex}`,
  );

  reportProgress("Deriving script parameters and addresses from the current blueprint");
  const configAssetName = normalizeHex(
    resolvedInput.configAssetName,
    "configAssetName",
  );
  const configNftPolicy = await makeConfigNftPolicy({
    bootstrapOutRef,
    configAssetName,
  });
  const configPolicyId = mintingPolicyToId(configNftPolicy);
  const configUnit = `${configPolicyId}${configAssetName}`;

  const configValidator = await makeConfigValidator({
    configPolicyId,
    configAssetName,
  });
  const configValidatorHash = validatorToScriptHash(configValidator);
  const configValidatorAddress = validatorToAddress("Preview", configValidator);

  const pairNftPolicy = await makePairNftPolicy({
    configPolicyId,
    configAssetName,
  });
  const pairPolicyId = mintingPolicyToId(pairNftPolicy);

  const oracleReceiver = await makeOracleReceiver({
    configPolicyId,
    configAssetName,
    pairPolicyId,
  });
  const oracleReceiverHash = validatorToScriptHash(oracleReceiver);
  const oracleReceiverAddress = validatorToAddress("Preview", oracleReceiver);

  const configDatum = buildConfigDatum(resolvedInput);
  const configDatumCbor = Data.to(configDatum);
  const mintRedeemer = Data.to(new Constr(0, []));
  const outputAssets = {
    lovelace: BigInt(resolvedInput.lovelace),
    [configUnit]: 1n,
  };

  reportProgress("Building Preview config bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .collectFrom([walletBootstrapUtxo])
    .attach.MintingPolicy(configNftPolicy)
    .mintAssets({ [configUnit]: 1n }, mintRedeemer)
    .pay.ToContract(
      configValidatorAddress,
      { kind: "inline", value: configDatumCbor },
      outputAssets,
    );

  const txSignBuilder = await txBuilder.complete();
  const unsignedHash = txSignBuilder.toHash();
  const unsignedCbor = txSignBuilder.toCBOR();

  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    reportProgress("Signing transaction with the configured wallet");
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    reportProgress("Submitting transaction to Preview");
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    reportProgress("Waiting for transaction confirmation on Preview");
    confirmed = await lucid.awaitTx(submittedTxHash, 3_000);

    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    reportProgress(`Transaction confirmed on Preview: ${submittedTxHash}`);
  } else {
    reportProgress(`Build-only mode: unsigned transaction ready: ${unsignedHash}`);
  }

  return {
    mode: args.buildOnly ? "build-only" : "submit",
    inputPath,
    wallet: {
      source,
      address: walletAddress,
    },
    configState: {
      validConfigSigners: resolvedInput.validConfigSigners,
      authorizedOraclePublicKeys: resolvedInput.authorizedOraclePublicKeys,
      feeAddresses: resolvedInput.feeAddresses,
      feeAmount: resolvedInput.feeAmount,
      domain: {
        name: resolvedInput.domain.name,
        version: resolvedInput.domain.version,
        sourceChainId: resolvedInput.domain.sourceChainId.toString(),
        verifyingContract: normalizeEthereumAddressHex(
          resolvedInput.domain.verifyingContract,
          "domain.verifyingContract",
        ),
      },
      allowedPairs: [],
    },
    bootstrapUtxo: bootstrapOutRef,
    scripts: {
      configPolicyId,
      configUnit,
      configValidatorHash,
      configValidatorAddress,
      pairPolicyId,
      oracleReceiverHash,
      oracleReceiverAddress,
    },
    datum: {
      cbor: configDatumCbor,
    },
    transaction: {
      unsignedHash,
      unsignedCbor,
      submittedTxHash,
      confirmed,
    },
  };
}

function reportProgress(message: string): void {
  console.error(`[preview:config:bootstrap] ${message}`);
}

async function readConfigBootstrapInput(
  inputPath: string,
): Promise<ConfigBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as ConfigBootstrapInput;
}

async function makeConfigNftPolicy(args: {
  bootstrapOutRef: OutRef;
  configAssetName: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(CONFIG_NFT_TITLE);

  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      outRefToData(args.bootstrapOutRef),
      args.configAssetName,
    ]),
  };
}

async function makeConfigValidator(args: {
  configPolicyId: string;
  configAssetName: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(CONFIG_VALIDATOR_TITLE);

  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

async function makePairNftPolicy(args: {
  configPolicyId: string;
  configAssetName: string;
}): Promise<MintingPolicy> {
  const validator = await getBlueprintValidator(PAIR_NFT_TITLE);

  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
    ]),
  };
}

async function makeOracleReceiver(args: {
  configPolicyId: string;
  configAssetName: string;
  pairPolicyId: string;
}): Promise<SpendingValidator> {
  const validator = await getBlueprintValidator(ORACLE_RECEIVER_TITLE);

  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode!, [
      args.configPolicyId,
      args.configAssetName,
      args.pairPolicyId,
    ]),
  };
}

function outRefToData(outRef: OutRef): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    normalizeHex(outRef.txHash, "bootstrapUtxo.txHash"),
    BigInt(outRef.outputIndex),
  ]);
}

function buildConfigDatum(
  input: ResolvedConfigBootstrapInput,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    input.validConfigSigners.map((signer) =>
      normalizeHex(signer, "validConfigSigners[]"),
    ),
    input.authorizedOraclePublicKeys.map((signer) =>
      normalizeHex(signer, "authorizedOraclePublicKeys[]"),
    ),
    input.feeAddresses.map(addressToData),
    BigInt(input.feeAmount),
    new Constr<PlutusData>(0, [
      utf8ToHex(input.domain.name),
      utf8ToHex(input.domain.version),
      BigInt(input.domain.sourceChainId),
      normalizeEthereumAddressHex(
        input.domain.verifyingContract,
        "domain.verifyingContract",
      ),
    ]),
    [],
  ]);
}

function addressToData(address: string): Constr<PlutusData> {
  const details = getAddressDetails(address);

  if (!details.paymentCredential) {
    throw new Error(`Address is missing a payment credential: ${address}`);
  }

  return new Constr<PlutusData>(0, [
    credentialToData(details.paymentCredential),
    details.stakeCredential
      ? new Constr<PlutusData>(0, [stakeCredentialToData(details.stakeCredential)])
      : new Constr<PlutusData>(1, []),
  ]);
}

function stakeCredentialToData(
  credential: { type: "Key" | "Script"; hash: string },
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [credentialToData(credential)]);
}

function credentialToData(
  credential: { type: "Key" | "Script"; hash: string },
): Constr<PlutusData> {
  return credential.type === "Key"
    ? new Constr<PlutusData>(0, [normalizeHex(credential.hash, "credential.hash")])
    : new Constr<PlutusData>(1, [normalizeHex(credential.hash, "credential.hash")]);
}

function utf8ToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function selectBootstrapUtxo<
  T extends {
    txHash: string;
    outputIndex: number;
    assets: Record<string, bigint>;
  },
>(
  utxos: T[],
  minimumLovelace: bigint,
): T | undefined {
  const sorted = [...utxos].sort(
    (left, right) =>
      Number((right.assets.lovelace ?? 0n) - (left.assets.lovelace ?? 0n)),
  );

  const adaOnly = sorted.filter((utxo) => {
    const units = Object.keys(utxo.assets);
    return (
      (utxo.assets.lovelace ?? 0n) >= minimumLovelace &&
      units.every((unit) => unit === "lovelace")
    );
  });

  if (adaOnly.length > 0) {
    return adaOnly[0];
  }

  return sorted.find((utxo) => (utxo.assets.lovelace ?? 0n) >= minimumLovelace);
}

function resolveConfigBootstrapInput(
  input: ConfigBootstrapInput,
  walletDefaults: {
    paymentKeyHash: string;
    feeAddress: string;
  },
): ResolvedConfigBootstrapInput {
  const validConfigSigners = sanitizedValues(input.validConfigSigners);
  const authorizedOraclePublicKeys = sanitizedValues(
    input.authorizedOraclePublicKeys,
  );
  const feeAddresses = sanitizedValues(input.feeAddresses);

  return {
    ...input,
    validConfigSigners:
      validConfigSigners.length > 0
        ? validConfigSigners
        : [walletDefaults.paymentKeyHash],
    authorizedOraclePublicKeys,
    feeAddresses:
      feeAddresses.length > 0 ? feeAddresses : [walletDefaults.feeAddress],
  };
}

function reportResolutionDefaults(
  input: ConfigBootstrapInput,
  resolvedInput: ResolvedConfigBootstrapInput,
  walletDefaults: {
    paymentKeyHash: string;
    feeAddress: string;
  },
): void {
  if (sanitizedValues(input.validConfigSigners).length === 0) {
    reportProgress(
      `Using wallet payment key hash as default config signer: ${walletDefaults.paymentKeyHash}`,
    );
  }

  if (sanitizedValues(input.feeAddresses).length === 0) {
    reportProgress(
      `Using wallet address as default fee recipient: ${walletDefaults.feeAddress}`,
    );
  }

  assertResolvedInput(resolvedInput);
}

function assertResolvedInput(input: ResolvedConfigBootstrapInput): void {
  if (input.validConfigSigners.length === 0) {
    throw new Error("No config signer was resolved for config bootstrap.");
  }

  if (input.authorizedOraclePublicKeys.length === 0) {
    throw new Error(
      "No authorized DIA oracle public keys were provided for config bootstrap.",
    );
  }

  if (input.feeAddresses.length === 0) {
    throw new Error(
      "No fee recipient address was resolved for config bootstrap.",
    );
  }
}

function sanitizedValues(values?: string[]): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter(
      (value) => value.length > 0 && !value.toLowerCase().includes("replace-with-"),
    );
}
