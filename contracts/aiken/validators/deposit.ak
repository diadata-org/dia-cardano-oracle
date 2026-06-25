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
use cardano/address
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction, placeholder}
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

// ---------------------------------------------------------------------------
// Tests — the validator wrapper: it locates its own input by `own_ref`, learns
// the deposit address, and delegates to `deposit_logic.collect_deposit_ok`
// (whose sweep/delta/anti-skim rules are exercised in deposit_logic's own tests).
// ---------------------------------------------------------------------------

const test_receiver_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const test_receiver_asset: AssetName = #"4449415f5245434549564552"

const test_deposit_hash: ByteArray =
  #"dededededededededededededededededededededededededededede"

fn test_deposit_input(tag: ByteArray, lovelace: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: tag, output_index: 0 },
    output: Output {
      address: address.from_script(test_deposit_hash),
      value: assets.from_lovelace(lovelace),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn test_receiver_output(lovelace: Int) -> Output {
  Output {
    address: address.from_script(test_receiver_policy),
    value: assets.add(assets.from_lovelace(lovelace), test_receiver_policy, test_receiver_asset, 1),
    datum: NoDatum,
    reference_script: None,
  }
}

fn test_receiver_input(lovelace: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      output_index: 0,
    },
    output: test_receiver_output(lovelace),
  }
}

const test_own_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

test wrapper_accepts_when_receiver_credited_by_the_swept_amount() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_receiver_input(12_000_000), test_deposit_input(test_own_ref.transaction_id, 5_000_000)],
      outputs: [test_receiver_output(17_000_000)],
    }
  deposit.spend(test_receiver_policy, test_receiver_asset, None, CollectDeposit, test_own_ref, tx)
}

test wrapper_rejects_when_receiver_not_credited() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_receiver_input(12_000_000), test_deposit_input(test_own_ref.transaction_id, 5_000_000)],
      outputs: [test_receiver_output(12_000_000)],
    }
  !deposit.spend(test_receiver_policy, test_receiver_asset, None, CollectDeposit, test_own_ref, tx)
}

test wrapper_rejects_when_own_ref_absent_from_inputs() fail {
  // `own_ref` is not among the inputs, so the `expect Some(own_input)` lookup
  // finds nothing and the validator fails.
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_receiver_input(12_000_000)],
      outputs: [test_receiver_output(17_000_000)],
    }
  deposit.spend(test_receiver_policy, test_receiver_asset, None, CollectDeposit, test_own_ref, tx)
}
