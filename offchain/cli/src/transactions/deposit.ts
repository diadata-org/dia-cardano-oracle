// Side-deposit funding CLI (Option A — see
// docs/audit/20260605-receiver-concurrency-and-griefing.md and
// contracts/aiken/validators/deposit.ak).
//
// Three sub-commands:
//   deposit:address  — print the per-client deposit script address. A client
//                      funds their Receiver balance by sending ADA there with
//                      an ORDINARY wallet payment (no CLI, no datum).
//   deposit:fund     — convenience: send a plain ADA payment to that address
//                      from the configured wallet (used by the runbook / tests
//                      to simulate a client funding their deposit).
//   deposit:merge    — sweep accumulated deposit UTxOs into the Receiver's
//                      balance in one tx, reusing the Receiver's `TopUp`
//                      redeemer. The deposit validator only authorises the
//                      spend when the Receiver's lovelace rises by >= the swept
//                      total, so the funds can only ever credit this client.
//
// The deposit address is derived on the fly from the client's Receiver NFT
// (policy id + asset name), so it needs no extra persisted state.

import { stepId, getCliConfig } from "../core/config.js";
import { Constr, type UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";

import {
  makeDepositValidator,
  scriptAddressFromValidator,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  appendTransactionRecord,
  type ClientStateArtifact,
  type ConfigStateArtifact,
} from "../core/state.js";
import { loadReferenceScriptUtxos } from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { completeWithRetry } from "../core/tx-build.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";

// The deposit floor (a UTxO is eligible for a sweep only if it is pure ADA at
// or above this) and the per-merge cap (max deposits folded into one tx) are
// deposit tx-build parameters read from the protocol state's
// `config-bootstrap.json::configState.depositMinLovelace` /
// `configState.depositMaxPerMerge` — set at `protocol:init`, alongside
// `minUtxoLovelace` / `baseFeeLovelace`. This is the SINGLE source shared with
// the feeder daemon (which loads the same `config-bootstrap.json`); there is no
// hardcoded copy here. Dust, native-token "junk", and oversized-datum UTxOs a
// griefer might park at the address are skipped — they stay harmlessly at the
// address and never block the Receiver.

// Read the side-deposit tx-build params from the protocol state's `configState`
// with a clear, actionable error when they are absent — e.g. a deployment
// created before side-deposits existed (its `config-bootstrap.json` has no
// `depositMinLovelace`). This replaces a raw `BigInt(undefined)` crash with a
// message that says exactly why a deposit command does not apply.
function requireDepositConfig(configState: {
  depositMinLovelace?: string;
  depositMaxPerMerge?: string;
  depositMaxPerUpdateFold?: string;
}): { minLovelace: bigint; maxPerMerge: number; maxPerUpdateFold: number } {
  if (
    configState.depositMinLovelace == null ||
    configState.depositMaxPerMerge == null
  ) {
    throw new Error(
      "Side-deposit config not found in config-bootstrap.json::configState " +
        "(depositMinLovelace / depositMaxPerMerge). This deployment predates " +
        "side-deposits — deposit:address / deposit:fund / deposit:merge and the " +
        "update deposit-fold are not available for it.",
    );
  }
  return {
    minLovelace: BigInt(configState.depositMinLovelace),
    maxPerMerge: Number(configState.depositMaxPerMerge),
    maxPerUpdateFold: Number(configState.depositMaxPerUpdateFold ?? "0"),
  };
}

type DepositArgs = {
  clientStatePath: string;
  protocolStatePath: string;
};

async function loadDepositAddress(args: DepositArgs): Promise<{
  state: ClientStateArtifact;
  protocol: ConfigStateArtifact;
  depositValidatorAddress: string;
}> {
  const { client: state, protocol } = await readClientContext({
    clientStatePath: args.clientStatePath,
    protocolStatePath: args.protocolStatePath,
  });
  if (!state.receiver) {
    throw new Error(
      "Deposit commands require a client state produced by receiver:parameterize / bootstrap.",
    );
  }
  const depositValidator = await makeDepositValidator({
    receiverPolicyId: state.receiver.receiverPolicyId,
    receiverAssetName: state.receiver.receiverAssetName,
  });
  return {
    state,
    protocol,
    depositValidatorAddress: scriptAddressFromValidator(depositValidator),
  };
}

/** Print the per-client deposit address (the address a client funds). */
export async function depositAddress(args: DepositArgs): Promise<{
  clientId: string;
  receiverUnit: string;
  depositValidatorAddress: string;
}> {
  const { state, depositValidatorAddress } = await loadDepositAddress(args);
  return {
    clientId: state.clientId,
    receiverUnit: state.receiver!.receiverUnit,
    depositValidatorAddress,
  };
}

/** Plain ADA payment to the deposit address (simulates a client funding it). */
export async function depositFund(args: DepositArgs & {
  amountLovelace: string;
  buildOnly: boolean;
}): Promise<{ depositValidatorAddress: string; submittedTxHash: string | null; confirmed: boolean }> {
  const amountLovelace = toBigInt(args.amountLovelace, "amountLovelace");
  const { protocol, depositValidatorAddress } = await loadDepositAddress(args);
  // Floor from config-bootstrap.json::configState (set at protocol:init), the
  // single source shared with the feeder daemon.
  const { minLovelace } = requireDepositConfig(protocol.configState);
  if (amountLovelace < minLovelace) {
    throw new Error(
      `deposit:fund amount ${amountLovelace} is below the ${minLovelace} lovelace minimum a sweep will accept.`,
    );
  }

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletUtxos = await wallet.getUtxos();

  reportProgress(`Paying ${amountLovelace} lovelace to deposit address ${depositValidatorAddress}`);
  // A plain output, NO datum — exactly how an ordinary client wallet would pay.
  const txSignBuilder = await completeWithRetry(
    () =>
      lucid
        .newTx()
        .pay.ToAddress(depositValidatorAddress, { lovelace: amountLovelace }),
    reportProgress,
  );

  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  let submittedTxHash: string | null = null;
  let confirmed = false;
  if (!args.buildOnly) {
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "deposit fund transaction",
    });
    if (!confirmed) {
      throw new Error(`Transaction ${submittedTxHash} was submitted but confirmation was not observed.`);
    }
    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      transaction: txSignBuilder,
      label: "deposit fund",
    });
  }
  return { depositValidatorAddress, submittedTxHash, confirmed };
}

