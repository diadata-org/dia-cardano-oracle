import { Constr, type LucidEvolution, type SpendingValidator, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
} from "../../core/contracts.js";
import type { ReferenceScriptUtxo } from "../../core/state.js";
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
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
  PairStateArtifact,
  ResolvedCompiledScripts,
  ResolvedDeploymentScripts,
  ReferenceScriptsState,
  ReceiverArtifact,
} from "../../core/state.js";
import type { DiaOracleIntent } from "../../core/dia-intent.js";

/**
 * Optional side-deposit fold. When present, the update tx ALSO spends the
 * listed (already-selected, clean ADA) deposit UTxOs with the `CollectDeposit`
 * redeemer and absorbs their lovelace into the Receiver's `balance_lovelace`
 * via the on-chain `AccrueFee` transition (`added = swept`). The deposit
 * validator authorises the spend because the canonical Receiver is consumed
 * and its lovelace rises by exactly the swept total — identical to the
 * standalone `deposit:merge`. When `utxos` is empty the builder produces the
 * exact pure-update tx (`added == 0`).
 *
 * Selection (which UTxOs are clean / above the floor) and the
 * `depositMaxPerUpdateFold` cap are applied by the CALLER (see
 * `selectDepositsForUpdateFold`), so the builder stays a pure tx assembler.
 */
export type OracleUpdateDepositFold = {
  /** Clean, ADA-only deposit UTxOs to fold (already capped + filtered). */
  utxos: UTxO[];
  /** The per-client deposit spend validator (parametrised by the Receiver NFT). */
  depositValidator: SpendingValidator;
  /** On-chain reference script for the deposit validator, when published. */
  referenceOutRef?: ReferenceScriptUtxo | null;
};

export type OracleUpdateContext = {
  isCreate: boolean;
  intent: DiaOracleIntent;
  witness: {
    signerPublicKey: string;
    compactSignature: string;
    intentHash: string;
  };
  networkNow: { slot: number; unixTimeMs: number; unixTimeSec: bigint | number };
  currentConfigUtxo: UTxO;
  currentPairUtxo: UTxO | null;
  currentReceiverUtxo: UTxO;
  walletPaymentKeyHash: string;
  scripts: ResolvedDeploymentScripts;
  compiledScripts: ResolvedCompiledScripts;
  referenceScripts?: ReferenceScriptsState;
  configState: ConfigStateArtifact["configState"];
  pairState: PairStateArtifact["pairState"];
  pair: PairStateArtifact["pair"];
  receiver: NonNullable<ClientStateArtifact["receiver"]>;
  /** Optional opportunistic side-deposit fold (see OracleUpdateDepositFold). */
  depositFold?: OracleUpdateDepositFold;
};

export type OracleUpdateResult = {
  txSignBuilder: TxSignBuilder;
  nextPairState: PairStateArtifact["pairState"];
  nextPairDatumCbor: string;
  nextReceiverState: NonNullable<ClientStateArtifact["receiver"]>["receiverState"];
  nextReceiverDatumCbor: string;
  /** Lovelace absorbed from folded side-deposits (0 when none were folded). */
  foldedDepositLovelace: bigint;
};

