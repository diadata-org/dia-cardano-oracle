// Side-deposit funding logic (Option A — see
// docs/audit/20260605-receiver-concurrency-and-griefing.md).
//
// A per-client deposit script address lets a client fund their Receiver
// balance with an ORDINARY wallet payment (no CLI, no datum). In Plutus V3 a
// datum-less script UTxO is presented to the spend validator as `None`, so a
// plain transfer lands as a spendable deposit (unlike the Receiver address,
// whose validator does `expect Some(datum)`).
//
// Security comes from the spend CONDITION, not a datum: a deposit may only be
// spent by a tx that consumes the canonical Receiver (identified by its NFT)
// and increases the Receiver UTxO's lovelace by at least the TOTAL swept from
// this deposit address. The Receiver's own `TopUp` spend then credits
// `balance_lovelace` by exactly that delta. Consequences:
//   * A deposit can only ever credit the client's own Receiver — never stolen.
//   * The Receiver must GAIN at least `swept`: a `TopUp`, or an update whose
//     `AccrueFee` absorbs the deposit (raising the Receiver's lovelace into
//     `balance_lovelace`), both satisfy this. Settle/Withdraw lower the
//     Receiver's lovelace, so they can never co-spend a deposit — the
//     `delta >= swept` guard fails.
//   * ANTI-SKIM: every deposit input at this address runs the SAME validator
//     instance with the SAME `swept` (the sum over all inputs at the address),
//     so a tx that sweeps N deposits but credits only one would fail every
//     instance — the full sweep must reach the Receiver.

use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, NoDatum, Output, OutputReference, Transaction}

/// True iff a `CollectDeposit` spend is safe (see module header). `swept` is
/// the total lovelace of every input at `deposit_address`; the tx must consume
/// the canonical Receiver (NFT qty 1) and raise its lovelace by `>= swept`.
pub fn collect_deposit_ok(
  self: Transaction,
  deposit_address: Address,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
) -> Bool {
  let swept = total_swept(self, deposit_address)

  when
    (
      list.find(
        self.inputs,
        fn(input) {
          assets.quantity_of(
            input.output.value,
            receiver_policy_id,
            receiver_asset_name,
          ) == 1
        },
      ),
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(
            output.value,
            receiver_policy_id,
            receiver_asset_name,
          ) == 1
        },
      ),
    )
  is {
    (Some(receiver_input), Some(receiver_output)) -> {
      let receiver_delta =
        assets.lovelace_of(receiver_output.value) - assets.lovelace_of(
          receiver_input.output.value,
        )
      and {
        swept > 0,
        receiver_delta >= swept,
      }
    }
    _ -> False
  }
}

