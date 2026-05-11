use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  IntentForReceiverAccrue, IntentForReceiverSettle, coordinator_intent_matches,
}
use dia_cardano_oracle/receiver_logic

pub type ReceiverMintAction {
  Bootstrap
}

validator receiver(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  mint(action: ReceiverMintAction, policy_id: PolicyId, self: Transaction) {
    let Bootstrap = action

    expect [Pair(asset_name, quantity)] =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    let consumes_bootstrap_input =
      list.any(
        self.inputs,
        fn(input) { input.output_reference == bootstrap_ref },
      )

    expect Some(config_input) =
      find_visible_config_input(self, config_policy_id, config_asset_name)
    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    and {
      consumes_bootstrap_input,
      asset_name == expected_asset_name,
      quantity == 1,
      config_logic.valid_config_state(config_datum),
      config_logic.has_config_signer(config_datum, self),
      has_valid_receiver_output(self.outputs, policy_id, expected_asset_name),
    }
  }

  spend(
    maybe_datum: Option<receiver_logic.ReceiverDatum>,
    redeemer: receiver_logic.ReceiverRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect Some(next_output) =
      list.find(
        self.outputs,
        fn(output) {
          assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
        },
      )

    expect InlineDatum(next_output_datum) = next_output.datum
    expect next_datum: receiver_logic.ReceiverDatum = next_output_datum

    and {
      receiver_logic.valid_receiver_state(current_datum),
      receiver_logic.valid_receiver_state(next_datum),
      own_policy_id == expected_receiver_hash(own_input.output),
      assets.quantity_of(
        own_input.output.value,
        own_policy_id,
        expected_asset_name,
      ) == 1,
      assets.quantity_of(next_output.value, own_policy_id, expected_asset_name) == 1,
      next_output.address.payment_credential == Script(own_policy_id),
      receiver_logic.exact_locked_lovelace(own_input.output, current_datum),
      receiver_logic.exact_locked_lovelace(next_output, next_datum),
      when redeemer is {
        receiver_logic.TopUp ->
          receiver_logic.top_up_transition(
            own_input.output,
            next_output,
            current_datum,
            next_datum,
          )

        // The protocol fee is moved from `balance_lovelace` to
        // `accrued_to_hook_lovelace` on the same UTxO. The actual lovelace
        // does not move out of the Receiver until a settlement tx flushes
        // accrued to the global PaymentHook. Per the coordinator-witness
        // pattern, this spend only does the local invariant
        // check and defers cross-UTxO arithmetic to the coordinator.
        receiver_logic.AccrueFee -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            coordinator_intent_matches(
              self,
              config_datum,
              IntentForReceiverAccrue {
                receiver_policy_id: own_policy_id,
                receiver_asset_name: expected_asset_name,
              },
            ),
            receiver_logic.accrue_fee_transition(
              current_datum,
              next_datum,
              current_datum.balance_lovelace - next_datum.balance_lovelace,
            ),
          }
        }

        // Drains pending fees to zero on this Receiver. Coordinator
        // verifies that the lovelace decrease here is summed into the
        // PaymentHook delta in the same tx. Local check only.
        receiver_logic.Settle -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            coordinator_intent_matches(
              self,
              config_datum,
              IntentForReceiverSettle {
                receiver_policy_id: own_policy_id,
                receiver_asset_name: expected_asset_name,
              },
            ),
            receiver_logic.settle_transition(current_datum, next_datum),
          }
        }

        receiver_logic.Withdraw { amount, recipient } -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            config_logic.has_config_signer(config_datum, self),
            receiver_logic.withdraw_transition(
              current_datum,
              next_datum,
              amount,
            ),
            receiver_logic.paid_to_recipient(self.outputs, recipient, amount),
          }
        }

        // Admin-only update of min_utxo_lovelace. Requires config signer.
        receiver_logic.UpdateMinUtxo { new_min_utxo_lovelace } -> {
          expect Some(config_input) =
            find_visible_config_input(self, config_policy_id, config_asset_name)
          expect InlineDatum(config_datum_data) = config_input.output.datum
          expect config_datum: config_logic.ConfigDatum = config_datum_data

          and {
            config_logic.valid_config_state(config_datum),
            config_logic.has_config_signer(config_datum, self),
            receiver_logic.update_min_utxo_transition(
              current_datum,
              next_datum,
              new_min_utxo_lovelace,
            ),
          }
        }
      },
    }
  }

  else(_) {
    False
  }
}

fn has_valid_receiver_output(
  outputs: List<Output>,
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(
          output.value,
          receiver_policy_id,
          receiver_asset_name,
        ) == 1
      },
    )
  is {
    Some(receiver_output) ->
      when receiver_output.datum is {
        InlineDatum(output_datum) -> {
          expect receiver_datum: receiver_logic.ReceiverDatum = output_datum
          and {
            receiver_output.address.payment_credential == Script(
              receiver_policy_id,
            ),
            receiver_logic.valid_receiver_state(receiver_datum),
            receiver_logic.exact_locked_lovelace(
              receiver_output,
              receiver_datum,
            ),
          }
        }

        _ -> False
      }

    None -> False
  }
}

fn find_visible_config_input(
  self: Transaction,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) -> Option<Input> {
  when
    list.find(
      self.inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          config_policy_id,
          config_asset_name,
        ) == 1
      },
    )
  is {
    Some(input) -> Some(input)
    None ->
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
  }
}

fn expected_receiver_hash(output: Output) -> PolicyId {
  expect Script(receiver_hash) = output.address.payment_credential
  receiver_hash
}
