use aiken/collection/dict
use aiken/collection/list
use aiken/fuzz
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Redeemer, Transaction,
  Withdraw, placeholder,
}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/coordinator_logic.{
  ApplySettle, CoordinatorRedeemer, SettleManifest, SettleReceiver,
  IntentForHookSettle, coordinator_intent_matches,
}
use dia_cardano_oracle/payment_hook_logic

pub type PaymentHookMintAction {
  Bootstrap
  /// Teardown burn of the PaymentHook NFT on decommission. Admin-gated.
  /// Requires the policy's own token quantity in `self.mint` to be
  /// exactly `-1` for `expected_asset_name`. The Config UTxO is located
  /// via the same visible-config helper the spend uses (input or
  /// reference input). The PaymentHook UTxO is spent in the same tx
  /// under the `Burn` spend redeemer; the admin recovers the min-ADA.
  Burn
}

validator payment_hook(
  bootstrap_ref: OutputReference,
  expected_asset_name: AssetName,
  config_policy_id: PolicyId,
  config_asset_name: AssetName,
  coordinator_credential: Credential,
) {
  mint(action: PaymentHookMintAction, policy_id: PolicyId, self: Transaction) {
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

        expect Some(config_input) =
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

        and {
          consumes_bootstrap_input,
          asset_name == expected_asset_name,
          quantity == 1,
          config_logic.valid_config_state(previous_config),
          config_logic.valid_config_state(next_config),
          previous_config.payment_hook_ref == None,
          previous_config.update_coordinator_credential == None,
          next_config.payment_hook_ref == Some(
            config_logic.PaymentHookRef {
              policy_id,
              asset_name: expected_asset_name,
            },
          ),
          next_config.update_coordinator_credential == Some(coordinator_credential),
          config_logic.has_config_signer(previous_config, self),
          has_valid_payment_hook_output(
            self.outputs,
            policy_id,
            expected_asset_name,
          ),
        }
      }

      Burn -> {
        // Admin-gated teardown burn. The Config UTxO is located via the
        // SAME visible-config helper the spend uses (input or reference
        // input), and the admin signature is read off its datum.
        expect Some(config_input) =
          find_visible_config_input(self, config_policy_id, config_asset_name)
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
    maybe_datum: Option<payment_hook_logic.PaymentHookDatum>,
    redeemer: payment_hook_logic.PaymentHookRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(current_datum) = maybe_datum
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect Script(own_policy_id) = own_input.output.address.payment_credential

    expect Some(config_input) =
      find_visible_config_input(self, config_policy_id, config_asset_name)
    expect InlineDatum(config_datum_data) = config_input.output.datum
    expect config_datum: config_logic.ConfigDatum = config_datum_data

    when redeemer is {
      payment_hook_logic.Burn -> and {
          // Admin-gated teardown. The PaymentHook NFT carried by this
          // very UTxO MUST be burned in the same tx (quantity `-1`);
          // both the mint policy's `Burn` and this spend duplicate the
          // admin-signer check, so neither side can be invoked alone.
          config_logic.has_config_signer(config_datum, self),
          assets.quantity_of(self.mint, own_policy_id, expected_asset_name) == -1,
          // No continuation output may carry the NFT: the UTxO is
          // destroyed and its locked min-ADA flows to the admin's other
          // outputs.
          !list.any(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
            },
          ),
          // Burn can NEVER be a backdoor around the proper fee drain:
          // all accrued fees must already have been withdrawn.
          current_datum.accrued_fees_lovelace == 0,
        }

      _ -> {
        expect Some(next_output) =
          list.find(
            self.outputs,
            fn(output) {
              assets.quantity_of(output.value, own_policy_id, expected_asset_name) == 1
            },
          )

        expect InlineDatum(next_output_datum) = next_output.datum
        expect next_datum: payment_hook_logic.PaymentHookDatum = next_output_datum

        and {
          payment_hook_logic.valid_payment_hook_state(current_datum),
          payment_hook_logic.valid_payment_hook_state(next_datum),
          assets.quantity_of(
            own_input.output.value,
            own_policy_id,
            expected_asset_name,
          ) == 1,
          assets.quantity_of(next_output.value, own_policy_id, expected_asset_name) == 1,
          next_output.address.payment_credential == Script(own_policy_id),
          payment_hook_logic.exact_locked_lovelace(own_input.output, current_datum),
          payment_hook_logic.exact_locked_lovelace(next_output, next_datum),
          when redeemer is {
            payment_hook_logic.ApplySettle -> {
              let delta =
                next_datum.accrued_fees_lovelace - current_datum.accrued_fees_lovelace

              and {
                has_expected_hook_ref(
                  config_datum,
                  own_policy_id,
                  expected_asset_name,
                ),
                coordinator_intent_matches(self, config_datum, IntentForHookSettle),
                // Defense-in-depth: also require an admin signature on
                // the hook spend, in addition to the coordinator witness.
                // Cheap (one tx-wide check) and protects the
                // single-most-valuable UTxO in the protocol.
                config_logic.has_config_signer(config_datum, self),
                payment_hook_logic.apply_settle_transition(
                  current_datum,
                  next_datum,
                  delta,
                ),
              }
            }

            payment_hook_logic.AdminUpdate -> and {
                config_logic.has_config_signer(config_datum, self),
                payment_hook_logic.admin_update_transition(
                  current_datum,
                  next_datum,
                ),
              }

            payment_hook_logic.Withdraw { amount } -> and {
                config_logic.has_config_signer(config_datum, self),
                payment_hook_logic.withdraw_transition(
                  current_datum,
                  next_datum,
                  amount,
                ),
                payment_hook_logic.withdraw_paid_to_target(
                  self.outputs,
                  current_datum.withdraw_address,
                  amount,
                ),
              }

            // Unreachable: the outer `when` already handled `Burn`.
            payment_hook_logic.Burn -> False
          }
        }
      }
    }
  }

  else(_) {
    False
  }
}