/** Sweep deposit UTxOs into the Receiver balance (reuses the TopUp redeemer). */
export async function depositMerge(args: DepositArgs & {
  buildOnly: boolean;
}): Promise<{ artifact: ClientStateArtifact; feePaidLovelace: bigint }> {
  const { client: state, protocol } = await readClientContext({
    clientStatePath: args.clientStatePath,
    protocolStatePath: args.protocolStatePath,
  });
  if (!state.receiver) {
    throw new Error("deposit:merge requires a client state after receiver bootstrap.");
  }
  if (!state.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found. Run receiver:parameterize first.");
  }

  const depositValidator = await makeDepositValidator({
    receiverPolicyId: state.receiver.receiverPolicyId,
    receiverAssetName: state.receiver.receiverAssetName,
  });
  const depositValidatorAddress = scriptAddressFromValidator(depositValidator);
  const receiverValidator = spendingValidatorFromCompiledScript(
    state.compiledScripts.receiverValidator,
  );

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([wallet.address(), wallet.getUtxos()]);

  const currentReceiverUtxo = await findSingleUtxoAtUnit(
    lucid,
    state.receiver.receiverValidatorAddress,
    state.receiver.receiverUnit,
    "receiver",
  );

  // Deposit floor + per-merge cap come from config-bootstrap.json::configState
  // (set at protocol:init, the single source shared with the feeder) — never
  // hardcoded here.
  const { minLovelace, maxPerMerge } = requireDepositConfig(protocol.configState);

  // Select clean, ADA-only deposits above the floor; skip dust / token junk /
  // datum-bearing UTxOs (a griefer cannot block the sweep — they stay put).
  const allDepositUtxos = await lucid.utxosAt(depositValidatorAddress);
  const eligible = allDepositUtxos
    .filter((u) => isCleanAdaDeposit(u, minLovelace))
    .slice(0, maxPerMerge);
  const skipped = allDepositUtxos.length - eligible.length;
  if (eligible.length === 0) {
    throw new Error(
      `No eligible deposits to merge at ${depositValidatorAddress} (found ${allDepositUtxos.length} UTxO(s); none were clean ADA >= ${minLovelace} lovelace).`,
    );
  }
  const sweptLovelace = eligible.reduce((acc, u) => acc + (u.assets.lovelace ?? 0n), 0n);
  reportProgress(
    `Merging ${eligible.length} deposit(s) totalling ${sweptLovelace} lovelace (${skipped} skipped) into the receiver`,
  );

  const currentReceiverState = currentReceiverUtxo.datum
    ? decodeReceiverDatum(currentReceiverUtxo.datum)
    : state.receiver.receiverState;
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (BigInt(currentReceiverState.balanceLovelace) + sweptLovelace).toString(),
  };
  const receiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  // Both redeemers are the single-constructor case at index 0:
  //   receiver_logic.TopUp  (credit balance by the lovelace delta)
  //   deposit_logic CollectDeposit
  const topUpRedeemer = Data.to(new Constr(0, []));
  const collectDepositRedeemer = Data.to(new Constr(0, []));

  const { utxos: referenceScriptUtxos, missing: missingReferenceScript } =
    await loadReferenceScriptUtxos(
      [
        {
          key: "receiver",
          label: "receiver",
          outRef: state.referenceScripts?.client?.receiver
            ? {
                txHash: state.referenceScripts.client.receiver.txHash,
                outputIndex: state.referenceScripts.client.receiver.outputIndex,
              }
            : null,
        },
        {
          key: "deposit",
          label: "deposit",
          outRef: state.referenceScripts?.client?.deposit
            ? {
                txHash: state.referenceScripts.client.deposit.txHash,
                outputIndex: state.referenceScripts.client.deposit.outputIndex,
              }
            : null,
        },
      ] as const,
      reportProgress,
    );

  // Attach inline only the scripts whose reference UTxO is missing on-chain
  // (e.g. on a state published before the deposit ref-script existed).
  if (missingReferenceScript.receiver) {
    reportProgress("Receiver reference script missing on-chain; attaching the receiver validator inline.");
  }
  if (missingReferenceScript.deposit) {
    reportProgress("Deposit reference script missing on-chain; attaching the deposit validator inline.");
  }

  const receiver = state.receiver;
  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .readFrom(referenceScriptUtxos)
      .collectFrom([currentReceiverUtxo], topUpRedeemer)
      .collectFrom(eligible, collectDepositRedeemer)
      .pay.ToContract(
        receiver.receiverValidatorAddress,
        { kind: "inline", value: receiverDatumCbor },
        {
          lovelace:
            BigInt(nextReceiverState.minUtxoLovelace) +
            BigInt(nextReceiverState.balanceLovelace) +
            BigInt(nextReceiverState.accruedToHookLovelace),
          [receiver.receiverUnit]: 1n,
        },
      );
    if (missingReferenceScript.receiver) {
      txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
    }
    if (missingReferenceScript.deposit) {
      txBuilder = txBuilder.attach.SpendingValidator(depositValidator);
    }
    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx, reportProgress);
  const { feeLovelace } = reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
  logEffectiveOutputs(txSignBuilder, reportProgress);
  let submittedTxHash: string | null = null;
  let confirmed = false;

  if (!args.buildOnly) {
    const signedTx = await txSignBuilder.sign.withWallet().complete();
    submittedTxHash = await signedTx.submit();
    reportProgress(`Submitted transaction hash: ${submittedTxHash}`);
    confirmed = await awaitTxConfirmation({
      lucid,
      txHash: submittedTxHash,
      reportProgress,
      label: "deposit merge transaction",
    });
    if (!confirmed) {
      throw new Error(`Transaction ${submittedTxHash} was submitted but confirmation was not observed.`);
    }
    await waitForWalletSettlement({
      wallet,
      previousUtxos: walletUtxos,
      transaction: txSignBuilder,
      label: "deposit merge",
    });
    await waitForUnitUtxoReplacement({
      lucid,
      address: state.receiver.receiverValidatorAddress,
      unit: state.receiver.receiverUnit,
      label: "receiver",
      previousOutRef: currentReceiverUtxo,
    });
  }

  return {
    artifact: {
      ...state,
      wallet: { source, address: walletAddress },
      receiver: { ...state.receiver, receiverState: nextReceiverState },
      datum: { ...state.datum, receiverCbor: receiverDatumCbor },
      transactions: appendTransactionRecord(state.transactions, {
        step: stepId("deposit:merge"),
        submittedTxHash,
        confirmed,
      }),
    },
    feePaidLovelace: feeLovelace,
  };
}

