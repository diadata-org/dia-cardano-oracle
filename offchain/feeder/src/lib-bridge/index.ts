// Bridge module — typed facade over the CLI's Cardano tx builders.
//
// `OracleIntentBridge` is the interface the submitter depends on.
// `createRealOracleIntentBridge` wires `buildOracleUpdateTx` and handles the
// full Lucid lifecycle:
//   load state → build tx → sign → submit → await confirmation.
//
// CLI modules are imported statically from the `@diadata-org/dia-cardano-
// oracle-cli` package (the CLI exposes them as subpath library exports). The
// `@lucid-evolution/lucid` runtime dependency the CLI pulls in must be
// installed for submission to work.
//
// Tests inject a `FakeOracleIntentBridge` instead.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readClientContext } from "@diadata-org/dia-cardano-oracle-cli/core/artifact-context";
import {
  decodePairDatum,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  findSingleUtxoAtUnit,
  requireInlineDatum,
  waitForUnitUtxoReplacement,
  waitForWalletSettlement,
} from "@diadata-org/dia-cardano-oracle-cli/core/chain-helpers";
import { getCliConfig } from "@diadata-org/dia-cardano-oracle-cli/core/config";
import {
  mintingPolicyFromCompiledScript,
  policyIdFromMintingPolicy,
  scriptAddressFromValidator,
  scriptHashFromValidator,
  spendingValidatorFromCompiledScript,
} from "@diadata-org/dia-cardano-oracle-cli/core/contracts";
import {
  assertDiaOracleIntentNotExpired,
  diaIntentToState,
  diaIntentTokenNameFromSymbol,
  diaPairIdHex,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  normalizeHex,
  recoverDiaOracleIntentWitness,
} from "@diadata-org/dia-cardano-oracle-cli/core/dia-intent";
import { pairSlugFromSymbol } from "@diadata-org/dia-cardano-oracle-cli/core/intent-paths";
import { makeConfiguredLucidWithConfig, selectConfiguredWalletWithConfig } from "@diadata-org/dia-cardano-oracle-cli/core/lucid";
import { getNetworkNow } from "@diadata-org/dia-cardano-oracle-cli/core/network-time";
import { appendTransactionRecord, readOptionalPairState } from "@diadata-org/dia-cardano-oracle-cli/core/state";
import { awaitTxConfirmation } from "@diadata-org/dia-cardano-oracle-cli/core/tx-confirmation";
import { assertTxStillOnChain } from "@diadata-org/dia-cardano-oracle-cli/core/tx-onchain-check";
import { buildBatchOracleUpdateTx } from "@diadata-org/dia-cardano-oracle-cli/lib/transactions/build-batch-oracle-update";
import { buildOracleUpdateTx } from "@diadata-org/dia-cardano-oracle-cli/lib/transactions/build-oracle-update";
import {
  assertOracleUpdateBootstrapRefsResolved,
  assertPaymentKeyHashIsConfigSigner,
} from "@diadata-org/dia-cardano-oracle-cli/preflight";
import { depositMerge, selectDepositsForUpdateFold } from "@diadata-org/dia-cardano-oracle-cli/transactions/deposit";
import { deriveConfiguredWalletDefaults } from "@diadata-org/dia-cardano-oracle-cli/wallet/wallet";
import type { CliConfig } from "@diadata-org/dia-cardano-oracle-cli/core/config";
import type { DiaOracleIntent } from "@diadata-org/dia-cardano-oracle-cli/core/dia-intent";
import type {
  ClientStateArtifact,
  ConfigStateArtifact,
  PairStateArtifact,
  ReferenceScriptsState,
  ResolvedCompiledScripts,
  ResolvedDeploymentScripts,
} from "@diadata-org/dia-cardano-oracle-cli/core/state";
import type { EnrichedIntent } from "../source/types.js";
import type { RouterSigner } from "../submitter/types.js";
import { DEFAULT_CONFIRMATION_DEPTH } from "../config/constants.js";

// The Lucid `UTxO` shape, derived from a CLI helper so the feeder does not
// import `@lucid-evolution/lucid` directly.
type UTxO = Awaited<ReturnType<typeof findSingleUtxoAtUnit>>;

// The combined state object the CLI's update builders consume. It is a
// `PairStateArtifact` (wallet/pair/pairState/datum/transactions) merged with
// the protocol + client deployment scripts, compiled scripts, reference
// scripts, config state, and the resolved receiver. `buildState` assembles it
// from the typed client + protocol artifacts the same way `cli/update.ts` does.
type CombinedUpdateState = PairStateArtifact & {
  scripts: ResolvedDeploymentScripts;
  compiledScripts: ResolvedCompiledScripts;
  referenceScripts: ReferenceScriptsState;
  configState: ConfigStateArtifact["configState"];
  receiver: NonNullable<ClientStateArtifact["receiver"]>;
};

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Parameters for a single oracle-update submission. */
export type OracleIntentSubmitParams = {
  /** Absolute or relative path to client-state.json. */
  clientStatePath: string;
  /** Absolute or relative path to config-bootstrap.json. */
  protocolStatePath: string;
  /** The enriched intent from the pipeline. */
  enriched: EnrichedIntent;
  /** EVM intent hash (`0x…`). */
  intentHash: string;
  /**
   * Called once for each pipeline step inside `submitOracleUpdate`.
   * Used by the write client to write intermediate entries to the
   * per-intent log file without coupling the bridge to the file logger.
   * Steps emitted (in order):
   *   connecting, building, signing, submitting,
   *   submitted (carries txHash), waiting_confirm,
   *   waiting_utxo, writing_state
   */
  onStep?: (step: string, meta?: { txHash?: string }) => void;
  /** Per-router signer override. When provided, the bridge uses this key
   *  instead of the global CARDANO_WALLET_SEED_<NETWORK> /
   *  CARDANO_PRIVATE_KEY_<NETWORK> env vars. */
  signer?: RouterSigner;
};

export type OracleIntentBatchSubmitParams = {
  /** Absolute or relative path to client-state.json. */
  clientStatePath: string;
  /** Absolute or relative path to config-bootstrap.json. */
  protocolStatePath: string;
  /** Intents that will share one Cardano transaction. */
  updates: Array<{
    enriched: EnrichedIntent;
    intentHash: string;
    onStep?: (step: string, meta?: { txHash?: string }) => void;
  }>;
  /** Per-router signer override. All intents in a batch share one lane
   *  (one client/protocol state) and therefore one signer. */
  signer?: RouterSigner;
};

/**
 * Snapshot of on-chain balances captured by the bridge immediately
 * after a tx confirmed and the new UTxOs settled. The daemon emits these
 * as Prometheus gauges (`cardano_receiver_balance_lovelace`, etc.).
 *
 * Any individual field is OPTIONAL: if its corresponding chain query
 * failed (provider hiccup, transient outage) the field is omitted so the
 * daemon does not emit a misleading 0-value gauge.
 */
export type PostConfirmChainState = {
  receiverBalanceLovelace?: bigint;
  receiverAccruedLovelace?: bigint;
  paymentHookAccruedLovelace?: bigint;
  adminWalletLovelace?: bigint;
  /** The client's on-chain Receiver script address — surfaced as a metric
   *  label together with `depositAddress` so ReceiverBalanceLow can show
   *  both the locked UTxO and the address operators should fund. */
  receiverAddress?: string;
  /** Sum of clean, un-merged ADA deposits (>= 1 ADA, no native tokens /
   *  datum / dust) sitting at the client's side-deposit address, awaiting a
   *  `deposit:merge` into the Receiver balance. Populated only by the
   *  read-only `snapshotBalances` probe. Undefined when the query failed or
   *  the client state carries no `receiver.depositValidatorAddress`. */
  depositPendingLovelace?: bigint;
  /** The client's side-deposit script address
   *  (`receiver.depositValidatorAddress`) — surfaced as a metric label and
   *  logged once at startup so operators can hand it to the client. */
  depositAddress?: string;
};

