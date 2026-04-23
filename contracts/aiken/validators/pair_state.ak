use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Credential, Script}
use cardano/assets
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/oracle_logic

pub type PairMintAction {
  BootstrapPair(oracle_logic.UpdateWitness)
}

pub type PairSpendAction {
  ApplyUpdate
}

validator pair_state(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  mint(action: PairMintAction, policy_id: PolicyId, self: Transaction) {
    let BootstrapPair(witness) = action

    expect [Pair(asset_name, quantity)] =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    expect Some(config_input) =
      list.find(
        self.inputs,
        fn(input) {
          assets.quantity_of(input.output.value, config_policy_id, config_asset_name) == 1
        },
      )

    expect Some(config_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, config_policy_id, config_asset_name) == 1
        },
      )

    expect InlineDatum(config_input_datum) = config_input.output.datum
    expect previous_config: config_logic.ConfigDatum = config_input_datum

    expect InlineDatum(config_output_datum) = config_output.datum
    expect next_config: config_logic.ConfigDatum = config_output_datum

    expect Some(pair) = config_logic.find_pair_by_token_name(next_config, asset_name)

    and {
      quantity == 1,
      witness.pair_token_name == asset_name,
      config_logic.valid_config_state(previous_config),
      config_logic.valid_config_state(next_config),
      config_logic.has_config_signer(previous_config, self),
      config_logic.registered_pair_transition(previous_config, next_config, pair),
      oracle_logic.has_valid_signature(next_config, witness),
      has_valid_pair_bootstrap_output(self.outputs, policy_id, pair, next_config, witness),
    }
  }

  spend(
    maybe_datum: Option<oracle_logic.PairDatum>,
    redeemer: PairSpendAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    let ApplyUpdate = redeemer

    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect [Pair(pair_token_name, 1)] =
      own_input.output.value
        |> assets.tokens(own_policy_id)
        |> dict.to_pairs()

    expect Some(config_input) =
      list.find(
        self.reference_inputs,
        fn(input) {
          assets.quantity_of(input.output.value, config_policy_id, config_asset_name) == 1
        },
      )

    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    expect Some(pair_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, own_policy_id, pair_token_name) == 1
        },
      )

    expect InlineDatum(output_datum) = pair_output.datum
    expect next_datum: oracle_logic.PairDatum = output_datum

    and {
      oracle_logic.valid_pair_state(current_datum),
      oracle_logic.valid_pair_state(next_datum),
      assets.quantity_of(pair_output.value, own_policy_id, pair_token_name) == 1,
      current_datum.pair_id == next_datum.pair_id,
      current_datum.min_utxo_lovelace == next_datum.min_utxo_lovelace,
      oracle_logic.exact_locked_lovelace(own_input.output, current_datum),
      oracle_logic.exact_locked_lovelace(pair_output, next_datum),
      oracle_logic.pair_is_authorized(config_datum, pair_token_name, next_datum.pair_id),
      coordinator_witness_present(self.withdrawals, config_datum),
    }
  }

  else(_) {
    False
  }
}

fn has_valid_pair_bootstrap_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair: config_logic.PairEntry,
  config_datum: config_logic.ConfigDatum,
  witness: oracle_logic.UpdateWitness,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, pair_policy_id, pair.token_name) == 1
      },
    )
  is {
    Some(matching_output) ->
      when matching_output.datum is {
        InlineDatum(output_datum) -> {
          expect pair_datum: oracle_logic.PairDatum = output_datum
          and {
            oracle_logic.valid_initial_pair_datum(pair, config_datum, pair_datum, witness),
            oracle_logic.exact_locked_lovelace(matching_output, pair_datum),
          }
        }

        _ -> False
      }

    None -> False
  }
}

fn coordinator_witness_present(
  withdrawals: Pairs<Credential, Int>,
  config_datum: config_logic.ConfigDatum,
) -> Bool {
  when config_datum.update_coordinator_credential is {
    Some(expected_credential) ->
      list.any(withdrawals, fn(withdrawal) { withdrawal.1st == expected_credential })

    None -> False
  }
}
