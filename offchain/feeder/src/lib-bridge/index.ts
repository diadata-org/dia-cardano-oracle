// Bridge module — typed facade over the CLI's Cardano tx builders.
//
// `OracleIntentBridge` is the interface the submitter depends on.
// `createRealOracleIntentBridge` wires `buildOracleUpdateTx` from
// `offchain/cli/src/lib/` and handles the full Lucid lifecycle:
//   load state → build tx → sign → submit → await confirmation.
//
// CLI modules are loaded via dynamic `import()` so the feeder can
// typecheck without `@lucid-evolution/lucid` present; at runtime the
// optional dependency must be installed (npm optionalDependencies).
//
// Tests inject a `FakeOracleIntentBridge` instead.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { EnrichedIntent } from "../source/types.js";

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
  /** True if this tx minted the pair NFT (first update for this symbol). */
  isCreate: boolean;
  /** On-chain balance snapshot for the four operational wallets. See
   *  `PostConfirmChainState` for the per-field semantics. */
  postState?: PostConfirmChainState;
};

export type OracleBatchUpdateResult = {
  /** Cardano transaction hash shared by every entry in the batch. */
  txHash: string;
  /** Receiver NFT unit touched by the batch update. */
  receiverUnit: string;
  /** Per-entry batch outcome in the same order as the request input. */
  entries: Array<{
    intentHash: string;
    pairUnit: string;
    isCreate: boolean;
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
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type RealBridgeOptions = {
  /** Progress lines are forwarded to this sink (default: process.stderr). */
  log?: (line: string) => void;
  /**
   * Absolute path to the feeder's `offchain/cli/src` root so dynamic
   * imports resolve correctly when the feeder is installed in a different
   * working directory.
   * Defaults to `../../../cli/src` relative to this file's location,
   * which is correct for the monorepo layout.
   */
  cliSrcRoot?: string;
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
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a production `OracleIntentBridge` that delegates every
 * oracle-update submission to the CLI's `buildOracleUpdateTx` builder.
 *
 * The implementation mirrors `cli/src/transactions/update.ts`:
 *   1. Read client + protocol state artifacts.
 *   2. Normalise the intent (bigint fields) and recover the EIP-712 witness.
 *   3. Fetch current chain UTxOs.
 *   4. Build, sign, submit the Cardano tx.
 *   5. Await multi-provider confirmation (Blockfrost primary → Koios → BF REST).
 *
 * Throws on any unrecoverable error so the submitter queue can mark the
 * request as failed and continue with the next intent.
 */
export function createRealOracleIntentBridge(
  options: RealBridgeOptions = {},
): OracleIntentBridge {
  const log = options.log ?? ((line: string) => process.stderr.write(`[bridge] ${line}\n`));
  // Default depth = 1: emit `tx_confirmed` as soon as the tx is observed
  // in any block. Higher values trade latency for rollback safety; see
  // RealBridgeOptions.confirmationDepth and the README finality section.
  const confirmationDepth = options.confirmationDepth ?? 1;

  // Resolve CLI src root once — avoids re-computing on every call.
  // Resolution priority (highest to lowest):
  //   1. explicit options.cliSrcRoot (programmatic override, tests)
  //   2. env CARDANO_FEEDER_CLI_DIST_ROOT
  //      (set by Docker image to /app/cli/dist; documented in .env.example)
  //   3. fallback: ../../../cli/src relative to this module (dev mode under tsx)
  const cliSrcRoot = options.cliSrcRoot
    ? path.resolve(options.cliSrcRoot)
    : process.env.CARDANO_FEEDER_CLI_DIST_ROOT
      ? path.resolve(process.env.CARDANO_FEEDER_CLI_DIST_ROOT)
      : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../cli/src");

  function cliPath(rel: string): string {
    return `${cliSrcRoot}/${rel}`;
  }

  const bridge: OracleIntentBridge = {
    async submitOracleUpdate(params: OracleIntentSubmitParams): Promise<OracleUpdateResult> {
      const { clientStatePath, protocolStatePath, enriched, intentHash, onStep } = params;
      const { fullIntent } = enriched;

      log(`submitOracleUpdate: intentHash=${intentHash} symbol=${fullIntent.symbol}`);

      // ------------------------------------------------------------------
      // Dynamic imports — keeps the feeder's static dependency graph free
      // of @lucid-evolution/lucid at typecheck time.
      // ------------------------------------------------------------------
      const configMod = cliPath("core/config.js");
      const lucidMod = cliPath("core/lucid.js");
      const artifactMod = cliPath("core/artifact-context.js");
      const diaIntentMod = cliPath("core/dia-intent.js");
      const networkTimeMod = cliPath("core/network-time.js");
      const chainHelpersMod = cliPath("core/chain-helpers.js");
      const onChainCheckMod = cliPath("core/tx-onchain-check.js");
      const confirmMod = cliPath("core/tx-confirmation.js");
      const buildMod = cliPath("lib/transactions/build-oracle-update.js");
      const stateMod = cliPath("core/state.js");
      const walletMod = cliPath("wallet/wallet.js");
      const contractsMod = cliPath("core/contracts.js");
      const preflightMod = cliPath("preflight/index.js");
      const intentPathsMod = cliPath("core/intent-paths.js");

      const [
        { getCliConfig },
        { makeConfiguredLucidWithConfig, selectConfiguredWalletWithConfig },
        { readClientContext },
        {
          normalizeDiaOracleIntent,
          recoverDiaOracleIntentWitness,
          normalizeDiaEip712Domain,
          diaIntentTokenNameFromSymbol,
          diaPairIdHex,
          diaIntentToState,
          normalizeHex,
          assertDiaOracleIntentNotExpired,
        },
        { getNetworkNow },
        {
          findSingleUtxoAtUnit,
          waitForWalletSettlement,
          waitForUnitUtxoReplacement,
          decodePairDatum,
          decodeReceiverDatum,
          decodePaymentHookDatum,
          requireInlineDatum,
        },
        { assertTxStillOnChain },
        { awaitTxConfirmation },
        { buildOracleUpdateTx },
        { readOptionalPairState, appendTransactionRecord },
        { deriveConfiguredWalletDefaults },
        {
          mintingPolicyFromCompiledScript,
          policyIdFromMintingPolicy,
          spendingValidatorFromCompiledScript,
          scriptHashFromValidator,
          scriptAddressFromValidator,
        },
        {
          assertOracleIntentTimestampAndNonceMonotonic,
          assertOracleUpdateBootstrapRefsResolved,
          assertPaymentKeyHashIsConfigSigner,
        },
        { pairSlugFromSymbol },
      ] = await Promise.all([
        import(configMod),
        import(lucidMod),
        import(artifactMod),
        import(diaIntentMod),
        import(networkTimeMod),
        import(chainHelpersMod),
        import(onChainCheckMod),
        import(confirmMod),
        import(buildMod),
        import(stateMod),
        import(walletMod),
        import(contractsMod),
        import(preflightMod),
        import(intentPathsMod),
      ]);

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
      const cliConfig = getCliConfig();
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

      const rawState = buildState({
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
        diaIntentToState,
      });
      // Cast through a minimal typed view so property access below typechecks.
      // All fields come from the CLI's JSON artifacts; the actual shape is
      // validated at runtime by the CLI helpers themselves.
      const state = rawState as {
        scripts: Record<string, string>;
        pair: Record<string, string>;
        receiver: Record<string, string>;
        pairState: Record<string, unknown>;
        configState: Record<string, unknown>;
        compiledScripts: Record<string, unknown>;
        referenceScripts: Record<string, unknown>;
        transactions?: unknown[];
      };
      if (pairValidatorHash !== state.scripts.pairValidatorHash) {
        throw new Error("Bridge: pair validator hash does not match the current blueprint.");
      }
      if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
        throw new Error(`Bridge: intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
      }
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate,
        intentTimestamp: intent.timestamp,
        intentNonce: intent.nonce,
        pairStateTimestamp: state.pairState.timestamp,
        pairStateNonce: state.pairState.nonce,
      });

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
      // 4. Build, sign, submit.
      // ------------------------------------------------------------------
      onStep?.("building");
      log(`building oracle update tx for symbol=${fullIntent.symbol}`);
      const { txSignBuilder, nextPairState, nextPairDatumCbor } = await buildOracleUpdateTx(lucid, {
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
      });

      // Hash is deterministic from the tx body — available before signing.
      const txHash = txSignBuilder.toHash();
      onStep?.("signing", { txHash });
      const signedTx = await txSignBuilder.sign.withWallet().complete();
      onStep?.("submitting", { txHash });
      await signedTx.submit();
      onStep?.("submitted", { txHash });
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
        spentUtxos: [],
        requireChangeWhenNoSpentUtxos: true,
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
        receiverUnit: state.receiver.receiverUnit as string,
        paymentHookValidatorAddress: state.scripts.paymentHookValidatorAddress,
        paymentHookUnit: state.scripts.paymentHookUnit,
        helpers: {
          findSingleUtxoAtUnit,
          decodeReceiverDatum,
          decodePaymentHookDatum,
          requireInlineDatum,
        },
        log,
      });

      return {
        txHash,
        receiverUnit: state.receiver.receiverUnit as string,
        pairUnit,
        isCreate,
        postState,
      };
    },

    async submitOracleUpdateBatch(
      params: OracleIntentBatchSubmitParams,
    ): Promise<OracleBatchUpdateResult> {
      const { clientStatePath, protocolStatePath, updates } = params;

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
            isCreate: result.isCreate,
          }],
          postState: result.postState,
        };
      }

      log(
        `submitOracleUpdateBatch: intents=${updates.length} symbols=${updates.map((update) => update.enriched.fullIntent.symbol).join(", ")}`,
      );

      const configMod = cliPath("core/config.js");
      const lucidMod = cliPath("core/lucid.js");
      const artifactMod = cliPath("core/artifact-context.js");
      const diaIntentMod = cliPath("core/dia-intent.js");
      const networkTimeMod = cliPath("core/network-time.js");
      const chainHelpersMod = cliPath("core/chain-helpers.js");
      const onChainCheckMod = cliPath("core/tx-onchain-check.js");
      const confirmMod = cliPath("core/tx-confirmation.js");
      const buildMod = cliPath("lib/transactions/build-batch-oracle-update.js");
      const stateMod = cliPath("core/state.js");
      const walletMod = cliPath("wallet/wallet.js");
      const contractsMod = cliPath("core/contracts.js");
      const preflightMod = cliPath("preflight/index.js");
      const intentPathsMod = cliPath("core/intent-paths.js");

      const [
        { getCliConfig },
        { makeConfiguredLucidWithConfig, selectConfiguredWalletWithConfig },
        { readClientContext },
        {
          normalizeDiaOracleIntent,
          recoverDiaOracleIntentWitness,
          normalizeDiaEip712Domain,
          diaIntentTokenNameFromSymbol,
          diaPairIdHex,
          diaIntentToState,
          normalizeHex,
          assertDiaOracleIntentNotExpired,
        },
        { getNetworkNow },
        {
          findSingleUtxoAtUnit,
          waitForWalletSettlement,
          waitForUnitUtxoReplacement,
          decodePairDatum,
          decodeReceiverDatum,
          decodePaymentHookDatum,
          requireInlineDatum,
        },
        { assertTxStillOnChain },
        { awaitTxConfirmation },
        { buildBatchOracleUpdateTx },
        { readOptionalPairState, appendTransactionRecord },
        { deriveConfiguredWalletDefaults },
        {
          mintingPolicyFromCompiledScript,
          policyIdFromMintingPolicy,
          spendingValidatorFromCompiledScript,
          scriptHashFromValidator,
          scriptAddressFromValidator,
        },
        {
          assertOracleIntentTimestampAndNonceMonotonic,
          assertOracleUpdateBootstrapRefsResolved,
          assertPaymentKeyHashIsConfigSigner,
        },
        { pairSlugFromSymbol },
      ] = await Promise.all([
        import(configMod),
        import(lucidMod),
        import(artifactMod),
        import(diaIntentMod),
        import(networkTimeMod),
        import(chainHelpersMod),
        import(onChainCheckMod),
        import(confirmMod),
        import(buildMod),
        import(stateMod),
        import(walletMod),
        import(contractsMod),
        import(preflightMod),
        import(intentPathsMod),
      ]);

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
      const cliConfig = getCliConfig();
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
        state: {
          scripts: Record<string, string>;
          pair: Record<string, string>;
          receiver: Record<string, string>;
          pairState: Record<string, unknown>;
          configState: Record<string, unknown>;
          compiledScripts: Record<string, unknown>;
          referenceScripts: Record<string, unknown>;
          transactions?: unknown[];
        };
        pairStatePath: string;
        pairUnit: string;
        isCreate: boolean;
        currentPairUtxo: { txHash: string; outputIndex: number; datum?: string } | null;
        intent: Awaited<ReturnType<typeof normalizeDiaOracleIntent>>;
        witness: Awaited<ReturnType<typeof recoverDiaOracleIntentWitness>>;
      }> = [];

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

        const rawState = buildState({
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
          diaIntentToState,
        });
        const state = rawState as {
          scripts: Record<string, string>;
          pair: Record<string, string>;
          receiver: Record<string, string>;
          pairState: Record<string, unknown>;
          configState: Record<string, unknown>;
          compiledScripts: Record<string, unknown>;
          referenceScripts: Record<string, unknown>;
          transactions?: unknown[];
        };

        if (pairValidatorHash !== state.scripts.pairValidatorHash) {
          throw new Error("Bridge: pair validator hash does not match the current blueprint.");
        }
        if (normalizeHex(state.pair.pairId, "pair.pairId") !== normalizeHex(pairId, "intent.symbol")) {
          throw new Error(`Bridge: intent symbol ${intent.symbol} does not match pair id ${state.pair.pairId}.`);
        }
        assertOracleIntentTimestampAndNonceMonotonic({
          isCreate,
          intentTimestamp: intent.timestamp,
          intentNonce: intent.nonce,
          pairStateTimestamp: state.pairState.timestamp,
          pairStateNonce: state.pairState.nonce,
        });

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
      const currentPairUtxoByUnit = new Map(
        preparedEntries
          .filter((entry) => !entry.isCreate && entry.currentPairUtxo)
          .map((entry) => [entry.pairUnit, entry.currentPairUtxo]),
      );

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
        spentUtxos: [],
        requireChangeWhenNoSpentUtxos: true,
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
        receiverUnit: firstEntry.state.receiver.receiverUnit as string,
        paymentHookValidatorAddress: firstEntry.state.scripts.paymentHookValidatorAddress,
        paymentHookUnit: firstEntry.state.scripts.paymentHookUnit,
        helpers: {
          findSingleUtxoAtUnit,
          decodeReceiverDatum,
          decodePaymentHookDatum,
          requireInlineDatum,
        },
        log,
      });

      return {
        txHash,
        receiverUnit: firstEntry.state.receiver.receiverUnit as string,
        entries: preparedEntries.map((entry) => ({
          intentHash: entry.update.intentHash,
          pairUnit: entry.pairUnit,
          isCreate: entry.isCreate,
        })),
        postState,
      };
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
  lucid: unknown;
  wallet: { getUtxos(): Promise<Array<{ assets: Record<string, bigint> }>> };
  receiverValidatorAddress: string;
  receiverUnit: string;
  paymentHookValidatorAddress: string;
  paymentHookUnit: string;
  helpers: {
    findSingleUtxoAtUnit: (
      lucid: unknown,
      address: string,
      unit: string,
      label: string,
    ) => Promise<{ datum?: string | null }>;
    decodeReceiverDatum: (raw: string) => {
      balanceLovelace: string;
      accruedToHookLovelace: string;
    };
    decodePaymentHookDatum: (
      raw: string,
      withdrawAddress?: string,
    ) => { accruedFeesLovelace: string };
    requireInlineDatum: (utxo: { datum?: string | null }, label: string) => string;
  };
  log: (line: string) => void;
}): Promise<{
  receiverBalanceLovelace?: bigint;
  receiverAccruedLovelace?: bigint;
  paymentHookAccruedLovelace?: bigint;
  adminWalletLovelace?: bigint;
}> {
  const result: {
    receiverBalanceLovelace?: bigint;
    receiverAccruedLovelace?: bigint;
    paymentHookAccruedLovelace?: bigint;
    adminWalletLovelace?: bigint;
  } = {};

  // 1. Receiver datum — exposes balanceLovelace + accruedToHookLovelace.
  try {
    const receiverUtxo = await args.helpers.findSingleUtxoAtUnit(
      args.lucid,
      args.receiverValidatorAddress,
      args.receiverUnit,
      "receiver",
    );
    const state = args.helpers.decodeReceiverDatum(
      args.helpers.requireInlineDatum(receiverUtxo, "receiver"),
    );
    result.receiverBalanceLovelace = BigInt(state.balanceLovelace);
    result.receiverAccruedLovelace = BigInt(state.accruedToHookLovelace);
  } catch (error) {
    args.log(`post-confirm: receiver query failed: ${(error as Error).message}`);
  }

  // 2. PaymentHook datum — exposes accruedFeesLovelace.
  try {
    const hookUtxo = await args.helpers.findSingleUtxoAtUnit(
      args.lucid,
      args.paymentHookValidatorAddress,
      args.paymentHookUnit,
      "payment hook",
    );
    const state = args.helpers.decodePaymentHookDatum(
      args.helpers.requireInlineDatum(hookUtxo, "payment hook"),
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
 * Assemble the combined state object expected by `buildOracleUpdateTx`,
 * merging client + protocol artifacts the same way `update.ts` does.
 */
function buildState(args: {
  client: Record<string, unknown>;
  protocol: Record<string, unknown>;
  existingPair: Record<string, unknown> | null;
  intent: Record<string, unknown>;
  walletAddress: string;
  pairTokenName: string;
  pairId: string;
  pairUnit: string;
  pairValidatorAddress: string;
  minUtxoLovelace: string | number | bigint;
  diaIntentToState: (intent: Record<string, unknown>) => unknown;
}): Record<string, unknown> {
  const { client, protocol, existingPair } = args;
  const defaultPairState = {
    pairId: args.pairId,
    price: "0",
    timestamp: "0",
    nonce: "0",
    intentHash: "00".repeat(32),
    signer: "00".repeat(20),
    minUtxoLovelace: args.minUtxoLovelace,
    intent: args.diaIntentToState(args.intent),
  };

  const pair = existingPair ?? {
    wallet: { source: "seed", address: args.walletAddress },
    pair: {
      tokenName: args.pairTokenName,
      pairId: args.pairId,
      pairUnit: args.pairUnit,
      pairValidatorAddress: args.pairValidatorAddress,
    },
    pairState: defaultPairState,
    datum: { pairCbor: "" },
  };

  return {
    ...(pair as object),
    scripts: {
      ...(protocol as Record<string, unknown>),
      ...(client as Record<string, unknown>),
      ...((protocol as Record<string, Record<string, unknown>>).scripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).scripts ?? {}),
    },
    configState: (protocol as Record<string, Record<string, unknown>>).configState,
    compiledScripts: {
      ...((protocol as Record<string, Record<string, unknown>>).compiledScripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).compiledScripts ?? {}),
    },
    referenceScripts: {
      ...((protocol as Record<string, Record<string, unknown>>).referenceScripts ?? {}),
      ...((client as Record<string, Record<string, unknown>>).referenceScripts ?? {}),
    },
    receiver: (client as Record<string, unknown>).receiver,
    transactions: (pair as Record<string, unknown>).transactions,
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