/** Structured result returned by a successful oracle-update submission. */
export type OracleUpdateResult = {
  /** Cardano transaction hash of the confirmed tx. */
  txHash: string;
  /** Receiver NFT unit (`policyId + assetName`) touched by this tx.
   *  Used as the exclusive-lock key in the inflight table. */
  receiverUnit: string;
  /** Pair NFT unit (`policyId + assetName`) updated by this tx. */
  pairUnit: string;
  /** Per-client pair validator address holding this symbol's pair UTxO. The
   *  Cardano analogue of a Spectra destination contract (one per client, holds
   *  all that client's symbols) — used to key `contract_symbol_updates`. */
  pairValidatorAddress?: string;
  /** True if this tx minted the pair NFT (first update for this symbol). */
  isCreate: boolean;
  /** Tx fee paid from the signer wallet, as a lovelace string.
   *  Absent when the fee could not be extracted from the tx body. */
  feePaidLovelace?: string;
  /** On-chain balance snapshot for the four operational wallets. See
   *  `PostConfirmChainState` for the per-field semantics. */
  postState?: PostConfirmChainState;
};

export type OracleBatchUpdateResult = {
  /** Cardano transaction hash shared by every entry in the batch. */
  txHash: string;
  /** Receiver NFT unit touched by the batch update. */
  receiverUnit: string;
  /** Per-entry batch outcome. Built entries (`skipped: false`) were included in
   *  the submitted tx; `skipped: true` entries were dropped before building
   *  because their intent was already superseded on chain (benign, no tx). */
  entries: Array<{
    intentHash: string;
    pairUnit: string;
    /** Per-client pair validator address (keys `contract_symbol_updates`). */
    pairValidatorAddress?: string;
    isCreate: boolean;
    /** True when the entry was dropped before building (superseded on chain);
     *  absent/false means it was built into the submitted tx. */
    skipped?: boolean;
  }>;
  /** On-chain balance snapshot shared by all entries in the batch (the
   *  receiver and admin wallet are the same for every entry of one batch). */
  postState?: PostConfirmChainState;
};

/**
 * Single method the write client calls. Implementors handle the full
 * Lucid lifecycle: load state, build tx, sign, submit, confirm.
 * Returns `OracleUpdateResult` on success; throws on failure.
 */
