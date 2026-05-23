import { Constr, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
} from "../../core/contracts.js";
import { slotBackoffUnixTimeMs } from "../../core/network-time.js";
import { loadReferenceScriptUtxos } from "../../core/reference-scripts.js";
import {
  buildPairDatumCbor,
  buildReceiverDatumCbor,
  decodeReceiverDatum,
  requireInlineDatum,
  splitUnit,
  updateWitnessData,
} from "../../core/chain-helpers.js";
import { buildPairApplyUpdateRedeemer } from "../../core/redeemers.js";
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
};

export type OracleUpdateResult = {
  txSignBuilder: TxSignBuilder;
  nextPairState: PairStateArtifact["pairState"];
  nextPairDatumCbor: string;
  nextReceiverState: NonNullable<ClientStateArtifact["receiver"]>["receiverState"];
  nextReceiverDatumCbor: string;
};

export async function buildOracleUpdateTx(
  lucid: LucidEvolution,
  ctx: OracleUpdateContext,
): Promise<OracleUpdateResult> {
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
  const nextReceiverState = {
    ...currentReceiverState,
    balanceLovelace: (
      BigInt(currentReceiverState.balanceLovelace) - protocolFee
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

  const txValidFromMs = slotBackoffUnixTimeMs(lucid, ctx.networkNow.slot);
  const intentExpiryMs = Number(ctx.intent.expiry) * 1000;
  const txValidToMs = Math.min(
    ctx.networkNow.unixTimeMs + 30 * 60_000,
    intentExpiryMs - 60_000,
  );

  let txBuilder = lucid
    .newTx()
    .validFrom(txValidFromMs)
    .validTo(txValidToMs)
    .readFrom([ctx.currentConfigUtxo, ...referenceScriptUtxos])
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

  if (missingReferenceScripts.receiver) {
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }
  if (missingReferenceScripts.coordinator) {
    txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
  }
  if (!ctx.isCreate && missingReferenceScripts.pair) {
    txBuilder = txBuilder.attach.SpendingValidator(pairValidator);
  }

  const txSignBuilder = await txBuilder.complete();

  return {
    txSignBuilder,
    nextPairState,
    nextPairDatumCbor,
    nextReceiverState,
    nextReceiverDatumCbor,
  };
}
