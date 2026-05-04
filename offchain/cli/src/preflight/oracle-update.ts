import type { ConfigStateArtifact } from "../core/state.js";

/**
 * Rejects uninitialized protocol artifacts before building an oracle update tx.
 * On-chain code still pins bootstrap refs; this catches operator mistakes early.
 */
export function assertOracleUpdateBootstrapRefsResolved(
  bootstrapRefs: ConfigStateArtifact["bootstrapRefs"],
): void {
  if (!bootstrapRefs.config.txHash?.trim()) {
    throw new Error(
      "Protocol config bootstrap reference is missing (empty tx hash). Complete config bootstrap before oracle updates.",
    );
  }
  if (
    bootstrapRefs.paymentHook !== null &&
    !bootstrapRefs.paymentHook.txHash?.trim()
  ) {
    throw new Error(
      "Protocol payment-hook bootstrap reference is missing (empty tx hash). Complete payment-hook bootstrap before oracle updates.",
    );
  }
}

/** Shared by single and batch oracle updates (mirrors on-chain monotonicity). */
export function assertOracleIntentTimestampAndNonceMonotonic(args: {
  isCreate: boolean;
  intentTimestamp: bigint;
  intentNonce: bigint;
  pairStateTimestamp: string;
  pairStateNonce: string;
  /** When set, error messages include this path (batch updates). */
  batchStatePath?: string;
}): void {
  if (!args.isCreate && args.intentTimestamp <= BigInt(args.pairStateTimestamp)) {
    throw new Error(
      args.batchStatePath !== undefined
        ? `Intent timestamp must be greater than current timestamp for ${args.batchStatePath}.`
        : "Oracle intent timestamp must be greater than the current timestamp.",
    );
  }
  if (!args.isCreate && args.intentNonce <= BigInt(args.pairStateNonce)) {
    throw new Error(
      args.batchStatePath !== undefined
        ? `Intent nonce must be greater than current nonce for ${args.batchStatePath}.`
        : "Oracle intent nonce must be greater than the current nonce.",
    );
  }
}
