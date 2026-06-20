// Crash-recovery decision for a transaction left in `submitted` status at
// startup (broadcast, awaiting confirmation when the previous process died).
//
// The old behaviour marked every such row `failed/CrashRecovery` unconditionally
// — so a tx that actually CONFIRMED on-chain was recorded as a failure and never
// counted, under-reporting confirmed/uptime. This asks the chain first: a tx the
// chain still shows is recorded as confirmed; only a tx the chain does not show
// (or that cannot be verified) is failed, so the event flow re-processes it (a
// re-submit of an already-on-chain update is cleanly dropped as NonMonotonicNonce).

/**
 * Decide whether a recovered `submitted` tx should be marked confirmed.
 *
 * Conservative: returns `true` (confirmed) ONLY when the injected `isOnChain`
 * check resolves `true`. A missing tx hash, a `false` result, or a thrown
 * provider error all return `false` (mark failed → re-process), never a
 * false-confirm.
 */
export async function recoverSubmittedTx(
  cardanoTxHash: string | undefined,
  isOnChain: (txHash: string) => Promise<boolean>,
): Promise<boolean> {
  if (!cardanoTxHash) return false;
  try {
    return await isOnChain(cardanoTxHash);
  } catch {
    // Provider unreachable / transient error at recovery — do not false-confirm;
    // mark failed so the update is re-processed (idempotent on-chain).
    return false;
  }
}
