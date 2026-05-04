/**
 * Payment-hook withdraw: amounts and accrued bounds (mirrors on-chain checks).
 */

export function assertPaymentHookWithdrawAmountValid(
  amountLovelace: bigint,
  currentAccruedFeesLovelace: bigint,
): void {
  if (amountLovelace > currentAccruedFeesLovelace) {
    throw new Error("PaymentHook accrued fees are not sufficient for the requested withdrawal.");
  }
}

export function assertPaymentHookWithdrawAmountPositive(amountLovelace: bigint): void {
  if (amountLovelace <= 0n) {
    throw new Error("Payment-hook withdraw amount must be greater than zero lovelace.");
  }
}
