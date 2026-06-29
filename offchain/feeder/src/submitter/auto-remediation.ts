// ---------------------------------------------------------------------------
// auto-remediation.ts — pure trigger decisions for the daemon's automatic
// fee-loop maintenance: settle, payment-hook withdraw, and wallet consolidation.
//
// WHY
//   The admin/signer wallet pays every tx's Cardano network fee + collateral, so
//   it drains over time; it is refilled by collecting earned revenue
//   (settle: Receiver accrued → PaymentHook; withdraw: PaymentHook → admin
//   wallet). Done by hand this is forgettable — and when the wallet runs dry or
//   shatters into sub-collateral dust the feeder stalls. These decisions let the
//   daemon run the loop itself, on the balance-refresh tick, as lane tasks.
//
//   ORDERING INVARIANT (alert first, automatic after): each `auto_*` threshold
//   sits BEYOND its paired alert threshold so the operator-facing alert fires
//   FIRST and the automatic step only follows if the condition keeps developing.
//   The YAML ordering is enforced by the threshold-drift test; these functions
//   implement the comparisons. Accruals (settle/withdraw) GROW, so "beyond" =
//   greater; the collateral floor SHRINKS, so "beyond" = smaller.
//
//   All functions are pure (no chain, no locks, no I/O) so the trigger logic is
//   unit-tested in isolation from the live submission path. An optional
//   threshold left undefined DISABLES that automatic step (never defaulted).
// ---------------------------------------------------------------------------

export type AutoSettleDecision =
  | { act: true; reason: "accrued_high" }
  | { act: false; reason: "disabled" | "below_threshold" | "in_progress" };

/**
 * Should the daemon auto-run `settle` (drain this Receiver's accrued fees into
 * the PaymentHook) on this tick? Fires when the Receiver accrued has reached
 * `autoSettleLovelace` (which must be > `settle_overdue_lovelace`, the alert),
 * and no settle is already enqueued/running for this lane (dedup only — the lane
 * queue provides mutual exclusion against updates).
 */
export function shouldAutoSettle(input: {
  receiverAccruedLovelace?: bigint;
  autoSettleLovelace?: bigint;
  inProgress: boolean;
}): AutoSettleDecision {
  if (input.inProgress) return { act: false, reason: "in_progress" };
  if (input.autoSettleLovelace === undefined) return { act: false, reason: "disabled" };
  const accrued = input.receiverAccruedLovelace ?? 0n;
  if (accrued >= input.autoSettleLovelace) return { act: true, reason: "accrued_high" };
  return { act: false, reason: "below_threshold" };
}

export type AutoWithdrawDecision =
  | { act: true; reason: "accrued_high"; amountLovelace: bigint }
  | { act: false; reason: "disabled" | "below_threshold" | "in_progress" };

/**
 * Should the daemon auto-run `payment-hook:withdraw` (PaymentHook → admin
 * wallet, refilling the wallet that pays fees) on this tick? Fires when the hook
 * accrued has reached `autoWithdrawLovelace` (which must be >
 * `payment_hook_withdraw_ready_lovelace`, the alert). Returns the amount to
 * withdraw — the full accrued, draining the hook in one tx.
 */
export function shouldAutoWithdraw(input: {
  paymentHookAccruedLovelace?: bigint;
  autoWithdrawLovelace?: bigint;
  inProgress: boolean;
}): AutoWithdrawDecision {
  if (input.inProgress) return { act: false, reason: "in_progress" };
  if (input.autoWithdrawLovelace === undefined) return { act: false, reason: "disabled" };
  const accrued = input.paymentHookAccruedLovelace ?? 0n;
  if (accrued >= input.autoWithdrawLovelace) {
    return { act: true, reason: "accrued_high", amountLovelace: accrued };
  }
  return { act: false, reason: "below_threshold" };
}

export type AutoConsolidateDecision =
  | { act: true; reason: "fragmented" }
  | { act: false; reason: "disabled" | "healthy" | "in_progress" | "unknown" };

/**
 * Should the daemon auto-run `wallet:consolidate` (fold the admin wallet's dust
 * into a dedicated collateral UTxO + working balance) on this tick? Fires when
 * the LARGEST pure-ADA UTxO has fallen below `autoConsolidateBelowLovelace`
 * (which must be < `admin_wallet_min_collateral_lovelace`, the alert), meaning
 * no UTxO can comfortably back collateral. Uses the largest UTxO, not the total,
 * because total is blind to fragmentation.
 */
export function shouldAutoConsolidate(input: {
  maxUtxoLovelace?: bigint;
  autoConsolidateBelowLovelace?: bigint;
  inProgress: boolean;
}): AutoConsolidateDecision {
  if (input.inProgress) return { act: false, reason: "in_progress" };
  if (input.autoConsolidateBelowLovelace === undefined) return { act: false, reason: "disabled" };
  // No reading → cannot judge (the wallet query failed this tick). Skip rather
  // than act blind; a real fragmentation persists and fires on a later tick.
  if (input.maxUtxoLovelace === undefined) return { act: false, reason: "unknown" };
  if (input.maxUtxoLovelace < input.autoConsolidateBelowLovelace) {
    return { act: true, reason: "fragmented" };
  }
  return { act: false, reason: "healthy" };
}

export type AutoSplitDecision =
  | { act: true; reason: "concentrated" }
  | { act: false; reason: "disabled" | "healthy" | "in_progress" | "unknown" };

/**
 * Should the daemon auto-run `wallet:split` (carve the wallet's largest pure-ADA
 * UTxO into more lanes) on this tick? This is the OPPOSITE of consolidate: it
 * fires when the wallet is too CONCENTRATED to feed parallel lanes — fewer than
 * `minUsableUtxos` arbiter-usable UTxOs — REGARDLESS of balance, since
 * concentration is about UTxO count, not size. The actual carve is left to the
 * planner (`planWalletSplit`), which no-ops when the wallet cannot be shaped
 * further, so this trigger stays a simple count test and never churns. Gated by
 * the `auto_split` flag; the manual `wallet:split` command works regardless.
 */
export function shouldAutoSplit(input: {
  usableUtxoCount?: number;
  minUsableUtxos: number;
  enabled?: boolean;
  inProgress: boolean;
}): AutoSplitDecision {
  if (input.inProgress) return { act: false, reason: "in_progress" };
  if (!input.enabled) return { act: false, reason: "disabled" };
  // No reading → cannot judge (the wallet query failed this tick). Skip rather
  // than act blind; a real concentration persists and fires on a later tick.
  if (input.usableUtxoCount === undefined) return { act: false, reason: "unknown" };
  if (input.usableUtxoCount < input.minUsableUtxos) return { act: true, reason: "concentrated" };
  return { act: false, reason: "healthy" };
}
