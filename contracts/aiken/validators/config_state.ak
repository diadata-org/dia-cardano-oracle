use aiken/collection/dict
use aiken/collection/list
use cardano/address.{Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use dia_cardano_oracle/config_logic

pub type ConfigMintAction {
  Bootstrap
  /// Teardown burn of the Config NFT on decommission. Admin-gated (a
  /// `config_admins` VKH must sign). Requires the policy's own token
  /// quantity in `self.mint` to be exactly `-1` for `expected_asset_name`.
  /// The Config UTxO is spent in the same tx under the `Burn` spend
  /// redeemer; the admin recovers the locked min-ADA.
  Burn
}

validator config_state(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
) {
  mint(action: ConfigMintAction, policy_id: PolicyId, self: Transaction) {
    expect [Pair(asset_name, quantity)] =
      self.mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    when action is {
      Bootstrap -> {
        let consumes_bootstrap_input =
          list.any(
            self.inputs,
            fn(input) { input.output_reference == bootstrap_ref },
          )

        and {
          consumes_bootstrap_input,
          asset_name == expected_asset_name,
          quantity == 1,
          has_valid_config_bootstrap_output(
            self.outputs,
            policy_id,
            expected_asset_name,
          ),
        }
      }

      Burn -> {
        // The Config UTxO being torn down is spent in the same tx, so
        // the Config datum is read from the input (not a reference
        // input). Both sides duplicate the admin-signer check on
        // purpose, so neither can be invoked alone.
        expect Some(config_input) =
          list.find(
            self.inputs,
            fn(input) {
              assets.quantity_of(
                input.output.value,
                policy_id,
                expected_asset_name,
              ) == 1
            },
          )
        expect InlineDatum(config_datum_data) = config_input.output.datum
        expect config_datum: config_logic.ConfigDatum = config_datum_data

        and {
          asset_name == expected_asset_name,
          quantity == -1,
          config_logic.has_config_signer(config_datum, self),
        }
      }
    }
  }

  spend(
    maybe_datum: Option<config_logic.ConfigDatum>,
    redeemer: config_logic.ConfigRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    when redeemer is {
      config_logic.AdminUpdate -> {
        expect Some(config_output) =
          list.find(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
            },
          )

        expect InlineDatum(output_datum) = config_output.datum
        expect next_datum: config_logic.ConfigDatum = output_datum

        and {
          assets.quantity_of(
            own_input.output.value,
            own_policy_id,
            expected_asset_name,
          ) == 1,
          assets.quantity_of(
            config_output.value,
            own_policy_id,
            expected_asset_name,
          ) == 1,
          config_output.address.payment_credential == Script(own_policy_id),
          config_logic.valid_config_state(current_datum),
          config_logic.valid_config_state(next_datum),
          config_logic.has_config_signer(current_datum, self),
          assets.lovelace_of(own_input.output.value) == current_datum.min_utxo_lovelace,
          assets.lovelace_of(config_output.value) == next_datum.min_utxo_lovelace,
          config_logic.admin_update_transition(current_datum, next_datum),
        }
      }

      config_logic.Burn -> and {
          config_logic.has_config_signer(current_datum, self),
          // The Config NFT carried by this very UTxO MUST be burned in
          // the same tx (quantity `-1` under this policy). Anything else
          // (e.g. moving the NFT to a wallet) would silently bypass the
          // mint-policy's burn gate, since spends and mints run
          // independently.
          assets.quantity_of(self.mint, own_policy_id, expected_asset_name) == -1,
          // No continuation output may carry the NFT: the UTxO is
          // destroyed and its locked min-ADA flows to the admin's other
          // outputs. Config has no value-bearing datum field beyond the
          // min-ADA itself, so there is no extra drain to gate.
          !list.any(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
            },
          ),
        }
    }
  }

  else(_) {
    False
  }
}

fn has_valid_config_bootstrap_output(
  outputs: List<Output>,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, config_policy_id, config_asset_name) == 1
      },
    )
  is {
    Some(config_output) ->
      when config_output.datum is {
        InlineDatum(output_datum) -> {
          expect config_datum: config_logic.ConfigDatum = output_datum
          and {
            config_output.address.payment_credential == Script(config_policy_id),
            config_logic.valid_config_state(config_datum),
            assets.lovelace_of(config_output.value) == config_datum.min_utxo_lovelace,
          }
        }

        _ -> False
      }

    None -> False
  }
}

