import { unlink } from "node:fs/promises";
import { stepId, getCliConfig } from "../core/config.js";
import path from "node:path";
import { confirm } from "@inquirer/prompts";

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
  readSignedIntentInput,
  recoverDiaOracleIntentWitness,
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
  readOptionalPairState,
  type PairStateArtifact,
} from "../core/state.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { getNetworkNow } from "../core/network-time.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  findSingleUtxoAtUnit,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";
import { buildOracleUpdateTx } from "../lib/transactions/build-oracle-update.js";

export async function submitOracleUpdate(args: {
  intentPath: string;
  statePath: string;
  clientStatePath: string;
  protocolStatePath: string;
  buildOnly: boolean;
}): Promise<PairStateArtifact> {
  reportProgress(`Loading signed intent from ${path.resolve(args.intentPath)}`);
  const input = await readSignedIntentInput(path.resolve(args.intentPath));
  const intent = normalizeDiaOracleIntent(input);

  const statePath = path.resolve(args.statePath);
  reportProgress(`Loading client and protocol state`);
  const { client, protocol } = await readClientContext({
    clientStatePath: args.clientStatePath,
    protocolStatePath: args.protocolStatePath,
  });
  if (!client.receiver) {
    throw new Error("Oracle update requires client state after Receiver bootstrap.");
  }
  if (!client.scripts.pairPolicyId || !client.scripts.pairValidatorHash || !client.scripts.pairValidatorAddress) {
    throw new Error("Oracle update requires client state after Receiver/Pair parameterization.");
  }
  assertOracleUpdateBootstrapRefsResolved(protocol.bootstrapRefs);

  let existingPair = await readOptionalPairState(statePath);
  if (
    existingPair &&
    existingPair.pair.pairValidatorAddress !== client.scripts.pairValidatorAddress
  ) {
    reportProgress(
      `Pair state file ${statePath} is from a different deployment. If you continue, the file will be deleted and recreated from the signed intent.`,
    );
    reportProgress(`  state file pair address: ${existingPair.pair.pairValidatorAddress}`);
    reportProgress(`  current deployment    : ${client.scripts.pairValidatorAddress}`);
    const proceed = await confirm({
      message:
        "Delete the stale pair state file and continue (the next update will mint a new Pair NFT and create the Pair UTxO from the signed intent)?",
      default: true,
    });
    if (!proceed) {
      throw new Error("Aborted by user. Stale pair state file was kept.");
    }
    await unlink(statePath);
    reportProgress(`Removed stale pair state file ${statePath}`);
    existingPair = null;
  }

  if (!client.compiledScripts.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found. Run receiver:parameterize first.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);
  const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
  const pairTokenName = diaIntentTokenNameFromSymbol(intent);
  const pairUnit = `${pairPolicyId}${pairTokenName}`;
  if (!client.compiledScripts.pairValidator) {
    throw new Error("pairValidator compiled script not found. Run receiver:parameterize first.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
  const pairValidatorHash = scriptHashFromValidator(pairValidator);
  const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
  const pairId = diaPairIdHex(intent);
  const isCreate = !existingPair;
  const minUtxoLovelace = existingPair?.pairState.minUtxoLovelace ?? protocol.configState.minUtxoLovelace;

  const pair: PairStateArtifact = existingPair ?? {
    wallet: { source: "seed", address: "" },
    pair: { tokenName: pairTokenName, pairId, pairUnit, pairValidatorAddress },
    pairState: {
      pairId,
      price: "0",
      timestamp: "0",
      nonce: "0",
      intentHash: "00".repeat(32),
      signer: "00".repeat(20),
      minUtxoLovelace,
      intent: diaIntentToState(intent),
    },
    datum: { pairCbor: "" },
  };

  const state = {
    ...pair,
    bootstrapRefs: protocol.bootstrapRefs,
    scripts: { ...protocol.scripts, ...client.scripts },
    configState: protocol.configState,
    compiledScripts: { ...protocol.compiledScripts, ...client.compiledScripts },
    referenceScripts: { ...protocol.referenceScripts, ...client.referenceScripts },
    receiver: client.receiver,
    datum: {
      configCbor: protocol.datum.configCbor,
      receiverCbor: client.datum.receiverCbor,
      pairCbor: pair.datum.pairCbor,
    },
  };

  if (pairValidatorHash !== state.scripts.pairValidatorHash) {
    throw new Error("Pair validator hash does not match the current blueprint.");
  }

  const domain = normalizeDiaEip712Domain({
    name: state.configState.domain.name,
    version: state.configState.domain.version,
    sourceChainId: state.configState.domain.sourceChainId,
    verifyingContract: state.configState.domain.verifyingContract,
  });
  const witness = recoverDiaOracleIntentWitness(domain, intent);
  if (!state.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
    throw new Error(
      "The recovered DIA signer public key is not authorized in the provided config state.",
    );
  }
  if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
    throw new Error(`Intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
  }
  assertOracleIntentTimestampAndNonceMonotonic({
    isCreate,
    intentTimestamp: intent.timestamp,
    intentNonce: intent.nonce,
    pairStateTimestamp: state.pairState.timestamp,
    pairStateNonce: state.pairState.nonce,
  });

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  if (isCreate) {
    // Pair creation is admin-gated on-chain (pair_state.mint MintPairs).
    // Fail loudly here rather than producing a tx the chain will reject.
    assertPaymentKeyHashIsConfigSigner(
      walletDefaults.paymentKeyHash,
      protocol.configState.validConfigSigners,
      {
        unauthorizedMessage:
          "Pair creation requires the configured wallet to be a config admin (config_admins). The current wallet is not authorized.",
      },
    );
  }

  const networkNow = await getNetworkNow(lucid);
  assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

  const currentConfigUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.scripts.configValidatorAddress,
    state.scripts.configUnit,
    "config",
  );
  const currentPairUtxo = isCreate
    ? null
    : await findSingleUtxoAtUnit(
        lucid,
        state.pair.pairValidatorAddress,
        state.pair.pairUnit,
        "pair",
      );
  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.receiver.receiverValidatorAddress,
    state.receiver.receiverUnit,
    "receiver",
  );
  reportProgress(`Building ${getCliConfig().cardanoNetwork} oracle update transaction`);
  const { txSignBuilder, nextPairState, nextPairDatumCbor } = await buildOracleUpdateTx(lucid, {
    isCreate,
    intent,
    witness,
    networkNow,
    currentConfigUtxo,
    currentPairUtxo,
    currentReceiverUtxo,
    walletPaymentKeyHash: walletDefaults.paymentKeyHash,
    scripts: state.scripts,
    compiledScripts: state.compiledScripts,
    referenceScripts: state.referenceScripts,
    configState: state.configState,
    pairState: state.pairState,
    pair: state.pair,
    receiver: state.receiver,
  });

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
      txHash: submittedTxHash!,
      reportProgress,
      label: "oracle update transaction",
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
      requireChangeWhenNoSpentUtxos: true,
      label: "oracle update",
    });
  }

  if (!args.buildOnly && confirmed) {
    await Promise.all([
      waitForUnitUtxoReplacement({
        lucid,
        address: state.pair.pairValidatorAddress,
        unit: state.pair.pairUnit,
        label: "pair",
        previousOutRef: currentPairUtxo ?? undefined,
      }),
      waitForUnitUtxoReplacement({
        lucid,
        address: state.receiver.receiverValidatorAddress,
        unit: state.receiver.receiverUnit,
        label: "receiver",
        previousOutRef: currentReceiverUtxo,
      }),
    ]);
  }

  return {
    wallet: { source, address: walletAddress },
    pair: { ...state.pair },
    pairState: nextPairState,
    datum: { pairCbor: nextPairDatumCbor },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("update"),
      submittedTxHash,
      confirmed,
    }),
  };
}

function reportProgress(message: string): void {
  console.error(`[update] ${message}`);
}
