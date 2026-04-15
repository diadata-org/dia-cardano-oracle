import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Constr,
  applyParamsToScript,
  validatorToAddress,
  validatorToScriptHash,
  type SpendingValidator,
} from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { getBlueprintValidator } from "./blueprint.js";
import {
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
import { readPairState, type OracleState } from "./state.js";

type UpdateInput = {
  intent: DiaOracleIntentInput;
};

type UpdateResult = {
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

const ORACLE_RECEIVER_TITLE = "oracle_receiver.oracle_receiver.spend";

export async function submitOracleUpdate(args: {
  inputPath: string;
  statePath: string;
  buildOnly: boolean;
}): Promise<UpdateResult> {
  reportProgress(`Loading oracle update input from ${path.resolve(args.inputPath)}`);
  const inputPath = path.resolve(args.inputPath);
  const input = await readUpdateInput(inputPath);

  const statePath = path.resolve(args.statePath);
  reportProgress(`Loading pair state from ${statePath}`);
  const state = await readPairState(statePath);

  reportProgress("Connecting to Preview and selecting the configured wallet");
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const walletAddress = await lucid.wallet().address();

  assertPairIsAuthorized(state.configState.allowedPairs, {
    tokenName: state.pair.tokenName,
    pairId: state.pair.pairId,
  });

  reportProgress(`Resolving current Config UTxO by unit ${state.scripts.configUnit}`);
  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  reportProgress(`Resolving current pair state UTxO by unit ${state.pair.pairUnit}`);
  const currentPairUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.pair.oracleReceiverAddress,
    state.pair.pairUnit,
    "pair",
  );

  const { policyId: configPolicyId, assetName: configAssetName } = splitUnit(
    state.scripts.configUnit,
  );
  if (configPolicyId !== state.scripts.configPolicyId) {
    throw new Error("Pair state file config policy id does not match config unit.");
  }

  const oracleReceiver = await makeOracleReceiver({
    configPolicyId,
    configAssetName,
    pairPolicyId: state.scripts.pairPolicyId,
  });
  const oracleReceiverHash = validatorToScriptHash(oracleReceiver);
  const oracleReceiverAddress = validatorToAddress("Preview", oracleReceiver);
  if (oracleReceiverHash !== state.scripts.oracleReceiverHash) {
    throw new Error(
      "Pair state file oracle receiver hash does not match the current blueprint.",
    );
  }
  if (oracleReceiverAddress !== state.pair.oracleReceiverAddress) {
    throw new Error(
      "Pair state file oracle receiver address does not match the current blueprint.",
    );
  }

  const currentOracleState = parseOracleDatum(await lucid.datumOf(currentPairUtxo));
  if (currentOracleState.pairId !== normalizeHex(state.pair.pairId, "pair.pairId")) {
    throw new Error("Current pair datum does not match the pair id in the state file.");
  }

  const intent = normalizeDiaOracleIntent(input.intent);
  const expectedPairId = diaPairIdHex(intent);
  if (expectedPairId !== normalizeHex(state.pair.pairId, "pair.pairId")) {
    throw new Error(
      `Intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`,
    );
  }

  if (intent.timestamp <= currentOracleState.timestamp) {
    throw new Error("Oracle intent timestamp must be greater than the current timestamp.");
  }
  if (intent.nonce <= currentOracleState.nonce) {
    throw new Error("Oracle intent nonce must be greater than the current nonce.");
  }

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
      "The recovered DIA signer public key is not authorized in the provided state file.",
    );
  }

  const oracleRedeemerCbor = diaOracleRedeemerToCbor({
    intent,
    signerPublicKey: witness.signerPublicKey,
  });
  const nextOracleDatumCbor = diaOracleDatumToCbor({
    intent,
    signerPublicKey: witness.signerPublicKey,
    intentHash: witness.intentHash,
  });

  reportProgress("Building Preview oracle update transaction");
  let txBuilder = lucid
    .newTx()
    .readFrom([currentConfigUtxo])
    .collectFrom([currentPairUtxo], oracleRedeemerCbor)
    .attach.SpendingValidator(oracleReceiver)
    .pay.ToContract(
      oracleReceiverAddress,
      { kind: "inline", value: nextOracleDatumCbor },
      { ...currentPairUtxo.assets },
    );

  const feeAmount = BigInt(state.configState.feeAmount);
  if (feeAmount > 0n) {
    for (const feeAddress of state.configState.feeAddresses) {
      txBuilder = txBuilder.pay.ToAddress(feeAddress, { lovelace: feeAmount });
    }
  }

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

  const latestPairUtxo =
    args.buildOnly || !confirmed
      ? currentPairUtxo
      : await waitForSingleUtxoAtUnit(
          lucid,
          oracleReceiverAddress,
          state.pair.pairUnit,
          "pair",
          currentPairUtxo,
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
    configState: state.configState,
    configUtxos: {
      spent: state.configUtxos.spent,
      current: {
        txHash: currentConfigUtxo.txHash,
        outputIndex: currentConfigUtxo.outputIndex,
      },
    },
    pair: {
      ...state.pair,
      oracleReceiverAddress,
      stateUtxo: {
        txHash: latestPairUtxo.txHash,
        outputIndex: latestPairUtxo.outputIndex,
      },
    },
    oracleState: {
      price: intent.price.toString(),
      timestamp: intent.timestamp.toString(),
      nonce: intent.nonce.toString(),
      intentHash: witness.intentHash,
      signer: intent.signer,
      signerPublicKey: witness.signerPublicKey,
      signature: intent.signature,
      rawIntent: Data.to(diaIntentData(intent)),
      intent: diaIntentToState(intent),
    },
    datum: {
      configCbor: state.datum.configCbor,
      oracleCbor: nextOracleDatumCbor,
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
  console.error(`[preview:update] ${message}`);
}

async function readUpdateInput(inputPath: string): Promise<UpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as UpdateInput;
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

function diaIntentData(
  intent: ReturnType<typeof normalizeDiaOracleIntent>,
): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    Buffer.from(intent.intentType, "utf8").toString("hex"),
    Buffer.from(intent.version, "utf8").toString("hex"),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    Buffer.from(intent.symbol, "utf8").toString("hex"),
    intent.price,
    intent.timestamp,
    Buffer.from(intent.source, "utf8").toString("hex"),
    intent.signature,
    intent.signer,
  ]);
}