/** A clean, sweepable deposit: pure ADA (only `lovelace`), at or above the
 *  floor. `minLovelace` is the configured floor from
 *  `config-bootstrap.json::configState.depositMinLovelace` (set at
 *  protocol:init). Exported for unit testing the selection predicate. */
export function isCleanAdaDeposit(utxo: UTxO, minLovelace: bigint): boolean {
  const assetKeys = Object.keys(utxo.assets);
  const onlyAda = assetKeys.length === 1 && assetKeys[0] === "lovelace";
  const lovelace = utxo.assets.lovelace ?? 0n;
  return onlyAda && lovelace >= minLovelace;
}

/**
 * Resolve the clean side-deposit UTxOs an oracle update may opportunistically
 * fold into its Receiver output. Reuses the EXACT selection the standalone
 * `deposit:merge` applies (`isCleanAdaDeposit`, ≥ floor) but caps the count at
 * `configState.depositMaxPerUpdateFold` (smaller than the merge cap, so the
 * fold stays within the tx budget alongside a price update). Both the floor
 * and the fold cap come from the protocol state's `configState` (set at the
 * CLI's protocol:init) — no hardcoded values.
 *
 * Returns the selected UTxOs plus the deposit validator + its on-chain
 * reference outRef, ready to hand to `buildOracleUpdateTx`'s `depositFold`.
 * When there are no eligible deposits, `utxos` is empty and the caller builds
 * the pure-update tx unchanged.
 */
