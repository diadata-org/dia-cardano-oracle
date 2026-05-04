use aiken/collection/list
use aiken/interval
use cardano/address.{Credential, Script}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Redeemer, Transaction, Withdraw, placeholder}
use dia_cardano_oracle/config_logic
use dia_cardano_oracle/oracle_logic

/// Identity of a Receiver UTxO referenced by a Settle manifest entry.
pub type SettleReceiver {
  SettleReceiver { receiver_policy_id: PolicyId, receiver_asset_name: AssetName }
}

/// Manifest passed to the coordinator's `ApplySettle` redeemer.
pub type SettleManifest {
  SettleManifest { receivers: List<SettleReceiver> }
}

/// The coordinator's three execution branches. This type is the single
/// source of truth for what cross-script intent a tx is expressing.
///
/// Subscripts (`receiver`, `pair_state`, `payment_hook`) MUST verify both
/// the coordinator's presence in the tx AND that the redeemer it is
/// running with names the script's own UTxO. Otherwise an attacker can
/// piggy-back on an unrelated coordinator branch and slip a tampered
/// transition past a subscript's local checks (cross-script
/// redeemer-confusion).
pub type CoordinatorRedeemer {
  ApplySingle(oracle_logic.UpdateWitness)
  ApplyBatch(List<oracle_logic.UpdateWitness>)
  ApplySettle(SettleManifest)
}

/// What a calling subscript expects the coordinator to be authorising.
/// Each variant carries the on-chain identity of the UTxO making the
/// claim, so the helper can prove the coordinator's redeemer literally
/// names this UTxO (not just any UTxO of the same kind).
pub type CoordinatorIntent {
  /// `receiver.spend AccrueFee` — the coordinator must be in
  /// `ApplySingle(witness)` or `ApplyBatch(ws)` and reference this exact
  /// Receiver NFT.
  IntentForReceiverAccrue {
    receiver_policy_id: PolicyId,
    receiver_asset_name: AssetName,
  }
  /// `receiver.spend Settle` — the coordinator must be in
  /// `ApplySettle(manifest)` and the manifest must list this exact
  /// Receiver NFT.
  IntentForReceiverSettle {
    receiver_policy_id: PolicyId,
    receiver_asset_name: AssetName,
  }
  /// `pair_state.mint MintPairs` (one per minted token) and
  /// `pair_state.spend ApplyUpdate` — the coordinator must be in
  /// `ApplySingle(w)` or `ApplyBatch(ws)` referencing this exact Pair
  /// NFT.
  IntentForPair { pair_policy_id: PolicyId, pair_token_name: ByteArray }
  /// `payment_hook.spend ApplySettle` — the coordinator must be in
  /// `ApplySettle(_)`.
  IntentForHookSettle
}

/// True iff the tx contains a coordinator withdrawal AND the redeemer it
/// runs with matches `expected`. Replaces the legacy
/// `coordinator_witness_present` (which only checked withdrawal presence
/// and was vulnerable to cross-script redeemer-confusion).
pub fn coordinator_intent_matches(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  expected: CoordinatorIntent,
) -> Bool {
  when config_datum.update_coordinator_credential is {
    None -> False
    Some(coord_credential) ->
      when find_coordinator_redeemer(self, coord_credential) is {
        None -> False
        Some(coord_redeemer) -> intent_matches(coord_redeemer, expected)
      }
  }
}

fn find_coordinator_redeemer(
  self: Transaction,
  expected_credential: Credential,
) -> Option<CoordinatorRedeemer> {
  when
    list.find(
      self.redeemers,
      fn(entry) {
        when entry.1st is {
          Withdraw(cred) -> cred == expected_credential
          _ -> False
        }
      },
    )
  is {
    None -> None
    Some(entry) -> {
      // If the redeemer payload does not decode as `CoordinatorRedeemer`
      // the `expect` traps, which is the desired behaviour: a tx whose
      // coordinator branch is unparseable must be rejected.
      expect coord_redeemer: CoordinatorRedeemer = entry.2nd
      Some(coord_redeemer)
    }
  }
}

