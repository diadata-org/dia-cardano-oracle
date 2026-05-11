use aiken/collection/dict
use aiken/collection/list
use aiken/primitive/bytearray
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  ApplyBatch, ApplySettle, ApplySingle, CoordinatorRedeemer, SettleManifest,
  SettleReceiver,
}
use dia_cardano_oracle/oracle_logic
use dia_cardano_oracle/payment_hook_logic
use dia_cardano_oracle/receiver_logic

validator update_coordinator(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  withdraw(
    redeemer: CoordinatorRedeemer,
    own_credential: Credential,
    self: Transaction,
  ) {
    expect Some(config_input) =
      list.find(
        self.reference_inputs,
        fn(input) {
          assets.quantity_of(
            input.output.value,
            config_policy_id,
            config_asset_name,
          ) == 1
        },
      )

    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    and {
      config_logic.valid_config_state(config_datum),
      config_datum.update_coordinator_credential == Some(own_credential),
      when redeemer is {
        ApplySingle(witness) -> and {
            oracle_logic.intent_expiry_satisfied(witness.intent, self),
            valid_single_update(self, config_datum, witness),
            valid_receiver_accrue_fee(
              self,
              witness.receiver_policy_id,
              witness.receiver_asset_name,
              // Single pair: fee = base + 1*k
              config_logic.calculate_protocol_fee(config_datum, 1),
            ),
          }

        ApplyBatch(witnesses) -> and {
            witnesses_share_receiver(witnesses),
            list.all(
              witnesses,
              fn(witness) {
                oracle_logic.intent_expiry_satisfied(witness.intent, self)
              },
            ),
            valid_batch_update(self, config_datum, witnesses),
            valid_batch_receiver_accrue_fee(
              self,
              witnesses,
              // Batch: fee = base + N*k (charged to the single receiver)
              config_logic.calculate_protocol_fee(config_datum, list.length(witnesses)),
            ),
          }

        ApplySettle(manifest) -> and {
            config_logic.has_config_signer(config_datum, self),
            valid_settle(self, config_datum, manifest),
          }
      },
    }
  }

  else(_) {
    False
  }
}

// Receiver transition from balance to accrued (inside the update tx).
// The lovelace stays at the UTxO; only the datum obligation moves.
fn valid_receiver_accrue_fee(
  self: Transaction,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
  fee_lovelace: Int,
) -> Bool {
  expect Some(receiver_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )
  expect Some(receiver_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )

  expect InlineDatum(receiver_input_datum) = receiver_input.output.datum
  expect previous_receiver: receiver_logic.ReceiverDatum = receiver_input_datum

  expect InlineDatum(receiver_output_datum) = receiver_output.datum
  expect next_receiver: receiver_logic.ReceiverDatum = receiver_output_datum

  and {
    receiver_logic.valid_receiver_state(previous_receiver),
    receiver_logic.valid_receiver_state(next_receiver),
    receiver_logic.exact_locked_lovelace(
      receiver_input.output,
      previous_receiver,
    ),
    receiver_logic.exact_locked_lovelace(receiver_output, next_receiver),
    receiver_logic.accrue_fee_transition(
      previous_receiver,
      next_receiver,
      fee_lovelace,
    ),
  }
}

fn valid_batch_receiver_accrue_fee(
  self: Transaction,
  witnesses: List<oracle_logic.UpdateWitness>,
  fee_lovelace: Int,
) -> Bool {
  when witnesses is {
    [] -> False
    [head, ..] ->
      valid_receiver_accrue_fee(
        self,
        head.receiver_policy_id,
        head.receiver_asset_name,
        fee_lovelace,
      )
  }
}

// Settle moves accrued fees from multiple Receivers to the PaymentHook.
// The coordinator validates the arithmetic so each Receiver only checks local invariants.
fn valid_settle(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  manifest: SettleManifest,
) -> Bool {
  expect Some(payment_hook_ref) = config_datum.payment_hook_ref

  // Exactly one Hook input and one Hook output
  expect Some(hook_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          payment_hook_ref.policy_id,
          payment_hook_ref.asset_name,
        ) == 1
      },
    )
  expect Some(hook_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          payment_hook_ref.policy_id,
          payment_hook_ref.asset_name,
        ) == 1
      },
    )

  expect InlineDatum(hook_input_datum) = hook_input.output.datum
  expect previous_hook: payment_hook_logic.PaymentHookDatum = hook_input_datum

  expect InlineDatum(hook_output_datum) = hook_output.datum
  expect next_hook: payment_hook_logic.PaymentHookDatum = hook_output_datum

  let expected_delta =
    next_hook.accrued_fees_lovelace - previous_hook.accrued_fees_lovelace

  and {
    list.length(manifest.receivers) > 0,
    unique_settle_receivers(manifest.receivers),
    payment_hook_logic.valid_payment_hook_state(previous_hook),
    payment_hook_logic.valid_payment_hook_state(next_hook),
    payment_hook_logic.exact_locked_lovelace(hook_input.output, previous_hook),
    payment_hook_logic.exact_locked_lovelace(hook_output, next_hook),
    payment_hook_logic.apply_settle_transition(
      previous_hook,
      next_hook,
      expected_delta,
    ),
    sum_receiver_accrued_equals_delta(
      self,
      manifest.receivers,
      expected_delta,
    ),
  }
}

