// Submitter-internal types.
//
// All Lucid / Cardano types are kept behind string or unknown aliases
// so the submitter module does not take a compile-time dependency on
// `@lucid-evolution/lucid`. The feeder's `lib-bridge` module is the
// only place that imports from the CLI's Lucid-backed code; everything
// here speaks in terms of these minimal interfaces.

import type { CardanoDestinationConfig } from "../config/types.js";
import type { EnrichedIntent } from "../source/types.js";
import type { FeederErrorCode } from "../errors/codes.js";

// ---------------------------------------------------------------------------
// Submit request
// ---------------------------------------------------------------------------

/**
 * Per-router Cardano signing key, resolved at daemon startup from the
 * router's `private_key_env` (or the inline `private_key` fallback).
 *
 * `kind` distinguishes a BIP-39 mnemonic seed phrase from a raw private
 * key so the bridge selects the matching Lucid wallet loader:
 *   - resolved from an env var whose name contains `PRIVATE_KEY` → privateKey
 *   - resolved from any other env var name (e.g. `…_WALLET_SEED_…`) → seed
 *   - the inline `private_key` YAML field → always privateKey
 */
export type RouterSigner =
  | { kind: "seed"; value: string }
  | { kind: "privateKey"; value: string };

/** One unit of work that the queue processes. */
export type SubmitRequest = {
  /** Canonical event identifier for correlation in logs + price cache. */
  intentHash: string;
  /** The enriched intent to submit. */
  enriched: EnrichedIntent;
  /** Cardano destination configuration from the matched router. */
  destination: CardanoDestinationConfig;
  /** Identifies which router+destination pair produced this request.
   *  Used as the price-cache key prefix. */
  routerId: string;
  destinationIndex: number;
  /** Cardano signer for this router. When absent the bridge falls back to
   *  the global CARDANO_WALLET_SEED_<NETWORK> / CARDANO_PRIVATE_KEY_<NETWORK>
   *  env vars — correct for single-wallet deployments. Multi-client
   *  deployments set a distinct signer per router via `private_key_env`. */
  signer?: RouterSigner;
};

export type BatchMemberInfo = {
  intentHash: string;
  symbol: string;
  pairUnit?: string;
  action?: "mint" | "update";
};

export type BatchSubmissionInfo = {
  size: number;
  members: BatchMemberInfo[];
};

// ---------------------------------------------------------------------------
// Submit result
// ---------------------------------------------------------------------------

export type SubmitResultOk = {
  ok: true;
  cardanoTxHash: string;
  intentHash: string;
  /** Receiver NFT unit (`policyId + assetName`) — exclusive-lock key in
   *  the inflight table and lane identifier for the coalescer. */
  receiverUnit: string;
  /** Pair NFT unit (`policyId + assetName`) updated by this tx. */
  pairUnit: string;
  /** Per-client pair validator address holding this symbol's pair UTxO. Keys
   *  `contract_symbol_updates` (the Cardano destination-contract analogue). */
  pairValidatorAddress?: string;
  /** Whether the pair was minted for the first time or updated in place. */
  pairAction?: "mint" | "update";
  /** Tx fee deducted from the signer wallet, as a lovelace string. */
  feePaidLovelace?: string;
  /** Present when this intent was confirmed as part of a multi-intent batch. */
  batch?: BatchSubmissionInfo;
  /** Snapshot of on-chain balances captured by the bridge immediately
   *  after the tx confirmed. Each field is optional: an undefined field
   *  means the chain query failed and the daemon must NOT emit the gauge
   *  (avoids reporting 0 as if the balance were drained). */
  postState?: {
    receiverBalanceLovelace?: bigint;
    receiverAccruedLovelace?: bigint;
    paymentHookAccruedLovelace?: bigint;
    adminWalletLovelace?: bigint;
    receiverAddress?: string;
    depositAddress?: string;
  };
};

export type SubmitResultErr = {
  ok: false;
  intentHash: string;
  error: Error;
  /** Structured category of the failure — used for logging and metrics. */
  code: FeederErrorCode;
  /** Human-readable fix hint surfaced in terminal output. */
  remediation: string;
  /** Present when the failed submission attempted a multi-intent batch. */
  batch?: BatchSubmissionInfo;
};

