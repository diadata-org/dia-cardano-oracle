import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkTag } from "./config.js";
import type { DiaOracleIntentInput } from "./dia-intent.js";
import { resolveRunStateDir } from "./run-state.js";

// JSON serializer for state artifacts. Handles `bigint` by emitting the
// decimal representation; matches the format the CLI's `writeJsonOutput`
// in `src/index.ts` produces, so files written via this helper are
// interchangeable with files written by the CLI entry point.
export async function writeStateJsonFile(
  outPath: string,
  value: unknown,
): Promise<string> {
  const resolvedPath = path.resolve(outPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ) + "\n",
    "utf8",
  );
  return resolvedPath;
}

export type PairEntryState = {
  tokenName: string;
  pairId: string;
};

export type PaymentHookRefState = {
  policyId: string;
  assetName: string;
  unit: string;
};

export type CoordinatorCredentialState = {
  type: "Script" | "Key";
  hash: string;
};

export type ConfigState = {
  validConfigSigners: string[];
  authorizedDiaPublicKeys: string[];
  domain: {
    name: string;
    version: string;
    sourceChainId: string;
    verifyingContract: string;
  };
  /// Base protocol fee in lovelace (constant component of fee formula)
  /// Formula: protocol_fee(N) = baseFeeLovelace + (N * perPairFeeLovelace)
  baseFeeLovelace: string;
  /// Per-pair protocol fee in lovelace (variable component per pair)
  /// Formula: protocol_fee(N) = baseFeeLovelace + (N * perPairFeeLovelace)
  perPairFeeLovelace: string;
  maxBootstrapDriftSeconds: string;  // Intent freshness window for bootstrap validation
  paymentHookRef: PaymentHookRefState | null;
  updateCoordinatorCredential: CoordinatorCredentialState | null;
  minUtxoLovelace: string;
  /// Deposit tx-build params (CLI domain), shared with the feeder via
  /// config-bootstrap.json. Set at protocol:init.
  ///
  /// Dust floor (lovelace, string): a side-deposit UTxO is eligible for a
  /// `deposit:merge` sweep only if it is pure ADA at or above this. Also the
  /// minimum a `deposit:fund` payment will accept, and the floor the feeder's
  /// deposit-pending probe applies. A sibling of `minUtxoLovelace`.
  depositMinLovelace: string;
  /// Max deposit UTxOs folded into one `deposit:merge` tx (string; convert
  /// with Number() at use sites). Caps the tx so it never exceeds the
  /// tx-size / execution budget; any remainder is swept by the next merge.
  depositMaxPerMerge: string;
  /// Max deposit UTxOs an oracle update may opportunistically fold into the
  /// same tx (string; convert with Number() at use sites). Smaller than
  /// `depositMaxPerMerge` so the fold stays within the tx budget even when it
  /// rides alongside a price update (and a batch of pairs). Set at
  /// protocol:init; read by the update builders and the feeder's opportunistic
  /// fold. The standalone `deposit:merge` keeps using `depositMaxPerMerge` for
  /// bulk sweeps.
  depositMaxPerUpdateFold: string;
};

export type PaymentHookState = {
  withdrawAddress: string;
  minUtxoLovelace: string;
  accruedFeesLovelace: string;
  lifetimeCollectedLovelace: string;
  lifetimeWithdrawnLovelace: string;
};

export type ProtocolDeploymentScripts = {
  configPolicyId: string;
  configUnit: string;
  configValidatorHash: string;
  configValidatorAddress: string;
  coordinatorHash: string;
  coordinatorRewardAddress: string;
  referenceHolderValidatorHash: string;
  referenceHolderAddress: string;
  paymentHookPolicyId: string;
  paymentHookUnit: string;
  paymentHookValidatorHash: string;
  paymentHookValidatorAddress: string;
};

export type ClientDeploymentScripts = {
  pairPolicyId: string;
  pairValidatorHash: string;
  pairValidatorAddress: string;
};

export type ResolvedDeploymentScripts = ProtocolDeploymentScripts &
  ClientDeploymentScripts;

