import { Constr, type LucidEvolution, type SpendingValidator, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
} from "../../core/contracts.js";
import { slotBackoffUnixTimeMs } from "../../core/network-time.js";
import { loadReferenceScriptUtxos } from "../../core/reference-scripts.js";
import { completeWithRetry } from "../../core/tx-build.js";
import {
  buildPairDatumCbor,
  buildReceiverDatumCbor,
  decodePairDatum,
  decodeReceiverDatum,
  requireInlineDatum,
  splitUnit,
  updateWitnessData,
} from "../../core/chain-helpers.js";
import { buildPairApplyUpdateRedeemer } from "../../core/redeemers.js";
import { assertOracleIntentTimestampAndNonceMonotonic } from "../../preflight/oracle-update.js";
import {
  resolvePairArtifact,
  sortBatchUpdatesByPairTokenName,
  ensureCompatibleBatch,
} from "../../transactions/update-batch.js";
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
  PairStateArtifact,
  ReferenceScriptsState,
  ReferenceScriptUtxo,
} from "../../core/state.js";
import type { DiaOracleIntent } from "../../core/dia-intent.js";

/** Optional side-deposit fold for a batch update — same semantics as the
 *  single-update `OracleUpdateDepositFold`. Selected + capped by the caller. */
export type BatchDepositFold = {
  utxos: UTxO[];
  depositValidator: SpendingValidator;
  referenceOutRef?: ReferenceScriptUtxo | null;
};

export type BatchUpdateEntry = {
  intent: DiaOracleIntent;
  witness: {
    signerPublicKey: string;
    compactSignature: string;
    intentHash: string;
  };
  pairArtifact: PairStateArtifact;
  isCreate: boolean;
};

export type BatchOracleUpdateContext = {
  entries: BatchUpdateEntry[];
  networkNow: { slot: number; unixTimeMs: number; unixTimeSec: bigint | number };
  currentConfigUtxo: UTxO;
  currentReceiverUtxo: UTxO;
  currentPairUtxoByUnit: Map<string, UTxO>;
  walletPaymentKeyHash: string;
  protocolState: ConfigStateArtifact;
  clientState: ClientStateArtifact;
  /** Optional opportunistic side-deposit fold (see BatchDepositFold). */
  depositFold?: BatchDepositFold;
};

export type BatchOracleUpdateResult = {
  txSignBuilder: TxSignBuilder;
  nextReceiverState: NonNullable<ClientStateArtifact["receiver"]>["receiverState"];
  nextReceiverDatumCbor: string;
  updatedPairStates: Array<{
    pairUnit: string;
    nextPairState: PairStateArtifact["pairState"];
    nextPairDatumCbor: string;
  }>;
  /** Lovelace absorbed from folded side-deposits (0 when none were folded). */
  foldedDepositLovelace: bigint;
};

