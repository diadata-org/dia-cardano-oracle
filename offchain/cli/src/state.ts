import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";
import type { DiaOracleIntentInput } from "./dia-intent.js";

export type PairEntryState = {
  tokenName: string;
  pairId: string;
};

export type ConfigState = {
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
  allowedPairs: PairEntryState[];
};

export type DeploymentScripts = {
  configPolicyId: string;
  configUnit: string;
  configValidatorHash: string;
  configValidatorAddress: string;
  pairPolicyId: string;
  oracleReceiverHash: string;
  oracleReceiverAddress: string;
};

export type ConfigStateArtifact = {
  scripts: DeploymentScripts;
  configState: ConfigState;
  transaction?: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

export type OracleState = {
  price: string;
  timestamp: string;
  nonce: string;
  intentHash: string;
  signer: string;
  signerPublicKey: string;
  signature: string;
  rawIntent: string;
  intent: DiaOracleIntentInput;
};

export type PairStateArtifact = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  scripts: DeploymentScripts;
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
  transaction?: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

type LegacyPreviewBootstrapArtifact = {
  scripts: DeploymentScripts;
  resolvedInput?: {
    validConfigSigners?: string[];
    authorizedOraclePublicKeys?: string[];
    feeAddresses?: string[];
  };
  transaction?: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
};

type LegacyPreviewPairStateArtifact = Omit<
  PairStateArtifact,
  "scripts" | "oracleState"
> & {
  scripts?: DeploymentScripts;
  oracleState?: OracleState;
};

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PREVIEW_CONFIG_STATE_PATH = path.resolve(
  CURRENT_DIR,
  "../state/preview/config-bootstrap.json",
);

export async function readConfigState(
  statePath: string = DEFAULT_PREVIEW_CONFIG_STATE_PATH,
): Promise<ConfigStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  const parsed = JSON.parse(raw) as
    | ConfigStateArtifact
    | LegacyPreviewBootstrapArtifact;

  if ("configState" in parsed && parsed.configState) {
    return parsed;
  }

  const legacyParsed = parsed as LegacyPreviewBootstrapArtifact;

  if (!legacyParsed.scripts) {
    throw new Error("State file is missing deployment script metadata.");
  }

  return {
    scripts: legacyParsed.scripts,
    configState: {
      validConfigSigners: legacyParsed.resolvedInput?.validConfigSigners ?? [],
      authorizedOraclePublicKeys:
        legacyParsed.resolvedInput?.authorizedOraclePublicKeys ?? [],
      feeAddresses: legacyParsed.resolvedInput?.feeAddresses ?? [],
      feeAmount: "0",
      domain: {
        name: "OracleIntentRegistry",
        version: "1",
        sourceChainId: "0",
        verifyingContract: "0000000000000000000000000000000000000000",
      },
      allowedPairs: [],
    },
    transaction: legacyParsed.transaction,
  };
}

export function getDefaultConfigStatePath(): string {
  return DEFAULT_PREVIEW_CONFIG_STATE_PATH;
}

export async function readPairState(
  statePath: string,
): Promise<PairStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  const parsed = JSON.parse(raw) as
    | PairStateArtifact
    | LegacyPreviewPairStateArtifact;

  if (!parsed.configState || !parsed.pair || !parsed.datum) {
    throw new Error("Pair state file is missing required fields.");
  }

  const scripts =
    parsed.scripts ?? (await readConfigState()).scripts;
  const oracleState =
    parsed.oracleState ?? decodeOracleStateFromCbor(parsed.datum.oracleCbor);

  return {
    ...parsed,
    scripts,
    oracleState,
  };
}

function decodeOracleStateFromCbor(oracleCbor: string): OracleState {
  const parsed = Data.from(oracleCbor) as {
    fields?: PlutusData[];
  };

  if (!Array.isArray(parsed.fields) || parsed.fields.length !== 9) {
    throw new Error("Pair state file contains an invalid oracle datum.");
  }

  const rawIntent = byteArrayDataToHex(parsed.fields[8], "oracle.rawIntent");
  const intent = decodeOracleIntentFromCbor(rawIntent);

  return {
    price: intDataToString(parsed.fields[1], "oracle.price"),
    timestamp: intDataToString(parsed.fields[2], "oracle.timestamp"),
    nonce: intDataToString(parsed.fields[3], "oracle.nonce"),
    intentHash: byteArrayDataToHex(parsed.fields[4], "oracle.intentHash"),
    signer: byteArrayDataToHex(parsed.fields[5], "oracle.signer"),
    signerPublicKey: byteArrayDataToHex(parsed.fields[6], "oracle.signerPublicKey"),
    signature: byteArrayDataToHex(parsed.fields[7], "oracle.signature"),
    rawIntent,
    intent,
  };
}

function decodeOracleIntentFromCbor(rawIntent: string): DiaOracleIntentInput {
  const parsed = Data.from(rawIntent) as {
    fields?: PlutusData[];
  };

  if (!Array.isArray(parsed.fields) || parsed.fields.length !== 11) {
    throw new Error("Pair state file contains an invalid OracleIntent payload.");
  }

  return {
    intentType: utf8DataToString(parsed.fields[0], "intent.intentType"),
    version: utf8DataToString(parsed.fields[1], "intent.version"),
    chainId: intDataToString(parsed.fields[2], "intent.chainId"),
    nonce: intDataToString(parsed.fields[3], "intent.nonce"),
    expiry: intDataToString(parsed.fields[4], "intent.expiry"),
    symbol: utf8DataToString(parsed.fields[5], "intent.symbol"),
    price: intDataToString(parsed.fields[6], "intent.price"),
    timestamp: intDataToString(parsed.fields[7], "intent.timestamp"),
    source: utf8DataToString(parsed.fields[8], "intent.source"),
    signature: with0x(byteArrayDataToHex(parsed.fields[9], "intent.signature")),
    signer: with0x(byteArrayDataToHex(parsed.fields[10], "intent.signer")),
  };
}

function intDataToString(value: PlutusData, label: string): string {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return value;
  }

  throw new Error(`Expected ${label} to decode as an integer.`);
}

function byteArrayDataToHex(value: PlutusData, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to decode as a bytearray.`);
  }

  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`Expected ${label} to decode as an even-length hex string.`);
  }

  return value.toLowerCase();
}

function utf8DataToString(value: PlutusData, label: string): string {
  const hex = byteArrayDataToHex(value, label);
  return Buffer.from(hex, "hex").toString("utf8");
}

function with0x(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}