fn intent_matches(
  coord_redeemer: CoordinatorRedeemer,
  expected: CoordinatorIntent,
) -> Bool {
  when expected is {
    IntentForReceiverAccrue { receiver_policy_id, receiver_asset_name } ->
      when coord_redeemer is {
        ApplySingle(witness) -> and {
            witness.receiver_policy_id == receiver_policy_id,
            witness.receiver_asset_name == receiver_asset_name,
          }

        ApplyBatch(witnesses) ->
          // The coordinator's `ApplyBatch` already enforces
          // `witnesses_share_receiver`, so checking the head is
          // sufficient AND the safest place to read the receiver
          // identity from. We still defensively check the list is
          // non-empty here.
          when witnesses is {
            [] -> False
            [head, ..] -> and {
                head.receiver_policy_id == receiver_policy_id,
                head.receiver_asset_name == receiver_asset_name,
              }
          }

        ApplySettle(_) -> False
      }

    IntentForReceiverSettle { receiver_policy_id, receiver_asset_name } ->
      when coord_redeemer is {
        ApplySettle(manifest) ->
          list.any(
            manifest.receivers,
            fn(r) {
              and {
                r.receiver_policy_id == receiver_policy_id,
                r.receiver_asset_name == receiver_asset_name,
              }
            },
          )

        _ -> False
      }

    IntentForPair { pair_policy_id, pair_token_name } ->
      when coord_redeemer is {
        ApplySingle(witness) -> and {
            witness.pair_policy_id == pair_policy_id,
            witness.pair_token_name == pair_token_name,
          }

        ApplyBatch(witnesses) ->
          list.any(
            witnesses,
            fn(witness) {
              and {
                witness.pair_policy_id == pair_policy_id,
                witness.pair_token_name == pair_token_name,
              }
            },
          )

        ApplySettle(_) -> False
      }

    IntentForHookSettle ->
      when coord_redeemer is {
        ApplySettle(_) -> True
        _ -> False
      }
  }
}

/// True iff the coordinator's redeemer binds to this exact Pair NFT AND
/// the witness backing that binding carries an intent whose `expiry` is
/// at or after the tx's finite upper validity bound. Used by
/// `pair_state` mint and spend so the expiry check runs on the same
/// code path that consumes the intent — not only transitively through
/// the coordinator's own redeemer body.
pub fn pair_intent_satisfied(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Bool {
  when find_pair_witness(self, config_datum, pair_policy_id, pair_token_name) is {
    None -> False
    Some(witness) -> oracle_logic.intent_expiry_satisfied(witness.intent, self)
  }
}

fn find_pair_witness(
  self: Transaction,
  config_datum: config_logic.ConfigDatum,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> Option<oracle_logic.UpdateWitness> {
  when config_datum.update_coordinator_credential is {
    None -> None
    Some(coord_credential) ->
      when find_coordinator_redeemer(self, coord_credential) is {
        Some(ApplySingle(witness)) ->
          if and {
            witness.pair_policy_id == pair_policy_id,
            witness.pair_token_name == pair_token_name,
          } {
            Some(witness)
          } else {
            None
          }
        Some(ApplyBatch(witnesses)) ->
          list.find(
            witnesses,
            fn(w) {
              and {
                w.pair_policy_id == pair_policy_id,
                w.pair_token_name == pair_token_name,
              }
            },
          )
        _ -> None
      }
  }
}

// --- Cross-script redeemer binding (regression for coordinator witness
// confusion): each intent must match the coordinator's actual redeemer.

fn test_coord_cred() -> Credential {
  Script(#"cccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
}

fn test_config_with_coord() -> config_logic.ConfigDatum {
  let cred = test_coord_cred()
  config_logic.ConfigDatum {
    ..config_logic.sample_config(),
    payment_hook_ref: Some(
      config_logic.PaymentHookRef {
        policy_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        asset_name: #"484f4f4b",
      },
    ),
    update_coordinator_credential: Some(cred),
  }
}

fn test_fixture_intent() -> oracle_logic.OracleIntent {
  oracle_logic.OracleIntent {
    intent_type: #"4f7261636c65557064617465",
    version: #"312e30",
    chain_id: 100640,
    nonce: 1,
    expiry: 9_999_999_999,
    symbol: #"555344432f555344",
    price: 1,
    timestamp: 1,
    source: #"444941204f7261636c65",
    signature: #"7e3ab9c6c59f1997f007063e96120ab198bb4129875e49b4f48298c533771d0e6266a261ea108343a4ed02a6823ab3602bcdedd4b891226c2f452b4a158ac1011b",
    signer: #"f64d333c19b007519c7b9316680ed26578f98c08",
  }
}

fn test_fixture_witness(
  receiver_policy_id: PolicyId,
  receiver_asset_name: AssetName,
  pair_policy_id: PolicyId,
  pair_token_name: ByteArray,
) -> oracle_logic.UpdateWitness {
  oracle_logic.UpdateWitness {
    receiver_policy_id,
    receiver_asset_name,
    pair_policy_id,
    pair_token_name,
    intent: test_fixture_intent(),
    signer_public_key: #"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
  }
}

fn tx_with_coordinator_redeemer(redeemer: CoordinatorRedeemer) -> Transaction {
  let cred = test_coord_cred()
  let payload: Redeemer = redeemer
  Transaction {
    ..placeholder,
    redeemers: [Pair(Withdraw(cred), payload)],
  }
}

test intent_for_pair_rejects_apply_settle_redeemer() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let tx =
    tx_with_coordinator_redeemer(
      ApplySettle(SettleManifest { receivers: [] }),
    )
  !coordinator_intent_matches(
    tx,
    cfg,
    IntentForPair {
      pair_policy_id: pair_pid,
      pair_token_name: pair_tok,
    },
  )
}

test intent_for_pair_accepts_apply_single_when_ids_match() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  let tx = tx_with_coordinator_redeemer(ApplySingle(w))
  coordinator_intent_matches(
    tx,
    cfg,
    IntentForPair { pair_policy_id: pair_pid, pair_token_name: pair_tok },
  )
}

test intent_for_receiver_accrue_rejects_apply_settle() {
  let cfg = test_config_with_coord()
  let rp = #"22222222222222222222222222222222222222222222222222222222"
  let ra = #"4449415f5245434549564552"
  let tx =
    tx_with_coordinator_redeemer(
      ApplySettle(SettleManifest { receivers: [] }),
    )
  !coordinator_intent_matches(
    tx,
    cfg,
    IntentForReceiverAccrue {
      receiver_policy_id: rp,
      receiver_asset_name: ra,
    },
  )
}

test intent_for_receiver_settle_rejects_apply_single() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let rp = #"22222222222222222222222222222222222222222222222222222222"
  let ra = #"4449415f5245434549564552"
  let w = test_fixture_witness(rp, ra, pair_pid, pair_tok)
  let tx = tx_with_coordinator_redeemer(ApplySingle(w))
  !coordinator_intent_matches(
    tx,
    cfg,
    IntentForReceiverSettle {
      receiver_policy_id: rp,
      receiver_asset_name: ra,
    },
  )
}