export async function buildOracleUpdateTx(
  lucid: LucidEvolution,
  ctx: OracleUpdateContext,
): Promise<OracleUpdateResult> {
  // Validate the intent against the LIVE on-chain pair datum (the ground
  // truth), not the caller's local pair-state file which can drift behind the
  // chain. The pair UTxO we are about to spend carries the authoritative
  // (timestamp, nonce); a tx that does not strictly beat it would be rejected
  // by the pair_state validator on submit, wasting the fee. Building it is
  // refused here so the off-chain only ever assembles txs the chain will accept.
  if (!ctx.isCreate && ctx.currentPairUtxo) {
    const onChainPair = decodePairDatum(requireInlineDatum(ctx.currentPairUtxo, "pair"));
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate: false,
      intentTimestamp: ctx.intent.timestamp,
      intentNonce: ctx.intent.nonce,
      pairStateTimestamp: onChainPair.timestamp,
      pairStateNonce: onChainPair.nonce,
    });
  }

  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(ctx.currentReceiverUtxo, "receiver"),
  );

  const nextPairState = {
    ...ctx.pairState,
    price: ctx.intent.price.toString(),
    timestamp: ctx.intent.timestamp.toString(),
    nonce: ctx.intent.nonce.toString(),
    intentHash: ctx.witness.intentHash,
    signer: ctx.intent.signer,
    intent: {
      intentType: ctx.intent.intentType,
      version: ctx.intent.version,
      chainId: ctx.intent.chainId.toString(),
      nonce: ctx.intent.nonce.toString(),
      expiry: ctx.intent.expiry.toString(),
      symbol: ctx.intent.symbol,
      price: ctx.intent.price.toString(),
      timestamp: ctx.intent.timestamp.toString(),
      source: ctx.intent.source,
      signature: ctx.intent.signature,
      signer: ctx.intent.signer,
    },
  };

  const protocolFee =
    BigInt(ctx.configState.baseFeeLovelace) +
    BigInt(ctx.configState.perPairFeeLovelace);

  // Optional side-deposit fold: sum the lovelace of the (already-selected,
  // clean) deposit UTxOs. The on-chain AccrueFee transition lands this `added`
  // entirely in balance (`next.balance = prev.balance - fee + added`), so the
  // deposit ADA tops up the prepaid pool in the same tx as the price update.
  const foldDeposits = ctx.depositFold?.utxos ?? [];
  const foldedDepositLovelace = foldDeposits.reduce(
    (acc, utxo) => acc + (utxo.assets.lovelace ?? 0n),
    0n,
  );

  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - protocolFee + foldedDepositLovelace
    ).toString(),
    accruedToHookLovelace: (
      BigInt(currentReceiverState.accruedToHookLovelace) + protocolFee
    ).toString(),
  };
  if (BigInt(nextReceiverState.balanceLovelace) < 0n) {
    throw new Error("Receiver balance is not sufficient to pay the protocol fee.");
  }

  const nextPairDatumCbor = buildPairDatumCbor(nextPairState);
  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);

  const pairRedeemer = buildPairApplyUpdateRedeemer();
  const pairMintRedeemer = Data.to(new Constr<PlutusData>(0, []));
  const receiverRedeemer = Data.to(new Constr(1, []));
  // deposit_logic CollectDeposit — single-constructor case at index 0,
  // identical to the standalone `deposit:merge`.
  const collectDepositRedeemer = Data.to(new Constr(0, []));
  const coordinatorRedeemer = Data.to(
    new Constr<PlutusData>(0, [
      updateWitnessData(
        ctx.intent,
        ctx.receiver.receiverPolicyId,
        ctx.receiver.receiverAssetName,
        splitUnit(ctx.pair.pairUnit).policyId,
        ctx.pair.tokenName,
        ctx.witness.signerPublicKey,
      ),
    ]),
  );

  if (!ctx.compiledScripts.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found.");
  }
  const pairMintPolicy = mintingPolicyFromCompiledScript(ctx.compiledScripts.pairMintPolicy);

  if (!ctx.compiledScripts.pairValidator) {
    throw new Error("pairValidator compiled script not found.");
  }
  const pairValidator = spendingValidatorFromCompiledScript(ctx.compiledScripts.pairValidator);

  if (!ctx.compiledScripts.receiverValidator) {
    throw new Error("receiverValidator compiled script not found.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(ctx.compiledScripts.receiverValidator);

  if (!ctx.compiledScripts.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(ctx.compiledScripts.coordinatorValidator);

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        { key: "coordinator", label: "coordinator", outRef: ctx.referenceScripts?.global?.coordinator ?? null },
        { key: "receiver",    label: "receiver",    outRef: ctx.referenceScripts?.client?.receiver    ?? null },
        { key: "pair",        label: "pair",        outRef: ctx.referenceScripts?.client?.pair        ?? null },
        { key: "pairMint",    label: "pairMint",    outRef: ctx.referenceScripts?.client?.pairMint    ?? null },
      ] as const,
      () => {},
    );

  // When folding deposits, load the deposit reference script the same way
  // `deposit:merge` does — separately so the pure-update path never touches it.
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

  const txValidFromMs = slotBackoffUnixTimeMs(lucid, ctx.networkNow.slot);
  const intentExpiryMs = Number(ctx.intent.expiry) * 1000;
  const txValidToMs = Math.min(
    ctx.networkNow.unixTimeMs + 30 * 60_000,
    intentExpiryMs - 60_000,
  );

  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .validFrom(txValidFromMs)
      .validTo(txValidToMs)
      .readFrom([ctx.currentConfigUtxo, ...referenceScriptUtxos, ...depositReferenceUtxos])
      .collectFrom([ctx.currentReceiverUtxo], receiverRedeemer)
      .withdraw(ctx.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
      .pay.ToContract(
        ctx.pair.pairValidatorAddress,
        { kind: "inline", value: nextPairDatumCbor },
        {
          lovelace: BigInt(nextPairState.minUtxoLovelace),
          [ctx.pair.pairUnit]: 1n,
        },
      )
      .pay.ToContract(
        ctx.receiver.receiverValidatorAddress,
        { kind: "inline", value: nextReceiverDatumCbor },
        {
          lovelace:
            BigInt(nextReceiverState.minUtxoLovelace) +
            BigInt(nextReceiverState.balanceLovelace) +
            BigInt(nextReceiverState.accruedToHookLovelace),
          [ctx.receiver.receiverUnit]: 1n,
        },
      );

    if (ctx.isCreate) {
      txBuilder = txBuilder
        .mintAssets({ [ctx.pair.pairUnit]: 1n }, pairMintRedeemer)
        .addSignerKey(ctx.walletPaymentKeyHash);
      if (missingReferenceScripts.pairMint) {
        txBuilder = txBuilder.attach.MintingPolicy(pairMintPolicy);
      }
    } else {
      txBuilder = txBuilder.collectFrom([ctx.currentPairUtxo!], pairRedeemer);
    }

    // Fold the selected side-deposits: spend them with CollectDeposit. The
    // Receiver output above already carries `+ foldedDepositLovelace` in its
    // balance, so the Receiver's physical lovelace rises by exactly `swept` —
    // satisfying both the deposit validator's anti-skim sum and the AccrueFee
    // `added` term. When no deposits are folded this block is a no-op.
    if (foldDeposits.length > 0) {
      txBuilder = txBuilder.collectFrom(foldDeposits, collectDepositRedeemer);
      if (missingDepositReference.deposit && ctx.depositFold) {
        txBuilder = txBuilder.attach.SpendingValidator(ctx.depositFold.depositValidator);
      }
    }

    if (missingReferenceScripts.receiver) {
      txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
    }
    if (missingReferenceScripts.coordinator) {
      txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
    }
    if (!ctx.isCreate && missingReferenceScripts.pair) {
      txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
    }

    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx);

  return {
    txSignBuilder,
    nextPairState,
    nextPairDatumCbor,
    nextReceiverState,
    nextReceiverDatumCbor,
    foldedDepositLovelace,
  };
}
