// Per-client side-deposit validator (Option A — see
// docs/audit/20260605-receiver-concurrency-and-griefing.md and
// lib/dia_cardano_oracle/deposit_logic.ak).
//
// Clients fund their Receiver balance by an ORDINARY wallet payment to this
// per-client script address (datum-less UTxOs are spendable in Plutus V3). The
// feeder/CLI later sweeps the accumulated deposits into the Receiver by
// spending them alongside the Receiver UTxO (with the Receiver's `TopUp`
// redeemer). The spend is authorised only when the canonical Receiver — found
// by its NFT (`receiver_policy_id` / `receiver_asset_name`, the parameters that
// make this address per-client) — is consumed and its lovelace rises by at
// least the total swept from this address. See `deposit_logic` for why this is
// safe (deposits can only ever credit the client's own Receiver) and anti-skim.

use aiken/collection/list
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use dia_cardano_oracle/deposit_logic

pub type DepositRedeemer {
  CollectDeposit
}

validator deposit(receiver_policy_id: PolicyId, receiver_asset_name: AssetName) {
  spend(
    _maybe_datum: Option<Data>,
    _redeemer: DepositRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    // own_ref is always present among the inputs (the ledger spends it); the
    // only purpose here is to learn this deposit's own address so the logic can
    // sum every sibling deposit at the same address.
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    deposit_logic.collect_deposit_ok(
      self,
      own_input.output.address,
      receiver_policy_id,
      receiver_asset_name,
    )
  }

  else(_) {
    False
  }
}
