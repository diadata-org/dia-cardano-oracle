// Pure inline-datum decoders for the protocol's on-chain UTxOs.
//
// Dependency-free by design: it imports only the plutus-data codec
// (@lucid-evolution/plutus — NOT the full lucid/provider stack), the hex
// normaliser, and type-only shapes. That lets a consumer (the indexer) decode a
// Pair / Receiver / PaymentHook datum read straight from chain without pulling
// in transaction building, wallets, or a provider. The CLI re-exports these
// from chain-helpers for its existing call sites; this module is the canonical
// home.

import { Constr, Data, type Data as PlutusData } from "@lucid-evolution/plutus";

import { normalizeHex } from "./primitives.js";
import type { PairLiveState, PaymentHookState, ReceiverState } from "./state.js";

/** Decode a Receiver inline datum (balance / accrued-to-hook / min-UTxO). */
export function decodeReceiverDatum(raw: string): ReceiverState {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [balanceLovelace, accruedToHookLovelace, minUtxoLovelace] = datum.fields;

  return {
    balanceLovelace: BigInt(balanceLovelace as bigint).toString(),
    accruedToHookLovelace: BigInt(accruedToHookLovelace as bigint).toString(),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}

/**
 * Decode a PaymentHook inline datum. The withdraw address is NOT in the datum
 * (it is encoded as plutus address data the decoder does not reconstruct here),
 * so the caller supplies the known `withdrawAddress` for the returned shape.
 */
export function decodePaymentHookDatum(
  raw: string,
  withdrawAddress: string,
): PaymentHookState {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [, accruedFeesLovelace, lifetimeCollectedLovelace, lifetimeWithdrawnLovelace, minUtxoLovelace] =
    datum.fields;

  return {
    withdrawAddress,
    accruedFeesLovelace: BigInt(accruedFeesLovelace as bigint).toString(),
    lifetimeCollectedLovelace: BigInt(lifetimeCollectedLovelace as bigint).toString(),
    lifetimeWithdrawnLovelace: BigInt(lifetimeWithdrawnLovelace as bigint).toString(),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}

/**
 * Decode the protocol fee parameters out of a Config inline datum. The Config
 * datum carries the whole protocol configuration; a consumer only needs the fee
 * formula inputs to know what an update costs, so this returns just those two
 * fields (datum field 3 = base, field 4 = per-pair). Fee for an N-pair update
 * is `baseFeeLovelace + N × perPairFeeLovelace`.
 */
export function decodeConfigFees(raw: string): {
  baseFeeLovelace: string;
  perPairFeeLovelace: string;
} {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [, , , baseFeeLovelace, perPairFeeLovelace] = datum.fields;

  return {
    baseFeeLovelace: BigInt(baseFeeLovelace as bigint).toString(),
    perPairFeeLovelace: BigInt(perPairFeeLovelace as bigint).toString(),
  };
}

/** Decode a Pair inline datum (the published oracle value + metadata). */
export function decodePairDatum(raw: string): Omit<PairLiveState, "intent"> {
  const datum = Data.from(raw) as Constr<PlutusData>;
  const [pairId, price, timestamp, nonce, intentHash, signer, minUtxoLovelace] =
    datum.fields;

  return {
    pairId: normalizeHex(pairId as string, "pairId"),
    price: BigInt(price as bigint).toString(),
    timestamp: BigInt(timestamp as bigint).toString(),
    nonce: BigInt(nonce as bigint).toString(),
    intentHash: normalizeHex(intentHash as string, "intentHash"),
    signer: normalizeHex(signer as string, "signer"),
    minUtxoLovelace: BigInt(minUtxoLovelace as bigint).toString(),
  };
}