test intent_for_receiver_settle_accepts_manifest_entry() {
  let cfg = test_config_with_coord()
  let rp = #"22222222222222222222222222222222222222222222222222222222"
  let ra = #"4449415f5245434549564552"
  let manifest =
    SettleManifest {
      receivers: [SettleReceiver { receiver_policy_id: rp, receiver_asset_name: ra }],
    }
  let tx = tx_with_coordinator_redeemer(ApplySettle(manifest))
  coordinator_intent_matches(
    tx,
    cfg,
    IntentForReceiverSettle {
      receiver_policy_id: rp,
      receiver_asset_name: ra,
    },
  )
}

test intent_for_hook_settle_rejects_apply_single() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  let tx = tx_with_coordinator_redeemer(ApplySingle(w))
  !coordinator_intent_matches(tx, cfg, IntentForHookSettle)
}

test intent_for_hook_settle_accepts_apply_settle() {
  let cfg = test_config_with_coord()
  let tx =
    tx_with_coordinator_redeemer(
      ApplySettle(SettleManifest { receivers: [] }),
    )
  coordinator_intent_matches(tx, cfg, IntentForHookSettle)
}

// --- pair_intent_satisfied: cross-script binding + intent expiry on the
// pair_state mint and spend paths.

fn tx_with_coord_redeemer_and_validity(
  redeemer: CoordinatorRedeemer,
  lower_millis: Int,
  upper_millis: Int,
) -> Transaction {
  let cred = test_coord_cred()
  let payload: Redeemer = redeemer
  Transaction {
    ..placeholder,
    redeemers: [Pair(Withdraw(cred), payload)],
    validity_range: interval.between(lower_millis, upper_millis),
  }
}

test pair_intent_satisfied_accepts_apply_single_when_expiry_in_range() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  // upper_bound strictly less than intent.expiry => fresh
  let tx =
    tx_with_coord_redeemer_and_validity(
      ApplySingle(w),
      0,
      w.intent.expiry * 1000 - 1,
    )
  pair_intent_satisfied(tx, cfg, pair_pid, pair_tok)
}

test pair_intent_satisfied_rejects_expired_intent_on_apply_single() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  // upper_bound past intent.expiry => binding holds but expiry has lapsed
  let tx =
    tx_with_coord_redeemer_and_validity(
      ApplySingle(w),
      0,
      w.intent.expiry * 1000 + 1,
    )
  !pair_intent_satisfied(tx, cfg, pair_pid, pair_tok)
}

test pair_intent_satisfied_rejects_open_upper_bound() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  // placeholder has open-ended validity range => expiry check rejects.
  let tx = tx_with_coordinator_redeemer(ApplySingle(w))
  !pair_intent_satisfied(tx, cfg, pair_pid, pair_tok)
}

test pair_intent_satisfied_rejects_apply_settle() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let tx =
    tx_with_coord_redeemer_and_validity(
      ApplySettle(SettleManifest { receivers: [] }),
      0,
      9_999_999_999_999,
    )
  !pair_intent_satisfied(tx, cfg, pair_pid, pair_tok)
}

test pair_intent_satisfied_rejects_mismatched_pair_id() {
  let cfg = test_config_with_coord()
  let pair_pid = #"11111111111111111111111111111111111111111111111111111111"
  let pair_tok = oracle_logic.pair_asset_name(test_fixture_intent().symbol)
  let w =
    test_fixture_witness(
      #"22222222222222222222222222222222222222222222222222222222",
      #"4449415f5245434549564552",
      pair_pid,
      pair_tok,
    )
  let tx =
    tx_with_coord_redeemer_and_validity(
      ApplySingle(w),
      0,
      w.intent.expiry * 1000 - 1,
    )
  // Same tx, different pair token => binding fails before expiry check.
  !pair_intent_satisfied(
    tx,
    cfg,
    pair_pid,
    #"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  )
}
