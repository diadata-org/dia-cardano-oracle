import path from "node:path";

import { readConfigState, type ConfigStateArtifact } from "../core/state.js";

function emptyReferenceScriptUtxo() {
  return {
    txHash: "",
    outputIndex: 0,
    scriptHash: "",
  };
}

export function createClientStateArtifact(state: ConfigStateArtifact): ConfigStateArtifact {
  if (!state.bootstrapRefs.config.txHash || !state.bootstrapRefs.paymentHook?.txHash) {
    throw new Error(
      "Client init requires protocol state after Config and PaymentHook bootstrap.",
    );
  }

  if (!state.configState.paymentHookRef || !state.configState.updateCoordinatorCredential) {
    throw new Error(
      "Client init requires protocol state after PaymentHook bootstrap.",
    );
  }

  return {
    ...state,
    scripts: {
      ...state.scripts,
      pairPolicyId: null,
      pairValidatorHash: null,
      pairValidatorAddress: null,
    },
    referenceScripts: {
      ...state.referenceScripts,
      client: {
        receiver: emptyReferenceScriptUtxo(),
        pair: emptyReferenceScriptUtxo(),
      },
    },
    receiver: undefined,
    datum: {
      ...state.datum,
      receiverCbor: "",
    },
    transaction: undefined,
  };
}

export async function initializeClientState(args: {
  statePath: string;
}): Promise<ConfigStateArtifact> {
  const state = await readConfigState(path.resolve(args.statePath));
  return createClientStateArtifact(state);
}
