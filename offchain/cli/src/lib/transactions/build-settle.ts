import { Constr, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import {
  spendingValidatorFromCompiledScript,
  withdrawalValidatorFromCompiledScript,
} from "../../core/contracts.js";
import { slotBackoffUnixTimeMs } from "../../core/network-time.js";
import { loadReferenceScriptUtxos } from "../../core/reference-scripts.js";
import { completeWithRetry } from "../../core/tx-build.js";
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

/**
 * One receiver participating in a multi-client settle: the loaded client
 * state plus the current on-chain Receiver UTxO it owns. The builder drains
 * each receiver's `accruedToHookLovelace` to zero and credits the sum to the
 * single shared payment hook.
 */
export type SettleClientInput = {
  clientState: ClientStateArtifact;
  currentReceiverUtxo: UTxO;
};

export type SettleContext = {
  networkNow: { slot: number; unixTimeMs: number; unixTimeSec: bigint | number };
  currentConfigUtxo: UTxO;
  currentPaymentHookUtxo: UTxO;
  walletPaymentKeyHash: string;
  protocolState: ConfigStateArtifact;
  /** One entry per receiver settled in this transaction (N >= 1). */
  clients: SettleClientInput[];
};

/** Per-receiver settle outcome, returned in the same order as `ctx.clients`. */
export type SettleReceiverResult = {
  clientState: ClientStateArtifact;
  receiver: NonNullable<ClientStateArtifact["receiver"]>;
  accruedLovelace: bigint;
  nextReceiverState: NonNullable<ClientStateArtifact["receiver"]>["receiverState"];
  nextReceiverDatumCbor: string;
};

export type SettleResult = {
  txSignBuilder: TxSignBuilder;
  /** Sum of every receiver's drained accrued lovelace (== hook delta). */
  totalAccruedLovelace: bigint;
  receivers: SettleReceiverResult[];
  nextPaymentHookState: NonNullable<ConfigStateArtifact["paymentHookState"]>;
  nextPaymentHookDatumCbor: string;
};

/**
 * Build a single Settle transaction that drains the accrued fees of N client
 * Receivers into the shared payment hook.
 *
 * The transaction:
 *   - reads the config UTxO + every applicable reference script;
 *   - spends each Receiver UTxO with the Receiver `Settle` redeemer and the
 *     payment hook UTxO with its `Withdraw` redeemer;
 *   - witnesses the whole thing with one coordinator withdrawal whose
 *     `SettleManifest` lists every receiver (policy id / asset name);
 *   - recreates each Receiver with `accruedToHookLovelace = 0` (balance and
 *     min-UTxO unchanged) and the hook with `accruedFees += Σ accrued`.
 *
 * Reference scripts are split by scope: the coordinator and payment-hook
 * validators are global (one reference UTxO loaded once), whereas each
 * client's Receiver validator is parametrised per client and lives at that
 * client's own reference-script UTxO. Each receiver reference is loaded
 * individually; when a receiver reference is missing the matching Receiver
 * validator is attached inline instead.
 */
export async function buildSettleTx(
  lucid: LucidEvolution,
  ctx: SettleContext,
): Promise<SettleResult> {
  const { protocolState, clients } = ctx;

  if (clients.length === 0) {
    throw new Error("Settle requires at least one client receiver.");
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
  const paymentHookValidatorAddress = protocolState.scripts.paymentHookValidatorAddress;
  const paymentHookUnit = protocolState.scripts.paymentHookUnit;

  // ── Per-receiver: decode current state, drain accrued to zero ──────
  const receiverRedeemer = Data.to(new Constr(2, []));
  const paymentHookRedeemer = Data.to(new Constr(0, []));

  const receivers: SettleReceiverResult[] = [];
  let totalAccruedLovelace = 0n;

  for (const { clientState, currentReceiverUtxo } of clients) {
    if (!clientState.receiver) {
      throw new Error(
        `Settle requires client state after Receiver bootstrap (client ${clientState.clientId}).`,
      );
    }
    const currentReceiverState = decodeReceiverDatum(
      requireInlineDatum(currentReceiverUtxo, `receiver ${clientState.clientId}`),
    );
    const accruedLovelace = BigInt(currentReceiverState.accruedToHookLovelace);
    if (accruedLovelace <= 0n) {
      throw new Error(
        `Nothing to settle: receiver ${clientState.receiver.receiverUnit} (client ${clientState.clientId}) has no accrued fees.`,
      );
    }

    const nextReceiverState = {
      ...currentReceiverState,
      accruedToHookLovelace: "0",
    };

    receivers.push({
      clientState,
      receiver: clientState.receiver,
      accruedLovelace,
      nextReceiverState,
      nextReceiverDatumCbor: buildReceiverDatumCbor(nextReceiverState),
    });
    totalAccruedLovelace += accruedLovelace;
  }

  // ── Payment hook: credit the sum of every drained receiver ─────────
  const currentPaymentHookState = decodePaymentHookDatum(
    requireInlineDatum(ctx.currentPaymentHookUtxo, "payment hook"),
    protocolState.paymentHookState.withdrawAddress,
  );
  const nextPaymentHookState = {
    ...currentPaymentHookState,
    accruedFeesLovelace: (
      BigInt(currentPaymentHookState.accruedFeesLovelace) + totalAccruedLovelace
    ).toString(),
    lifetimeCollectedLovelace: (
      BigInt(currentPaymentHookState.lifetimeCollectedLovelace) + totalAccruedLovelace
    ).toString(),
  };
  const nextPaymentHookDatumCbor = buildPaymentHookDatumCbor(nextPaymentHookState);

  // ── Coordinator witness: SettleManifest listing every receiver ─────
  const settleManifest = new Constr<PlutusData>(0, [
    receivers.map(
      (entry) =>
        new Constr<PlutusData>(0, [
          entry.receiver.receiverPolicyId,
          entry.receiver.receiverAssetName,
        ]),
    ),
  ]);
  const coordinatorRedeemer = Data.to(new Constr<PlutusData>(2, [settleManifest]));

  if (!protocolState.compiledScripts?.paymentHookValidator) {
    throw new Error("paymentHookValidator compiled script not found.");
  }
  const paymentHookValidator = spendingValidatorFromCompiledScript(protocolState.compiledScripts.paymentHookValidator);

  if (!protocolState.compiledScripts?.coordinatorValidator) {
    throw new Error("coordinatorValidator compiled script not found.");
  }
  const coordinatorValidator = withdrawalValidatorFromCompiledScript(protocolState.compiledScripts.coordinatorValidator);

  // ── Reference scripts ──────────────────────────────────────────────
  // Global scripts (coordinator + payment hook) are shared by every client,
  // so they are loaded once.
  const { utxos: globalReferenceScriptUtxos, missing: missingGlobalReferenceScripts } =
    await loadReferenceScriptUtxos(
      [
        { key: "coordinator", label: "coordinator", outRef: protocolState.referenceScripts?.global?.coordinator ?? null },
        { key: "paymentHook", label: "payment hook", outRef: protocolState.referenceScripts?.global?.paymentHook ?? null },
      ] as const,
      () => {},
    );

  // The Receiver validator is parametrised per client, so each client's
  // reference script differs. Load each individually; a missing one falls
  // back to attaching that client's Receiver validator inline.
  const perClientReceiverRefs = await Promise.all(
    receivers.map(async (entry) => {
      const { utxos, missing } = await loadReferenceScriptUtxos(
        [
          {
            key: "receiver",
            label: `receiver ${entry.clientState.clientId}`,
            outRef: entry.clientState.referenceScripts?.client?.receiver ?? null,
          },
        ] as const,
        () => {},
      );
      if (!entry.clientState.compiledScripts?.receiverValidator) {
        throw new Error(
          `receiverValidator compiled script not found (client ${entry.clientState.clientId}).`,
        );
      }
      return {
        entry,
        utxos,
        missingReceiver: missing.receiver,
        receiverValidator: spendingValidatorFromCompiledScript(
          entry.clientState.compiledScripts.receiverValidator,
        ),
      };
    }),
  );

  const referenceScriptUtxos = [
    ...globalReferenceScriptUtxos,
    ...perClientReceiverRefs.flatMap((ref) => ref.utxos),
  ];

  // ── Assemble the transaction ───────────────────────────────────────
  const buildTx = () => {
    let txBuilder = lucid
      .newTx()
      .validFrom(slotBackoffUnixTimeMs(lucid, ctx.networkNow.slot))
      .validTo(ctx.networkNow.unixTimeMs + 30 * 60_000)
      .readFrom([ctx.currentConfigUtxo, ...referenceScriptUtxos])
      .collectFrom(
        ctx.clients.map((client) => client.currentReceiverUtxo),
        receiverRedeemer,
      )
      .collectFrom([ctx.currentPaymentHookUtxo], paymentHookRedeemer)
      .withdraw(protocolState.scripts.coordinatorRewardAddress, 0n, coordinatorRedeemer)
      .addSignerKey(ctx.walletPaymentKeyHash);

    // Recreate each Receiver with accrued drained to zero (balance + min-UTxO
    // unchanged), preserving its NFT.
    for (const entry of receivers) {
      txBuilder = txBuilder.pay.ToContract(
        entry.receiver.receiverValidatorAddress,
        { kind: "inline", value: entry.nextReceiverDatumCbor },
        {
          lovelace:
            BigInt(entry.nextReceiverState.minUtxoLovelace) +
            BigInt(entry.nextReceiverState.balanceLovelace) +
            BigInt(entry.nextReceiverState.accruedToHookLovelace),
          [entry.receiver.receiverUnit]: 1n,
        },
      );
    }

    // Recreate the single shared payment hook crediting Σ accrued.
    txBuilder = txBuilder.pay.ToContract(
      paymentHookValidatorAddress,
      { kind: "inline", value: nextPaymentHookDatumCbor },
      {
        lovelace:
          BigInt(nextPaymentHookState.minUtxoLovelace) +
          BigInt(nextPaymentHookState.accruedFeesLovelace),
        [paymentHookUnit]: 1n,
      },
    );

    // Attach inline validators for any missing reference scripts. The Receiver
    // validators differ per client, so each missing one is attached separately.
    for (const ref of perClientReceiverRefs) {
      if (ref.missingReceiver) {
        txBuilder = txBuilder.attach.SpendingValidator(ref.receiverValidator);
      }
    }
    if (missingGlobalReferenceScripts.paymentHook) {
      txBuilder = txBuilder.attach.SpendingValidator(paymentHookValidator);
    }
    if (missingGlobalReferenceScripts.coordinator) {
      txBuilder = txBuilder.attach.WithdrawalValidator(coordinatorValidator);
    }

    return txBuilder;
  };

  const txSignBuilder = await completeWithRetry(buildTx);

  return {
    txSignBuilder,
    totalAccruedLovelace,
    receivers,
    nextPaymentHookState,
    nextPaymentHookDatumCbor,
  };
}