export async function selectDepositsForUpdateFold(args: {
  lucid: import("@lucid-evolution/lucid").LucidEvolution;
  client: ClientStateArtifact;
  protocol: ConfigStateArtifact;
}): Promise<{
  utxos: UTxO[];
  depositValidator: import("@lucid-evolution/lucid").SpendingValidator;
  depositValidatorAddress: string;
  referenceOutRef: { txHash: string; outputIndex: number; scriptHash: string } | null;
  sweptLovelace: bigint;
}> {
  const { lucid, client, protocol } = args;
  if (!client.receiver) {
    throw new Error("selectDepositsForUpdateFold requires a client state after receiver bootstrap.");
  }
  const depositValidator = await makeDepositValidator({
    receiverPolicyId: client.receiver.receiverPolicyId,
    receiverAssetName: client.receiver.receiverAssetName,
  });
  const depositValidatorAddress = scriptAddressFromValidator(depositValidator);
  // Floor + fold cap come from configState (protocol:init), never hardcoded.
  const { minLovelace, maxPerUpdateFold: maxPerFold } = requireDepositConfig(
    protocol.configState,
  );

  const allDepositUtxos = await lucid.utxosAt(depositValidatorAddress);
  const utxos = allDepositUtxos
    .filter((u) => isCleanAdaDeposit(u, minLovelace))
    .slice(0, maxPerFold);
  const sweptLovelace = utxos.reduce((acc, u) => acc + (u.assets.lovelace ?? 0n), 0n);

  return {
    utxos,
    depositValidator,
    depositValidatorAddress,
    referenceOutRef: client.referenceScripts?.client?.deposit ?? null,
    sweptLovelace,
  };
}

function reportProgress(message: string): void {
  console.error(`[deposit] ${message}`);
}
