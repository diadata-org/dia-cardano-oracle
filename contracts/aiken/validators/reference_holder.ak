use aiken/collection/list
use cardano/address
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, Output, OutputReference, Transaction,
  placeholder}
use dia_cardano_oracle/config_logic

validator reference_holder(
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) {
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(config_input) =
      find_config_input(self, config_policy_id, config_asset_name)
    expect InlineDatum(config_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_data
    config_logic.has_config_signer(config_datum, self)
  }

  else(_) {
    False
  }
}

fn find_config_input(
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
    Some(i) -> Some(i)
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

// ---------------------------------------------------------------------------
// Tests — reclaiming a published reference-script UTxO is admin-gated by the
// canonical Config (found via its NFT, in either inputs or reference inputs).
// ---------------------------------------------------------------------------

const test_admin_vkh: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const test_other_vkh: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const test_config_policy: PolicyId =
  #"cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00"

const test_config_asset: AssetName = #"4449415f434f4e464947"

const test_own_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

fn test_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum { ..config_logic.sample_config(), config_admins: [test_admin_vkh] }
}

/// A Config UTxO carrying the Config NFT + the ConfigDatum (admins = [admin]).
fn config_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"abababababababababababababababababababababababababababababababab",
      output_index: 0,
    },
    output: Output {
      address: address.from_script(test_config_policy),
      value: assets.add(
        assets.from_lovelace(test_config_datum().min_utxo_lovelace),
        test_config_policy,
        test_config_asset,
        1,
      ),
      datum: InlineDatum(test_config_datum()),
      reference_script: None,
    },
  }
}

test reclaim_accepts_with_config_in_inputs_and_admin_signer() {
  let tx =
    Transaction { ..placeholder, inputs: [config_input()], extra_signatories: [test_admin_vkh] }
  reference_holder.spend(test_config_policy, test_config_asset, None, Void, test_own_ref, tx)
}

test reclaim_accepts_with_config_in_reference_inputs_and_admin_signer() {
  // The config NFT may travel as a reference input instead of a spent input.
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [config_input()],
      extra_signatories: [test_admin_vkh],
    }
  reference_holder.spend(test_config_policy, test_config_asset, None, Void, test_own_ref, tx)
}

test reclaim_rejects_without_admin_signer() {
  let tx = Transaction { ..placeholder, inputs: [config_input()], extra_signatories: [] }
  !reference_holder.spend(test_config_policy, test_config_asset, None, Void, test_own_ref, tx)
}

test reclaim_rejects_non_admin_signer() {
  let tx =
    Transaction { ..placeholder, inputs: [config_input()], extra_signatories: [test_other_vkh] }
  !reference_holder.spend(test_config_policy, test_config_asset, None, Void, test_own_ref, tx)
}

test reclaim_rejects_without_config_nft() fail {
  // The config lookup scans inputs then reference inputs; with the NFT in
  // neither, `expect Some(..)` finds nothing and the validator fails.
  let tx = Transaction { ..placeholder, inputs: [], extra_signatories: [test_admin_vkh] }
  reference_holder.spend(test_config_policy, test_config_asset, None, Void, test_own_ref, tx)
}