export type SubmitResult = SubmitResultOk | SubmitResultErr;

/** Failure codes that mean the feeder DECLINED to submit a transaction rather
 *  than one being broadcast and rejected. A `NonMonotonicNonce` failure is
 *  raised by the build-time monotonicity assertion (the builder reads the live
 *  on-chain pair datum and refuses to build a losing tx) and by the coalescer
 *  pre-filter that drops superseded batch members — in both cases no tx is
 *  broadcast and no fee is paid. Such failures must NOT count as failed
 *  transactions; they are correct no-ops. */
const NO_TRANSACTION_FAILURE_CODES: ReadonlySet<FeederErrorCode> = new Set<FeederErrorCode>([
  "NonMonotonicNonce",
]);

/** True when a failed result represents a deliberately-skipped intent (no tx
 *  broadcast), so tx-level metrics can exclude it. See
 *  `NO_TRANSACTION_FAILURE_CODES`. */
export function isNoTransactionFailure(result: SubmitResultErr): boolean {
  return NO_TRANSACTION_FAILURE_CODES.has(result.code);
}

/** True when this result is the representative member of its transaction — the
 *  single result (one fires per intent) that should emit tx-scoped metrics, so
 *  a batch of N pairs counts as ONE tx instead of N. The first batch member is
 *  the stateless representative; a single (non-batch) result is its own. */
export function isTransactionRepresentative(result: SubmitResult): boolean {
  const representativeIntentHash = result.batch?.members[0]?.intentHash ?? result.intentHash;
  return result.intentHash === representativeIntentHash;
}

/** Every distinct router id that contributed a member to this transaction.
 *  A batch coalesces symbols from all routers sharing one lane, so the
 *  router-membership metric must credit each contributing router exactly once
 *  — not just the representative's. `resolveRouterId` maps a member's intent
 *  hash back to the router that produced it; members that no longer resolve are
 *  skipped, and a batch that resolves to nothing falls back to the caller's
 *  own router id. The result is sorted for deterministic emission order. */
export function routerIdsForTransaction(
  result: SubmitResult,
  fallbackRouterId: string,
  resolveRouterId: (intentHash: string) => string | undefined,
): string[] {
  const routerIds = new Set<string>();
  for (const member of result.batch?.members ?? []) {
    const routerId = resolveRouterId(member.intentHash);
    if (routerId !== undefined) {
      routerIds.add(routerId);
    }
  }
  if (routerIds.size === 0) {
    routerIds.add(fallbackRouterId);
  }
  return [...routerIds].sort();
}

// ---------------------------------------------------------------------------
// Thin Lucid facade — only the methods the submitter calls.
// ---------------------------------------------------------------------------

/** Minimal interface the write client needs from Lucid. Using this
 *  interface (instead of importing `LucidEvolution` directly) lets the
 *  test suite swap in a fake without pulling in `@lucid-evolution/lucid`. */
export type LucidLike = {
  /** Returns milliseconds and slot; used by `buildOracleUpdateTx`. */
  currentSlot(): number;
  wallet(): {
    address(): Promise<string>;
    getUtxos(): Promise<unknown[]>;
  };
  awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Thin TxSignBuilder facade.
// ---------------------------------------------------------------------------

export type TxSignBuilderLike = {
  toHash(): string;
  sign: {
    withWallet(): {
      complete(): Promise<{ submit(): Promise<string> }>;
    };
  };
};

// ---------------------------------------------------------------------------
// Write-client interface — the only surface the queue depends on.
// ---------------------------------------------------------------------------

export type CardanoWriteClient = {
  /** Submit one oracle update. Signs, submits, and awaits on-chain
   *  confirmation. Resolves with the Cardano tx hash. */
  submit(request: SubmitRequest): Promise<SubmitResult>;
  /** Submit one Cardano tx covering multiple oracle updates for the same
   *  destination lane. The returned results preserve request order. */
  submitBatch(requests: SubmitRequest[]): Promise<SubmitResult[]>;

  /** A short identifier for this client in logs (e.g. "Preview/client-a"). */
  readonly label: string;
};
