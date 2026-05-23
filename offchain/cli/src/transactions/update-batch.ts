import { readFile } from "node:fs/promises";
import { stepId, getCliConfig } from "../core/config.js";
import path from "node:path";

import {
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  assertDiaOracleIntentNotExpired,
  diaIntentToState,
  diaIntentTokenNameFromSymbol,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
  readSignedIntentInput,
  type DiaOracleIntent,
} from "../core/dia-intent.js";
import {
  assertOracleIntentTimestampAndNonceMonotonic,
  assertOracleUpdateBootstrapRefsResolved,
  assertPaymentKeyHashIsConfigSigner,
} from "../preflight/index.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  hasCompletedStep,
  readOptionalPairState,
  type ConfigStateArtifact,
  type ClientStateArtifact,
  type PairStateArtifact,
  type ResolvedCompiledScripts,
  type ResolvedDeploymentScripts,
  type ReferenceScriptsState,
} from "../core/state.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { getNetworkNow } from "../core/network-time.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildPairDatumCbor,
  buildReceiverDatumCbor,
  findSingleUtxoAtUnit,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
  writeJsonFile,
} from "../core/chain-helpers.js";
import { buildBatchOracleUpdateTx } from "../lib/transactions/build-batch-oracle-update.js";

type BatchUpdateEntry = {
  statePath: string;
  outPath?: string;
  intentPath: string;
};

type BatchUpdateInput = {
  updates: BatchUpdateEntry[];
};

type BatchUpdateResult = {
  wallet: {
    source: "seed" | "private-key";
    address: string;
  };
  receiver: ResolvedPairStateArtifact["receiver"];
  pairs: Array<{
    statePath: string;
    outPath: string;
    pairId: string;
    pairUnit: string;
  }>;
  transactions?: ConfigStateArtifact["transactions"];
};

type ResolvedPairStateArtifact = PairStateArtifact & {
  bootstrapRefs: ConfigStateArtifact["bootstrapRefs"];
  scripts: ResolvedDeploymentScripts;
  configState: ConfigStateArtifact["configState"];
  paymentHookState: NonNullable<ConfigStateArtifact["paymentHookState"]>;
  compiledScripts: ResolvedCompiledScripts;
  referenceScripts?: ReferenceScriptsState;
  receiver: NonNullable<ClientStateArtifact["receiver"]>;
  datum: PairStateArtifact["datum"] & {
    configCbor: string;
    paymentHookCbor: string;
    receiverCbor: string;
  };
};

