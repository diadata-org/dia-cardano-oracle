use aiken/collection/list
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
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
