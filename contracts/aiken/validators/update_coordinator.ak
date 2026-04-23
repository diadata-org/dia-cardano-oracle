use aiken/collection/list
use cardano/address.{Credential}
use cardano/assets
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/oracle_logic
use dia_cardano_oracle/payment_hook_logic

pub type CoordinatorRedeemer {
  ApplySingle(oracle_logic.UpdateWitness)
  ApplyBatch(List<oracle_logic.UpdateWitness>)
}

validator update_coordinator(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
  pair_policy_id: PolicyId,
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
          assets.quantity_of(input.output.value, config_policy_id, config_asset_name) == 1
        },
      )

    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    expect Some(payment_hook_ref) = config_datum.payment_hook_ref

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

    and {
      config_logic.valid_config_state(config_datum),
      config_datum.update_coordinator_credential == Some(own_credential),
      payment_hook_logic.valid_payment_hook_state(previous_hook),
      payment_hook_logic.valid_payment_hook_state(next_hook),
      payment_hook_logic.exact_locked_lovelace(hook_input.output, previous_hook),
      payment_hook_logic.exact_locked_lovelace(hook_output, next_hook),
      payment_hook_logic.fee_charge_transition(previous_hook, next_hook),
      when redeemer is {
        ApplySingle(witness) ->
          valid_single_update(self, config_datum, pair_policy_id, witness)

        ApplyBatch(witnesses) ->
          valid_batch_update(self, config_datum, pair_policy_id, witnesses)
      },
    }
  }

  else(_) {
    False
  }
}

fn valid_single_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  pair_policy_id: PolicyId,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  let pair_input_count = count_pair_inputs(self.inputs, pair_policy_id)
  let pair_output_count = count_pair_outputs(self.outputs, pair_policy_id)

  expect Some(pair_input) = find_pair_input(self.inputs, pair_policy_id, witness.pair_token_name)
  expect Some(pair_output) =
    find_pair_output(self.outputs, pair_policy_id, witness.pair_token_name)

  expect InlineDatum(input_datum_data) = pair_input.output.datum
  expect previous_pair: oracle_logic.PairDatum = input_datum_data

  expect InlineDatum(output_datum_data) = pair_output.datum
  expect next_pair: oracle_logic.PairDatum = output_datum_data

  and {
    pair_input_count == 1,
    pair_output_count == 1,
    oracle_logic.next_pair_matches_witness(
      previous_pair,
      next_pair,
      config_datum,
      witness,
    ),
  }
}

fn valid_batch_update(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  pair_policy_id: PolicyId,
  witnesses: List<oracle_logic.UpdateWitness>,
) -> Bool {
  and {
    list.length(witnesses) > 0,
    unique_pair_token_names(witnesses),
    count_pair_inputs(self.inputs, pair_policy_id) == list.length(witnesses),
    count_pair_outputs(self.outputs, pair_policy_id) == list.length(witnesses),
    list.all(
      witnesses,
      fn(witness) {
        expect Some(pair_input) =
          find_pair_input(self.inputs, pair_policy_id, witness.pair_token_name)
        expect Some(pair_output) =
          find_pair_output(self.outputs, pair_policy_id, witness.pair_token_name)

        expect InlineDatum(input_datum_data) = pair_input.output.datum
        expect previous_pair: oracle_logic.PairDatum = input_datum_data

        expect InlineDatum(output_datum_data) = pair_output.datum
        expect next_pair: oracle_logic.PairDatum = output_datum_data

        oracle_logic.next_pair_matches_witness(
          previous_pair,
          next_pair,
          config_datum,
          witness,
        )
      },
    ),
  }
}

fn find_pair_input(
  inputs: List<Input>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Input> {
  list.find(
    inputs,
    fn(input) {
      assets.quantity_of(input.output.value, pair_policy_id, pair_token_name) == 1
    },
  )
}

fn find_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<Output> {
  list.find(
    outputs,
    fn(output) {
      assets.quantity_of(output.value, pair_policy_id, pair_token_name) == 1
    },
  )
}

fn count_pair_inputs(inputs: List<Input>, pair_policy_id: PolicyId) -> Int {
  inputs
    |> list.filter(fn(input) { assets.has_any_nft(input.output.value, pair_policy_id) })
    |> list.length
}

fn count_pair_outputs(outputs: List<Output>, pair_policy_id: PolicyId) -> Int {
  outputs
    |> list.filter(fn(output) { assets.has_any_nft(output.value, pair_policy_id) })
    |> list.length
}

fn unique_pair_token_names(witnesses: List<oracle_logic.UpdateWitness>) -> Bool {
  when witnesses is {
    [] -> True
    [head, ..tail] ->
      and {
        !list.any(
          tail,
          fn(other) { other.pair_token_name == head.pair_token_name },
        ),
        unique_pair_token_names(tail),
      }
  }
}