export type ReceiverState = {
  balanceLovelace: string;
  accruedToHookLovelace: string;  // Pending protocol fees to be settled to the hook
  minUtxoLovelace: string;
};

export type ReceiverArtifact = {
  clientId: string;
  bootstrapRef: {
    txHash: string;
    outputIndex: number;
  };
  receiverAssetName: string;
  receiverPolicyId: string;
  receiverUnit: string;
  receiverValidatorHash: string;
  receiverValidatorAddress: string;
  /** Per-client side-deposit address. A client funds their balance by sending
   *  ADA here with an ordinary wallet payment (no CLI); the feeder/CLI later
   *  folds those deposits into the Receiver balance with a TopUp. Derived from
   *  the Receiver NFT, so it is unique per client. */
  depositValidatorHash: string;
  depositValidatorAddress: string;
  receiverState: ReceiverState;
};

export type ReceiverParameterizeDefaults = {
  clientId: string;
  receiverAssetLabel?: string;
  receiverAssetName: string;
  minUtxoLovelace: string;
};

export type ConfigParameterizeDefaults = {
  configAssetLabel?: string;
  configAssetName: string;
};

export type PaymentHookParameterizeDefaults = {
  paymentHookAssetLabel?: string;
  paymentHookAssetName: string;
  withdrawAddress: string;
  minUtxoLovelace: string;
};

export type ReferenceScriptUtxo = {
  txHash: string;
  outputIndex: number;
  scriptHash: string;
};

export type ReferenceScriptsState = {
  global?: {
    config: ReferenceScriptUtxo;
    coordinator: ReferenceScriptUtxo;
    paymentHook: ReferenceScriptUtxo;
  };
  client?: {
    receiver: ReferenceScriptUtxo;
    pair: ReferenceScriptUtxo;
    pairMint: ReferenceScriptUtxo;
  };
};

export type ProtocolCompiledScripts = {
  configMintPolicy: string;
  configValidator: string;
  coordinatorValidator: string;
  paymentHookMintPolicy: string;
  paymentHookValidator: string;
  referenceHolderValidator: string;
};

export type ClientCompiledScripts = {
  receiverMintPolicy: string;
  receiverValidator: string;
  pairMintPolicy: string;
  pairValidator: string;
  /** Per-client side-deposit spend validator (parametrised by the Receiver
   *  NFT). Persisted like the other client scripts so the merge + the
   *  reference-script publish can load it from state. */
  depositValidator: string;
};

export type ResolvedCompiledScripts = ProtocolCompiledScripts &
  ClientCompiledScripts;

export type TransactionRecord = {
  step: string;
  submittedTxHash: string | null;
  confirmed: boolean;
};

export type ConfigStateArtifact = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  bootstrapRefs: {
    config: {
      txHash: string;
      outputIndex: number;
    };
    paymentHook: {
      txHash: string;
      outputIndex: number;
    } | null;
  };
  scripts: ProtocolDeploymentScripts;
  configState: ConfigState;
  paymentHookState: PaymentHookState | null;
  compiledScripts: ProtocolCompiledScripts;
  drafts?: {
    configParameterize?: ConfigParameterizeDefaults;
    paymentHookParameterize?: PaymentHookParameterizeDefaults;
    receiverParameterize?: ReceiverParameterizeDefaults;
  };
  referenceScripts?: ReferenceScriptsState;
  receiver?: ReceiverArtifact;
  datum: {
    configCbor: string;
    paymentHookCbor: string;
  };
  transactions?: TransactionRecord[];
};

export type ClientStateArtifact = {
  wallet?: {
    source: "seed" | "private-key";
    address: string;
  };
  clientId: string;
  scripts: ClientDeploymentScripts;
  compiledScripts: ClientCompiledScripts;
  drafts?: {
    receiverParameterize?: ReceiverParameterizeDefaults;
  };
  referenceScripts?: {
    client?: {
      receiver: ReferenceScriptUtxo;
      pair: ReferenceScriptUtxo;
      pairMint: ReferenceScriptUtxo;
      /** On-chain reference script for the deposit validator, so the merge tx
       *  references it instead of carrying the script bytes inline. Optional:
       *  absent on client states published before this step / before deposits. */
      deposit?: ReferenceScriptUtxo;
    };
  };
  receiver?: ReceiverArtifact;
  datum: {
    receiverCbor: string;
  };
  transactions?: TransactionRecord[];
};