// ---------------------------------------------------------------------------
// Teardown-burn tests
//
// On decommission the Config NFT is burned and its min-ADA recovered by the
// admin. Both the mint policy's `Burn` action and the spend `Burn` redeemer
// require a `config_admins` signature AND the NFT being burned (`-1`) in the
// same tx; the spend additionally forbids any continuation output carrying
// the NFT. These mirror `pair_state`'s `BurnPairs` / `BurnPair` tests.

const test_admin_vkh: ByteArray =
  #"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"

const test_other_vkh: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

const test_config_policy: PolicyId =
  #"cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00"

const test_config_asset: AssetName =
  #"4449415f434f4e464947"

const test_bootstrap_ref: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }

const test_own_ref: OutputReference =
  OutputReference {
    transaction_id: #"0101010101010101010101010101010101010101010101010101010101010101",
    output_index: 0,
  }

fn test_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    ..config_logic.sample_config(),
    config_admins: [test_admin_vkh],
  }
}

fn test_config_input() -> Input {
  Input {
    output_reference: test_own_ref,
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

fn test_admin_output() -> Output {
  Output {
    address: address.from_verification_key(test_admin_vkh),
    value: assets.from_lovelace(test_config_datum().min_utxo_lovelace),
    datum: NoDatum,
    reference_script: None,
  }
}

// MINT: a well-formed burn (-1 + admin signer) is accepted.
test config_burn_mint_accepts_with_admin_and_minus_one() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [test_admin_vkh],
    }
  config_state.mint(
    test_bootstrap_ref,
    test_config_asset,
    Burn,
    test_config_policy,
    tx,
  )
}

// MINT: a burn without an admin signer is rejected.
test config_burn_mint_rejects_without_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [],
    }
  !config_state.mint(
    test_bootstrap_ref,
    test_config_asset,
    Burn,
    test_config_policy,
    tx,
  )
}

// MINT: a non-admin signer is rejected even though a signature is present.
test config_burn_mint_rejects_non_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [test_other_vkh],
    }
  !config_state.mint(
    test_bootstrap_ref,
    test_config_asset,
    Burn,
    test_config_policy,
    tx,
  )
}

// MINT: a positive quantity under the Burn action is rejected (not a burn).
test config_burn_mint_rejects_positive_quantity() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, 1),
      extra_signatories: [test_admin_vkh],
    }
  !config_state.mint(
    test_bootstrap_ref,
    test_config_asset,
    Burn,
    test_config_policy,
    tx,
  )
}

// SPEND: a well-formed burn (admin signer + NFT burned + no continuation
// output) is accepted; the min-ADA flows to the admin output.
test config_burn_spend_accepts_with_admin_and_burn() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [test_admin_vkh],
      outputs: [test_admin_output()],
    }
  config_state.spend(
    test_bootstrap_ref,
    test_config_asset,
    Some(test_config_datum()),
    config_logic.Burn,
    test_own_ref,
    tx,
  )
}

// SPEND: a burn without an admin signer is rejected.
test config_burn_spend_rejects_without_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [],
      outputs: [test_admin_output()],
    }
  !config_state.spend(
    test_bootstrap_ref,
    test_config_asset,
    Some(test_config_datum()),
    config_logic.Burn,
    test_own_ref,
    tx,
  )
}

// SPEND: if the NFT is NOT burned in this tx (no `-1` entry), the spend
// fails even with an admin signature — prevents draining the min-ADA while
// keeping the NFT alive.
test config_burn_spend_rejects_without_matching_burn() {
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.zero,
      extra_signatories: [test_admin_vkh],
      outputs: [test_admin_output()],
    }
  !config_state.spend(
    test_bootstrap_ref,
    test_config_asset,
    Some(test_config_datum()),
    config_logic.Burn,
    test_own_ref,
    tx,
  )
}

// SPEND: if a continuation output still carries the NFT, the burn is
// rejected (the UTxO must be destroyed, not preserved).
test config_burn_spend_rejects_continuation_output_with_nft() {
  let continuation =
    Output {
      address: address.from_script(test_config_policy),
      value: assets.add(
        assets.from_lovelace(test_config_datum().min_utxo_lovelace),
        test_config_policy,
        test_config_asset,
        1,
      ),
      datum: InlineDatum(test_config_datum()),
      reference_script: None,
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [test_config_input()],
      mint: assets.from_asset(test_config_policy, test_config_asset, -1),
      extra_signatories: [test_admin_vkh],
      outputs: [continuation],
    }
  !config_state.spend(
    test_bootstrap_ref,
    test_config_asset,
    Some(test_config_datum()),
    config_logic.Burn,
    test_own_ref,
    tx,
  )
}
