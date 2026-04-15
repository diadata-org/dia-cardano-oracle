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
  type SpendingValidator,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { getBlueprintValidator } from "./blueprint.js";
import {
  diaIntentTokenNameFromSymbol,
  diaOracleDatumToCbor,
  diaOracleRedeemerToCbor,
  diaPairIdHex,
  diaIntentToState,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  type DiaOracleIntentInput,
} from "./dia-intent.js";
import { makeConfiguredLucid, selectConfiguredWallet } from "./lucid.js";
import {
  getDefaultConfigStatePath,
  readConfigState,
  type ConfigState,
  type OracleState,
  type PairEntryState,
} from "./state.js";
import { deriveConfiguredWalletDefaults } from "./wallet.js";

type PairBootstrapInput = {
  pairTokenName?: string;
  intent: DiaOracleIntentInput;
  lovelace: string;
};

type PairBootstrapResult = {
  mode: "build-only" | "submit";
  inputPath: string;
  statePath: string;
  wallet: {
    source: "seed" | "private-key";
    address: string;
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
  configState: ConfigState;
  configUtxos: {
    spent: {
      txHash: string;
      outputIndex: number;
    };
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
  pair: {
    tokenName: string;
    pairId: string;
    pairUnit: string;
    oracleReceiverAddress: string;
    stateUtxo: {
      txHash: string;
      outputIndex: number;
    };
  };
  oracleState: OracleState;
  datum: {
    configCbor: string;
    oracleCbor: string;
  };
  transaction: {
    unsignedHash: string;
    unsignedCbor: string;
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

const CONFIG_VALIDATOR_TITLE = "config_validator.config_validator.spend";
const PAIR_NFT_TITLE = "pair_nft.pair_nft.mint";
const ORACLE_RECEIVER_TITLE = "oracle_receiver.oracle_receiver.spend";

export async function pairBootstrap(args: {
  inputPath: string;
  statePath?: string;
  buildOnly: boolean;
}): Promise<PairBootstrapResult> {
  reportProgress(`Loading pair bootstrap input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readPairBootstrapInput(inputPath);

  const statePath = path.resolve(
    args.statePath ?? getDefaultConfigStatePath(),
  );
  reportProgress(`Loading config state from ${statePath}`);
  const state = await readConfigState(statePath);

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();
  const walletDefaults = deriveConfiguredWalletDefaults({
    source,
    address: walletAddress,
  });

  if (!state.configState.validConfigSigners.includes(walletDefaults.paymentKeyHash)) {
    throw new Error(
      "The configured wallet is not authorized as a config signer in the provided state file.",
    );
  }

  const intent = normalizeDiaOracleIntent(input.intent);
  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });
  const witness = recoverDiaOracleIntentWitness(domain, intent);

  if (
    !state.configState.authorizedOraclePublicKeys.includes(witness.signerPublicKey)
  ) {
    throw new Error(
      `Recovered DIA signer public key ${witness.signerPublicKey} is not authorized in the current config state.`,
    );
  }

  const pair = {
    tokenName: normalizeHex(
      input.pairTokenName?.trim() && input.pairTokenName.trim().length > 0
        ? input.pairTokenName
        : diaIntentTokenNameFromSymbol(intent),
      "pairTokenName",
    ),
    pairId: diaPairIdHex(intent),
  };
  assertPairIsNew(state.configState.allowedPairs, pair);

  const configUnit = state.scripts.configUnit;
  reportProgress(`Resolving current Config UTxO by unit ${configUnit}`);
  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    configUnit,
    "config",
  );

  const { policyId: configPolicyId, assetName: configAssetName } = splitUnit(configUnit);
  if (configPolicyId !== state.scripts.configPolicyId) {
    throw new Error("State file config policy id does not match config unit.");
  }

  const configValidator = await makeConfigValidator({
    configPolicyId,
    configAssetName,
  });
  const pairNftPolicy = await makePairNftPolicy({
    configPolicyId,
    configAssetName,
  });
  const pairPolicyId = mintingPolicyToId(pairNftPolicy);
  if (pairPolicyId !== state.scripts.pairPolicyId) {
    throw new Error("State file pair policy id does not match the current blueprint.");
  }

  const oracleReceiver = await makeOracleReceiver({
    configPolicyId,
    configAssetName,
    pairPolicyId,
  });
  const oracleReceiverHash = validatorToScriptHash(oracleReceiver);
  const oracleReceiverAddress = validatorToAddress("Preview", oracleReceiver);
  if (oracleReceiverHash !== state.scripts.oracleReceiverHash) {
    throw new Error(
      "State file oracle receiver hash does not match the current blueprint.",
    );
  }

  const pairUnit = `${pairPolicyId}${pair.tokenName}`;
  const nextConfigState: ConfigState = {
    ...state.configState,
    allowedPairs: [...state.configState.allowedPairs, pair],
  };

  const configRedeemer = Data.to(
    new Constr(1, [new Constr<PlutusData>(0, [pair.tokenName, pair.pairId])]),
  );
  const pairMintRedeemer = Data.to(new Constr(0, []));
  const nextConfigDatumCbor = Data.to(buildConfigDatum(nextConfigState));
  const oracleDatumCbor = diaOracleDatumToCbor({
    intent,
    signerPublicKey: witness.signerPublicKey,
    intentHash: witness.intentHash,
  });

  const oracleState: OracleState = {
    price: intent.price.toString(),
    timestamp: intent.timestamp.toString(),
    nonce: intent.nonce.toString(),
    intentHash: witness.intentHash,
    signer: intent.signer,
    signerPublicKey: witness.signerPublicKey,
    signature: intent.signature,
    rawIntent: Data.to(
      new Constr<PlutusData>(0, [
        diaOracleRedeemerIntentData(intent),
      ]),
    ),
    intent: diaIntentToState(intent),
  };

  reportProgress("Building Preview pair bootstrap transaction");
  const txBuilder = lucid
    .newTx()
    .collectFrom([currentConfigUtxo], configRedeemer)
    .addSignerKey(walletDefaults.paymentKeyHash)
    .attach.SpendingValidator(configValidator)
    .attach.MintingPolicy(pairNftPolicy)
    .mintAssets({ [pairUnit]: 1n }, pairMintRedeemer)
    .pay.ToContract(
      state.scripts.configValidatorAddress,
      { kind: "inline", value: nextConfigDatumCbor },
      { ...currentConfigUtxo.assets },
    )
    .pay.ToContract(
      oracleReceiverAddress,
      { kind: "inline", value: oracleDatumCbor },
      {
        lovelace: BigInt(input.lovelace),
        [pairUnit]: 1n,
      },
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

  const latestConfigUtxo =
    args.buildOnly || !confirmed
      ? currentConfigUtxo
      : await waitForSingleUtxoAtUnit(
          lucid,
          state.scripts.configValidatorAddress,
          configUnit,
          "config",
          currentConfigUtxo,
        );
  const pairStateUtxo =
    args.buildOnly || !confirmed
      ? null
      : await waitForSingleUtxoAtUnit(
          lucid,
          oracleReceiverAddress,
          pairUnit,
          "pair",
          null,
        );

  return {
    mode: args.buildOnly ? "build-only" : "submit",
    inputPath,
    statePath,
    wallet: {
      source,
      address: walletAddress,
    },
    scripts: state.scripts,
    configState: nextConfigState,
    configUtxos: {
      spent: {
        txHash: currentConfigUtxo.txHash,
        outputIndex: currentConfigUtxo.outputIndex,
      },
      current: {
        txHash: latestConfigUtxo.txHash,
        outputIndex: latestConfigUtxo.outputIndex,
      },
    },
    pair: {
      tokenName: pair.tokenName,
      pairId: pair.pairId,
      pairUnit,
      oracleReceiverAddress,
      stateUtxo: pairStateUtxo
        ? {
            txHash: pairStateUtxo.txHash,
            outputIndex: pairStateUtxo.outputIndex,
          }
        : {
            txHash: "",
            outputIndex: 0,
          },
    },
    oracleState: {
      ...oracleState,
      rawIntent: diaOracleDatumRawIntent(intent),
    },
    datum: {
      configCbor: nextConfigDatumCbor,
      oracleCbor: oracleDatumCbor,
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
  console.error(`[preview:pair:bootstrap] ${message}`);
}

async function readPairBootstrapInput(
  inputPath: string,
): Promise<PairBootstrapInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as PairBootstrapInput;
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

function buildConfigDatum(state: ConfigState): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    state.validConfigSigners.map((signer) =>
      normalizeHex(signer, "validConfigSigners[]"),
    ),
    state.authorizedOraclePublicKeys.map((signer) =>
      normalizeHex(signer, "authorizedOraclePublicKeys[]"),
    ),
    state.feeAddresses.map(addressToData),
    BigInt(state.feeAmount),
    new Constr<PlutusData>(0, [
      utf8ToHex(state.domain.name),
      utf8ToHex(state.domain.version),
      BigInt(state.domain.sourceChainId),
      normalizeHex(state.domain.verifyingContract, "domain.verifyingContract"),
    ]),
    state.allowedPairs.map(
      (pair) =>
        new Constr<PlutusData>(0, [
          normalizeHex(pair.tokenName, "allowedPairs[].tokenName"),
          normalizeHex(pair.pairId, "allowedPairs[].pairId"),
        ]),
    ),
  ]);
}

function diaOracleDatumRawIntent(intent: ReturnType<typeof normalizeDiaOracleIntent>): string {
  return Data.to(diaOracleRedeemerIntentData(intent));
}

function diaOracleRedeemerIntentData(
  intent: ReturnType<typeof normalizeDiaOracleIntent>,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    utf8ToHex(intent.intentType),
    utf8ToHex(intent.version),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    utf8ToHex(intent.symbol),
    intent.price,
    intent.timestamp,
    utf8ToHex(intent.source),
    intent.signature,
    intent.signer,
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

function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "configUnit");

  if (normalizedUnit.length < 56) {
    throw new Error("configUnit is shorter than a valid policy id.");
  }

  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}

function assertPairIsNew(
  allowedPairs: PairEntryState[],
  nextPair: PairEntryState,
): void {
  const conflict = allowedPairs.find(
    (pair) =>
      pair.tokenName === nextPair.tokenName || pair.pairId === nextPair.pairId,
  );

  if (conflict) {
    throw new Error(
      "The provided pair already exists in the current config state file.",
    );
  }
}

async function findSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
) {
  const utxos = await lucid.utxosAtWithUnit(address, unit);

  if (utxos.length === 0) {
    throw new Error(`No ${label} UTxO found at ${address} for unit ${unit}.`);
  }

  if (utxos.length > 1) {
    throw new Error(`Expected exactly one ${label} UTxO at ${address} for unit ${unit}.`);
  }

  return utxos[0];
}

async function waitForSingleUtxoAtUnit(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
  label: string,
  previous:
    | {
        txHash: string;
        outputIndex: number;
      }
    | null,
): Promise<Awaited<ReturnType<typeof findSingleUtxoAtUnit>>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const utxo = await findSingleUtxoAtUnit(lucid, address, unit, label);
      if (
        previous === null ||
        utxo.txHash !== previous.txHash ||
        utxo.outputIndex !== previous.outputIndex
      ) {
        return utxo;
      }
    } catch (_error) {
      // The new UTxO may not be indexed yet immediately after confirmation.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
  }

  throw new Error(
    `Timed out while waiting for the refreshed ${label} UTxO at ${address} for unit ${unit}.`,
  );
}