fn has_valid_payment_hook_output(
  outputs: List<Output>,
  hook_policy_id: PolicyId,
  hook_asset_name: AssetName,
) -> Bool {
  when
    list.find(
      outputs,
      fn(output) {
        assets.quantity_of(output.value, hook_policy_id, hook_asset_name) == 1
      },
    )
  is {
    Some(hook_output) ->
      when hook_output.datum is {
        InlineDatum(output_datum) -> {
          expect hook_datum: payment_hook_logic.PaymentHookDatum = output_datum
          and {
            hook_output.address.payment_credential == Script(hook_policy_id),
            payment_hook_logic.valid_payment_hook_state(hook_datum),
            payment_hook_logic.exact_locked_lovelace(hook_output, hook_datum),
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

fn has_expected_hook_ref(
  config_datum: config_logic.ConfigDatum,
  hook_policy_id: PolicyId,
  hook_asset_name: AssetName,
) -> Bool {
  config_datum.payment_hook_ref == Some(
    config_logic.PaymentHookRef {
      policy_id: hook_policy_id,
      asset_name: hook_asset_name,
    },
  )
}

// ---------------------------------------------------------------------------
// Benchmarks
//
// `payment_hook.spend ApplySettle` is on a hot operational path and currently
// decodes the full `ApplySettle(manifest)` redeemer even though it only needs
// to know the coordinator is in settle mode. This bench gives us a baseline for
// that growth before optimizing the binding.

const bench_bootstrap_ref: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }

const bench_hook_ref: OutputReference =
  OutputReference {
    transaction_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    output_index: 0,
  }

const bench_config_ref: OutputReference =
  OutputReference {
    transaction_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    output_index: 0,
  }

const bench_config_policy: PolicyId =
  #"cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00cf00"

const bench_config_asset: AssetName =
  #"4449415f434f4e464947"

const bench_hook_policy: PolicyId =
  #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

const bench_hook_asset: AssetName =
  #"484f4f4b"

const bench_coord_credential: Credential =
  Script(#"abababababababababababababababababababababababababababab")

const bench_admin_vkh: ByteArray =
  #"11111111111111111111111111111111111111111111111111111111"

type PaymentHookBenchCase {
  PaymentHookBenchCase {
    own_ref: OutputReference,
    current_datum: payment_hook_logic.PaymentHookDatum,
    tx: Transaction,
  }
}

fn bench_config_datum() -> config_logic.ConfigDatum {
  config_logic.ConfigDatum {
    ..config_logic.sample_config(),
    config_admins: [bench_admin_vkh],
    payment_hook_ref: Some(
      config_logic.PaymentHookRef {
        policy_id: bench_hook_policy,
        asset_name: bench_hook_asset,
      },
    ),
    update_coordinator_credential: Some(bench_coord_credential),
  }
}

fn bench_hook_output(datum: payment_hook_logic.PaymentHookDatum) -> Output {
  Output {
    address: address.from_script(bench_hook_policy),
    value:
      assets.add(
        assets.from_lovelace(
          datum.min_utxo_lovelace + datum.accrued_fees_lovelace,
        ),
        bench_hook_policy,
        bench_hook_asset,
        1,
      ),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn bench_hook_input(
  own_ref: OutputReference,
  datum: payment_hook_logic.PaymentHookDatum,
) -> Input {
  Input { output_reference: own_ref, output: bench_hook_output(datum) }
}

fn bench_config_input() -> Input {
  Input {
    output_reference: bench_config_ref,
    output: Output {
      address: address.from_script(
        #"ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ),
      value: assets.from_asset(bench_config_policy, bench_config_asset, 1),
      datum: InlineDatum(bench_config_datum()),
      reference_script: None,
    },
  }
}

fn bench_manifest_receivers(count: Int) -> List<SettleReceiver> {
  if count <= 0 {
    []
  } else {
    let tail = bench_manifest_receivers(count - 1)
    [
      SettleReceiver {
        receiver_policy_id: #"99999999999999999999999999999999999999999999999999999999",
        receiver_asset_name: #"4449415f52454345495645525f4d414e4946455354",
      },
      ..tail
    ]
  }
}

fn payment_hook_bench_case(count: Int) -> PaymentHookBenchCase {
  let current =
    payment_hook_logic.PaymentHookDatum {
      ..payment_hook_logic.sample_payment_hook(),
      accrued_fees_lovelace: 1_000_000,
      lifetime_collected_lovelace: 5_000_000,
    }
  let next =
    payment_hook_logic.PaymentHookDatum {
      ..current,
      accrued_fees_lovelace: 4_000_000,
      lifetime_collected_lovelace: 8_000_000,
    }
  let coord_redeemer: CoordinatorRedeemer =
    ApplySettle(
      SettleManifest { receivers: bench_manifest_receivers(count) },
    )
  let payload: Redeemer = coord_redeemer

  PaymentHookBenchCase {
    own_ref: bench_hook_ref,
    current_datum: current,
    tx: Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      outputs: [bench_hook_output(next)],
      redeemers: [Pair(Withdraw(bench_coord_credential), payload)],
      extra_signatories: [bench_admin_vkh],
    },
  }
}

fn sample_payment_hook_case(size: Int) -> Fuzzer<PaymentHookBenchCase> {
  fuzz.constant(payment_hook_bench_case(size + 1))
}

bench payment_hook_spend_apply_settle_decodes_manifest(
  bench_case via sample_payment_hook_case,
) {
  payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(bench_case.current_datum),
    payment_hook_logic.ApplySettle,
    bench_case.own_ref,
    bench_case.tx,
  )
}

// ---------------------------------------------------------------------------
// Teardown-burn tests
//
// On decommission the PaymentHook NFT is burned and its min-ADA recovered by
// the admin. Both the mint policy's `Burn` action and the spend `Burn`
// redeemer require a `config_admins` signature AND the NFT being burned
// (`-1`) in the same tx; the spend additionally forbids any continuation
// output carrying the NFT AND requires `accrued_fees_lovelace == 0` so burn
// can never be a backdoor around the payment-hook withdraw. These mirror
// `pair_state`'s `BurnPairs` / `BurnPair` tests.

const burn_other_vkh: ByteArray =
  #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

fn burn_hook_datum_zero_accrued() -> payment_hook_logic.PaymentHookDatum {
  payment_hook_logic.PaymentHookDatum {
    ..payment_hook_logic.sample_payment_hook(),
    accrued_fees_lovelace: 0,
  }
}

fn burn_admin_output() -> Output {
  Output {
    address: address.from_verification_key(bench_admin_vkh),
    value: assets.from_lovelace(
      burn_hook_datum_zero_accrued().min_utxo_lovelace,
    ),
    datum: NoDatum,
    reference_script: None,
  }
}

// MINT: a well-formed burn (-1 + admin signer) is accepted.
test hook_burn_mint_accepts_with_admin_and_minus_one() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [bench_admin_vkh],
    }
  payment_hook.mint(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Burn,
    bench_hook_policy,
    tx,
  )
}

// MINT: a burn without an admin signer is rejected.
test hook_burn_mint_rejects_without_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [],
    }
  !payment_hook.mint(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Burn,
    bench_hook_policy,
    tx,
  )
}

// MINT: a non-admin signer is rejected even though a signature is present.
test hook_burn_mint_rejects_non_admin_signer() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [burn_other_vkh],
    }
  !payment_hook.mint(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Burn,
    bench_hook_policy,
    tx,
  )
}