export type PairLiveState = {
  pairId: string;
  price: string;
  timestamp: string;
  nonce: string;
  intentHash: string;
  signer: string;
  minUtxoLovelace: string;
  intent: DiaOracleIntentInput;
};

export type PairStateArtifact = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  pair: {
    tokenName: string;
    pairId: string;
    pairUnit: string;
    pairValidatorAddress: string;
  };
  pairState: PairLiveState;
  datum: {
    pairCbor: string;
  };
  transactions?: TransactionRecord[];
};

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Shared state tree at offchain/state/. This module lives at
// offchain/cli/src/core/, so three levels up (core → src → cli) reaches offchain/.
const SHARED_STATE_ROOT = path.resolve(CURRENT_DIR, "../../../state");

export function getDefaultStateDir(): string {
  return resolveRunStateDir(networkTag(), SHARED_STATE_ROOT);
}

export function getDefaultConfigStatePath(): string {
  const runPath = path.join(getDefaultStateDir(), "config-bootstrap.json");
  if (existsSync(runPath)) {
    return runPath;
  }
  return path.join(SHARED_STATE_ROOT, networkTag(), "config-bootstrap.json");
}

export function getDefaultClientStatePath(clientId = "client-a"): string {
  const runPath = path.join(getDefaultStateDir(), "clients", `${clientId}.json`);
  if (existsSync(runPath)) {
    return runPath;
  }
  return path.join(SHARED_STATE_ROOT, networkTag(), "clients", `${clientId}.json`);
}

export function getDefaultIntentsDir(): string {
  return path.join(getDefaultStateDir(), "intents");
}

export function getDefaultPairsDir(clientId = "client-a"): string {
  return path.join(getDefaultStateDir(), "clients", clientId, "pairs");
}

export async function readConfigState(
  statePath: string = getDefaultConfigStatePath(),
): Promise<ConfigStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as ConfigStateArtifact;
}

export async function readClientState(
  statePath: string,
): Promise<ClientStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as ClientStateArtifact;
}

export function emptyProtocolCompiledScripts(): ProtocolCompiledScripts {
  return {
    configMintPolicy: "",
    configValidator: "",
    coordinatorValidator: "",
    paymentHookMintPolicy: "",
    paymentHookValidator: "",
    referenceHolderValidator: "",
  };
}

export function emptyReferenceScriptUtxo(): ReferenceScriptUtxo {
  return {
    txHash: "",
    outputIndex: 0,
    scriptHash: "",
  };
}

export function emptyClientCompiledScripts(): ClientCompiledScripts {
  return {
    receiverMintPolicy: "",
    receiverValidator: "",
    pairMintPolicy: "",
    pairValidator: "",
    depositValidator: "",
  };
}

export function appendTransactionRecord(
  records: TransactionRecord[] | undefined,
  entry: TransactionRecord,
): TransactionRecord[] | undefined {
  if (!entry.submittedTxHash) {
    return records;
  }

  return [...(records ?? []), entry];
}

export function hasCompletedStep(
  records: TransactionRecord[] | undefined,
  step: string,
): boolean {
  return Boolean(
    records?.some((entry) => entry.step === step && entry.submittedTxHash),
  );
}

export async function readPairState(
  statePath: string,
): Promise<PairStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as PairStateArtifact;
}

// Same as readPairState, but returns null if the file does not exist
// instead of throwing. Used by the update tx builders to handle the
// "first update for this pair" case.
export async function readOptionalPairState(
  statePath: string,
): Promise<PairStateArtifact | null> {
  try {
    await access(statePath);
  } catch {
    return null;
  }
  return readPairState(statePath);
}
