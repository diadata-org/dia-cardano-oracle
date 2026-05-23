import { Constr, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
} from "../../core/contracts.js";
import { slotBackoffUnixTimeMs } from "../../core/network-time.js";
import { loadReferenceScriptUtxos } from "../../core/reference-scripts.js";
import {
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  requireInlineDatum,
} from "../../core/chain-helpers.js";
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
} from "../../core/state.js";

export type SettleContext = {
  networkNow: { slot: number; unixTimeMs: number; unixTimeSec: bigint | number };
  currentConfigUtxo: UTxO;
  currentReceiverUtxo: UTxO;
  currentPaymentHookUtxo: UTxO;
  walletPaymentKeyHash: string;
  protocolState: ConfigStateArtifact;
  clientState: ClientStateArtifact;
};

export type SettleResult = {
  txSignBuilder: TxSignBuilder;
  accruedLovelace: bigint;
  nextReceiverState: NonNullable<ClientStateArtifact["receiver"]>["receiverState"];
  nextReceiverDatumCbor: string;
  nextPaymentHookState: NonNullable<ConfigStateArtifact["paymentHookState"]>;
  nextPaymentHookDatumCbor: string;
};

export async function buildSettleTx(
  lucid: LucidEvolution,
  ctx: SettleContext,
): Promise<SettleResult> {
  const { protocolState, clientState } = ctx;

  if (!clientState.receiver) {
    throw new Error("Settle requires client state after Receiver bootstrap.");
  }
  if (!protocolState.paymentHookState) {
    throw new Error("Settle requires protocol state after PaymentHook bootstrap.");
  }
  if (!protocolState.scripts.paymentHookValidatorAddress) {
    throw new Error("paymentHookValidatorAddress not found in protocol scripts.");
  }
  if (!protocolState.scripts.paymentHookUnit) {
    throw new Error("paymentHookUnit not found in protocol scripts.");
  }

  const currentReceiverState = decodeReceiverDatum(
    requireInlineDatum(ctx.currentReceiverUtxo, "receiver"),
  );
  const currentPaymentHookState = decodePaymentHookDatum(
    requireInlineDatum(ctx.currentPaymentHookUtxo, "payment hook"),
    protocolState.paymentHookState.withdrawAddress,
  );

  const accruedLovelace = BigInt(currentReceiverState.accruedToHookLovelace);
  if (accruedLovelace <= 0n) {
    throw new Error("Nothing to settle: receiver has no accrued fees.");
  }

  const nextReceiverState = {
    ...currentReceiverState,
    accruedToHookLovelace: "0",
  };
  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) + accruedLovelace
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(currentPaymentHookState.lifetimeCollectedLovelace) + accruedLovelace
    ).toString(),
  };

  const nextReceiverDatumCbor = buildReceiverDatumCbor(nextReceiverState);
  const nextPaymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);

  const receiverRedeemer = Data.to(new Constr(2, []));
  const paymentHookRedeemer = Data.to(new Constr(0, []));
  const settleManifest = new Constr<PlutusData>(0, [
    [
      new Constr<PlutusData>(0, [
        clientState.receiver.receiverPolicyId,
        clientState.receiver.receiverAssetName,
      ]),
    ],
  ]);
  const coordinatorRedeemer = Data.to(new Constr<PlutusData>(2, [settleManifest]));

  if (!clientState.compiledScripts?.receiverValidator) {
    throw new Error("receiverValidator compiled script not found.");
  }
  const receiverValidator = spendingValidatorFromCompiledScript(clientState.compiledScripts.receiverValidator);

  if (!protocolState.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(protocolState.compiledScripts.paymentHookValidator);

  if (!protocolState.compiledScripts?.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(protocolState.compiledScripts.coordinatorValidator);

  const { utxos: referenceScriptUtxos, missing: missingReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        { key: "coordinator", label: "coordinator", outRef: protocolState.referenceScripts?.global?.coordinator ?? null },
        { key: "paymentHook", label: "payment hook", outRef: protocolState.referenceScripts?.global?.paymentHook  ?? null },
        { key: "receiver",    label: "receiver",    outRef: clientState.referenceScripts?.client?.receiver        ?? null },
      ] as const,
      () => {},
    );

  let txBuilder = lucid
    .newTx()
    .validFrom(slotBackoffUnixTimeMs(lucid, ctx.networkNow.slot))
    .validTo(ctx.networkNow.unixTimeMs + 30 * 60_000)
    .readFrom([ctx.currentConfigUtxo, ...referenceScriptUtxos])
    .collectFrom([ctx.currentReceiverUtxo], receiverRedeemer)
    .collectFrom([ctx.currentPaymentHookUtxo], paymentHookRedeemer)
    .withdraw(protocolState.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
    .addSignerKey(ctx.walletPaymentKeyHash)
    .pay.ToContract(
      clientState.receiver.receiverValidatorAddress,
      { kind: "inline", value: nextReceiverDatumCbor },
      {
        lovelace:
          BigInt(nextReceiverState.minUtxoLovelace) +
          BigInt(nextReceiverState.balanceLovelace) +
          BigInt(nextReceiverState.accruedToHookLovelace),
        [clientState.receiver.receiverUnit]: 1n,
      },
    )
    .pay.ToContract(
      protocolState.scripts.paymentHookValidatorAddress,
      { kind: "inline", value: nextPaymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [protocolState.scripts.paymentHookUnit]: 1n,
      },
    );

  if (missingReferenceScripts.receiver) {
    txBuilder = txBuilder.attach.SpendingValidator(receiverValidator);
  }
  if (missingReferenceScripts.paymentHook) {
    txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
  }
  if (missingReferenceScripts.coordinator) {
    txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
  }

  const txSignBuilder = await txBuilder.complete();

  return {
    txSignBuilder,
    accruedLovelace,
    nextReceiverState,
    nextReceiverDatumCbor,
    nextPaymentHookState,
    nextPaymentHookDatumCbor,
  };
}