export async function buildBatchOracleUpdateTx(
  lucid: LucidEvolution,
  ctx: BatchOracleUpdateContext,
): Promise<BatchOracleUpdateResult> {
  const { protocolState, clientState } = ctx;

  if (!clientState.receiver) {
    throw new Error("Batch update requires client state after Receiver bootstrap.");
  }

  const resolvedEntries = sortBatchUpdatesByPairTokenName(
    ctx.entries.map((entry) => ({
      artifact: resolvePairArtifact(entry.pairArtifact, clientState, protocolState),
      intent: entry.intent,
      witness: entry.witness,
      isCreate: entry.isCreate,
    })),
  );

  ensureCompatibleBatch(resolvedEntries.map((e) => e.artifact));

  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(ctx.currentReceiverUtxo, "receiver"),
  );

  const preparedUpdates = resolvedEntries.map(({ artifact, intent, witness, isCreate }) => {
    // Validate each non-create entry against the LIVE on-chain pair datum (the
    // ground truth), not the local pair-state artifact which can drift behind
    // the chain. One entry that does not strictly beat its on-chain
    // (timestamp, nonce) would make the atomic batch revert on submit and waste
    // the fee, so the builder refuses to assemble it. The feeder pre-filters
    // such entries out of the batch upstream; the CLI surfaces the throw.
    if (!isCreate) {
      const currentPairUtxo = ctx.currentPairUtxoByUnit.get(artifact.pair.pairUnit);
      if (currentPairUtxo) {
        const onChainPair = decodePairDatum(requireInlineDatum(currentPairUtxo, "pair"));
        assertOracleIntentTimestampAndNonceMonotonic({
          isCreate: false,
          intentTimestamp: intent.timestamp,
          intentNonce: intent.nonce,
          pairStateTimestamp: onChainPair.timestamp,
          pairStateNonce: onChainPair.nonce,
          batchStatePath: artifact.pair.pairUnit,
        });
      }
    }
    const nextPairState = {
      ...artifact.pairState,
      price: intent.price.toString(),
      timestamp: intent.timestamp.toString(),
      nonce: intent.nonce.toString(),
      intentHash: witness.intentHash,
      signer: intent.signer,
      intent: {
        intentType: intent.intentType,
        version: intent.version,
        chainId: intent.chainId.toString(),
        nonce: intent.nonce.toString(),
        expiry: intent.expiry.toString(),
        symbol: intent.symbol,
        price: intent.price.toString(),
        timestamp: intent.timestamp.toString(),
        source: intent.source,
        signature: intent.signature,
        signer: intent.signer,
      },
    };
    return { artifact, intent, witness, isCreate, nextPairState };
  });

  const state = resolvedEntries[0]!.artifact;

  const totalFee =
    BigInt(state.configState.baseFeeLovelace) +
    BigInt(state.configState.perPairFeeLovelace) * BigInt(preparedUpdates.length);

  // Optional side-deposit fold: absorb the (already-selected, clean) deposits
  // into the Receiver balance in the same batch tx via the AccrueFee `added`
  // term. Empty when no fold was requested → unchanged pure-batch behaviour.
  const foldDeposits = ctx.depositFold?.utxos ?? [];
  const foldedDepositLovelace = foldDeposits.reduce(
    (acc, utxo) => acc + (utxo.assets.lovelace ?? 0n),
    0n,
  );

  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - totalFee + foldedDepositLovelace
    ).toString(),
    accruedToHookLovelace: (
      BigInt(currentReceiverState.accruedToHookLovelace) + totalFee
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee batch.");
  }

  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  if (!state.compiledScripts.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(state.compiledScripts.pairMintPolicy);

  if (!state.compiledScripts.pairValidator) {
    throw new Error("pairValidator compiled script not found.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(state.compiledScripts.pairValidator);

  if (!state.compiledScripts.receiverValidator) {
    throw new Error("receiverValidator compiled script not found.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(state.compiledScripts.receiverValidator);

  if (!state.compiledScripts.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(state.compiledScripts.coordinatorValidator);

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        { key: "coordinator", label: "coordinator", outRef: state.referenceScripts?.global?.coordinator ?? null },
        { key: "receiver",    label: "receiver",    outRef: state.referenceScripts?.client?.receiver    ?? null },
        { key: "pair",        label: "pair",        outRef: state.referenceScripts?.client?.pair        ?? null },
        { key: "pairMint",    label: "pairMint",    outRef: state.referenceScripts?.client?.pairMint    ?? null },
      ] as const,
      () => {},
    );

  // Deposit reference script — loaded only when folding deposits, so the
  // pure-batch path never touches it.
  const { utxos: depositReferenceUtxos, missing: missingDepositReference } =
    foldDeposits.length > 0
      ? await loadReferenceScriptUtxos(
          [
            {
              key: "deposit",
              label: "deposit",
              outRef: ctx.depositFold?.referenceOutRef
                ? {
                    txHash: ctx.depositFold.referenceOutRef.txHash,
                    outputIndex: ctx.depositFold.referenceOutRef.outputIndex,
                  }
                : null,
            },
          ] as const,
          () => {},
        )
      : { utxos: [], missing: { deposit: false } };

  const receiverRedeemer = Data.to(new Constr(1, []));
  // deposit_logic CollectDeposit — single-constructor case at index 0.
  const collectDepositRedeemer = Data.to(new Constr(0, []));
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(1, [
      preparedUpdates.map(({ intent, witness, artifact }) =>
        updateWitnessData(
          intent,
          artifact.receiver!.receiverPolicyId,
          artifact.receiver!.receiverAssetName,
          splitUnit(artifact.pair.pairUnit).policyId,
          artifact.pair.tokenName,
          witness.signerPublicKey,
        ),
      ),
    ]),
  );

  const earliestExpirySec = preparedUpdates.reduce(
    (min, u) => (u.intent.expiry < min ? u.intent.expiry : min),
    preparedUpdates[0]!.intent.expiry,
  );
  const txValidFromMs = slotBackoffUnixTimeMs(lucid, ctx.networkNow.slot);
  const txValidToMs = Math.min(
    ctx.networkNow.unixTimeMs + 30 * 60_000,
    Number(earliestExpirySec) * 1000 - 60_000,
  );

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .validFrom(txValidFromMs)
      .validTo(txValidToMs)
      .readFrom([ctx.currentConfigUtxo, ...referenceScriptUtxos, ...depositReferenceUtxos])
      .collectFrom([ctx.currentReceiverUtxo], receiverRedeemer)
      .withdraw(state.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer);

    // Fold the selected side-deposits with CollectDeposit. The Receiver output
    // below already carries `+ foldedDepositLovelace`, so the Receiver's physical
    // lovelace rises by exactly the swept total. No-op when nothing is folded.
    if (foldDeposits.length > 0) {
      txBuilder = txBuilder.collectFrom(foldDeposits, collectDepositRedeemer);
      if (missingDepositReference.deposit && ctx.depositFold) {
        txBuilder = txBuilder.attach.SpendingValidator(ctx.depositFold.depositValidator);
      }
    }

    for (const { artifact, isCreate } of preparedUpdates) {
      if (!isCreate) {
        const currentPairUtxo = ctx.currentPairUtxoByUnit.get(artifact.pair.pairUnit);
        if (!currentPairUtxo) {
          throw new Error(`Missing current UTxO for pair ${artifact.pair.pairUnit}`);
        }
        txBuilder = txBuilder.collectFrom([currentPairUtxo], buildPairApplyUpdateRedeemer());
      }
    }

    if (missingReferenceScripts.receiver) {
      txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
    }
    if (missingReferenceScripts.coordinator) {
      txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
    }
    if (missingReferenceScripts.pair) {
      txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
    }

    const mintAssets: Record<string, bigint> = {};
    for (const { artifact, isCreate } of preparedUpdates) {
      if (isCreate) {
        mintAssets[artifact.pair.pairUnit] = 1n;
      }
    }
    if (Object.keys(mintAssets).length > 0) {
      txBuilder = txBuilder
        .mintAssets(mintAssets, Data.to(new Constr<PlutusData>(0, [])))
        .addSignerKey(ctx.walletPaymentKeyHash);
      if (missingReferenceScripts.pairMint) {
        txBuilder = txBuilder.attach.MintingPolicy(pairMintPolicy);
      }
    }

    for (const { artifact, nextPairState } of preparedUpdates) {
      txBuilder = txBuilder.pay.ToContract(
        artifact.pair.pairValidatorAddress,
        { kind: "inline", value: buildPairDatumCbor(nextPairState) },
        {
          lovelace: BigInt(nextPairState.minUtxoLovelace),
          [artifact.pair.pairUnit]: 1n,
        },
      );
    }

    txBuilder = txBuilder.pay.ToContract(
      state.receiver.receiverValidatorAddress,
      { kind: "inline", value: nextReceiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [state.receiver.receiverUnit]: 1n,
      },
    );

    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx);

  return {
    txSignBuilder,
    nextReceiverState,
    nextReceiverDatumCbor,
    updatedPairStates: preparedUpdates.map(({ artifact, nextPairState }) => ({
      pairUnit: artifact.pair.pairUnit,
      nextPairState,
      nextPairDatumCbor: buildPairDatumCbor(nextPairState),
    })),
    foldedDepositLovelace,
  };
}