function parseOracleDatum(value: unknown): {
  pairId: string;
  timestamp: bigint;
  nonce: bigint;
} {
  const parsed = value as {
    fields?: PlutusData[];
  };

  if (!Array.isArray(parsed.fields) || parsed.fields.length !== 9) {
    throw new Error("Current pair datum could not be decoded as OracleDatum.");
  }

  return {
    pairId: byteArrayDataToHex(parsed.fields[0], "oracle.pairId"),
    timestamp: toIntData(parsed.fields[2], "oracle.timestamp"),
    nonce: toIntData(parsed.fields[3], "oracle.nonce"),
  };
}

function byteArrayDataToHex(value: PlutusData, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to decode as a bytearray.`);
  }

  return normalizeHex(value, label);
}

function toIntData(value: PlutusData, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }

  throw new Error(`Expected ${label} to decode as an integer.`);
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

function assertPairIsAuthorized(
  allowedPairs: UpdateResult["configState"]["allowedPairs"],
  pair: {
    tokenName: string;
    pairId: string;
  },
): void {
  const match = allowedPairs.find(
    (allowedPair) =>
      allowedPair.tokenName === pair.tokenName && allowedPair.pairId === pair.pairId,
  );

  if (!match) {
    throw new Error(
      "The current pair is not present in the allowed pairs of the provided state file.",
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
  previous: {
    txHash: string;
    outputIndex: number;
  },
): Promise<Awaited<ReturnType<typeof findSingleUtxoAtUnit>>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const utxo = await findSingleUtxoAtUnit(lucid, address, unit, label);
      if (
        utxo.txHash !== previous.txHash ||
        utxo.outputIndex !== previous.outputIndex
      ) {
        return utxo;
      }
    } catch (_error) {
      // The replacement pair UTxO may not be indexed yet immediately after confirmation.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
  }

  throw new Error(
    `Timed out while waiting for the refreshed ${label} UTxO at ${address} for unit ${unit}.`,
  );
}
