/**
 * Pure checks for receiver top-up / withdraw before building Lucid txs.
 */

/** Withdraw amount must not exceed balance (`balance_lovelace` only; never `accrued_to_hook`). */
export function assertReceiverWithdrawAmountValid(
  amountLovelace: bigint,
  currentBalanceLovelace: bigint,
): void {
  if (amountLovelace > currentBalanceLovelace) {
    throw new Error("Receiver balance is not sufficient for the requested withdrawal.");
  }
}

export function assertReceiverTopUpAmountPositive(amountLovelace: bigint): void {
  if (amountLovelace <= 0n) {
    throw new Error("Receiver top-up amount must be greater than zero lovelace.");
  }
}

export function assertReceiverWithdrawAmountPositive(amountLovelace: bigint): void {
  if (amountLovelace <= 0n) {
    throw new Error("Receiver withdraw amount must be greater than zero lovelace.");
  }
}