// MINT: a positive quantity under the Burn action is rejected (not a burn).
test hook_burn_mint_rejects_positive_quantity() {
  let tx =
    Transaction {
      ..placeholder,
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, 1),
      extra_signatories: [bench_admin_vkh],
    }
  !payment_hook.mint(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Burn,
    bench_hook_policy,
    tx,
  )
}

// SPEND: a well-formed burn (admin signer + NFT burned + no continuation
// output + accrued == 0) is accepted; the min-ADA flows to the admin output.
test hook_burn_spend_accepts_with_admin_and_burn() {
  let current = burn_hook_datum_zero_accrued()
  let tx =
    Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [bench_admin_vkh],
      outputs: [burn_admin_output()],
    }
  payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(current),
    payment_hook_logic.Burn,
    bench_hook_ref,
    tx,
  )
}

// SPEND: a burn without an admin signer is rejected.
test hook_burn_spend_rejects_without_admin_signer() {
  let current = burn_hook_datum_zero_accrued()
  let tx =
    Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [],
      outputs: [burn_admin_output()],
    }
  !payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(current),
    payment_hook_logic.Burn,
    bench_hook_ref,
    tx,
  )
}

// SPEND: if the NFT is NOT burned in this tx (no `-1` entry), the spend
// fails even with an admin signature.
test hook_burn_spend_rejects_without_matching_burn() {
  let current = burn_hook_datum_zero_accrued()
  let tx =
    Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      mint: assets.zero,
      extra_signatories: [bench_admin_vkh],
      outputs: [burn_admin_output()],
    }
  !payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(current),
    payment_hook_logic.Burn,
    bench_hook_ref,
    tx,
  )
}