export type OracleIntentBridge = {
  submitOracleUpdate(params: OracleIntentSubmitParams): Promise<OracleUpdateResult>;
  submitOracleUpdateBatch(
    params: OracleIntentBatchSubmitParams,
  ): Promise<OracleBatchUpdateResult>;
  /**
   * Read the four operational balances (receiver balance + accrued, payment
   * hook accrued, admin wallet) straight from chain WITHOUT submitting a tx.
   * The daemon polls this on a timer so the Prometheus gauges stay current
   * even when no oracle update is flowing — a balance dashboard must never
   * depend on update traffic. Read-only; never signs or submits.
   */
  snapshotBalances(params: {
    clientStatePath: string;
    protocolStatePath: string;
  }): Promise<PostConfirmChainState & { clientId?: string; receiverUnit?: string }>;
  /**
   * Sweep the client's clean, un-merged side-deposit UTxOs into the Receiver
   * balance by delegating to the CLI's `depositMerge` (spends the Receiver
   * with the `TopUp` redeemer + the deposit UTxOs). Builds, signs, submits,
   * and awaits confirmation. The merge spends the SAME Receiver UTxO as an
   * oracle update, so the CALLER MUST serialize it against the update lane —
   * this method does no locking of its own. Throws on failure (no eligible
   * deposits, build/submit/confirm error) so the caller can log and retry on
   * the next tick. Returns the confirmed tx hash.
   */
  mergeDeposits(params: {
    clientStatePath: string;
    protocolStatePath: string;
  }): Promise<{ txHash: string | null; confirmed: boolean }>;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RealBridgeOptions = {
  /** Progress lines are forwarded to this sink (default: process.stderr). */
  log?: (line: string) => void;
  /**
   * Number of Cardano blocks the bridge waits past inclusion before
   * declaring the tx confirmed.
   *
   *   - depth = 1 (default): emit `tx_confirmed` as soon as the tx is
   *     observed in one block by any indexer. Current behaviour.
   *   - depth > 1: after inclusion, wait approximately
   *     `(depth - 1) × 20 s` (Cardano's ~20 s block time), then re-check
   *     via `assertTxStillOnChain`. If the tx is no longer on chain, the
   *     bridge throws `TxDroppedFromChainError` so the daemon increments
   *     `transactionsReorg` and re-queues the intent.
   *
   * Sourced from `infrastructure.<network>.yaml::cardano.confirmation_depth`.
   */
  confirmationDepth?: number;
  /**
   * Minimum lovelace a clean, ADA-only side-deposit UTxO must hold to count
   * toward the deposit-pending probe in `snapshotBalances`. This is the SAME
   * floor the CLI's `deposit:merge` sweep applies, so the gauge never counts
   * dust the sweep would skip. It is a deposit tx-build param read from the
   * protocol state's `config-bootstrap.json::configState.depositMinLovelace`
   * (set at the CLI's `protocol:init`) and passed in by the daemon (which loads
   * it via `readDepositMinLovelace`) — there is NO hardcoded default here.
   * Required: the factory throws when it is omitted, so the floor can only ever
   * come from that single CLI-owned protocol state shared with the sweep. It is
   * NOT a feeder-YAML key.
   */
  depositMinLovelace: bigint;
  /**
   * Max side-deposit UTxOs an oracle update may opportunistically fold into the
   * same tx. A deposit tx-build param read from the protocol state's
   * `config-bootstrap.json::configState.depositMaxPerUpdateFold` (set at the
   * CLI's protocol:init) and passed in by the daemon (via
   * `readDepositMaxPerUpdateFold`). When > 0 the bridge attempts to fold up to
   * this many confirmed, clean (ADA-only, ≥ floor) deposits into each update;
   * if the combined tx fails to build OR submit it falls back to a pure update
   * so a bad/contended deposit never blocks a price update. When 0 (or absent)
   * the fold is disabled and updates are always pure. NOT a feeder-YAML key.
   */
  depositMaxPerUpdateFold?: number;
};

/**
 * Pure decision: how many side-deposits should this update attempt to fold?
 *
 * Returns the deposit UTxOs to fold (already filtered + capped) — empty when
 * the fold is disabled (`maxPerUpdateFold <= 0`) or there is nothing clean to
 * fold. Kept pure (no chain, no Lucid) so the fold decision is unit-tested in
 * isolation from the live build/submit path. The actual best-effort attempt +
 * fallback-on-failure lives in `submitOracleUpdate`.
 */
export function selectFoldUtxos<T extends { assets?: Record<string, bigint | string>; datum?: string | null; datumHash?: string | null }>(
  candidates: T[],
  minLovelace: bigint,
  maxPerUpdateFold: number,
): T[] {
  if (maxPerUpdateFold <= 0) return [];
  return candidates
    .filter((utxo) => isCleanAdaDepositUtxo(utxo, minLovelace))
    .slice(0, maxPerUpdateFold);
}

/**
 * Best-effort fold orchestration: try the update with the selected deposits
 * first; if that throws (build OR submit failure), retry the SAME update
 * WITHOUT deposits so a bad/contended deposit never blocks the price update.
 *
 * - When `fold` has 0 deposits the attempt runs once with no fold; a failure
 *   propagates (there is nothing to fall back to).
 * - When `fold` has deposits the attempt runs folded; on failure it runs once
 *   more unfolded. A failure of the UNFOLDED retry propagates.
 *
 * `attempt(fold)` performs the actual build → sign → submit and returns its
 * result. `onFallback(err)` is invoked once, only when the folded attempt
 * failed and the pure retry is about to run. Pure (no chain/Lucid) so the
 * fallback semantics are unit-tested in isolation.
 */
export async function runWithFoldFallback<
  F extends { utxos: unknown[] },
  R,
>(args: {
  fold: F | undefined;
  attempt: (fold: F | undefined) => Promise<R>;
  onFallback?: (err: Error) => void;
}): Promise<R & { foldedDeposits: number }> {
  const foldCount = args.fold?.utxos.length ?? 0;
  if (foldCount === 0) {
    const result = await args.attempt(undefined);
    return { ...result, foldedDeposits: 0 };
  }
  try {
    const result = await args.attempt(args.fold);
    return { ...result, foldedDeposits: foldCount };
  } catch (err) {
    args.onFallback?.(err instanceof Error ? err : new Error(String(err)));
    const result = await args.attempt(undefined);
    return { ...result, foldedDeposits: 0 };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a production `OracleIntentBridge` that delegates every
 * oracle-update submission to the CLI's `buildOracleUpdateTx` builder.
 *
 * The implementation mirrors `cli/src/transactions/update.ts`:
 *   1. Read client + protocol state files.
 *   2. Normalise the intent (bigint fields) and recover the EIP-712 witness.
 *   3. Fetch current chain UTxOs.
 *   4. Build, sign, submit the Cardano tx.
 *   5. Await multi-provider confirmation (Blockfrost primary → Koios → BF REST).
 *
 * Throws on any unrecoverable error so the submitter queue can mark the
 * request as failed and continue with the next intent.
 */
export function createRealOracleIntentBridge(
  options: RealBridgeOptions,
): OracleIntentBridge {
  const log = options.log ?? ((line: string) => process.stderr.write(`[bridge] ${line}\n`));
  // Default depth = 1: emit `tx_confirmed` as soon as the tx is observed
  // in any block. Higher values trade latency for rollback safety; see
  // RealBridgeOptions.confirmationDepth and the README finality section.
  const confirmationDepth = options.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH;
  // Deposit-pending probe floor — a deposit tx-build param from the protocol
  // state's config-bootstrap.json::configState.depositMinLovelace (set at the
  // CLI's protocol:init), passed in by the daemon via readDepositMinLovelace.
  // No hardcoded default: that protocol state is the single source shared with
  // the CLI's `deposit:merge` sweep. Not a feeder-YAML key.
  const depositMinLovelace = options.depositMinLovelace;
  // Opportunistic-fold cap — a deposit tx-build param from the protocol state's
  // config-bootstrap.json::configState.depositMaxPerUpdateFold (set at the CLI's
  // protocol:init), passed in by the daemon via readDepositMaxPerUpdateFold.
  // 0/absent disables the fold (always pure updates). Not a feeder-YAML key.
  const depositMaxPerUpdateFold = options.depositMaxPerUpdateFold ?? 0;

  /**
   * Apply a per-router signer override on top of the env-derived CLI config.
   * Returns a new config object (never mutates the input) with exactly one
   * of cardanoWalletSeed / cardanoPrivateKey set from the router signer, so
   * `selectConfiguredWalletWithConfig` loads the right wallet. When `signer`
   * is undefined the env-derived config passes through unchanged (single
   * global wallet — the common single-client case).
   */
  function applySigner(
    cliConfig: CliConfig,
    signer: RouterSigner | undefined,
  ): CliConfig {
    if (!signer) return cliConfig;
    if (signer.kind === "seed") {
      return { ...cliConfig, cardanoWalletSeed: signer.value, cardanoPrivateKey: null };
    }
    return { ...cliConfig, cardanoPrivateKey: signer.value, cardanoWalletSeed: null };
  }

  const bridge: OracleIntentBridge = {
    async submitOracleUpdate(params: OracleIntentSubmitParams): Promise<OracleUpdateResult> {
      const { clientStatePath, protocolStatePath, enriched, intentHash, onStep, signer } = params;
      const { fullIntent } = enriched;

      log(`submitOracleUpdate: intentHash=${intentHash} symbol=${fullIntent.symbol}`);

      // ------------------------------------------------------------------
      // 1. Load client + protocol state.
      // ------------------------------------------------------------------
      log(`loading state: client=${clientStatePath} protocol=${protocolStatePath}`);
      const { client, protocol } = await readClientContext({
        clientStatePath: path.resolve(clientStatePath),
        protocolStatePath: path.resolve(protocolStatePath),
      });

      if (!client.receiver) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no receiver — run receiver:bootstrap first.`,
        );
      }
      if (!client.scripts.pairPolicyId || !client.scripts.pairValidatorHash || !client.scripts.pairValidatorAddress) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no pair scripts — run receiver:parameterize first.`,
        );
      }
      assertOracleUpdateBootstrapRefsResolved(protocol.bootstrapRefs);

      // ------------------------------------------------------------------
      // 2. Normalise intent + recover EIP-712 witness.
      // ------------------------------------------------------------------
      // `fullIntent` fields are already bigint — pass them through as-is.
      const intentInput = {
        intentType: fullIntent.intentType,
        version: fullIntent.version,
        chainId: fullIntent.chainId.toString(),
        nonce: fullIntent.nonce.toString(),
        expiry: fullIntent.expiry.toString(),
        symbol: fullIntent.symbol,
        price: fullIntent.price.toString(),
        timestamp: fullIntent.timestamp.toString(),
        source: fullIntent.source,
        signature: fullIntent.signature,
        signer: fullIntent.signer,
      };
      const intent = normalizeDiaOracleIntent(intentInput);

      const domain = normalizeDiaEip712Domain({
        name: protocol.configState.domain.name,
        version: protocol.configState.domain.version,
        sourceChainId: protocol.configState.domain.sourceChainId,
        verifyingContract: protocol.configState.domain.verifyingContract,
      });
      const witness = recoverDiaOracleIntentWitness(domain, intent);
      if (!protocol.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
        throw new Error("Bridge: recovered DIA signer public key is not authorized in the provided config state.");
      }

      // ------------------------------------------------------------------
      // 3. Connect Lucid + resolve current UTxOs.
      // ------------------------------------------------------------------
      onStep?.("connecting");
      log(`connecting to Cardano…`);
      const cliConfig = applySigner(getCliConfig(), signer);
      const lucid = await makeConfiguredLucidWithConfig(cliConfig);
      const walletSource = await selectConfiguredWalletWithConfig(lucid, cliConfig);
      const wallet = lucid.wallet();
      const [walletAddress, walletUtxos] = await Promise.all([
        wallet.address(),
        wallet.getUtxos(),
      ]);
      const walletDefaults = deriveConfiguredWalletDefaults({ source: walletSource, address: walletAddress });

      const networkNow = await getNetworkNow(lucid);
      assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

      // Compute pair unit first — needed for the on-chain isCreate check.
      if (!client.compiledScripts.pairMintPolicy) {
        throw new Error("Bridge: pairMintPolicy compiled script not found. Run receiver:parameterize first.");
      }
      const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);
      const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
      const pairTokenName = diaIntentTokenNameFromSymbol(intent);
      const pairUnit = `${pairPolicyId}${pairTokenName}`;
      if (!client.compiledScripts.pairValidator) {
        throw new Error("Bridge: pairValidator compiled script not found. Run receiver:parameterize first.");
      }
      const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
      const pairValidatorHash = scriptHashFromValidator(pairValidator);
      const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
      const pairId = diaPairIdHex(intent);

      // ------------------------------------------------------------------
      // isCreate decided from chain — not from local file.
      // utxosAtWithUnit returns [] when the pair NFT has never been minted
      // or was burned; a non-empty result means a live pair UTxO exists.
      // ------------------------------------------------------------------
      const chainPairUtxos = await lucid.utxosAtWithUnit(pairValidatorAddress, pairUnit);

      if (chainPairUtxos.length > 1) {
        const outRefs = chainPairUtxos
          .map((u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`)
          .join(", ");
        log(
          `WARN [duplicate-pairs] symbol=${fullIntent.symbol} count=${chainPairUtxos.length} ` +
          `outRefs=[${outRefs}] — ` +
          `chain state has multiple Pair UTxOs for the same unit. ` +
          `Remedy: npm run cli -- pair:dedup ` +
          `--client-state ${clientStatePath} ` +
          `--protocol-state ${protocolStatePath}`,
        );
      }

      const isCreate = chainPairUtxos.length === 0;
      const currentPairUtxo = chainPairUtxos[0] ?? null;

      if (isCreate) {
        assertPaymentKeyHashIsConfigSigner(
          walletDefaults.paymentKeyHash,
          protocol.configState.validConfigSigners,
          {
            unauthorizedMessage:
              "Bridge: pair creation requires the configured wallet to be a config admin.",
          },
        );
      }

      // Read local pair state. If the pair is on-chain but the local file is
      // absent (startup reconcile failed or file was deleted mid-run),
      // reconstruct a minimal state from the on-chain datum so the monotonic-
      // nonce check and buildState have the correct baseline.
      const pairStatePath = pairStatePathForSymbol(clientStatePath, fullIntent.symbol, pairSlugFromSymbol);
      let existingPair = await readOptionalPairState(pairStatePath);
      if (!isCreate && !existingPair && currentPairUtxo?.datum) {
        const onChain = decodePairDatum(currentPairUtxo.datum);
        log(
          `submitOracleUpdate: local pair state missing for symbol=${fullIntent.symbol}; ` +
          `reconstructed from chain nonce=${onChain.nonce}`,
        );
        existingPair = {
          wallet: { source: "seed", address: walletAddress },
          pair: { tokenName: pairTokenName, pairId, pairUnit, pairValidatorAddress },
          pairState: {
            ...onChain,
            intent: {
              intentType: "", version: "0", chainId: "0", nonce: "0", expiry: "0",
              symbol: fullIntent.symbol, price: onChain.price,
              timestamp: onChain.timestamp, source: "", signature: "", signer: onChain.signer,
            },
          },
          datum: { pairCbor: currentPairUtxo.datum },
        };
      }

      const minUtxoLovelace = existingPair?.pairState.minUtxoLovelace ?? protocol.configState.minUtxoLovelace;

      const state = buildState({
        client,
        protocol,
        existingPair,
        intent,
        walletAddress,
        pairTokenName,
        pairId,
        pairUnit,
        pairValidatorAddress,
        minUtxoLovelace,
      });
      if (pairValidatorHash !== state.scripts.pairValidatorHash) {
        throw new Error("Bridge: pair validator hash does not match the current blueprint.");
      }
      if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
        throw new Error(`Bridge: intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
      }
      // Monotonicity is validated by `buildOracleUpdateTx` against the LIVE
      // on-chain pair datum (the single source of truth) — not the local
      // pair-state file. A superseded intent makes the builder throw before any
      // tx is built; the submitter classifies it as a benign NonMonotonicNonce.

      const currentConfigUtxo = await findSingleUtxoAtUnit(
        lucid,
        state.scripts.configValidatorAddress,
        state.scripts.configUnit,
        "config",
      );
      // currentPairUtxo already fetched above via utxosAtWithUnit (isCreate check).
      const currentReceiverUtxo = await findSingleUtxoAtUnit(
        lucid,
        state.receiver.receiverValidatorAddress,
        state.receiver.receiverUnit,
        "receiver",
      );

      // ------------------------------------------------------------------
      // 4. Build, sign, submit — with opportunistic best-effort deposit fold.
      //
      // When the fold is enabled (depositMaxPerUpdateFold > 0) we first try to
      // fold up to that many confirmed, clean (ADA-only, >= floor) side-deposits
      // into THIS update (absorbed into the Receiver balance via AccrueFee). If
      // the combined tx fails to BUILD or SUBMIT, we fall back to the SAME update
      // WITHOUT the deposits (a pure update) so a bad/contended deposit never
      // blocks a price update. Selection + the fold cap come from the protocol
      // state's configState (set at the CLI's protocol:init) — no hardcoded
      // values; the standalone auto-merge still handles bulk sweeps.
      // ------------------------------------------------------------------
      let depositFold:
        | Awaited<ReturnType<typeof selectDepositsForUpdateFold>>
        | undefined;
      if (depositMaxPerUpdateFold > 0) {
        try {
          // selectDepositsForUpdateFold reads the floor + the
          // depositMaxPerUpdateFold cap from configState and filters to clean
          // ADA deposits — the same eligibility the CLI sweep applies.
          const selected = await selectDepositsForUpdateFold({ lucid, client, protocol });
          if (selected.utxos.length > 0) {
            depositFold = selected;
            log(
              `fold: selected ${selected.utxos.length} clean deposit(s) totalling ` +
              `${selected.sweptLovelace} lovelace to absorb into update symbol=${fullIntent.symbol}`,
            );
          }
        } catch (err) {
          // Selection failure (provider hiccup, missing deposit script) must
          // never block the update — proceed with a pure update.
          log(`fold: deposit selection failed, proceeding pure — ${(err as Error).message}`);
          depositFold = undefined;
        }
      }

      // Build the tx for a given fold (or none). Kept as a closure so the
      // fallback path re-runs it with no deposits. Returns the built artifacts
      // needed by the confirmation + state-write steps below.
      async function buildUpdate(fold: typeof depositFold) {
        const built = await buildOracleUpdateTx(lucid, {
          isCreate,
          intent,
          witness,
          networkNow,
          currentConfigUtxo,
          currentPairUtxo,
          currentReceiverUtxo,
          walletPaymentKeyHash: walletDefaults.paymentKeyHash,
          scripts: state.scripts,
          compiledScripts: state.compiledScripts,
          referenceScripts: state.referenceScripts,
          configState: state.configState,
          pairState: state.pairState,
          pair: state.pair,
          receiver: state.receiver,
          depositFold:
            fold && fold.utxos.length > 0
              ? {
                  utxos: fold.utxos,
                  depositValidator: fold.depositValidator,
                  referenceOutRef: fold.referenceOutRef,
                }
              : undefined,
        });
        return built;
      }

      onStep?.("building");
      log(`building oracle update tx for symbol=${fullIntent.symbol}`);

      let txSignBuilder: Awaited<ReturnType<typeof buildOracleUpdateTx>>["txSignBuilder"];
      let nextPairState: Awaited<ReturnType<typeof buildOracleUpdateTx>>["nextPairState"];
      let nextPairDatumCbor: Awaited<ReturnType<typeof buildOracleUpdateTx>>["nextPairDatumCbor"];
      let txHash: string;
      let feePaidLovelace: string | undefined;

      // Extract the tx fee from a built tx body (best-effort; a future Lucid API
      // change must not break the happy path).
      const extractFee = (
        builder: Awaited<ReturnType<typeof buildOracleUpdateTx>>["txSignBuilder"],
      ): string | undefined => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fee = (builder as any).toTransaction?.().body?.().fee?.();
          return fee !== undefined && fee !== null ? BigInt(fee).toString() : undefined;
        } catch {
          return undefined;
        }
      };

      // One build → sign → submit attempt for a given fold (or none). Returns
      // the built artifacts; throws on build/sign/submit failure so the
      // fold-fallback wrapper can retry pure.
      const attemptSubmit = async (fold: typeof depositFold) => {
        const built = await buildUpdate(fold);
        const builtHash = built.txSignBuilder.toHash();
        const builtFee = extractFee(built.txSignBuilder);
        onStep?.("signing", { txHash: builtHash });
        const signedTx = await built.txSignBuilder.sign.withWallet().complete();
        onStep?.("submitting", { txHash: builtHash });
        await signedTx.submit();
        onStep?.("submitted", { txHash: builtHash });
        return {
          txSignBuilder: built.txSignBuilder,
          nextPairState: built.nextPairState,
          nextPairDatumCbor: built.nextPairDatumCbor,
          txHash: builtHash,
          feePaidLovelace: builtFee,
        };
      };

      // Try the folded tx first; on ANY build/sign/submit failure, fall back to
      // a pure update (at most one fallback). `runWithFoldFallback` is the pure
      // orchestration core (unit-tested in lib-bridge/__tests__).
      const submitted = await runWithFoldFallback({
        fold: depositFold,
        attempt: attemptSubmit,
        onFallback: (err) =>
          log(
            `fold: combined update+absorb failed for symbol=${fullIntent.symbol} ` +
            `(${err.message}); retrying as a PURE update without deposits`,
          ),
      });
      txSignBuilder = submitted.txSignBuilder;
      nextPairState = submitted.nextPairState;
      nextPairDatumCbor = submitted.nextPairDatumCbor;
      txHash = submitted.txHash;
      feePaidLovelace = submitted.feePaidLovelace;
      if (submitted.foldedDeposits > 0) {
        log(
          `fold: submitted update+absorb txHash=${txHash} deposits=${submitted.foldedDeposits}`,
        );
      }
      log(`submitted: txHash=${txHash} intentHash=${intentHash}`);

      // ------------------------------------------------------------------
      // 5. Await confirmation.
      // ------------------------------------------------------------------
      onStep?.("waiting_confirm", { txHash });
      const confirmed = await awaitTxConfirmation({
        lucid,
        txHash,
        reportProgress: log,
        label: `oracle update (${fullIntent.symbol}, intentHash=${intentHash})`,
      });

      if (!confirmed) {
        throw new Error(
          `Transaction ${txHash} was submitted but confirmation was never observed ` +
          `(intentHash=${intentHash}).`,
        );
      }

      // Honour `cardano.confirmation_depth`: wait an approximation of
      // `(depth - 1) × 20 s` (Cardano's slot time) past inclusion, then
      // re-check the tx is still on chain. If a reorg dropped it, this
      // throws `TxDroppedFromChainError` which the daemon classifies as
      // `TxDroppedFromChain` → increments `transactionsReorg`.
      if (confirmationDepth > 1) {
        log(`awaiting ${confirmationDepth - 1} extra block(s) past inclusion of ${txHash}`);
        await sleep((confirmationDepth - 1) * 20_000);
        await assertTxStillOnChain({ txHash });
      }

      onStep?.("waiting_utxo", { txHash });
      await waitForWalletSettlement({
        wallet,
        previousUtxos: walletUtxos,
        transaction: txSignBuilder,
        label: "oracle update",
      });
      await Promise.all([
        waitForUnitUtxoReplacement({
          lucid,
          address: state.pair.pairValidatorAddress,
          unit: state.pair.pairUnit,
          label: "pair",
          previousOutRef: currentPairUtxo ?? undefined,
          txHash,
        }),
        waitForUnitUtxoReplacement({
          lucid,
          address: state.receiver.receiverValidatorAddress,
          unit: state.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
          txHash,
        }),
      ]);
      onStep?.("writing_state", { txHash });
      await writePairState(pairStatePath, {
        wallet: { source: walletSource, address: walletAddress },
        pair: { ...state.pair },
        pairState: nextPairState,
        datum: { pairCbor: nextPairDatumCbor },
        transactions: appendTransactionRecord(state.transactions, {
          step: "feeder:update",
          submittedTxHash: txHash,
          confirmed,
        }),
      });

      log(`confirmed: txHash=${txHash} receiverUnit=${state.receiver.receiverUnit as string}`);

      // ------------------------------------------------------------------
      // 6. Capture post-confirm balances for Prometheus gauges.
      //    Each query is best-effort: a provider hiccup leaves the field
      //    undefined and the daemon skips emitting that gauge rather
      //    than reporting a misleading 0.
      // ------------------------------------------------------------------
      const postState = await capturePostConfirmState({
        lucid,
        wallet,
        receiverValidatorAddress: state.receiver.receiverValidatorAddress as string,
        depositValidatorAddress: state.receiver.depositValidatorAddress as string | undefined,
        receiverUnit: state.receiver.receiverUnit as string,
        paymentHookValidatorAddress: state.scripts.paymentHookValidatorAddress,
        paymentHookUnit: state.scripts.paymentHookUnit,
        log,
      });

      return {
        txHash,
        receiverUnit: state.receiver.receiverUnit as string,
        pairUnit,
        pairValidatorAddress: state.pair.pairValidatorAddress,
        isCreate,
        feePaidLovelace,
        postState,
      };
    },

    async submitOracleUpdateBatch(
      params: OracleIntentBatchSubmitParams,
    ): Promise<OracleBatchUpdateResult> {
      const { clientStatePath, protocolStatePath, updates, signer } = params;

      if (updates.length === 0) {
        throw new Error("Bridge: batch submission requires at least one intent.");
      }

      if (updates.length === 1) {
        const [single] = updates;
        const result = await bridge.submitOracleUpdate({
          clientStatePath,
          protocolStatePath,
          enriched: single!.enriched,
          intentHash: single!.intentHash,
          onStep: single!.onStep,
        });
        return {
          txHash: result.txHash,
          receiverUnit: result.receiverUnit,
          entries: [{
            intentHash: single!.intentHash,
            pairUnit: result.pairUnit,
            pairValidatorAddress: result.pairValidatorAddress,
            isCreate: result.isCreate,
            skipped: false,
          }],
          postState: result.postState,
        };
      }

      log(
        `submitOracleUpdateBatch: intents=${updates.length} symbols=${updates.map((update) => update.enriched.fullIntent.symbol).join(", ")}`,
      );

      const { client, protocol } = await readClientContext({
        clientStatePath: path.resolve(clientStatePath),
        protocolStatePath: path.resolve(protocolStatePath),
      });

      if (!client.receiver) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no receiver — run receiver:bootstrap first.`,
        );
      }
      if (!client.scripts.pairPolicyId || !client.scripts.pairValidatorHash || !client.scripts.pairValidatorAddress) {
        throw new Error(
          `Bridge: client state at ${clientStatePath} has no pair scripts — run receiver:parameterize first.`,
        );
      }
      assertOracleUpdateBootstrapRefsResolved(protocol.bootstrapRefs);

      emitBatchStep(updates, "connecting");
      const cliConfig = applySigner(getCliConfig(), signer);
      const lucid = await makeConfiguredLucidWithConfig(cliConfig);
      const walletSource = await selectConfiguredWalletWithConfig(lucid, cliConfig);
      const wallet = lucid.wallet();
      const [walletAddress, walletUtxos] = await Promise.all([
        wallet.address(),
        wallet.getUtxos(),
      ]);
      const walletDefaults = deriveConfiguredWalletDefaults({ source: walletSource, address: walletAddress });
      const networkNow = await getNetworkNow(lucid);

      const domain = normalizeDiaEip712Domain({
        name: protocol.configState.domain.name,
        version: protocol.configState.domain.version,
        sourceChainId: protocol.configState.domain.sourceChainId,
        verifyingContract: protocol.configState.domain.verifyingContract,
      });

      const preparedEntries: Array<{
        update: OracleIntentBatchSubmitParams["updates"][number];
        state: CombinedUpdateState;
        pairStatePath: string;
        pairUnit: string;
        isCreate: boolean;
        currentPairUtxo: UTxO | null;
        intent: Awaited<ReturnType<typeof normalizeDiaOracleIntent>>;
        witness: Awaited<ReturnType<typeof recoverDiaOracleIntentWitness>>;
      }> = [];

      // Candidates dropped because their intent does not strictly beat the
      // live on-chain pair datum — already superseded on chain. Reported
      // benignly (not failed): no tx, no fee, retried on the next DIA intent.
      const skippedEntries: Array<{ intentHash: string; pairUnit: string; pairValidatorAddress: string }> = [];

      let requiresConfigSigner = false;

      for (const update of updates) {
        const { fullIntent } = update.enriched;
        const intent = normalizeDiaOracleIntent({
          intentType: fullIntent.intentType,
          version: fullIntent.version,
          chainId: fullIntent.chainId.toString(),
          nonce: fullIntent.nonce.toString(),
          expiry: fullIntent.expiry.toString(),
          symbol: fullIntent.symbol,
          price: fullIntent.price.toString(),
          timestamp: fullIntent.timestamp.toString(),
          source: fullIntent.source,
          signature: fullIntent.signature,
          signer: fullIntent.signer,
        });
        const witness = recoverDiaOracleIntentWitness(domain, intent);
        if (!protocol.configState.authorizedDiaPublicKeys.includes(witness.signerPublicKey)) {
          throw new Error("Bridge: recovered DIA signer public key is not authorized in the provided config state.");
        }
        assertDiaOracleIntentNotExpired(intent, networkNow.unixTimeSec);

        if (!client.compiledScripts.pairMintPolicy) {
          throw new Error("Bridge: pairMintPolicy compiled script not found. Run receiver:parameterize first.");
        }
        const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);
        const pairPolicyId = policyIdFromMintingPolicy(pairMintPolicy);
        const pairTokenName = diaIntentTokenNameFromSymbol(intent);
        const pairUnit = `${pairPolicyId}${pairTokenName}`;
        if (!client.compiledScripts.pairValidator) {
          throw new Error("Bridge: pairValidator compiled script not found. Run receiver:parameterize first.");
        }
        const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
        const pairValidatorHash = scriptHashFromValidator(pairValidator);
        const pairValidatorAddress = scriptAddressFromValidator(pairValidator);
        const pairId = diaPairIdHex(intent);
        const chainPairUtxos = await lucid.utxosAtWithUnit(pairValidatorAddress, pairUnit);

        if (chainPairUtxos.length > 1) {
          const outRefs = chainPairUtxos
            .map((utxo: { txHash: string; outputIndex: number }) => `${utxo.txHash}#${utxo.outputIndex}`)
            .join(", ");
          log(
            `WARN [duplicate-pairs] symbol=${fullIntent.symbol} count=${chainPairUtxos.length} outRefs=[${outRefs}]`,
          );
        }

        const isCreate = chainPairUtxos.length === 0;
        const currentPairUtxo = chainPairUtxos[0] ?? null;
        if (isCreate) {
          requiresConfigSigner = true;
        }

        const pairStatePath = pairStatePathForSymbol(clientStatePath, fullIntent.symbol, pairSlugFromSymbol);
        let existingPair = await readOptionalPairState(pairStatePath);
        if (!isCreate && !existingPair && currentPairUtxo?.datum) {
          const onChain = decodePairDatum(currentPairUtxo.datum);
          existingPair = {
            wallet: { source: "seed", address: walletAddress },
            pair: { tokenName: pairTokenName, pairId, pairUnit, pairValidatorAddress },
            pairState: {
              ...onChain,
              intent: {
                intentType: "",
                version: "0",
                chainId: "0",
                nonce: "0",
                expiry: "0",
                symbol: fullIntent.symbol,
                price: onChain.price,
                timestamp: onChain.timestamp,
                source: "",
                signature: "",
                signer: onChain.signer,
              },
            },
            datum: { pairCbor: currentPairUtxo.datum },
          };
        }

        const minUtxoLovelace =
          existingPair?.pairState.minUtxoLovelace ?? protocol.configState.minUtxoLovelace;

        const state = buildState({
          client,
          protocol,
          existingPair,
          intent,
          walletAddress,
          pairTokenName,
          pairId,
          pairUnit,
          pairValidatorAddress,
          minUtxoLovelace,
        });

        if (pairValidatorHash !== state.scripts.pairValidatorHash) {
          throw new Error("Bridge: pair validator hash does not match the current blueprint.");
        }
        if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
          throw new Error(`Bridge: intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
        }
        // Validate against the LIVE on-chain pair datum — the single source of
        // truth — not the local pair-state file (which can drift behind chain).
        // A non-create intent that does not strictly beat the on-chain
        // (timestamp, nonce) is already superseded on chain: skip it so it never
        // poisons the atomic batch (one stale pair would revert the whole tx and
        // waste the fee). It is reported benignly and retried on the next DIA
        // intent. The builder re-asserts this as a final guard.
        if (!isCreate && currentPairUtxo?.datum) {
          const onChain = decodePairDatum(currentPairUtxo.datum);
          const beatsOnChain =
            intent.timestamp > BigInt(onChain.timestamp) && intent.nonce > BigInt(onChain.nonce);
          if (!beatsOnChain) {
            log(
              `submitOracleUpdateBatch: skipping ${fullIntent.symbol} — intent ` +
                `(ts=${intent.timestamp}, nonce=${intent.nonce}) does not beat on-chain ` +
                `(ts=${onChain.timestamp}, nonce=${onChain.nonce}); superseded.`,
            );
            skippedEntries.push({ intentHash: update.intentHash, pairUnit, pairValidatorAddress });
            continue;
          }
        }

        preparedEntries.push({
          update,
          state,
          pairStatePath,
          pairUnit,
          isCreate,
          currentPairUtxo,
          intent,
          witness,
        });
      }

      if (requiresConfigSigner) {
        assertPaymentKeyHashIsConfigSigner(
          walletDefaults.paymentKeyHash,
          protocol.configState.validConfigSigners,
          {
            unauthorizedMessage:
              "Bridge: batch pair creation requires the configured wallet to be a config admin.",
          },
        );
      }

      const [firstEntry] = preparedEntries;
      if (!firstEntry) {
        // Every candidate was superseded on chain — nothing to build or submit.
        // Report all as benign skips: no tx, no fee. The submitter maps each to
        // a NonMonotonicNonce-equivalent (benign) result.
        if (skippedEntries.length > 0) {
          log(
            `submitOracleUpdateBatch: all ${skippedEntries.length} candidate(s) superseded on chain; no tx submitted.`,
          );
          return {
            txHash: "",
            receiverUnit: "",
            entries: skippedEntries.map((e) => ({
              intentHash: e.intentHash,
              pairUnit: e.pairUnit,
              pairValidatorAddress: e.pairValidatorAddress,
              isCreate: false,
              skipped: true,
            })),
          };
        }
        throw new Error("Bridge: batch submission requires at least one prepared entry.");
      }

      const currentConfigUtxo = await findSingleUtxoAtUnit(
        lucid,
        firstEntry.state.scripts.configValidatorAddress,
        firstEntry.state.scripts.configUnit,
        "config",
      );
      const currentReceiverUtxo = await findSingleUtxoAtUnit(
        lucid,
        firstEntry.state.receiver.receiverValidatorAddress,
        firstEntry.state.receiver.receiverUnit,
        "receiver",
      );
      const currentPairUtxoByUnit = new Map<string, UTxO>();
      for (const entry of preparedEntries) {
        if (!entry.isCreate && entry.currentPairUtxo) {
          currentPairUtxoByUnit.set(entry.pairUnit, entry.currentPairUtxo);
        }
      }

      emitBatchStep(updates, "building");
      const { txSignBuilder, updatedPairStates } = await buildBatchOracleUpdateTx(lucid, {
        entries: preparedEntries.map((entry) => ({
          intent: entry.intent,
          witness: entry.witness,
          pairArtifact: entry.state,
          isCreate: entry.isCreate,
        })),
        networkNow,
        currentConfigUtxo,
        currentReceiverUtxo,
        currentPairUtxoByUnit,
        walletPaymentKeyHash: walletDefaults.paymentKeyHash,
        protocolState: protocol,
        clientState: client,
      });

      const txHash = txSignBuilder.toHash();
      emitBatchStep(updates, "signing", { txHash });
      const signedTx = await txSignBuilder.sign.withWallet().complete();
      emitBatchStep(updates, "submitting", { txHash });
      await signedTx.submit();
      emitBatchStep(updates, "submitted", { txHash });

      emitBatchStep(updates, "waiting_confirm", { txHash });
      const confirmed = await awaitTxConfirmation({
        lucid,
        txHash,
        reportProgress: log,
        label: `oracle update batch (${updates.map((update) => update.enriched.fullIntent.symbol).join(", ")})`,
      });

      if (!confirmed) {
        throw new Error(
          `Transaction ${txHash} was submitted but confirmation was never observed ` +
          `(intentCount=${updates.length}).`,
        );
      }

      // Honour `cardano.confirmation_depth` — see the single-tx path for
      // the full rationale (RealBridgeOptions.confirmationDepth).
      if (confirmationDepth > 1) {
        log(`awaiting ${confirmationDepth - 1} extra block(s) past batch inclusion of ${txHash}`);
        await sleep((confirmationDepth - 1) * 20_000);
        await assertTxStillOnChain({ txHash });
      }

      emitBatchStep(updates, "waiting_utxo", { txHash });
      await waitForWalletSettlement({
        wallet,
        previousUtxos: walletUtxos,
        transaction: txSignBuilder,
        label: "oracle update batch",
      });
      await Promise.all([
        ...preparedEntries.map((entry) =>
          waitForUnitUtxoReplacement({
            lucid,
            address: entry.state.pair.pairValidatorAddress,
            unit: entry.pairUnit,
            label: `pair:${entry.update.enriched.fullIntent.symbol}`,
            previousOutRef: entry.currentPairUtxo ?? undefined,
            txHash,
          })),
        waitForUnitUtxoReplacement({
          lucid,
          address: firstEntry.state.receiver.receiverValidatorAddress,
          unit: firstEntry.state.receiver.receiverUnit,
          label: "receiver",
          previousOutRef: currentReceiverUtxo,
          txHash,
        }),
      ]);

      const updatedPairStateByUnit = new Map<
        string,
        { pairUnit: string; nextPairState: unknown; nextPairDatumCbor: string }
      >(
        updatedPairStates.map((state: { pairUnit: string; nextPairState: unknown; nextPairDatumCbor: string }) => [
          state.pairUnit,
          state,
        ]),
      );

      emitBatchStep(updates, "writing_state", { txHash });
      await Promise.all(
        preparedEntries.map(async (entry) => {
          const updatedState = updatedPairStateByUnit.get(entry.pairUnit);
          if (!updatedState) {
            throw new Error(`Bridge: missing updated pair state for ${entry.pairUnit}.`);
          }
          await writePairState(entry.pairStatePath, {
            wallet: { source: walletSource, address: walletAddress },
            pair: { ...entry.state.pair },
            pairState: updatedState.nextPairState,
            datum: { pairCbor: updatedState.nextPairDatumCbor },
            transactions: appendTransactionRecord(entry.state.transactions, {
              step: "feeder:update:batch",
              submittedTxHash: txHash,
              confirmed,
            }),
          });
        }),
      );

      // Capture post-confirm balances once for the whole batch — the
      // receiver, payment hook, and admin wallet are shared across all
      // entries in this submission.
      const postState = await capturePostConfirmState({
        lucid,
        wallet,
        receiverValidatorAddress: firstEntry.state.receiver.receiverValidatorAddress as string,
        depositValidatorAddress: firstEntry.state.receiver.depositValidatorAddress as string | undefined,
        receiverUnit: firstEntry.state.receiver.receiverUnit as string,
        paymentHookValidatorAddress: firstEntry.state.scripts.paymentHookValidatorAddress,
        paymentHookUnit: firstEntry.state.scripts.paymentHookUnit,
        log,
      });

      return {
        txHash,
        receiverUnit: firstEntry.state.receiver.receiverUnit as string,
        entries: [
          ...preparedEntries.map((entry) => ({
            intentHash: entry.update.intentHash,
            pairUnit: entry.pairUnit,
            pairValidatorAddress: entry.state.pair.pairValidatorAddress,
            isCreate: entry.isCreate,
            skipped: false,
          })),
          ...skippedEntries.map((e) => ({
            intentHash: e.intentHash,
            pairUnit: e.pairUnit,
            pairValidatorAddress: e.pairValidatorAddress,
            isCreate: false,
            skipped: true,
          })),
        ],
        postState,
      };
    },

    async snapshotBalances(params: {
      clientStatePath: string;
      protocolStatePath: string;
    }): Promise<PostConfirmChainState & { clientId?: string; receiverUnit?: string }> {
      // Read-only balance probe used by the daemon's periodic refresh. Reuses
      // the same on-chain reads as the post-confirm capture, but sets up Lucid
      // with no signer override and never builds or submits a tx.
      const { client, protocol } = await readClientContext({
        clientStatePath: path.resolve(params.clientStatePath),
        protocolStatePath: path.resolve(params.protocolStatePath),
      });

      const receiver = (client as Record<string, unknown>).receiver as
        | Record<string, unknown>
        | undefined;
      const protocolScripts = (protocol as Record<string, unknown>).scripts as
        | Record<string, unknown>
        | undefined;
      if (!receiver || !protocolScripts) {
        throw new Error(
          `Bridge.snapshotBalances: state missing receiver/scripts (client=${params.clientStatePath})`,
        );
      }

      const lucid = await makeConfiguredLucidWithConfig(getCliConfig());
      await selectConfiguredWalletWithConfig(lucid, getCliConfig());
      const wallet = lucid.wallet();

      const balances = await capturePostConfirmState({
        lucid,
        wallet,
        receiverValidatorAddress: receiver.receiverValidatorAddress as string,
        depositValidatorAddress: receiver.depositValidatorAddress as string | undefined,
        receiverUnit: receiver.receiverUnit as string,
        paymentHookValidatorAddress: protocolScripts.paymentHookValidatorAddress as string,
        paymentHookUnit: protocolScripts.paymentHookUnit as string,
        log,
      });

      // Deposit-pending probe. The client funds its Receiver by paying ADA to
      // the per-client deposit script address (CLI artifact field
      // `receiver.depositValidatorAddress`); that ADA must later be folded into
      // the Receiver balance with `deposit:merge`. Here we read-only sum the
      // CLEAN, mergeable deposits sitting there so the daemon can expose how
      // much is pending and decide whether to auto-merge. A UTxO is counted
      // only when it is pure ADA (no native tokens), carries no datum, and is
      // at or above 1 ADA — exactly the eligibility the CLI's `depositMerge`
      // sweep applies (`isCleanAdaDeposit`), so dust / token-junk / oversized-
      // datum UTxOs a griefer might park there are skipped and never inflate
      // the gauge or trigger a no-op merge. Best-effort: a query failure or a
      // missing deposit address leaves both fields undefined and the daemon
      // skips emitting the gauge rather than reporting a misleading 0.
      const depositAddress = receiver.depositValidatorAddress as string | undefined;
      let depositPendingLovelace: bigint | undefined;
      if (depositAddress) {
        try {
          const depositUtxos = (await (lucid as {
            utxosAt(addr: string): Promise<
              Array<{ assets?: Record<string, bigint | string>; datum?: string | null; datumHash?: string | null }>
            >;
          }).utxosAt(depositAddress)) ?? [];
          let total = 0n;
          for (const utxo of depositUtxos) {
            if (!isCleanAdaDepositUtxo(utxo, depositMinLovelace)) continue;
            const lovelace = utxo.assets?.lovelace ?? 0n;
            total += typeof lovelace === "bigint" ? lovelace : BigInt(lovelace);
          }
          depositPendingLovelace = total;
        } catch (error) {
          log(`snapshot-balances: deposit query failed for ${depositAddress}: ${(error as Error).message}`);
        }
      }

      return {
        ...balances,
        depositAddress,
        depositPendingLovelace,
        clientId: (client as Record<string, unknown>).clientId as string | undefined,
        // Receiver NFT unit — the exclusive-lock key the update queue uses in
        // the in-flight table. Surfaced so the daemon can serialize an auto-
        // merge against any in-flight update on the same Receiver.
        receiverUnit: receiver.receiverUnit as string | undefined,
      };
    },

    async mergeDeposits(params: {
      clientStatePath: string;
      protocolStatePath: string;
    }): Promise<{ txHash: string | null; confirmed: boolean }> {
      // Delegate to the CLI's `depositMerge` tx builder so the feeder keeps a
      // single source of truth for the merge tx shape (TopUp redeemer + deposit
      // UTxOs). build-only is false: this submits and awaits confirmation.
      // Serialization against the update lane is the CALLER's responsibility
      // (the daemon holds the lane lock around this call) — `depositMerge`
      // itself spends the live Receiver UTxO with no awareness of in-flight
      // updates.
      log(`mergeDeposits: client=${params.clientStatePath}`);
      const result = (await depositMerge({
        clientStatePath: path.resolve(params.clientStatePath),
        protocolStatePath: path.resolve(params.protocolStatePath),
        buildOnly: false,
      })) as {
        transactions?: Array<{ step?: string; submittedTxHash?: string | null; confirmed?: boolean }>;
      };
      // `depositMerge` appends a single transaction record carrying the
      // submitted hash + confirmation flag; the last record is this merge.
      const record = result.transactions?.[result.transactions.length - 1];
      const txHash = record?.submittedTxHash ?? null;
      const confirmed = record?.confirmed === true;
      log(`mergeDeposits: confirmed=${confirmed} txHash=${txHash ?? "(none)"}`);
      return { txHash, confirmed };
    },
  };

  return bridge;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Capture the four operational lovelace balances the daemon exposes as
 * Prometheus gauges (`cardano_receiver_balance_lovelace`,
 * `cardano_receiver_accrued_lovelace`, `cardano_payment_hook_accrued_lovelace`,
 * `cardano_admin_wallet_lovelace`).
 *
 * Each query is best-effort: a transient provider error leaves the
 * corresponding field undefined. The daemon must skip emitting the gauge
 * when a field is undefined rather than reporting a misleading 0.
 *
 * Called once at the tail of every confirmed oracle update (single or batch).
 */
async function capturePostConfirmState(args: {
  lucid: Parameters<typeof findSingleUtxoAtUnit>[0];
  wallet: { getUtxos(): Promise<Array<{ assets: Record<string, bigint> }>> };
  receiverValidatorAddress: string;
  depositValidatorAddress?: string;
  receiverUnit: string;
  paymentHookValidatorAddress: string;
  paymentHookUnit: string;
  log: (line: string) => void;
}): Promise<{
  receiverBalanceLovelace?: bigint;
  receiverAccruedLovelace?: bigint;
  paymentHookAccruedLovelace?: bigint;
  adminWalletLovelace?: bigint;
  receiverAddress?: string;
  depositAddress?: string;
}> {
  const result: {
    receiverBalanceLovelace?: bigint;
    receiverAccruedLovelace?: bigint;
    paymentHookAccruedLovelace?: bigint;
    adminWalletLovelace?: bigint;
    receiverAddress?: string;
    depositAddress?: string;
  } = {
    // Known from the inputs (not a chain query) — always available so the
    // ReceiverBalanceLow alert can name the Receiver and funding address.
    receiverAddress: args.receiverValidatorAddress,
    depositAddress: args.depositValidatorAddress,
  };

  // 1. Receiver datum — exposes balanceLovelace + accruedToHookLovelace.
  try {
    const receiverUtxo = await findSingleUtxoAtUnit(
      args.lucid,
      args.receiverValidatorAddress,
      args.receiverUnit,
      "receiver",
    );
    const state = decodeReceiverDatum(
      requireInlineDatum(receiverUtxo, "receiver"),
    );
    result.receiverBalanceLovelace = BigInt(state.balanceLovelace);
    result.receiverAccruedLovelace = BigInt(state.accruedToHookLovelace);
  } catch (error) {
    args.log(`post-confirm: receiver query failed: ${(error as Error).message}`);
  }

  // 2. PaymentHook datum — exposes accruedFeesLovelace.
  try {
    const hookUtxo = await findSingleUtxoAtUnit(
      args.lucid,
      args.paymentHookValidatorAddress,
      args.paymentHookUnit,
      "payment hook",
    );
    // withdrawAddress is only echoed back in the decoded struct; this probe
    // reads accruedFeesLovelace only, so the value passed here is irrelevant.
    const state = decodePaymentHookDatum(
      requireInlineDatum(hookUtxo, "payment hook"),
      "",
    );
    result.paymentHookAccruedLovelace = BigInt(state.accruedFeesLovelace);
  } catch (error) {
    args.log(`post-confirm: payment hook query failed: ${(error as Error).message}`);
  }

  // 3. Admin (signer) wallet — sum lovelace across fresh UTxOs.
  try {
    const utxos = await args.wallet.getUtxos();
    let total = 0n;
    for (const utxo of utxos) {
      const lovelace = utxo.assets?.lovelace ?? 0n;
      total += typeof lovelace === "bigint" ? lovelace : BigInt(lovelace as unknown as string);
    }
    result.adminWalletLovelace = total;
  } catch (error) {
    args.log(`post-confirm: admin wallet query failed: ${(error as Error).message}`);
  }

  return result;
}

/**
 * A clean, mergeable side-deposit UTxO: pure ADA (only `lovelace`), no inline
 * datum or datum hash, at or above the configured floor (`minLovelace`).
 * Native-token, datum-bearing, and dust UTxOs a griefer might park at the
 * deposit address are rejected — they stay harmlessly at the address and are
 * never swept, so they must not inflate the deposit-pending gauge either.
 * This is the read-only counterpart of the CLI's `isCleanAdaDeposit` selection
 * in `cli/src/transactions/deposit.ts`, applying the SAME floor: both come from
 * `config-bootstrap.json::configState.depositMinLovelace` (set at the CLI's
 * protocol:init; the daemon reads it via `readDepositMinLovelace` and passes it
 * in via `RealBridgeOptions.depositMinLovelace`). Not a feeder-YAML key.
 */
export function isCleanAdaDepositUtxo(
  utxo: {
    assets?: Record<string, bigint | string>;
    datum?: string | null;
    datumHash?: string | null;
  },
  minLovelace: bigint,
): boolean {
  if (utxo.datum || utxo.datumHash) return false;
  const assets = utxo.assets ?? {};
  const assetKeys = Object.keys(assets);
  const onlyAda = assetKeys.length === 1 && assetKeys[0] === "lovelace";
  if (!onlyAda) return false;
  const raw = assets.lovelace ?? 0n;
  const lovelace = typeof raw === "bigint" ? raw : BigInt(raw);
  return lovelace >= minLovelace;
}

/**
 * Assemble the combined state object expected by `buildOracleUpdateTx`,
 * merging client + protocol state files the same way `update.ts` does.
 */
function buildState(args: {
  client: ClientStateArtifact;
  protocol: ConfigStateArtifact;
  existingPair: PairStateArtifact | null;
  intent: DiaOracleIntent;
  walletAddress: string;
  pairTokenName: string;
  pairId: string;
  pairUnit: string;
  pairValidatorAddress: string;
  minUtxoLovelace: string | number | bigint;
}): CombinedUpdateState {
  const { client, protocol, existingPair } = args;
  if (!client.receiver) {
    throw new Error("buildState: client state has no receiver — run receiver:bootstrap first.");
  }

  const pair: PairStateArtifact = existingPair ?? {
    wallet: { source: "seed", address: args.walletAddress },
    pair: {
      tokenName: args.pairTokenName,
      pairId: args.pairId,
      pairUnit: args.pairUnit,
      pairValidatorAddress: args.pairValidatorAddress,
    },
    pairState: {
      pairId: args.pairId,
      price: "0",
      timestamp: "0",
      nonce: "0",
      intentHash: "00".repeat(32),
      signer: "00".repeat(20),
      minUtxoLovelace: String(args.minUtxoLovelace),
      intent: diaIntentToState(args.intent),
    },
    datum: { pairCbor: "" },
  };

  return {
    wallet: pair.wallet,
    pair: pair.pair,
    pairState: pair.pairState,
    datum: pair.datum,
    transactions: pair.transactions,
    scripts: { ...protocol.scripts, ...client.scripts },
    compiledScripts: { ...protocol.compiledScripts, ...client.compiledScripts },
    referenceScripts: { ...protocol.referenceScripts, ...client.referenceScripts },
    configState: protocol.configState,
    receiver: client.receiver,
  };
}

function pairStatePathForSymbol(
  clientStatePath: string,
  symbol: string,
  pairSlugFromSymbol: (symbol: string) => string,
): string {
  const resolvedClientPath = path.resolve(clientStatePath);
  const clientFile = path.basename(resolvedClientPath, path.extname(resolvedClientPath));
  return path.join(
    path.dirname(resolvedClientPath),
    clientFile,
    "pairs",
    `${pairSlugFromSymbol(symbol)}.json`,
  );
}

async function writePairState(filePath: string, state: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function emitBatchStep(
  updates: OracleIntentBatchSubmitParams["updates"],
  step: string,
  meta?: { txHash?: string },
): void {
  for (const update of updates) {
    update.onStep?.(step, meta);
  }
}
