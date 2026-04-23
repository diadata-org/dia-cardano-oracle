use aiken/collection/list
use cardano/address.{Address, VerificationKey}
use cardano/assets
use cardano/transaction.{Output}

pub type PaymentHookDatum {
  PaymentHookDatum {
    withdraw_address: Address,
    protocol_fee_per_tx_lovelace: Int,
    min_utxo_lovelace: Int,
    accrued_fees_lovelace: Int,
    lifetime_fees_collected_lovelace: Int,
    lifetime_fees_withdrawn_lovelace: Int,
    fee_charge_count: Int,
  }
}

pub type PaymentHookRedeemer {
  ApplyFee
  AdminUpdate
  Withdraw { amount: Int }
}

pub fn valid_payment_hook_state(datum: PaymentHookDatum) -> Bool {
  and {
    datum.protocol_fee_per_tx_lovelace >= 0,
    datum.min_utxo_lovelace >= 0,
    datum.accrued_fees_lovelace >= 0,
    datum.lifetime_fees_collected_lovelace >= 0,
    datum.lifetime_fees_withdrawn_lovelace >= 0,
    datum.fee_charge_count >= 0,
  }
}

pub fn exact_locked_lovelace(output: Output, datum: PaymentHookDatum) -> Bool {
  assets.lovelace_of(output.value) ==
    datum.min_utxo_lovelace + datum.accrued_fees_lovelace
}

pub fn admin_update_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
) -> Bool {
  and {
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace,
    next.lifetime_fees_collected_lovelace ==
      previous.lifetime_fees_collected_lovelace,
    next.lifetime_fees_withdrawn_lovelace ==
      previous.lifetime_fees_withdrawn_lovelace,
    next.fee_charge_count == previous.fee_charge_count,
  }
}

pub fn fee_charge_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
) -> Bool {
  and {
    next.withdraw_address == previous.withdraw_address,
    next.protocol_fee_per_tx_lovelace == previous.protocol_fee_per_tx_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.accrued_fees_lovelace ==
      previous.accrued_fees_lovelace + previous.protocol_fee_per_tx_lovelace,
    next.lifetime_fees_collected_lovelace ==
      previous.lifetime_fees_collected_lovelace
        + previous.protocol_fee_per_tx_lovelace,
    next.lifetime_fees_withdrawn_lovelace ==
      previous.lifetime_fees_withdrawn_lovelace,
    next.fee_charge_count == previous.fee_charge_count + 1,
  }
}

pub fn withdraw_transition(
  previous: PaymentHookDatum,
  next: PaymentHookDatum,
  amount: Int,
) -> Bool {
  and {
    amount >= 0,
    amount <= previous.accrued_fees_lovelace,
    next.withdraw_address == previous.withdraw_address,
    next.protocol_fee_per_tx_lovelace == previous.protocol_fee_per_tx_lovelace,
    next.min_utxo_lovelace == previous.min_utxo_lovelace,
    next.accrued_fees_lovelace == previous.accrued_fees_lovelace - amount,
    next.lifetime_fees_collected_lovelace ==
      previous.lifetime_fees_collected_lovelace,
    next.lifetime_fees_withdrawn_lovelace ==
      previous.lifetime_fees_withdrawn_lovelace + amount,
    next.fee_charge_count == previous.fee_charge_count,
  }
}

pub fn withdraw_paid_to_target(
  outputs: List<Output>,
  withdraw_address: Address,
  amount: Int,
) -> Bool {
  let total_paid =
    outputs
      |> list.filter(fn(output) { output.address == withdraw_address })
      |> list.foldl(0, fn(output, acc) { acc + assets.lovelace_of(output.value) })

  total_paid >= amount
}

test valid_payment_hook_state_accepts_non_negative_values() {
  valid_payment_hook_state(sample_payment_hook())
}

test fee_charge_transition_increments_counters() {
  fee_charge_transition(
    sample_payment_hook(),
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      protocol_fee_per_tx_lovelace: sample_payment_hook().protocol_fee_per_tx_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
      accrued_fees_lovelace:
        sample_payment_hook().accrued_fees_lovelace
          + sample_payment_hook().protocol_fee_per_tx_lovelace,
      lifetime_fees_collected_lovelace:
        sample_payment_hook().lifetime_fees_collected_lovelace
          + sample_payment_hook().protocol_fee_per_tx_lovelace,
      lifetime_fees_withdrawn_lovelace:
        sample_payment_hook().lifetime_fees_withdrawn_lovelace,
      fee_charge_count: sample_payment_hook().fee_charge_count + 1,
    },
  )
}

test withdraw_transition_decrements_accrued_balance() {
  withdraw_transition(
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      protocol_fee_per_tx_lovelace: sample_payment_hook().protocol_fee_per_tx_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
      accrued_fees_lovelace: 10_000_000,
      lifetime_fees_collected_lovelace: 20_000_000,
      lifetime_fees_withdrawn_lovelace: 5_000_000,
      fee_charge_count: 4,
    },
    PaymentHookDatum {
      withdraw_address: sample_payment_hook().withdraw_address,
      protocol_fee_per_tx_lovelace: sample_payment_hook().protocol_fee_per_tx_lovelace,
      min_utxo_lovelace: sample_payment_hook().min_utxo_lovelace,
      accrued_fees_lovelace: 7_000_000,
      lifetime_fees_collected_lovelace: 20_000_000,
      lifetime_fees_withdrawn_lovelace: 8_000_000,
      fee_charge_count: 4,
    },
    3_000_000,
  )
}

pub fn sample_payment_hook() -> PaymentHookDatum {
  PaymentHookDatum {
    withdraw_address: sample_address(),
    protocol_fee_per_tx_lovelace: 2_000_000,
    min_utxo_lovelace: 2_000_000,
    accrued_fees_lovelace: 0,
    lifetime_fees_collected_lovelace: 0,
    lifetime_fees_withdrawn_lovelace: 0,
    fee_charge_count: 0,
  }
}

fn sample_address() -> Address {
  Address {
    payment_credential:
      VerificationKey(#"11111111111111111111111111111111111111111111111111111111"),
    stake_credential: None,
  }
}