// SPEND: if a continuation output still carries the NFT, the burn is
// rejected (the UTxO must be destroyed, not preserved).
test hook_burn_spend_rejects_continuation_output_with_nft() {
  let current = burn_hook_datum_zero_accrued()
  let tx =
    Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [bench_admin_vkh],
      outputs: [bench_hook_output(current)],
    }
  !payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(current),
    payment_hook_logic.Burn,
    bench_hook_ref,
    tx,
  )
}

// SPEND: if `accrued_fees_lovelace != 0`, the burn is rejected — the admin
// must run payment-hook:withdraw first, so burn can never drain pending
// protocol fees.
test hook_burn_spend_rejects_nonzero_accrued_fees() {
  let current =
    payment_hook_logic.PaymentHookDatum {
      ..payment_hook_logic.sample_payment_hook(),
      accrued_fees_lovelace: 1_000_000,
    }
  let tx =
    Transaction {
      ..placeholder,
      inputs: [bench_hook_input(bench_hook_ref, current)],
      reference_inputs: [bench_config_input()],
      mint: assets.from_asset(bench_hook_policy, bench_hook_asset, -1),
      extra_signatories: [bench_admin_vkh],
      outputs: [
        Output {
          address: address.from_verification_key(bench_admin_vkh),
          value: assets.from_lovelace(
            current.min_utxo_lovelace + current.accrued_fees_lovelace,
          ),
          datum: NoDatum,
          reference_script: None,
        },
      ],
    }
  !payment_hook.spend(
    bench_bootstrap_ref,
    bench_hook_asset,
    bench_config_policy,
    bench_config_asset,
    bench_coord_credential,
    Some(current),
    payment_hook_logic.Burn,
    bench_hook_ref,
    tx,
  )
}
