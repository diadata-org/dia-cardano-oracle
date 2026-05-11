use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{pair_intent_satisfied}
use dia_cardano_oracle/oracle_logic

pub type PairMintAction {
  MintPairs
}

pub type PairSpendAction {
  ApplyUpdate
  /// Admin-only update of min_utxo_lovelace. Requires config signer authorization.
  UpdateMinUtxo { new_min_utxo_lovelace: Int }
}

validator pair_state(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
  receiver_hash: ScriptHash,
) {
  mint(action: PairMintAction, policy_id: PolicyId, self: Transaction) {
    let MintPairs = action
    let minted_pairs =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

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
      list.length(minted_pairs) > 0,
      list.all(
        minted_pairs,
        fn(minted_pair) {
          let Pair(asset_name, quantity) = minted_pair
          and {
            quantity == 1,
            has_pair_output(self.outputs, policy_id, asset_name),
            // Binds the coordinator redeemer to this exact Pair NFT AND
            // re-asserts intent expiry locally (defence-in-depth: every
            // path that consumes a signed intent enforces expiry, not
            // only the coordinator's own redeemer body).
            pair_intent_satisfied(self, config_datum, policy_id, asset_name),
          }
        },
      ),
      config_logic.valid_config_state(config_datum),
    }
  }

  spend(
    maybe_datum: Option<oracle_logic.PairDatum>,
    redeemer: PairSpendAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
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
          assets.quantity_of(
            input.output.value,
            config_policy_id,
            config_asset_name,
          ) == 1
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

    when redeemer is {
      ApplyUpdate -> {
        and {
          oracle_logic.valid_pair_state(current_datum),
          oracle_logic.valid_pair_state(next_datum),
          assets.quantity_of(pair_output.value, own_policy_id, pair_token_name) == 1,
          pair_output.address.payment_credential == Script(own_policy_id),
          current_datum.pair_id == next_datum.pair_id,
          current_datum.min_utxo_lovelace == next_datum.min_utxo_lovelace,
          pair_token_name == oracle_logic.pair_asset_name(current_datum.pair_id),
          receiver_input_present(self.inputs, receiver_hash),
          config_logic.valid_config_state(config_datum),
          oracle_logic.exact_locked_lovelace(own_input.output, current_datum),
          oracle_logic.exact_locked_lovelace(pair_output, next_datum),
          // Same defence-in-depth as the mint branch: bind to this Pair NFT
          // AND enforce intent expiry locally on the spend path.
          pair_intent_satisfied(
            self,
            config_datum,
            own_policy_id,
            pair_token_name,
          ),
        }
      }

      UpdateMinUtxo { new_min_utxo_lovelace } -> {
        // Admin-only: config signer required
        and {
          config_logic.has_config_signer(config_datum, self),
          new_min_utxo_lovelace > 0,
          next_datum.min_utxo_lovelace == new_min_utxo_lovelace,
          // All other fields must remain unchanged
          next_datum.pair_id == current_datum.pair_id,
          next_datum.price == current_datum.price,
          next_datum.timestamp == current_datum.timestamp,
          next_datum.nonce == current_datum.nonce,
          next_datum.intent_hash == current_datum.intent_hash,
          next_datum.signer == current_datum.signer,
          // Basic validity and output checks
          oracle_logic.valid_pair_state(current_datum),
          oracle_logic.valid_pair_state(next_datum),
          assets.quantity_of(pair_output.value, own_policy_id, pair_token_name) == 1,
          pair_output.address.payment_credential == Script(own_policy_id),
          pair_token_name == oracle_logic.pair_asset_name(current_datum.pair_id),
          config_logic.valid_config_state(config_datum),
          oracle_logic.exact_locked_lovelace(own_input.output, current_datum),
          oracle_logic.exact_locked_lovelace(pair_output, next_datum),
        }
      }
    }
  }

  else(_) {
    False
  }
}

fn has_pair_output(
  outputs: List<Output>,
  pair_policy_id: PolicyId,
  pair_asset_name: ByteArray,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, pair_policy_id, pair_asset_name) == 1
      },
    )
  is {
    Some(matching_output) ->
      when matching_output.datum is {
        InlineDatum(output_datum) -> {
          expect pair_datum: oracle_logic.PairDatum = output_datum
          and {
            matching_output.address.payment_credential == Script(pair_policy_id),
            oracle_logic.pair_asset_name(pair_datum.pair_id) == pair_asset_name,
            oracle_logic.valid_pair_state(pair_datum),
            oracle_logic.exact_locked_lovelace(matching_output, pair_datum),
          }
        }

        _ -> False
      }

    None -> False
  }
}

fn receiver_input_present(
  inputs: List<Input>,
  receiver_hash: ScriptHash,
) -> Bool {
  list.any(
    inputs,
    fn(input) {
      input.output.address.payment_credential == Script(receiver_hash)
    },
  )
}
