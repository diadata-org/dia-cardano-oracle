import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiaOracleIntentInput } from "./dia-intent.js";

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
  allowedPairs: PairEntryState[];
  paymentHookRef: PaymentHookRefState | null;
  updateCoordinatorCredential: CoordinatorCredentialState | null;
  minUtxoLovelace: string;
};

export type PaymentHookState = {
  withdrawAddress: string;
  protocolFeePerTxLovelace: string;
  minUtxoLovelace: string;
  accruedFeesLovelace: string;
  lifetimeFeesCollectedLovelace: string;
  lifetimeFeesWithdrawnLovelace: string;
  feeChargeCount: string;
};

export type DeploymentScripts = {
  configPolicyId: string;
  configUnit: string;
  configValidatorHash: string;
  configValidatorAddress: string;
  pairPolicyId: string;
  pairValidatorHash: string;
  pairValidatorAddress: string;
  coordinatorHash: string;
  coordinatorRewardAddress: string;
  paymentHookPolicyId: string | null;
  paymentHookUnit: string | null;
  paymentHookValidatorHash: string | null;
  paymentHookValidatorAddress: string | null;
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
  scripts: DeploymentScripts;
  configState: ConfigState;
  configUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
  paymentHookState: PaymentHookState | null;
  paymentHookUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  } | null;
  datum: {
    configCbor: string;
    paymentHookCbor: string | null;
  };
  transaction?: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
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
  bootstrapRefs: {
    config: {
      txHash: string;
      outputIndex: number;
    };
    paymentHook: {
      txHash: string;
      outputIndex: number;
    };
  };
  scripts: DeploymentScripts;
  configState: ConfigState;
  configUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
  paymentHookState: PaymentHookState;
  paymentHookUtxo: {
    current: {
      txHash: string;
      outputIndex: number;
    };
  };
  pair: {
    tokenName: string;
    pairId: string;
    pairUnit: string;
    pairValidatorAddress: string;
    stateUtxo: {
      txHash: string;
      outputIndex: number;
    };
  };
  pairState: PairLiveState;
  datum: {
    configCbor: string;
    paymentHookCbor: string;
    pairCbor: string;
  };
  transaction?: {
    submittedTxHash: string | null;
    confirmed: boolean;
  };
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
  return JSON.parse(raw) as ConfigStateArtifact;
}

export function getDefaultConfigStatePath(): string {
  return DEFAULT_PREVIEW_CONFIG_STATE_PATH;
}

export async function readPairState(
  statePath: string,
): Promise<PairStateArtifact> {
  const raw = await readFile(path.resolve(statePath), "utf8");
  return JSON.parse(raw) as PairStateArtifact;
}
