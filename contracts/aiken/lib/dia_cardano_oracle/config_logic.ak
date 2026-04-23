use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Credential}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Transaction}

pub type Domain {
  Domain {
    name: ByteArray,
    version: ByteArray,
    source_chain_id: Int,
    verifying_contract: ByteArray,
  }
}

pub type PairEntry {
  PairEntry {
    token_name: ByteArray,
    pair_code: ByteArray,
  }
}

pub type PaymentHookRef {
  PaymentHookRef {
    policy_id: PolicyId,
    asset_name: AssetName,
  }
}

pub type ConfigDatum {
  ConfigDatum {
    valid_config_signers: List<VerificationKeyHash>,
    authorized_dia_public_keys: List<ByteArray>,
    domain_data: Domain,
    allowed_pairs: List<PairEntry>,
    payment_hook_ref: Option<PaymentHookRef>,
    update_coordinator_credential: Option<Credential>,
    min_utxo_lovelace: Int,
  }
}

pub type ConfigRedeemer {
  AdminUpdate
  RegisterPair(PairEntry)
}

pub fn has_config_signer(datum: ConfigDatum, tx: Transaction) -> Bool {
  list.any(
    datum.valid_config_signers,
    fn(config_signer) { list.has(tx.extra_signatories, config_signer) },
  )
}

pub fn find_pair_by_token_name(
  datum: ConfigDatum,
  token_name: ByteArray,
) -> Option<PairEntry> {
  list.find(datum.allowed_pairs, fn(pair) { pair.token_name == token_name })
}

pub fn contains_pair(datum: ConfigDatum, pair: PairEntry) -> Bool {
  list.has(datum.allowed_pairs, pair)
}

pub fn pair_token_is_allowed(datum: ConfigDatum, token_name: ByteArray) -> Bool {
  datum
    |> find_pair_by_token_name(token_name)
    |> is_some
}

pub fn valid_pair_entry(pair: PairEntry) -> Bool {
  and {
    !bytearray.is_empty(pair.token_name),
    !bytearray.is_empty(pair.pair_code),
  }
}

pub fn valid_domain(domain: Domain) -> Bool {
  and {
    !bytearray.is_empty(domain.name),
    !bytearray.is_empty(domain.version),
    domain.source_chain_id >= 0,
    bytearray.length(domain.verifying_contract) == 20,
  }
}

pub fn valid_payment_hook_ref(hook_ref: PaymentHookRef) -> Bool {
  !bytearray.is_empty(hook_ref.asset_name)
}

pub fn valid_config_state(datum: ConfigDatum) -> Bool {
  and {
    list.length(datum.valid_config_signers) > 0,
    list.length(datum.authorized_dia_public_keys) > 0,
    valid_domain(datum.domain_data),
    hook_and_coordinator_are_consistent(
      datum.payment_hook_ref,
      datum.update_coordinator_credential,
    ),
    unique_authorized_dia_public_keys(datum.authorized_dia_public_keys),
    unique_allowed_pairs(datum.allowed_pairs),
    datum.min_utxo_lovelace >= 0,
  }
}

pub fn same_allowed_pairs(previous: ConfigDatum, next: ConfigDatum) -> Bool {
  previous.allowed_pairs == next.allowed_pairs
}

pub fn registered_pair_transition(
  previous: ConfigDatum,
  next: ConfigDatum,
  pair: PairEntry,
) -> Bool {
  and {
    valid_pair_entry(pair),
    !contains_pair(previous, pair),
    contains_pair(next, pair),
    list.length(next.allowed_pairs) == list.length(previous.allowed_pairs) + 1,
    list.all(previous.allowed_pairs, fn(existing_pair) {
      list.has(next.allowed_pairs, existing_pair)
    }),
    previous.valid_config_signers == next.valid_config_signers,
    previous.authorized_dia_public_keys == next.authorized_dia_public_keys,
    previous.domain_data == next.domain_data,
    previous.payment_hook_ref == next.payment_hook_ref,
    previous.update_coordinator_credential == next.update_coordinator_credential,
    previous.min_utxo_lovelace == next.min_utxo_lovelace,
  }
}

fn unique_allowed_pairs(pairs: List<PairEntry>) -> Bool {
  when pairs is {
    [] -> True
    [head, ..tail] ->
      and {
        valid_pair_entry(head),
        !list.any(
          tail,
          fn(other) {
            other.token_name == head.token_name || other.pair_code == head.pair_code
          },
        ),
        unique_allowed_pairs(tail),
      }
  }
}

