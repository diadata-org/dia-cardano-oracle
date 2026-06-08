import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

// `PairSpendAction::ApplyUpdate` no longer carries a witness index.
// The Aiken `pair_state.spend` body for updates only checks NFT
// continuity, exact ADA locking, and a fingerprint-based proof that
// the coordinator's redeemer is in update mode. The previous
// `witness_index` field was eliminated because `update_coordinator`
// already enforces one-pair-input-per-witness accounting (and rejects
// extra/duplicate inputs) globally; the per-pair index was redundant.
export function buildPairApplyUpdateRedeemer(): string {
  return Data.to(new Constr<PlutusData>(0, []));
}

// `PairSpendAction::BurnPair` (constructor index 2). Admin-gated path
// used by `pair:burn` to release the locked min-ADA of a Pair UTxO.
// The on-chain validator additionally requires the matching Pair NFT
// to be burned in the same tx under the `PairMintAction::BurnPairs`
// redeemer, so both redeemers MUST be paired for the tx to succeed.
export function buildPairBurnRedeemer(): string {
  return Data.to(new Constr<PlutusData>(2, []));
}

// `PairMintAction::MintPairs` (constructor index 0). Admin-gated. A
// signed DIA intent alone is no longer sufficient: the tx MUST also
// be signed by a `config_admins` payment key. This closes the
// pair-creation replay vector — without the gate, the same DIA intent
// could be reused across two txs to mint two NFTs with the same
// `pair_token_name`.
export function buildPairMintRedeemer(): string {
  return Data.to(new Constr<PlutusData>(0, []));
}

// `PairMintAction::BurnPairs` (constructor index 1). Admin-gated burn
// of one or more Pair NFTs. Every entry in the mint set under this
// redeemer must have quantity `-1`. Used jointly with
// `buildPairBurnRedeemer` to release the locked min-ADA of a Pair
// UTxO.
export function buildPairMintBurnRedeemer(): string {
  return Data.to(new Constr<PlutusData>(1, []));
}

// ---------------------------------------------------------------------------
// Teardown burns for the singleton / per-client NFT families.
//
// Each of config_state / payment_hook / receiver exposes a mint `Burn`
// action AND a spend `Burn` redeemer. A teardown tx spends the NFT-bearing
// UTxO with the spend `Burn` redeemer AND mints `-1` of that NFT under the
// mint `Burn` action in the SAME tx, recovering the locked min-ADA to the
// admin. Both sides duplicate the config-admin signer check on purpose, so
// neither can be invoked alone. This is the same shape as `pair:burn`
// (spend `BurnPair` + mint `BurnPairs` -1).
//
// Constructor indices were read directly from the on-chain enums (do NOT
// guess — see contracts/aiken):
//   * Spend redeemers
//     - lib/.../receiver_logic.ak ReceiverRedeemer:
//         TopUp(0) AccrueFee(1) Settle(2) Withdraw(3) UpdateMinUtxo(4) Burn(5)
//     - lib/.../payment_hook_logic.ak PaymentHookRedeemer:
//         ApplySettle(0) AdminUpdate(1) Withdraw(2) Burn(3)
//     - lib/.../config_logic.ak ConfigRedeemer:
//         AdminUpdate(0) Burn(1)
//   * Mint actions (each declared in the matching validator file)
//     - validators/receiver.ak ReceiverMintAction:       Bootstrap(0) Burn(1)
//     - validators/payment_hook.ak PaymentHookMintAction: Bootstrap(0) Burn(1)
//     - validators/config_state.ak ConfigMintAction:      Bootstrap(0) Burn(1)
//   The Bootstrap(0) index is corroborated by every bootstrap builder using
//   `new Constr(0, [])` for its mint redeemer (config/payment-hook/receiver
//   bootstrap), so the teardown `Burn` action is unambiguously index 1.

// `ReceiverRedeemer::Burn` (constructor index 5). Admin-gated teardown of
// the Receiver UTxO. The validator additionally requires the Receiver NFT
// burned (`-1`) in the same tx, no continuation output carrying the NFT,
// and both `balance_lovelace == 0` and `accrued_to_hook_lovelace == 0`.
export function buildReceiverBurnSpendRedeemer(): string {
  return Data.to(new Constr<PlutusData>(5, []));
}

// `PaymentHookRedeemer::Burn` (constructor index 3). Admin-gated teardown
// of the PaymentHook UTxO. The validator additionally requires the Hook
// NFT burned (`-1`) in the same tx, no continuation output carrying the
// NFT, and `accrued_fees_lovelace == 0`.
export function buildPaymentHookBurnSpendRedeemer(): string {
  return Data.to(new Constr<PlutusData>(3, []));
}

// `ConfigRedeemer::Burn` (constructor index 1). Admin-gated teardown of
// the Config UTxO. The validator additionally requires the Config NFT
// burned (`-1`) in the same tx and no continuation output carrying the NFT.
export function buildConfigBurnSpendRedeemer(): string {
  return Data.to(new Constr<PlutusData>(1, []));
}

// Mint `Burn` action (constructor index 1) shared by the config_state,
// payment_hook, and receiver mint policies. Bootstrap is index 0, so the
// teardown `Burn` action is index 1 in every one of the three MintAction
// enums.
export function buildSingletonMintBurnRedeemer(): string {
  return Data.to(new Constr<PlutusData>(1, []));
}