fn sum_receiver_accrued_equals_delta(
  self: Transaction,
  receivers: List<SettleReceiver>,
  expected_delta: Int,
) -> Bool {
  let total_accrued =
    list.foldl(
      receivers,
      0,
      fn(receiver, acc) {
        acc + get_receiver_accrued_drained(self, receiver)
      },
    )
  total_accrued == expected_delta
}

fn get_receiver_accrued_drained(
  self: Transaction,
  receiver: SettleReceiver,
) -> Int {
  expect Some(receiver_input) =
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          receiver.receiver_policy_id,
          receiver.receiver_asset_name,
        ) == 1
      },
    )
  expect Some(receiver_output) =
    list.find(
      self.outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver.receiver_policy_id,
          receiver.receiver_asset_name,
        ) == 1
      },
    )

  expect InlineDatum(receiver_input_datum) = receiver_input.output.datum
  expect previous_receiver: receiver_logic.ReceiverDatum = receiver_input_datum

  expect InlineDatum(receiver_output_datum) = receiver_output.datum
  expect next_receiver: receiver_logic.ReceiverDatum = receiver_output_datum

  expect and {
    receiver_logic.valid_receiver_state(previous_receiver),
    receiver_logic.valid_receiver_state(next_receiver),
    receiver_logic.exact_locked_lovelace(
      receiver_input.output,
      previous_receiver,
    ),
    receiver_logic.exact_locked_lovelace(receiver_output, next_receiver),
    receiver_logic.settle_transition(previous_receiver, next_receiver),
    receiver_output.address.payment_credential == Script(
      receiver.receiver_policy_id,
    ),
  }

  previous_receiver.accrued_to_hook_lovelace
}

fn unique_settle_receivers(receivers: List<SettleReceiver>) -> Bool {
  when receivers is {
    [] -> True
    [head, ..tail] -> and {
        !list.any(
          tail,
          fn(other) {
            and {
              other.receiver_policy_id == head.receiver_policy_id,
              other.receiver_asset_name == head.receiver_asset_name,
            }
          },
        ),
        unique_settle_receivers(tail),
      }
  }
}

fn valid_single_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  let pair_policy_id = witness.pair_policy_id
  let domain_sep = oracle_logic.domain_separator(config_datum.domain_data)
  let pair_input =
    find_unique_pair_input(self.inputs, pair_policy_id, witness.pair_token_name)

  expect Some(pair_output) =
    find_unique_pair_output(self.outputs, pair_policy_id, witness.pair_token_name)

  expect InlineDatum(output_datum_data) = pair_output.datum
  expect next_pair: oracle_logic.PairDatum = output_datum_data

  when pair_input is {
    None -> and {
        minted_pair_quantity(self, pair_policy_id, witness.pair_token_name) == 1,
        minted_pair_token_count(self, pair_policy_id) == 1,
        pair_output.address.payment_credential == Script(pair_policy_id),
        oracle_logic.exact_locked_lovelace(pair_output, next_pair),
        oracle_logic.initial_pair_matches_witness(
          next_pair,
          config_datum,
          domain_sep,
          witness,
        ),
        oracle_logic.intent_freshness_satisfied(
          witness.intent,
          self,
          config_datum.max_bootstrap_drift_seconds,
        ),
      }

    Some(pair_input) -> {
      expect InlineDatum(input_datum_data) = pair_input.output.datum
      expect previous_pair: oracle_logic.PairDatum = input_datum_data

      and {
        minted_pair_token_count(self, pair_policy_id) == 0,
        oracle_logic.next_pair_matches_witness(
          previous_pair,
          next_pair,
          config_datum,
          domain_sep,
          witness,
        ),
      }
    }
  }
}

fn valid_batch_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  let domain_sep = oracle_logic.domain_separator(config_datum.domain_data)

  and {
    list.length(witnesses) > 0,
    witnesses_sorted_unique_same_policy(witnesses),
    minted_pair_token_count(self, first_pair_policy_id(witnesses)) == create_witness_count(
      self,
      witnesses,
    ),
    list.all(
      witnesses,
      fn(witness) {
        let pair_policy_id = witness.pair_policy_id
        let pair_input =
          find_unique_pair_input(
            self.inputs,
            pair_policy_id,
            witness.pair_token_name,
          )

        expect Some(pair_output) =
          find_unique_pair_output(
            self.outputs,
            pair_policy_id,
            witness.pair_token_name,
          )

        expect InlineDatum(output_datum_data) = pair_output.datum
        expect next_pair: oracle_logic.PairDatum = output_datum_data

        when pair_input is {
          None -> and {
              minted_pair_quantity(
                self,
                pair_policy_id,
                witness.pair_token_name,
              ) == 1,
              pair_output.address.payment_credential == Script(pair_policy_id),
              oracle_logic.exact_locked_lovelace(pair_output, next_pair),
              oracle_logic.initial_pair_matches_witness(
                next_pair,
                config_datum,
                domain_sep,
                witness,
              ),
              oracle_logic.intent_freshness_satisfied(
                witness.intent,
                self,
                config_datum.max_bootstrap_drift_seconds,
              ),
            }

          Some(pair_input) -> {
            expect InlineDatum(input_datum_data) = pair_input.output.datum
            expect previous_pair: oracle_logic.PairDatum = input_datum_data

            oracle_logic.next_pair_matches_witness(
              previous_pair,
              next_pair,
              config_datum,
              domain_sep,
              witness,
            )
          }
        }
      },
    ),
  }
}