export async function submitBatchOracleUpdate(args: {
  manifestPath: string;
  clientStatePath: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<BatchUpdateResult> {
  reportProgress(`Loading batch update manifest from ${path.resolve(args.manifestPath)}`);
  const input = await readBatchUpdateInput(path.resolve(args.manifestPath));

  if (input.updates.length === 0) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  const context = await readClientContext({
    clientStatePath: path.resolve(args.clientStatePath),
    protocolStatePath: path.resolve(args.protocolStatePath),
  });
  if (!context.client.receiver) {
    throw new Error("Batch update requires client state after Receiver bootstrap.");
  }
  if (
    !context.client.scripts.pairPolicyId ||
    !context.client.scripts.pairValidatorHash ||
    !context.client.scripts.pairValidatorAddress
  ) {
    throw new Error("Batch update requires client state after Receiver/Pair parameterization.");
  }
  assertOracleUpdateBootstrapRefsResolved(context.protocol.bootstrapRefs);
  if (!context.client.compiledScripts.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run receiver:parameterize first.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(context.client.compiledScripts.pairMintPolicy);
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  if (!context.client.compiledScripts.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(context.client.compiledScripts.pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);

  const states = await Promise.all(
    input.updates.map(async (entry) => {
      const loadedIntent = await readSignedIntentInput(path.resolve(entry.intentPath));
      const intent = normalizeDiaOracleIntent(loadedIntent);
      const existingPair = await readOptionalPairState(path.resolve(entry.statePath));
      const pair = existingPair ?? createPairArtifactFromIntent({
        intent,
        pairPolicyId,
        pairValidatorAddress,
        minUtxoLovelace: context.protocol.configState.minUtxoLovelace,
      });
      return {
        entry,
        protocol: context.protocol,
        client: context.client,
        artifact: resolvePairArtifact(pair, context.client, context.protocol),
        intent: loadedIntent,
        isCreate: !existingPair,
      };
    }),
  );

  const [first] = states;
  if (!first) {
    throw new Error("Batch update requires at least one pair update entry.");
  }

  ensureCompatibleBatch(states.map(({ artifact }) => artifact));
  const state = first.artifact;
  const protocolState = first.protocol;
  const clientState = first.client;
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const clientStatePath = path.resolve(args.clientStatePath);
  if (!state.receiver) {
    throw new Error("Batch update requires pair artifacts produced under the receiver architecture.");
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });
  const hasCreate = states.some(({ isCreate }) => isCreate);
  if (hasCreate) {
    // Any batch that includes a pair creation MUST be signed by a config
    // admin (pair_state.mint MintPairs is admin-gated). Pure-update
    // batches do not need this.
    assertPaymentKeyHashIsConfigSigner(
      walletDefaults.paymentKeyHash,
      protocolState.configState.validConfigSigners,
      {
        unauthorizedMessage:
          "Batch update includes one or more pair creations and requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
      },
    );
  }
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  if (!state.compiledScripts.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);
  const receiverValidatorHash = scriptHashFromValidator(receiverValidator);
  if (receiverValidatorHash !== state.receiver.receiverValidatorHash) {
    throw new Error("Receiver validator hash does not match the current blueprint.");
  }

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });

  const networkNow = await getNetworkNow(lucid);

  const batchEntries = states.map(({ entry, artifact, intent: loadedIntent, isCreate }) => {
    const intent = normalizeDiaOracleIntent(loadedIntent);
    const witness = recoverDiaOracleIntentWitness(domain, intent);

    if (!artifact.receiver) {
      throw new Error(`State file ${entry.statePath} is missing receiver metadata.`);
    }
    if (!artifact.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
      throw new Error(
        `Recovered DIA signer public key ${witness.signerPublicKey} is not authorized for ${entry.statePath}.`,
      );
    }
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate,
      intentTimestamp: intent.timestamp,
      intentNonce: intent.nonce,
      pairStateTimestamp: artifact.pairState.timestamp,
      pairStateNonce: artifact.pairState.nonce,
      batchStatePath: entry.statePath,
    });
    assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

    return { entry, pairArtifact: artifact, intent, witness, isCreate };
  });

  const [currentConfigUtxo, currentReceiverUtxo] = await Promise.all([
    findSingleUtxoAtUnit(lucid, state.scripts.configValidatorAddress, state.scripts.configUnit, "config"),
    findSingleUtxoAtUnit(lucid, state.receiver.receiverValidatorAddress, state.receiver.receiverUnit, "receiver"),
  ]);

  const currentPairEntries = await Promise.all(
    batchEntries
      .filter(({ isCreate }) => !isCreate)
      .map(async ({ pairArtifact }) => ({
        unit: pairArtifact.pair.pairUnit,
        utxo: await findSingleUtxoAtUnit(
          lucid,
          pairArtifact.pair.pairValidatorAddress,
          pairArtifact.pair.pairUnit,
          `pair ${pairArtifact.pair.pairId}`,
        ),
      })),
  );
  const currentPairUtxoByUnit = new Map(
    currentPairEntries.map(({ unit, utxo }) => [unit, utxo]),
  );

  reportProgress(`Building ${getCliConfig().cardanoNetwork} oracle batch update transaction`);
  const {
    txSignBuilder,
    nextReceiverState,
    nextReceiverDatumCbor: _nextReceiverDatumCbor,
    updatedPairStates,
  } = await buildBatchOracleUpdateTx(lucid, {
    entries: batchEntries.map(({ pairArtifact, intent, witness, isCreate }) => ({
      intent,
      witness,
      pairArtifact,
      isCreate,
    })),
    networkNow,
    currentConfigUtxo,
    currentReceiverUtxo,
    currentPairUtxoByUnit,
    walletPaymentKeyHash: walletDefaults.paymentKeyHash,
    protocolState,
    clientState,
  });

  // Build a map from pairUnit -> nextPairState for result assembly below
  const nextPairStateByUnit = new Map(
    updatedPairStates.map(({ pairUnit, nextPairState }) => [pairUnit, nextPairState]),
  );

  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  const unsignedHash = txSignBuilder.toHash();
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    reportProgress(`Unsigned transaction ready: ${unsignedHash}`);
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "oracle batch update transaction",
    });
    if (!confirmed) {
      throw new Error(
        `Transaction ${submittedTxHash} was submitted but confirmation was not observed.`,
      );
    }

    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      spentUtxos: [],
      label: "oracle batch update",
      requireChangeWhenNoSpentUtxos: true,
    });
  }

  if (!args.buildOnly && confirmed) {
    await Promise.all([
      ...batchEntries.map(({ pairArtifact }) =>
        waitForUnitUtxoReplacement({
          lucid,
          address: pairArtifact.pair.pairValidatorAddress,
          unit: pairArtifact.pair.pairUnit,
          label: `pair ${pairArtifact.pair.pairId}`,
          previousOutRef: currentPairUtxoByUnit.get(pairArtifact.pair.pairUnit),
        }),
      ),
      waitForUnitUtxoReplacement({
        lucid,
        address: state.receiver.receiverValidatorAddress,
        unit: state.receiver.receiverUnit,
        label: "receiver",
        previousOutRef: currentReceiverUtxo,
      }),
    ]);
  }


  const updatedArtifacts = batchEntries.map(({ entry, pairArtifact: artifact }) => {
    const nextPairState = nextPairStateByUnit.get(artifact.pair.pairUnit)!;
    const updatedArtifact: PairStateArtifact = {
      wallet: {
        source,
        address: walletAddress,
      },
      pair: {
        ...artifact.pair,
      },
      pairState: nextPairState,
      datum: {
        pairCbor: buildPairDatumCbor(nextPairState),
      },
      transactions: appendTransactionRecord(artifact.transactions, {
        step: stepId("update:batch"),
        submittedTxHash,
        confirmed,
      }),
    };

    return {
      entry,
      artifact: updatedArtifact,
    };
  });

  if (!args.buildOnly && confirmed) {
    for (const { entry, artifact } of updatedArtifacts) {
      await writeJsonFile(entry.outPath ?? entry.statePath, artifact);
    }
    if (clientStatePath && clientState.receiver) {
      await writeJsonFile(clientStatePath, {
        ...clientState,
        wallet: {
          source,
          address: walletAddress,
        },
        receiver: {
          ...clientState.receiver,
          receiverState: nextReceiverState,
        },
        datum: {
          ...clientState.datum,
          receiverCbor: buildReceiverDatumCbor(nextReceiverState),
        },
        transactions: appendTransactionRecord(clientState.transactions, {
          step: stepId("update:batch"),
          submittedTxHash,
          confirmed,
        }),
      });
    }
  }

  return {
    wallet: {
      source,
      address: walletAddress,
    },
    receiver: {
      ...state.receiver,
      receiverState: nextReceiverState,
    },
    pairs: updatedArtifacts.map(({ entry, artifact }) => ({
      statePath: path.resolve(entry.statePath),
      outPath: path.resolve(entry.outPath ?? entry.statePath),
      pairId: artifact.pair.pairId,
      pairUnit: artifact.pair.pairUnit,
    })),
    transactions: appendTransactionRecord(undefined, {
      step: stepId("update:batch"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[update:batch] ${message}`);
}

async function readBatchUpdateInput(inputPath: string): Promise<BatchUpdateInput> {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw) as BatchUpdateInput;
}

function createPairArtifactFromIntent(args: {
  intent: DiaOracleIntent;
  pairPolicyId: string;
  pairValidatorAddress: string;
  minUtxoLovelace: string;
}): PairStateArtifact {
  const pairId = diaPairIdHex(args.intent);
  const tokenName = diaIntentTokenNameFromSymbol(args.intent);
  return {
    wallet: {
      source: "seed",
      address: "",
    },
    pair: {
      tokenName,
      pairId,
      pairUnit: `${args.pairPolicyId}${tokenName}`,
      pairValidatorAddress: args.pairValidatorAddress,
    },
    pairState: {
      pairId,
      price: "0",
      timestamp: "0",
      nonce: "0",
      intentHash: "00".repeat(32),
      signer: "00".repeat(20),
      minUtxoLovelace: args.minUtxoLovelace,
      intent: diaIntentToState(args.intent),
    },
    datum: {
      pairCbor: "",
    },
  };
}

export function resolvePairArtifact(
  artifact: PairStateArtifact,
  clientState: ClientStateArtifact,
  protocolState: ConfigStateArtifact,
): ResolvedPairStateArtifact {
  if (
    !protocolState.paymentHookState ||
    !hasCompletedStep(protocolState.transactions, stepId("payment-hook:bootstrap"))
  ) {
    throw new Error("Batch update requires protocol state after PaymentHook bootstrap.");
  }

  if (!clientState.receiver) {
    throw new Error("Batch update requires client state after Receiver bootstrap.");
  }

  return {
    ...artifact,
    bootstrapRefs: protocolState.bootstrapRefs,
    scripts: {
      ...protocolState.scripts,
      ...clientState.scripts,
    },
    configState: protocolState.configState,
    paymentHookState: protocolState.paymentHookState,
    compiledScripts: {
      ...protocolState.compiledScripts,
      ...clientState.compiledScripts,
    },
    referenceScripts: {
      ...protocolState.referenceScripts,
      ...clientState.referenceScripts,
    },
    receiver: clientState.receiver,
    datum: {
      ...artifact.datum,
      configCbor: protocolState.datum.configCbor,
      paymentHookCbor: protocolState.datum.paymentHookCbor,
      receiverCbor: clientState.datum.receiverCbor,
    },
  };
}

// Canonical batch order — the on-chain coordinator rejects any batch whose
// witnesses are not strictly ascending by `bytearray.compare` on
// `pair_token_name` during its main witness walk. Pair token names are
// `blake2b_256(pair_id)` bytes serialized as lowercase even-length hex by
// the CLI, so a bytewise compare on the decoded bytes is equivalent to a
// plain lexicographic compare on the normalized hex string. We avoid
// `localeCompare` because it can apply locale-sensitive collation that
// diverges from byte order on some platforms; we normalize first to
// guarantee that the input matches the on-chain expectation.
export function sortBatchUpdatesByPairTokenName<
  T extends { artifact: { pair: { tokenName: string } } },
>(updates: T[]): T[] {
  const normalized = updates.map((update) => ({
    update,
    tokenName: normalizeHex(update.artifact.pair.tokenName, "pair.tokenName"),
  }));
  normalized.sort((left, right) => compareHexBytewise(left.tokenName, right.tokenName));
  return normalized.map(({ update }) => update);
}

// Bytewise comparison on two already-normalized (lowercase, even-length)
// hex strings. Equivalent to `bytearray.compare` on the decoded bytes:
// hex digits 0-9 < a-f preserve byte order, and pair-wise hex chars
// inherit byte order from their numeric value.
export function compareHexBytewise(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function ensureCompatibleBatch(states: ResolvedPairStateArtifact[]): void {
  const [head, ...tail] = states;
  if (!head || !head.receiver) {
    throw new Error("Batch update requires at least one pair artifact with receiver metadata.");
  }

  const seenPairUnits = new Set<string>();
  for (const state of states) {
    if (!state.receiver) {
      throw new Error("Batch update requires pair artifacts with receiver metadata.");
    }

    if (
      state.receiver.receiverUnit !== head.receiver.receiverUnit ||
      state.scripts.configUnit !== head.scripts.configUnit ||
      state.scripts.paymentHookUnit !== head.scripts.paymentHookUnit ||
      state.scripts.pairPolicyId !== head.scripts.pairPolicyId
    ) {
      throw new Error("Batch update entries must belong to the same client deployment.");
    }

    if (seenPairUnits.has(state.pair.pairUnit)) {
      throw new Error(`Duplicate pair state included in batch: ${state.pair.pairUnit}`);
    }
    seenPairUnits.add(state.pair.pairUnit);
  }

  for (const state of tail) {
    if (state.pair.pairValidatorAddress !== head.pair.pairValidatorAddress) {
      throw new Error("Batch update entries must target the same client pair validator.");
    }
  }
}
