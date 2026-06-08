import { readFile } from "node:fs/promises";
import path from "node:path";

import { getCliConfig } from "../core/config.js";
import {
  signDiaOracleIntentInput,
  type DiaEip712DomainInput,
  type UnsignedDiaOracleIntentInput,
} from "../core/dia-intent.js";

export type IntentSignInput = {
  domain: DiaEip712DomainInput;
  intent: UnsignedDiaOracleIntentInput;
};

type SignedPreviewOracleIntent = {
  intent: ReturnType<typeof signDiaOracleIntentInput>["intent"];
  witness: {
    signerPublicKey: string;
    signerAddress: string;
    intentHash: string;
    compactSignature: string;
  };
};

// The LOCAL self-sign key (ours): DIA_AUTHORIZED_PRIVATE_KEY_<network>. The CLI /
// run-all sign demo OracleIntents with it; its derived public key must be in the
// deployment's authorized set. DIA's real intents are signed by DIA's own keys —
// we only authorize their public halves via DIA_AUTHORIZED_PUBLIC_KEYS_<network>.
function requireIntentSigningPrivateKey(): string {
  const { authorizedDiaPrivateKey, networkSuffix } = getCliConfig();
  if (!authorizedDiaPrivateKey) {
    throw new Error(
      `Missing required environment variable: DIA_AUTHORIZED_PRIVATE_KEY_${networkSuffix}`,
    );
  }
  return authorizedDiaPrivateKey;
}

export function signPreviewOracleIntentFromInput(args: {
  input: IntentSignInput;
}): SignedPreviewOracleIntent {
  const signed = signDiaOracleIntentInput({
    domain: args.input.domain,
    intent: args.input.intent,
    privateKey: requireIntentSigningPrivateKey(),
  });

  return {
    intent: signed.intent,
    witness: {
      signerPublicKey: signed.signerPublicKey,
      signerAddress: signed.signerAddress,
      intentHash: signed.intentHash,
      compactSignature: signed.compactSignature,
    },
  };
}

export async function signPreviewOracleIntent(args: {
  inputPath: string;
}): Promise<SignedPreviewOracleIntent> {
  const input = await readIntentSignInput(path.resolve(args.inputPath));
  return signPreviewOracleIntentFromInput({ input });
}

async function readIntentSignInput(inputPath: string): Promise<IntentSignInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as IntentSignInput;
}