/// Total lovelace across every transaction input sitting at `deposit_address`.
pub fn total_swept(self: Transaction, deposit_address: Address) -> Int {
  list.foldl(
    self.inputs,
    0,
    fn(input, acc) {
      if input.output.address == deposit_address {
        acc + assets.lovelace_of(input.output.value)
      } else {
        acc
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const receiver_policy: PolicyId =
  #"22222222222222222222222222222222222222222222222222222222"

const receiver_asset: AssetName =
  #"4449415f5245434549564552"

const deposit_hash: ByteArray =
  #"dededededededededededededededededededededededededededede"

const other_hash: ByteArray =
  #"ababababababababababababababababababababababababababababab"

fn deposit_address() -> Address {
  address.from_script(deposit_hash)
}

fn deposit_input(tag: ByteArray, lovelace: Int) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: tag, output_index: 0 },
    output: Output {
      address: deposit_address(),
      value: assets.from_lovelace(lovelace),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn receiver_output(lovelace: Int) -> Output {
  Output {
    address: address.from_script(receiver_policy),
    value: assets.add(
      assets.from_lovelace(lovelace),
      receiver_policy,
      receiver_asset,
      1,
    ),
    datum: NoDatum,
    reference_script: None,
  }
}

fn receiver_input(lovelace: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      output_index: 0,
    },
    output: receiver_output(lovelace),
  }
}

fn tx_with(inputs: List<Input>, outputs: List<Output>) -> Transaction {
  Transaction { ..transaction.placeholder, inputs: inputs, outputs: outputs }
}

test collect_deposit_ok_accepts_full_sweep_credited() {
  // One 5 ADA deposit; Receiver lovelace rises by exactly 5 ADA.
  let tx =
    tx_with(
      [receiver_input(12_000_000), deposit_input(#"01", 5_000_000)],
      [receiver_output(17_000_000)],
    )
  collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_accepts_multiple_deposits_fully_credited() {
  // Two deposits (5 + 3 = 8 ADA); Receiver lovelace rises by 8 ADA.
  let tx =
    tx_with(
      [
        receiver_input(12_000_000),
        deposit_input(#"01", 5_000_000),
        deposit_input(#"02", 3_000_000),
      ],
      [receiver_output(20_000_000)],
    )
  collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_rejects_skim_partial_credit() {
  // ANTI-SKIM: sweeps 8 ADA but only credits 5 ADA to the Receiver.
  let tx =
    tx_with(
      [
        receiver_input(12_000_000),
        deposit_input(#"01", 5_000_000),
        deposit_input(#"02", 3_000_000),
      ],
      [receiver_output(17_000_000)],
    )
  !collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_rejects_receiver_not_credited() {
  // Receiver lovelace unchanged (e.g. a pure update that absorbs nothing) → deposit cannot move.
  let tx =
    tx_with(
      [receiver_input(12_000_000), deposit_input(#"01", 5_000_000)],
      [receiver_output(12_000_000)],
    )
  !collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_rejects_receiver_lovelace_decrease() {
  // Settle/Withdraw-shaped tx lowers Receiver lovelace → rejected.
  let tx =
    tx_with(
      [receiver_input(12_000_000), deposit_input(#"01", 5_000_000)],
      [receiver_output(10_000_000)],
    )
  !collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_rejects_no_receiver_in_tx() {
  // No canonical Receiver consumed → cannot collect.
  let tx =
    tx_with(
      [deposit_input(#"01", 5_000_000)],
      [
        Output {
          address: address.from_script(other_hash),
          value: assets.from_lovelace(5_000_000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    )
  !collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_rejects_zero_swept_no_deposit_input() {
  // ANTI-SKIM degenerate case: the Receiver is consumed and even gains lovelace,
  // but NO input sits at the deposit address (swept == 0). The `swept > 0` guard
  // must reject — a CollectDeposit spend with nothing to collect is meaningless
  // and must never authorise on the back of an unrelated Receiver top-up.
  let tx =
    tx_with(
      [receiver_input(12_000_000)],
      [receiver_output(20_000_000)],
    )
  !collect_deposit_ok(tx, deposit_address(), receiver_policy, receiver_asset)
}

test collect_deposit_ok_credits_full_ada_of_token_wrapped_deposit() {
  // A deposit input that also carries a native token still contributes its full
  // lovelace to `swept` (lovelace_of ignores the token). The Receiver must be
  // credited that full ADA, proving a griefer cannot wrap ADA in a token to
  // skim part of a sweep: the spend only passes when the FULL ADA reaches the
  // Receiver.
  let token_deposit =
    Input {
      output_reference: OutputReference { transaction_id: #"07", output_index: 0 },
      output: Output {
        address: deposit_address(),
        value: assets.add(
          assets.from_lovelace(5_000_000),
          other_hash,
          #"4a554e4b",
          1,
        ),
        datum: NoDatum,
        reference_script: None,
      },
    }
  // Receiver rises by the full 5 ADA → accepted.
  let ok_tx =
    tx_with([receiver_input(12_000_000), token_deposit], [receiver_output(17_000_000)])
  // Receiver rises by only 4 ADA (token counted as if it offset the credit) → rejected.
  let skim_tx =
    tx_with([receiver_input(12_000_000), token_deposit], [receiver_output(16_000_000)])
  and {
    collect_deposit_ok(ok_tx, deposit_address(), receiver_policy, receiver_asset),
    !collect_deposit_ok(skim_tx, deposit_address(), receiver_policy, receiver_asset),
  }
}

test total_swept_only_counts_inputs_at_the_deposit_address() {
  // An unrelated input at another address must not inflate `swept`.
  let other =
    Input {
      output_reference: OutputReference { transaction_id: #"99", output_index: 0 },
      output: Output {
        address: address.from_script(other_hash),
        value: assets.from_lovelace(100_000_000),
        datum: NoDatum,
        reference_script: None,
      },
    }
  let tx = tx_with([deposit_input(#"01", 5_000_000), other], [])
  total_swept(tx, deposit_address()) == 5_000_000
}