fn minted_pair_quantity(
  self: Transaction,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Int {
  assets.quantity_of(self.mint, pair_policy_id, pair_token_name)
}

fn minted_pair_token_count(self: Transaction, pair_policy_id: PolicyId) -> Int {
  self.mint
    |> assets.tokens(pair_policy_id)
    |> dict.to_pairs()
    |> list.length
}

fn create_witness_count(
  self: Transaction,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Int {
  witnesses
    |> list.filter(
        fn(witness) {
          find_unique_pair_input(
            self.inputs,
            witness.pair_policy_id,
            witness.pair_token_name,
          ) == None
        },
      )
    |> list.length
}

fn first_pair_policy_id(witnesses: List<oracle_logic.UpdateWitness>) -> PolicyId {
  expect [head, ..] = witnesses
  head.pair_policy_id
}

fn find_unique_pair_input(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Input> {
  find_unique_pair_input_go(inputs, pair_policy_id, pair_token_name, None)
}

fn find_unique_pair_input_go(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
  found: Option<Input>,
) -> Option<Input> {
  when inputs is {
    [] -> found
    [head, ..tail] ->
      if assets.quantity_of(head.output.value, pair_policy_id, pair_token_name) == 1 {
        when found is {
          None -> find_unique_pair_input_go(tail, pair_policy_id, pair_token_name, Some(head))
          Some(_) -> None
        }
      } else {
        find_unique_pair_input_go(tail, pair_policy_id, pair_token_name, found)
      }
  }
}

fn find_unique_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Output> {
  find_unique_pair_output_go(outputs, pair_policy_id, pair_token_name, None)
}

fn find_unique_pair_output_go(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
  found: Option<Output>,
) -> Option<Output> {
  when outputs is {
    [] -> found
    [head, ..tail] ->
      if assets.quantity_of(head.value, pair_policy_id, pair_token_name) == 1 {
        when found is {
          None -> find_unique_pair_output_go(tail, pair_policy_id, pair_token_name, Some(head))
          Some(_) -> None
        }
      } else {
        find_unique_pair_output_go(tail, pair_policy_id, pair_token_name, found)
      }
  }
}

fn witnesses_sorted_unique_same_policy(
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  when witnesses is {
    [] | [_] -> True
    [a, b, ..rest] -> and {
        a.pair_policy_id == b.pair_policy_id,
        bytearray.compare(a.pair_token_name, b.pair_token_name) == Less,
        witnesses_sorted_unique_same_policy([b, ..rest]),
      }
  }
}

fn witnesses_share_receiver(witnesses: List<oracle_logic.UpdateWitness>) -> Bool {
  when witnesses is {
    [] -> True
    [head, ..tail] ->
      list.all(
        tail,
        fn(other) {
          and {
            other.receiver_policy_id == head.receiver_policy_id,
            other.receiver_asset_name == head.receiver_asset_name,
          }
        },
      )
  }
}


fn sample_sort_witness(policy_id: ByteArray, token_name: ByteArray) -> oracle_logic.UpdateWitness {
  oracle_logic.UpdateWitness {
    receiver_policy_id: #"22222222222222222222222222222222222222222222222222222222",
    receiver_asset_name: #"4449415f5245434549564552",
    pair_policy_id: policy_id,
    pair_token_name: token_name,
    intent: oracle_logic.OracleIntent {
      intent_type: #"4f7261636c65557064617465",
      version: #"312e30",
      chain_id: 100640,
      nonce: 1,
      expiry: 2,
      symbol: #"555344432f555344",
      price: 1,
      timestamp: 1,
      source: #"444941204f7261636c65",
      signature: #"00",
      signer: #"0000000000000000000000000000000000000000",
    },
    signer_public_key: #"03",
  }
}

test witnesses_sorted_unique_same_policy_accepts_strict_order() {
  witnesses_sorted_unique_same_policy([
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"01"),
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"02"),
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"03"),
  ])
}

test witnesses_sorted_unique_same_policy_rejects_bad_order() {
  !witnesses_sorted_unique_same_policy([
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"02"),
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"01"),
  ])
}

test witnesses_sorted_unique_same_policy_rejects_mixed_policies() {
  !witnesses_sorted_unique_same_policy([
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"01"),
    sample_sort_witness(#"22222222222222222222222222222222222222222222222222222222", #"02"),
  ])
}

test witnesses_sorted_unique_same_policy_rejects_duplicates() {
  !witnesses_sorted_unique_same_policy([
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"01"),
    sample_sort_witness(#"11111111111111111111111111111111111111111111111111111111", #"01"),
  ])
}
