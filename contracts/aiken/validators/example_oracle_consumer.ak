//// EXAMPLE consumer — a reference for dApps integrating a DIA feed.
////
//// The canonical pattern for a Cardano dApp that CONSUMES a DIA oracle feed:
//// take the published Pair UTxO as a REFERENCE INPUT, AUTHENTICATE it by its
//// Pair NFT, read `price` from the inline datum, and gate the spend on it. The
//// oracle UTxO is read-only — it stays put — so any number of dApps can
//// reference the same feed in the same block.
////
//// This validator locks funds spendable only while the referenced feed for
//// `pair_id` reports `price >= min_price`. Authenticity comes from requiring the
//// reference input to carry exactly one Pair NFT under `pair_policy_id` with the
//// asset name derived from `pair_id` (`blake2b_256(pair_id)`): this binds the
//// price to the real oracle, since only the protocol mints that NFT. It is the
//// single most important rule when consuming an oracle by reference input.
////
//// A production consumer also bounds freshness — require `feed.timestamp` to be
//// recent relative to `self.validity_range` (the datum's unit is seconds, the
//// validity range POSIX milliseconds, so convert before comparing).

use aiken/collection/list
use cardano/address
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use dia_cardano_oracle/oracle_logic.{PairDatum}

/// What the consumer's locked UTxO commits to: which feed to read and the
/// minimum price that unlocks it.
pub type ConsumerDatum {
  ConsumerDatum {
    pair_policy_id: PolicyId,
    pair_id: ByteArray,
    min_price: Int,
  }
}

validator example_oracle_consumer {
  spend(
    datum: Option<ConsumerDatum>,
    _redeemer: Data,
    _own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(config) = datum
    let expected_asset = oracle_logic.pair_asset_name(config.pair_id)

    // Authenticate the feed: a REFERENCE input must carry exactly one Pair NFT
    // under the known policy + derived asset name. This is what proves the
    // datum read below is the real oracle's, not a forgery.
    expect Some(oracle_input) =
      list.find(
        self.reference_inputs,
        fn(input: Input) {
          assets.quantity_of(
            input.output.value,
            config.pair_policy_id,
            expected_asset,
          ) == 1
        },
      )

    expect InlineDatum(raw_datum) = oracle_input.output.datum
    expect feed: PairDatum = raw_datum

    and {
      // The NFT we matched corresponds to this exact pair.
      feed.pair_id == config.pair_id,
      // The consumption rule: price at or above the configured floor.
      feed.price >= config.min_price,
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const test_pair_policy: PolicyId =
  #"b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f"

// "BTC/USD" as UTF-8 hex.
const test_pair_id: ByteArray = #"4254432f555344"

fn test_feed_datum(price: Int) -> PairDatum {
  PairDatum {
    pair_id: test_pair_id,
    price,
    timestamp: 1_700_000_000,
    nonce: 1,
    intent_hash: #"abababababababababababababababababababababababababababababababab",
    signer: #"f64d333c19b007519c7b9316680ed26578f98c08",
    min_utxo_lovelace: 2_000_000,
  }
}

/// A reference input that genuinely holds the Pair NFT + the feed datum.
fn authentic_oracle_ref(price: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"1111111111111111111111111111111111111111111111111111111111111111",
      output_index: 0,
    },
    output: transaction.Output {
      address: address.from_script(test_pair_policy),
      value: assets.add(
        assets.from_lovelace(2_000_000),
        test_pair_policy,
        oracle_logic.pair_asset_name(test_pair_id),
        1,
      ),
      datum: InlineDatum(test_feed_datum(price)),
      reference_script: None,
    },
  }
}

/// A forged reference input: it carries the feed datum and plain lovelace only.
fn forged_oracle_ref(price: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"2222222222222222222222222222222222222222222222222222222222222222",
      output_index: 0,
    },
    output: transaction.Output {
      address: address.from_script(test_pair_policy),
      value: assets.from_lovelace(2_000_000),
      datum: InlineDatum(test_feed_datum(price)),
      reference_script: None,
    },
  }
}

fn dummy_own_ref() -> OutputReference {
  OutputReference {
    transaction_id: #"3333333333333333333333333333333333333333333333333333333333333333",
    output_index: 0,
  }
}

fn config(min_price: Int) -> ConsumerDatum {
  ConsumerDatum { pair_policy_id: test_pair_policy, pair_id: test_pair_id, min_price }
}

test allows_spend_when_price_meets_threshold() {
  let tx =
    Transaction { ..transaction.placeholder, reference_inputs: [authentic_oracle_ref(65_000)] }
  example_oracle_consumer.spend(Some(config(50_000)), Void, dummy_own_ref(), tx)
}

test rejects_spend_when_price_below_threshold() {
  let tx =
    Transaction { ..transaction.placeholder, reference_inputs: [authentic_oracle_ref(40_000)] }
  !example_oracle_consumer.spend(Some(config(50_000)), Void, dummy_own_ref(), tx)
}

test rejects_forged_feed_without_pair_nft() fail {
  // The reference input carries the datum and plain lovelace; the `expect Some(..)`
  // NFT lookup yields None, so the validator rejects the spend.
  let tx =
    Transaction { ..transaction.placeholder, reference_inputs: [forged_oracle_ref(65_000)] }
  example_oracle_consumer.spend(Some(config(50_000)), Void, dummy_own_ref(), tx)
}
