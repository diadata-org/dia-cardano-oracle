// pool-funding.ts — pure trigger for the daemon's main→pool funding.
//
// WHY
//   Pool wallets pay tx fees + collateral and so drain over time; only the main
//   wallet self-funds (it is the on-chain PaymentHook withdraw target). This
//   decision keeps each pool wallet usable by topping it up from the main when it
//   runs low, on the balance-refresh tick, as a lane task.
//
//   The band gives hysteresis (top up at `low`, fill to `target`) so a wallet is
//   not refilled every tick; a per-wallet cooldown bounds the funding-tx rate;
//   and the main is never drawn below its own reserve, so funding the pool can
//   never starve the wallet everything else depends on.
//
//   Pure (no chain, no locks, no I/O) so the trigger is unit-tested in isolation
//   from the live submission path. The band + cooldown come from
//   `infrastructure.<network>.yaml::wallet_pool` (each key with a `DEFAULT_*`
//   fallback the daemon resolves before calling this).

export type FundPoolDecision =
  | { act: true; amountLovelace: bigint }
  | { act: false; reason: "above_low" | "in_progress" | "cooldown" | "main_insufficient" };

/**
 * Should the daemon fund this pool wallet from the main on this tick? Fires when
 * the pool wallet's spendable lovelace is below `lowLovelace`, no funding for it
 * is already in flight, its cooldown has elapsed, and the main keeps at least
 * `mainReserveLovelace` after paying. The amount fills the wallet to
 * `targetLovelace`.
 */
export function shouldFundPoolWallet(input: {
  /** The pool wallet's spendable (unlocked, pure-ADA) lovelace. */
  poolWalletSpendableLovelace: bigint;
  /** The main wallet's spendable lovelace. */
  mainWalletSpendableLovelace: bigint;
  /** Below this, the pool wallet is topped up. YAML: `pool_wallet_low_lovelace`. */
  lowLovelace: bigint;
  /** Funding fills up to this. YAML: `pool_wallet_target_lovelace`. */
  targetLovelace: bigint;
  /** The main never funds below this. YAML: `main_wallet_reserve_lovelace`. */
  mainReserveLovelace: bigint;
  /** A funding tx for this wallet is already enqueued/running. */
  inProgress: boolean;
  /** When this wallet was last funded (ms since epoch); absent if never. */
  lastFundedAtMs?: number;
  /** Current wall-clock (ms since epoch). */
  nowMs: number;
  /** Per-wallet cooldown between funding txs. YAML: `pool_fund_min_interval_ms`. */
  minIntervalMs: number;
}): FundPoolDecision {
  if (input.inProgress) return { act: false, reason: "in_progress" };
  if (input.poolWalletSpendableLovelace >= input.lowLovelace) {
    return { act: false, reason: "above_low" };
  }
  if (
    input.lastFundedAtMs !== undefined &&
    input.nowMs - input.lastFundedAtMs < input.minIntervalMs
  ) {
    return { act: false, reason: "cooldown" };
  }
  const amountLovelace = input.targetLovelace - input.poolWalletSpendableLovelace;
  if (input.mainWalletSpendableLovelace - amountLovelace < input.mainReserveLovelace) {
    return { act: false, reason: "main_insufficient" };
  }
  return { act: true, amountLovelace };
}