fn unique_authorized_dia_public_keys(keys: List<ByteArray>) -> Bool {
  when keys is {
    [] -> True
    [head, ..tail] ->
      and {
        !bytearray.is_empty(head),
        !list.has(tail, head),
        unique_authorized_dia_public_keys(tail),
      }
  }
}

fn hook_and_coordinator_are_consistent(
  maybe_hook_ref: Option<PaymentHookRef>,
  maybe_coordinator_credential: Option<Credential>,
) -> Bool {
  when maybe_hook_ref is {
    Some(hook_ref) ->
      when maybe_coordinator_credential is {
        Some(_) -> valid_payment_hook_ref(hook_ref)
        None -> False
      }

    None ->
      when maybe_coordinator_credential is {
        None -> True
        Some(_) -> False
      }
  }
}

fn is_some(value: Option<a>) -> Bool {
  when value is {
    Some(_) -> True
    None -> False
  }
}

pub fn sample_domain() -> Domain {
  Domain {
    name: #"444941204f7261636c65",
    version: #"312e30",
    source_chain_id: 100640,
    verifying_contract: #"f8c614a483a0427a13512f52ac72a576678be317",
  }
}

pub fn sample_pair() -> PairEntry {
  PairEntry {
    token_name: #"555344435f555344",
    pair_code: #"555344432f555344",
  }
}

pub fn sample_config() -> ConfigDatum {
  ConfigDatum {
    valid_config_signers: [#"11111111111111111111111111111111111111111111111111111111"],
    authorized_dia_public_keys: [#"03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"],
    domain_data: sample_domain(),
    allowed_pairs: [sample_pair()],
    payment_hook_ref: None,
    update_coordinator_credential: None,
    min_utxo_lovelace: 2_000_000,
  }
}

fn sample_registered_pair_config() -> ConfigDatum {
  ConfigDatum {
    valid_config_signers: sample_config().valid_config_signers,
    authorized_dia_public_keys: sample_config().authorized_dia_public_keys,
    domain_data: sample_config().domain_data,
    allowed_pairs: [
      sample_pair(),
      PairEntry {
        token_name: #"4144415f555344",
        pair_code: #"4144412f555344",
      },
    ],
    payment_hook_ref: None,
    update_coordinator_credential: None,
    min_utxo_lovelace: sample_config().min_utxo_lovelace,
  }
}

test valid_pair_entry_requires_token_name_and_pair_code() {
  valid_pair_entry(sample_pair())
}

test valid_config_state_requires_non_empty_signers_and_domain() {
  valid_config_state(sample_config())
}

test pair_lookup_by_token_name_works() {
  sample_config()
    |> find_pair_by_token_name(sample_pair().token_name)
    |> is_some
}

test registered_pair_transition_accepts_single_new_pair() {
  registered_pair_transition(
    sample_config(),
    sample_registered_pair_config(),
    PairEntry {
      token_name: #"4144415f555344",
      pair_code: #"4144412f555344",
    },
  )
}

test same_allowed_pairs_rejects_pair_changes() {
  !same_allowed_pairs(sample_config(), sample_registered_pair_config())
}

test duplicate_pair_token_names_are_rejected() {
  !valid_config_state(
    ConfigDatum {
      valid_config_signers: sample_config().valid_config_signers,
      authorized_dia_public_keys: sample_config().authorized_dia_public_keys,
      domain_data: sample_domain(),
      allowed_pairs: [
        sample_pair(),
        PairEntry {
          token_name: sample_pair().token_name,
          pair_code: #"4f544845522f50414952",
        },
      ],
      payment_hook_ref: None,
      update_coordinator_credential: None,
      min_utxo_lovelace: 2_000_000,
    },
  )
}

test duplicate_authorized_dia_public_keys_are_rejected() {
  !valid_config_state(
    ConfigDatum {
      valid_config_signers: sample_config().valid_config_signers,
      authorized_dia_public_keys: [
        #"022222222222222222222222222222222222222222222222222222222222222222",
        #"022222222222222222222222222222222222222222222222222222222222222222",
      ],
      domain_data: sample_domain(),
      allowed_pairs: [sample_pair()],
      payment_hook_ref: None,
      update_coordinator_credential: None,
      min_utxo_lovelace: 2_000_000,
    },
  )
}
