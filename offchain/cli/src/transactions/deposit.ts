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
} from "../core/state.js";
import {
  isAnyReferenceScriptMissing,
  loadReferenceScriptUtxos,
} from "../core/reference-scripts.js";
import { reportTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { logEffectiveOutputs } from "../core/output-logging.js";
import { awaitTxConfirmation } from "../core/tx-confirmation.js";
import { readClientContext } from "../core/artifact-context.js";
import {
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  toBigInt,
  waitForWalletSettlement,
  waitForUnitUtxoReplacement,
} from "../core/chain-helpers.js";

// A deposit UTxO is eligible for a sweep only if it is pure ADA at or above
// this floor. Dust, native-token "junk", and oversized-datum UTxOs a griefer
// might park at the address are skipped — they stay harmlessly at the address
// and never block the Receiver. Sourced here (not the YAML) because it is a
// CLI ergonomics default; the feeder daemon reads its own configured floor.
const MIN_DEPOSIT_LOVELACE = 1_000_000n;
// Cap the deposits swept in a single tx so the merge never grows past the tx
// size / execution budget. Any remainder is swept by the next merge.
const MAX_DEPOSITS_PER_MERGE = 20;

type DepositArgs = {
  clientStatePath: string;
  protocolStatePath: string;
};

async function loadDepositAddress(args: DepositArgs): Promise<{
  state: ClientStateArtifact;
  depositValidatorAddress: string;
}> {
  const { client: state } = await readClientContext({
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
  if (amountLovelace < MIN_DEPOSIT_LOVELACE) {
    throw new Error(
      `deposit:fund amount ${amountLovelace} is below the ${MIN_DEPOSIT_LOVELACE} lovelace minimum a sweep will accept.`,
    );
  }
  const { depositValidatorAddress } = await loadDepositAddress(args);

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const walletUtxos = await wallet.getUtxos();

  reportProgress(`Paying ${amountLovelace} lovelace to deposit address ${depositValidatorAddress}`);
  // A plain output, NO datum — exactly how an ordinary client wallet would pay.
  const txSignBuilder = await lucid
    .newTx()
    .pay.ToAddress(depositValidatorAddress, { lovelace: amountLovelace })
    .complete();

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
}): Promise<ClientStateArtifact> {
  const { client: state } = await readClientContext({
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

  // Select clean, ADA-only deposits above the floor; skip dust / token junk /
  // datum-bearing UTxOs (a griefer cannot block the sweep — they stay put).
  const allDepositUtxos = await lucid.utxosAt(depositValidatorAddress);
  const eligible = allDepositUtxos
    .filter((u) => isCleanAdaDeposit(u))
    .slice(0, MAX_DEPOSITS_PER_MERGE);
  const skipped = allDepositUtxos.length - eligible.length;
  if (eligible.length === 0) {
    throw new Error(
      `No eligible deposits to merge at ${depositValidatorAddress} (found ${allDepositUtxos.length} UTxO(s); none were clean ADA >= ${MIN_DEPOSIT_LOVELACE} lovelace).`,
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
      ] as const,
      reportProgress,
    );

  let txBuilder = lucid
    .newTx()
    .readFrom(referenceScriptUtxos)
    .collectFrom([currentReceiverUtxo], topUpRedeemer)
    .collectFrom(eligible, collectDepositRedeemer)
    .attach.SpendingValidator(depositValidator)
    .pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: receiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    );

  if (isAnyReferenceScriptMissing(missingReferenceScript)) {
    reportProgress("Receiver reference script missing on-chain; attaching the receiver validator inline.");
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }

  const txSignBuilder = await txBuilder.complete();
  reportTxSignBuilderMetrics(txSignBuilder, reportProgress);
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
    ...state,
    wallet: { source, address: walletAddress },
    receiver: { ...state.receiver, receiverState: nextReceiverState },
    datum: { ...state.datum, receiverCbor: receiverDatumCbor },
    transactions: appendTransactionRecord(state.transactions, {
      step: stepId("deposit:merge"),
      submittedTxHash,
      confirmed,
    }),
  };
}

/** A clean, sweepable deposit: pure ADA (only `lovelace`), at or above the floor. */
function isCleanAdaDeposit(utxo: UTxO): boolean {
  const assetKeys = Object.keys(utxo.assets);
  const onlyAda = assetKeys.length === 1 && assetKeys[0] === "lovelace";
  const lovelace = utxo.assets.lovelace ?? 0n;
  return onlyAda && lovelace >= MIN_DEPOSIT_LOVELACE;
}

function reportProgress(message: string): void {
  console.error(`[deposit] ${message}`);
}
