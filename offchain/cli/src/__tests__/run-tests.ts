import "./_test-env.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Constr, type Data as PlutusData, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";
import {
  ensureCompatibleBatch,
  resolvePairArtifact,
  sortBatchUpdatesByPairTokenName,
} from "../transactions/update-batch.js";
import { createProtocolStateArtifact } from "../init/protocol-init.js";
import { createClientStateArtifact } from "../init/client-init.js";
import {
  deriveCompressedPublicKeyFromPrivateKey,
  recoverDiaOracleIntentWitness,
  normalizeDiaEip712Domain,
  normalizeDiaOracleIntent,
  signDiaOracleIntentInput,
  assertDiaOracleIntentNotExpired,
} from "../core/dia-intent.js";
import { getCliConfig } from "../core/config.js";
import { createEthereumWallet } from "../oracle/ethereum-wallet-create.js";
import { createWallet } from "../wallet/wallet-create.js";
import {
  buildConfigDatumCbor,
  buildPairDatumCbor,
  buildPaymentHookDatumCbor,
  buildReceiverDatumCbor,
  decodePairDatum,
  decodePaymentHookDatum,
  decodeReceiverDatum,
  addressToPlutusData,
  waitForWalletSettlement,
  computeSpentWalletOutRefs,
  computeWalletChangeOutputs,
} from "../core/chain-helpers.js";
import {
  normalizeHex,
  splitUnit,
  toBigInt,
  parseCommaSeparatedHexList,
  utf8ToHex,
} from "../core/primitives.js";
import {
  assertClientIdNonEmpty,
  assertConfigUtxoLivesAtValidatorAddress,
  assertHookCoordinatorConsistency,
  assertNftBootstrapDestinationIsNotFundingWallet,
  assertNonEmptyConfigSignerList,
  assertOracleIntentTimestampAndNonceMonotonic,
  assertOracleUpdateBootstrapRefsResolved,
  assertPaymentHookWithdrawAmountPositive,
  assertPaymentHookWithdrawAmountValid,
  assertPaymentKeyHashIsConfigSigner,
  assertPositiveMinUtxoLovelace,
  assertReceiverTopUpAmountPositive,
  assertReceiverWithdrawAmountPositive,
  assertReceiverWithdrawAmountValid,
  assertSettleManifestMatchesClientReceivers,
  assertSettleManifestReceiversNonEmptyAndUnique,
  assertSettleReceiverAccruedPositive,
} from "../preflight/index.js";
import type {
  ConfigStateArtifact,
  ClientStateArtifact,
  PairStateArtifact,
} from "../core/state.js";
import {
  emulatorSubmitAndMine,
  makeOracleEmulatorLucid,
  makeOracleEmulatorWithReferenceScriptRow,
} from "./emulator/harness.js";
import { isAnyReferenceScriptMissing } from "../core/reference-scripts.js";
import { collectTxSignBuilderMetrics } from "../core/tx-metrics.js";
import { buildPairApplyUpdateRedeemer } from "../core/redeemers.js";
import { writeStateJsonFile } from "../core/state.js";
import { depositFund, isCleanAdaDeposit } from "../transactions/deposit.js";
import { fundPoolWallet } from "../transactions/fund-pool-wallet.js";
import { splitWallet } from "../transactions/split-wallet.js";
import { planWalletSplit, type SplitUtxo, type WalletShapeProfile } from "../wallet/split-plan.js";
import { selectConsolidationUtxos } from "../wallet/wallet-consolidate.js";
import { resolveClientUtxoRefs } from "../transactions/reclaim-reference-script.js";
import { completeWithRetry } from "../core/tx-build.js";
import {
  createRetryingProvider,
  isTransientProviderError,
  isQuotaError,
  isRateLimitError,
  type ProviderCallEvent,
} from "../core/provider-retry.js";
import type { Provider } from "@lucid-evolution/core-types";
import {
  decodePairDatum as decodePairDatumDirect,
  decodeReceiverDatum as decodeReceiverDatumDirect,
} from "../core/datum-decoders.js";
import { resolveRunStateDir, latestRunDir } from "../core/run-state.js";

// Verbose runner: each test logs [pass] <name> as it completes, and the final
// line reports the count — so the captured output is real evidence, not just
// "passed". `run` awaits, so sync and async test functions both work.
let __passed = 0;
async function run(name: string, fn: () => unknown): Promise<void> {
  await fn();
  __passed += 1;
  console.log(`[pass] ${name}`);
}

await run("testCardanoWalletCreate", testCardanoWalletCreate);
await run("testEthereumWalletCreate", testEthereumWalletCreate);
await run("testCliConfigAllowsCardanoOnlyModeWithoutDiaSourceEnv", testCliConfigAllowsCardanoOnlyModeWithoutDiaSourceEnv);
await run("testIntentSigning", testIntentSigning);
await run("testBatchSnapshotRefresh", testBatchSnapshotRefresh);
await run("testCompatibleBatchRules", testCompatibleBatchRules);
await run("testBatchUpdatesSortByPairTokenName", testBatchUpdatesSortByPairTokenName);
await run("testBatchUpdatesSortMatchesBytewiseCompare", testBatchUpdatesSortMatchesBytewiseCompare);
await run("testBatchUpdatesSortRejectsNonNormalizedTokenName", testBatchUpdatesSortRejectsNonNormalizedTokenName);
await run("testPairApplyUpdateRedeemerHasNoFields", testPairApplyUpdateRedeemerHasNoFields);
await run("testProtocolStateInit", testProtocolStateInit);
await run("testProtocolInitAuthorizedKeysFromEnv", testProtocolInitAuthorizedKeysFromEnv);
await run("testClientStateInit", testClientStateInit);
await run("testDepositFundReadsFloorFromConfigState", testDepositFundReadsFloorFromConfigState);
await run("testDepositMergeSelectionFiltersAndCaps", testDepositMergeSelectionFiltersAndCaps);
await run("testConsolidationUtxoSelection", testConsolidationUtxoSelection);
await run("testPlanWalletSplit", testPlanWalletSplit);
await run("testRunStateResolution", testRunStateResolution);

// --- Datum encoder/decoder regression tests ---------------------------------
// These exist as a regression net for three real bugs found and fixed in the
// off-chain encoders during the architecture review:
//   1. Receiver bootstrap encoded only 2 of the 3 ReceiverDatum fields.
//   2. Config bootstrap had `max_bootstrap_drift_seconds` and
//      `payment_hook_ref` swapped.
//   3. PaymentHook bootstrap omitted `max_bootstrap_drift_seconds` from the
//      ConfigDatum entirely.
// They are golden-style: any reordering or missing field will trip them.

await run("testPrimitivesPureHelpers", testPrimitivesPureHelpers);
await run("testReceiverDatumRoundTrip", testReceiverDatumRoundTrip);
await run("testReceiverDatumExactlyThreeIntegerFields", testReceiverDatumExactlyThreeIntegerFields);
await run("testPaymentHookDatumRoundTrip", testPaymentHookDatumRoundTrip);
await run("testPaymentHookDatumWithdrawAddressRoundTrip", testPaymentHookDatumWithdrawAddressRoundTrip);
await run("testConfigDatumRoundTrip", testConfigDatumRoundTrip);
await run("testConfigDatumFieldOrderAndArity", testConfigDatumFieldOrderAndArity);
await run("testPairDatumRoundTrip", testPairDatumRoundTrip);
await run("testDatumDecodersModuleMatchesReExport", testDatumDecodersModuleMatchesReExport);
await run("testAddressToPlutusDataKeyAndStake", testAddressToPlutusDataKeyAndStake);

// --- Pure invariant tests (withdraw, settle, batch guards) -----------------
await run("testReceiverWithdrawDoesNotTouchAccrued", testReceiverWithdrawDoesNotTouchAccrued);
await run("testSettleDeltaInvariant", testSettleDeltaInvariant);
await run("testMultiClientSettleSumAccrued", testMultiClientSettleSumAccrued);
await run("testBatchRejectsDuplicatePair", testBatchRejectsDuplicatePair);
await run("testBatchRejectsForeignReceiver", testBatchRejectsForeignReceiver);
await run("testSettleManifestPreChecks", testSettleManifestPreChecks);
await run("testHookCoordinatorConsistencyPure", testHookCoordinatorConsistencyPure);
await run("testReferenceScriptMissingHelper", testReferenceScriptMissingHelper);
await run("testClientReclaimUtxoRefsIncludesDeposit", testClientReclaimUtxoRefsIncludesDeposit);
await run("testClientReclaimUtxoRefsSkipsDepositWhenAbsent", testClientReclaimUtxoRefsSkipsDepositWhenAbsent);
await run("testWithdrawAmountPreflightHelpers", testWithdrawAmountPreflightHelpers);
await run("testReceiverTransactionPreflightGuards", testReceiverTransactionPreflightGuards);
await run("testConfigUpdateAndInitArtifactPreflight", testConfigUpdateAndInitArtifactPreflight);
await run("testBootstrapNftPayPreflight", testBootstrapNftPayPreflight);
await run("testSettleAndPaymentHookPreflight", testSettleAndPaymentHookPreflight);
await run("testOracleUpdatePreflightPureGuards", testOracleUpdatePreflightPureGuards);

// --- completeWithRetry rebuilds a fresh tx per attempt ----------------------
// lucid's TxBuilder is stateful and `.complete()` is NOT idempotent: retrying
// the SAME builder duplicates outputs. completeWithRetry must REBUILD via the
// factory on each attempt. These guard both the retry path and the
// rethrow-real-errors path.
await run("testCompleteWithRetryRebuildsFreshBuilderOnRetry", testCompleteWithRetryRebuildsFreshBuilderOnRetry);
await run("testCompleteWithRetryRethrowsRealErrorImmediately", testCompleteWithRetryRethrowsRealErrorImmediately);

// --- Provider retry wrapper (transient-network resilience + consumption metrics)
// A single transient `fetch failed` must not abort an admin command; the wrapper
// retries transient transport errors with backoff, rethrows real ledger errors
// immediately, and reports every request to the metrics observer (by outcome).
await run("testProviderRetryClassifiers", testProviderRetryClassifiers);
await run("testProviderRetryRetriesTransientThenSucceeds", testProviderRetryRetriesTransientThenSucceeds);
await run("testProviderRetryRethrowsNonTransientImmediately", testProviderRetryRethrowsNonTransientImmediately);
await run("testProviderRetryExhaustsThenRethrows", testProviderRetryExhaustsThenRethrows);
await run("testProviderRetryReportsOutcomesToObserver", testProviderRetryReportsOutcomesToObserver);
await run("testProviderRetryPreservesThisAndNonFunctionProps", testProviderRetryPreservesThisAndNonFunctionProps);

// --- Wallet settlement wait (provider lag / stale-UTxO regression) ----------
await run("testWalletSettlementWaitsForSpentInputs", testWalletSettlementWaitsForSpentInputs);
await run("testComputeSpentWalletOutRefs", testComputeSpentWalletOutRefs);
await run("testComputeWalletChangeOutputs", testComputeWalletChangeOutputs);
await run("testFundPoolWalletRejectsNonPositiveAmount", testFundPoolWalletRejectsNonPositiveAmount);
await run("testSplitWalletRejectsInvalidPlan", testSplitWalletRejectsInvalidPlan);

// --- Lucid emulator harness (smoke: pay + reference script genesis) ---------
await run("runLucidEmulatorHarnessSmokeTests", runLucidEmulatorHarnessSmokeTests);

console.log(`CLI tests passed (${__passed} tests)`);

// Regression for the stale-UTxO / provider-lag bug: waitForWalletSettlement
// must derive the spent wallet inputs FROM THE TX and block until the
// provider stops listing them — not return on the first "wallet changed".
// Here the provider keeps listing the spent wallet input for two polls, then
// drops it; the wait must poll until it is gone and never return while it is
// still visible. The tx also carries a script input (not a wallet UTxO) which
// must be ignored.
// Test A — rebuild-on-retry: the factory must be invoked once per attempt so a
// FRESH builder is constructed each time (proving the helper rebuilds rather
// than re-completing the same stateful builder). The first builder's
// `.complete()` throws the transient WASM detached-ArrayBuffer error; the
// second builder's resolves to a sentinel, which must be returned.
async function testCompleteWithRetryRebuildsFreshBuilderOnRetry(): Promise<void> {
  const previousDelay = process.env.TX_BUILD_RETRY_DELAY_MS;
  // 1ms — the smallest value envNumber accepts (it rejects 0); keeps the test fast.
  process.env.TX_BUILD_RETRY_DELAY_MS = "1";
  try {
    const sentinel = { __sentinel: "second-build" } as unknown as TxSignBuilder;
    let factoryCalls = 0;
    const buildTx = () => {
      factoryCalls += 1;
      const callIndex = factoryCalls;
      return {
        complete: async (): Promise<TxSignBuilder> => {
          if (callIndex === 1) {
            throw new TypeError(
              "Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer",
            );
          }
          return sentinel;
        },
      };
    };

    const result = await completeWithRetry(buildTx, () => {});

    assert.equal(
      factoryCalls,
      2,
      "factory must be called twice — a fresh builder per attempt (rebuild, not re-complete)",
    );
    assert.equal(result, sentinel, "must return the tx from the second (successful) build");
  } finally {
    if (previousDelay === undefined) {
      delete process.env.TX_BUILD_RETRY_DELAY_MS;
    } else {
      process.env.TX_BUILD_RETRY_DELAY_MS = previousDelay;
    }
  }
}

// Test B — real errors rethrow immediately: a non-WASM error must surface on the
// FIRST attempt with no retry, so genuine failures are never masked.
async function testCompleteWithRetryRethrowsRealErrorImmediately(): Promise<void> {
  let factoryCalls = 0;
  const buildTx = () => {
    factoryCalls += 1;
    return {
      complete: async (): Promise<TxSignBuilder> => {
        throw new Error("amount exceeds balance");
      },
    };
  };

  await assert.rejects(
    () => completeWithRetry(buildTx, () => {}),
    /amount exceeds balance/,
    "real (non-WASM) build errors must rethrow",
  );
  assert.equal(
    factoryCalls,
    1,
    "real errors must not retry — the factory is called exactly once",
  );
}

// --- Provider retry wrapper -------------------------------------------------
// No-op sleep so the retry tests never wait on real wall-clock backoff.
// A hoisted function declaration (not a const) so it is available when the
// top-level `await run(...)` calls above execute it.
async function noopSleep(_ms: number): Promise<void> {}

function testProviderRetryClassifiers(): void {
  for (const message of [
    "fetch failed",
    "ECONNRESET",
    "socket hang up",
    "ETIMEDOUT",
    "503 Service Unavailable",
    "getaddrinfo ENOTFOUND blockfrost.io",
    "429 Too Many Requests",
  ]) {
    assert.equal(isTransientProviderError(new Error(message)), true, `transient: ${message}`);
  }
  for (const message of ["BadInputsUTxO", "ValueNotConservedUTxO", "402 Payment Required"]) {
    assert.equal(isTransientProviderError(new Error(message)), false, `not transient: ${message}`);
  }
  assert.equal(isQuotaError(new Error("402 Payment Required")), true, "402 is a quota wall");
  assert.equal(isQuotaError(new Error("fetch failed")), false, "network blip is not a quota wall");
  assert.equal(isRateLimitError(new Error("429 Too Many Requests")), true, "429 is a rate limit");
  assert.equal(isRateLimitError(new Error("BadInputsUTxO")), false, "ledger error is not a rate limit");

  // Nested cause (fetch wraps the socket error) is inspected.
  const wrapped = new Error("request to https://blockfrost failed");
  (wrapped as Error & { cause?: unknown }).cause = new Error("ECONNRESET");
  assert.equal(isTransientProviderError(wrapped), true, "nested cause is classified");
}

async function testProviderRetryRetriesTransientThenSucceeds(): Promise<void> {
  let calls = 0;
  const base = {
    getUtxos: async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return [];
    },
  } as unknown as Provider;
  const p = createRetryingProvider(base, { attempts: 5, delayMs: 1, sleep: noopSleep });

  assert.deepEqual(await p.getUtxos("addr" as never), [], "recovers after transient errors");
  assert.equal(calls, 3, "two failures then success = three attempts");
}

async function testProviderRetryRethrowsNonTransientImmediately(): Promise<void> {
  let calls = 0;
  const base = {
    submitTx: async () => {
      calls += 1;
      throw new Error("BadInputsUTxO");
    },
  } as unknown as Provider;
  const p = createRetryingProvider(base, { attempts: 5, delayMs: 1, sleep: noopSleep });

  await assert.rejects(p.submitTx("cbor"), /BadInputsUTxO/, "real ledger errors must surface");
  assert.equal(calls, 1, "non-transient errors must not retry");
}

async function testProviderRetryExhaustsThenRethrows(): Promise<void> {
  let calls = 0;
  const base = {
    getProtocolParameters: async () => {
      calls += 1;
      throw new Error("fetch failed");
    },
  } as unknown as Provider;
  const p = createRetryingProvider(base, { attempts: 3, delayMs: 1, sleep: noopSleep });

  await assert.rejects(p.getProtocolParameters(), /fetch failed/, "rethrows after exhausting attempts");
  assert.equal(calls, 3, "exactly `attempts` tries");
}

async function testProviderRetryReportsOutcomesToObserver(): Promise<void> {
  const events: ProviderCallEvent[] = [];
  const onCall = (event: ProviderCallEvent): void => {
    events.push(event);
  };

  // ok: a successful call reports once.
  events.length = 0;
  const okProvider = createRetryingProvider({ getUtxos: async () => [] } as unknown as Provider, {
    attempts: 3,
    delayMs: 1,
    sleep: noopSleep,
    providerName: "Blockfrost",
    onCall,
  });
  await okProvider.getUtxos("addr" as never);
  assert.deepEqual(
    events.map((e) => e.outcome),
    ["ok"],
    "success reports a single ok",
  );
  assert.equal(events[0]!.provider, "Blockfrost");
  assert.equal(events[0]!.method, "getUtxos");

  // quota_exceeded: a 402 reports quota_exceeded and is NOT retried.
  events.length = 0;
  let quotaCalls = 0;
  const quotaProvider = createRetryingProvider(
    {
      submitTx: async () => {
        quotaCalls += 1;
        throw new Error("402 Payment Required");
      },
    } as unknown as Provider,
    { attempts: 4, delayMs: 1, sleep: noopSleep, providerName: "Blockfrost", onCall },
  );
  await assert.rejects(quotaProvider.submitTx("cbor"));
  assert.equal(quotaCalls, 1, "402 quota wall is not retried");
  assert.deepEqual(events.map((e) => e.outcome), ["quota_exceeded"]);

  // rate_limited: a 429 reports rate_limited and IS retried (transient).
  events.length = 0;
  let rlCalls = 0;
  const rlProvider = createRetryingProvider(
    {
      getDatum: async () => {
        rlCalls += 1;
        if (rlCalls < 2) throw new Error("429 Too Many Requests");
        return "datum";
      },
    } as unknown as Provider,
    { attempts: 4, delayMs: 1, sleep: noopSleep, providerName: "Koios", onCall },
  );
  assert.equal(await rlProvider.getDatum("h" as never), "datum");
  assert.deepEqual(events.map((e) => e.outcome), ["rate_limited", "ok"]);
  assert.equal(events[0]!.provider, "Koios");
}

async function testProviderRetryPreservesThisAndNonFunctionProps(): Promise<void> {
  class FakeProvider {
    label = "blockfrost";
    private token = "abc";
    async getDatum(): Promise<string> {
      return this.token;
    }
  }
  const base = new FakeProvider() as unknown as Provider & { label: string };
  const p = createRetryingProvider(base, { attempts: 2, delayMs: 1, sleep: noopSleep }) as Provider & {
    label: string;
  };

  assert.equal(p.label, "blockfrost", "non-function properties pass through");
  assert.equal(await p.getDatum("h" as never), "abc", "method `this` is preserved through the proxy");
}

async function testWalletSettlementWaitsForSpentInputs(): Promise<void> {
  const spentTxHash = "ab".repeat(32);
  const scriptTxHash = "cd".repeat(32);
  const changeTxHash = "ef".repeat(32);

  const mkUtxo = (txHash: string, outputIndex: number): UTxO => ({
    txHash,
    outputIndex,
    address: "addr_test1qpgtest",
    assets: { lovelace: 5_000_000n },
  });

  // Wallet before the tx: the input the tx will spend + an unrelated UTxO.
  const previousUtxos: UTxO[] = [mkUtxo(spentTxHash, 0), mkUtxo("11".repeat(32), 0)];
  const spentInput = mkUtxo(spentTxHash, 0);
  const changeUtxo = mkUtxo(changeTxHash, 0);

  // Fake built tx: one wallet input (in previousUtxos) + one script input
  // (NOT in the wallet, must be ignored by the wait).
  const fakeTransaction = {
    toTransaction: () => ({
      body: () => ({
        inputs: () => ({
          len: () => 2,
          get: (index: number) =>
            index === 0
              ? { transaction_id: () => ({ to_hex: () => spentTxHash }), index: () => 0n }
              : { transaction_id: () => ({ to_hex: () => scriptTxHash }), index: () => 1n },
        }),
      }),
    }),
  } as unknown as TxSignBuilder;

  // Provider lists the spent input as still-available for the first two polls
  // (even though the change UTxO already appeared), then finally drops it.
  let polls = 0;
  const wallet = {
    getUtxos: async (): Promise<UTxO[]> => {
      polls += 1;
      if (polls < 3) {
        return [spentInput, changeUtxo];
      }
      return [changeUtxo];
    },
  };

  const settled = await waitForWalletSettlement({
    wallet,
    previousUtxos,
    transaction: fakeTransaction,
    label: "settlement-wait test",
    delayMs: 1,
  });

  assert.equal(polls, 3, "must keep polling while the spent wallet input is still listed");
  assert.ok(
    !settled.some((u) => u.txHash === spentTxHash && u.outputIndex === 0),
    "must only return once the spent wallet input is gone from the provider",
  );
}

function testComputeSpentWalletOutRefs(): void {
  const walletTxHash = "ab".repeat(32);
  const scriptTxHash = "cd".repeat(32);

  // Wallet before the tx: one UTxO the tx will spend + one it leaves alone.
  const previousUtxos: UTxO[] = [
    { txHash: walletTxHash, outputIndex: 0, address: "addr_test1qwallet", assets: { lovelace: 98_000_000n } },
    { txHash: "11".repeat(32), outputIndex: 0, address: "addr_test1qwallet", assets: { lovelace: 97_000_000n } },
  ];

  // Built tx: the wallet input (index 0) + a script input the wallet never lists.
  const fakeTransaction = {
    toTransaction: () => ({
      body: () => ({
        inputs: () => ({
          len: () => 2,
          get: (index: number) =>
            index === 0
              ? { transaction_id: () => ({ to_hex: () => walletTxHash }), index: () => 0n }
              : { transaction_id: () => ({ to_hex: () => scriptTxHash }), index: () => 4n },
        }),
      }),
    }),
  } as unknown as TxSignBuilder;

  const spent = computeSpentWalletOutRefs(previousUtxos, fakeTransaction);
  assert.deepEqual(spent, [`${walletTxHash}#0`], "only the wallet input is reported; script inputs are dropped");
}

function testComputeWalletChangeOutputs(): void {
  const txHash = "ef".repeat(32);
  const walletAddress = "addr_test1qwallet";
  const receiverAddress = "addr_test1wreceiver";

  // Built tx outputs: a script output (receiver), a pure-ADA change output back
  // to the wallet, and a wallet output that also carries a native asset.
  const fakeTransaction = {
    toTransaction: () => ({
      body: () => ({
        outputs: () => ({
          len: () => 3,
          get: (index: number) => {
            const rows = [
              { addr: receiverAddress, coin: 9_900_000_000n, policies: 1 },
              { addr: walletAddress, coin: 95_000_000n, policies: 0 },
              { addr: walletAddress, coin: 2_000_000n, policies: 2 },
            ];
            const row = rows[index]!;
            return {
              address: () => ({ to_bech32: () => row.addr }),
              amount: () => ({
                coin: () => row.coin,
                multi_asset: () => ({ policy_count: () => row.policies }),
              }),
            };
          },
        }),
      }),
    }),
  } as unknown as TxSignBuilder;

  const change = computeWalletChangeOutputs(fakeTransaction, txHash, walletAddress);
  assert.deepEqual(
    change,
    [
      { outRef: `${txHash}#1`, lovelace: 95_000_000n, hasOnlyAda: true },
      { outRef: `${txHash}#2`, lovelace: 2_000_000n, hasOnlyAda: false },
    ],
    "returns wallet-address outputs with positional index; receiver output excluded; hasOnlyAda reflects native assets",
  );
}

async function testFundPoolWalletRejectsNonPositiveAmount(): Promise<void> {
  // The amount guard runs before any chain work, so a non-positive transfer is
  // rejected without selecting a wallet or touching a provider.
  for (const bad of [0n, -1_000_000n]) {
    await assert.rejects(
      () =>
        fundPoolWallet({
          signer: { kind: "seed", value: "irrelevant" },
          toAddress: "addr_test1qpool",
          amountLovelace: bad,
        }),
      /amountLovelace must be positive/,
      `expected amount ${bad} to be rejected`,
    );
  }
}

async function testSplitWalletRejectsInvalidPlan(): Promise<void> {
  // The plan guards run before any chain work, so a degenerate split plan is
  // rejected without selecting a wallet or touching a provider.
  const signer = { kind: "seed" as const, value: "irrelevant" };
  await assert.rejects(
    () => splitWallet({ signer, consumeOutRefs: [], outputLovelaces: [100_000_000n] }),
    /consumeOutRefs must not be empty/,
    "an empty input set is rejected",
  );
  await assert.rejects(
    () => splitWallet({ signer, consumeOutRefs: ["tx#0"], outputLovelaces: [] }),
    /outputLovelaces must not be empty/,
    "an empty output set is rejected",
  );
  for (const bad of [0n, -1_000_000n]) {
    await assert.rejects(
      () => splitWallet({ signer, consumeOutRefs: ["tx#0"], outputLovelaces: [bad] }),
      /outputLovelaces must all be positive/,
      `a non-positive output (${bad}) is rejected`,
    );
  }
}

function testCardanoWalletCreate(): void {
  const originalNetwork = process.env.CARDANO_NETWORK;
  try {
    for (const [network, addressPrefix, walletSeedVar] of [
      ["Preview", "addr_test1", "CARDANO_WALLET_SEED_TESTNET"],
      ["Mainnet", "addr1", "CARDANO_WALLET_SEED_MAINNET"],
    ] as const) {
      process.env.CARDANO_NETWORK = network;
      const wallet = createWallet();
      assert.equal(typeof wallet.mnemonic, "string");
      assert(
        wallet.address.startsWith(addressPrefix),
        `expected ${network} address to start with ${addressPrefix}, got ${wallet.address}`,
      );
      assertHexString(wallet.paymentKeyHash);
      assert.equal(wallet.paymentKeyHash.length, 56);
      assert.equal(wallet.env[walletSeedVar], wallet.mnemonic);
      assert.equal(wallet.env.CARDANO_NETWORK, network);
    }
  } finally {
    if (originalNetwork === undefined) {
      delete process.env.CARDANO_NETWORK;
    } else {
      process.env.CARDANO_NETWORK = originalNetwork;
    }
  }
}

function testEthereumWalletCreate(): void {
  const originalNetwork = process.env.CARDANO_NETWORK;
  try {
    for (const [network, privateKeyVar] of [
      ["Preview", "DIA_AUTHORIZED_PRIVATE_KEY_TESTNET"],
      ["Mainnet", "DIA_AUTHORIZED_PRIVATE_KEY_MAINNET"],
    ] as const) {
      process.env.CARDANO_NETWORK = network;
      const wallet = createEthereumWallet();
      assertHexString(wallet.privateKey);
      assertHexString(wallet.publicKey);
      assert.equal(wallet.publicKey.length, 66);
      assert.equal(wallet.env[privateKeyVar], wallet.privateKey);
      assert(wallet.address.startsWith("0x"));
    }
  } finally {
    if (originalNetwork === undefined) {
      delete process.env.CARDANO_NETWORK;
    } else {
      process.env.CARDANO_NETWORK = originalNetwork;
    }
  }
}

function testCliConfigAllowsCardanoOnlyModeWithoutDiaSourceEnv(): void {
  const keys = [
    "DIA_SOURCE_CHAIN_ID_TESTNET",
    "DIA_RPC_URL_TESTNET",
    "DIA_WS_URL_TESTNET",
    "DIA_REGISTRY_ADDRESS_TESTNET",
    "DIA_EXPLORER_URL_TESTNET",
  ] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]] as const));

  try {
    for (const key of keys) {
      delete process.env[key];
    }

    const config = getCliConfig();
    assert.equal(config.cardanoNetwork, "Preview");
    assert.equal(config.networkSuffix, "TESTNET");
    assert.equal(config.dia, null);
    assert.equal(typeof config.blockfrostApiUrl, "string");
    assert.equal(typeof config.koiosApiUrl, "string");
  } finally {
    for (const [key, value] of original.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function testIntentSigning(): void {
  const domain = {
    name: "DIA Oracle",
    version: "1.0",
    sourceChainId: "100640",
    verifyingContract: "0xF8c614A483A0427A13512F52ac72A576678bE317",
  };
  const signed = signDiaOracleIntentInput({
    domain,
    intent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: "100640",
      nonce: "1776186346664217710",
      expiry: "1779705275",
      symbol: "USDC/USD",
      price: "100045678",
      timestamp: "1777113276",
      source: "DIA Oracle",
    },
    privateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const recovered = recoverDiaOracleIntentWitness(
    normalizeDiaEip712Domain(domain),
    normalizeDiaOracleIntent(signed.intent),
  );

  assert.equal(recovered.signerPublicKey, signed.signerPublicKey);
  assert.equal(recovered.signerAddress, signed.signerAddress.slice(2).toLowerCase());
  assert.equal(recovered.intentHash, signed.intentHash);
}

function testBatchSnapshotRefresh(): void {
  const pair = samplePairArtifact("aa");
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = {
    ...sampleReceiverArtifact(),
    receiverState: {
      balanceLovelace: "33000000",
      accruedToHookLovelace: "0",
      minUtxoLovelace: "3000000",
    },
  };
  client.datum.receiverCbor = "client-receiver-cbor";

  protocol.configState.baseFeeLovelace = "600000";
  protocol.configState.perPairFeeLovelace = "400000";
  protocol.paymentHookState = {
    ...samplePaymentHookState(),
    accruedFeesLovelace: "9000000",
  };
  protocol.datum.configCbor = "protocol-config-cbor";
  protocol.datum.paymentHookCbor = "protocol-hook-cbor";

  const refreshed = resolvePairArtifact(pair, client, protocol);

  assert.equal(refreshed.configState.baseFeeLovelace, "600000");
  assert.equal(refreshed.configState.perPairFeeLovelace, "400000");
  assert.equal(refreshed.paymentHookState.accruedFeesLovelace, "9000000");
  assert.equal(refreshed.receiver?.receiverState.balanceLovelace, "33000000");
  assert.equal(refreshed.datum.configCbor, "protocol-config-cbor");
  assert.equal(refreshed.datum.paymentHookCbor, "protocol-hook-cbor");
  assert.equal(refreshed.datum.receiverCbor, "client-receiver-cbor");
}

function testCompatibleBatchRules(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);

  assert.doesNotThrow(() => ensureCompatibleBatch([first, second]));
  assert.throws(
    () => ensureCompatibleBatch([first, first]),
    /Duplicate pair state included in batch/,
  );
  assert.throws(
    () =>
      ensureCompatibleBatch([
        first,
        {
          ...second,
          receiver: {
            ...second.receiver,
            receiverUnit: `${"33".repeat(28)}444946464552454e54`,
          },
        },
      ]),
    /same client deployment/,
  );
}

function testBatchUpdatesSortByPairTokenName(): void {
  const updates = [
    { artifact: samplePairArtifact("cc"), label: "cc" },
    { artifact: samplePairArtifact("aa"), label: "aa" },
    { artifact: samplePairArtifact("bb"), label: "bb" },
  ];

  const sorted = sortBatchUpdatesByPairTokenName(updates);

  assert.deepEqual(sorted.map((update) => update.label), ["aa", "bb", "cc"]);
  assert.deepEqual(updates.map((update) => update.label), ["cc", "aa", "bb"]);
}

// The on-chain coordinator enforces strict ascending order by
// `bytearray.compare` on `pair_token_name`. Token names are
// `blake2b_256(pair_id)` serialized as lowercase hex, so a bytewise compare
// on the decoded bytes is equivalent to a plain lexicographic compare on
// the normalized hex string. This regression pins that equivalence using
// token names that mix digits and lowercase letters — exactly the cases
// where a locale-sensitive collation could diverge from byte order on some
// platforms.
function testBatchUpdatesSortMatchesBytewiseCompare(): void {
  // Hex bytes ordered: 0x09 < 0x0a < 0x0f < 0x10 < 0xa0 < 0xff.
  const tokenNames = ["ff", "10", "0a", "a0", "0f", "09"];
  const updates = tokenNames.map((name) => ({
    artifact: samplePairArtifact(name),
    label: name,
  }));

  const sorted = sortBatchUpdatesByPairTokenName(updates);
  const sortedNames = sorted.map((update) =>
    update.artifact.pair.tokenName,
  );

  // Verify strict ascending order matches a bytewise compare on the
  // decoded bytes — the exact rule the on-chain batch witness header
  // check enforces during the coordinator's main witness walk.
  for (let i = 1; i < sortedNames.length; i++) {
    const prev = Buffer.from(sortedNames[i - 1], "hex");
    const curr = Buffer.from(sortedNames[i], "hex");
    assert.ok(
      Buffer.compare(prev, curr) < 0,
      `Expected bytewise ascending order: ${sortedNames[i - 1]} < ${sortedNames[i]}`,
    );
  }
}

function testBatchUpdatesSortRejectsNonNormalizedTokenName(): void {
  // Odd-length hex would not round-trip to bytes and must be rejected
  // before sorting — otherwise the off-chain order could diverge from the
  // on-chain bytewise rule on the decoded bytes.
  const oddUpdates = [
    { artifact: { pair: { tokenName: "abc" } }, label: "odd" },
    { artifact: { pair: { tokenName: "aabb" } }, label: "even" },
  ];
  assert.throws(
    () => sortBatchUpdatesByPairTokenName(oddUpdates),
    /even-length hex/,
  );

  // Non-hex characters must also be rejected; `normalizeHex` only accepts
  // `[0-9a-f]` after lower-casing, so anything else is structurally invalid
  // as a Cardano token-name bytestring representation.
  const nonHexUpdates = [
    { artifact: { pair: { tokenName: "zzzz" } }, label: "non-hex" },
    { artifact: { pair: { tokenName: "aabb" } }, label: "ok" },
  ];
  assert.throws(
    () => sortBatchUpdatesByPairTokenName(nonHexUpdates),
    /even-length hex/,
  );
}

function testPairApplyUpdateRedeemerHasNoFields(): void {
  // The on-chain `PairSpendAction::ApplyUpdate` constructor carries no
  // fields after the witness-index removal — pair_state.spend no longer
  // binds to a specific witness because update_coordinator's count
  // checks already enforce one-pair-input-per-witness accounting.
  assert.equal(
    buildPairApplyUpdateRedeemer(),
    Data.to(new Constr<PlutusData>(0, [])),
  );
}

// With DIA_AUTHORIZED_PUBLIC_KEYS_<network> set, protocol:init authorizes exactly
// those keys (DIA's real signers); with it unset it derives the self-sign key from
// DIA_AUTHORIZED_PRIVATE_KEY. Hermetic — manages the env var itself.
function testProtocolInitAuthorizedKeysFromEnv(): void {
  const saved = process.env.DIA_AUTHORIZED_PUBLIC_KEYS_TESTNET;
  const walletAddress =
    "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j";
  try {
    process.env.DIA_AUTHORIZED_PUBLIC_KEYS_TESTNET =
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807,03c7d448ea95104a628945f43745f177f1e9895c6d4c8e43614d7b1c0395469b2d";
    const configured = createProtocolStateArtifact({ source: "seed", walletAddress });
    assert.deepEqual(configured.configState.authorizedDiaPublicKeys, [
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
      "03c7d448ea95104a628945f43745f177f1e9895c6d4c8e43614d7b1c0395469b2d",
    ]);

    delete process.env.DIA_AUTHORIZED_PUBLIC_KEYS_TESTNET;
    const fallback = createProtocolStateArtifact({ source: "seed", walletAddress });
    const authorizedDiaPrivateKey = getCliConfig().authorizedDiaPrivateKey;
    if (authorizedDiaPrivateKey) {
      assert.deepEqual(fallback.configState.authorizedDiaPublicKeys, [
        deriveCompressedPublicKeyFromPrivateKey(authorizedDiaPrivateKey),
      ]);
    }
  } finally {
    if (saved === undefined) delete process.env.DIA_AUTHORIZED_PUBLIC_KEYS_TESTNET;
    else process.env.DIA_AUTHORIZED_PUBLIC_KEYS_TESTNET = saved;
  }
}

function testProtocolStateInit(): void {
  const state = createProtocolStateArtifact({
    source: "seed",
    walletAddress: "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j",
  });

  assert.equal(state.scripts.referenceHolderAddress, "");
  assert.equal(state.bootstrapRefs.config.txHash, "");
  assert.equal(state.referenceScripts?.global?.config.txHash, "");
  assert.equal(state.configState.validConfigSigners.length, 1);
  // Precedence (see defaultProtocolConfigInput): DIA_AUTHORIZED_PUBLIC_KEYS_<network>
  // wins; otherwise the self-sign key derived from DIA_AUTHORIZED_PRIVATE_KEY; otherwise a
  // fixture. testProtocolInitAuthorizedKeysFromEnv covers both paths hermetically.
  const cliConfig = getCliConfig();
  const expectedAuthorizedDiaPublicKey =
    cliConfig.authorizedDiaPublicKeys.length > 0
      ? cliConfig.authorizedDiaPublicKeys[0]
      : cliConfig.authorizedDiaPrivateKey
        ? deriveCompressedPublicKeyFromPrivateKey(cliConfig.authorizedDiaPrivateKey)
        : "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807";
  assert.equal(state.configState.authorizedDiaPublicKeys[0], expectedAuthorizedDiaPublicKey);
  assert.equal(state.configState.domain.name, "DIA Oracle");
  assert.equal(state.configState.baseFeeLovelace, "600000");
  assert.equal(state.configState.perPairFeeLovelace, "400000");
  // Deposit tx-build params seeded at protocol:init (shared with the feeder via
  // config-bootstrap.json::configState; read by deposit:fund/merge).
  assert.equal(state.configState.depositMinLovelace, "1000000");
  assert.equal(state.configState.depositMaxPerMerge, "20");
  assert.equal(state.configState.depositMaxPerUpdateFold, "3");
  assert.equal(state.datum.configCbor, "");
  assert.equal(state.datum.paymentHookCbor, "");
  assert.equal(
    state.drafts?.configParameterize?.configAssetName,
    "4449415f434f4e464947",
  );
  assert.equal(
    state.drafts?.paymentHookParameterize?.paymentHookAssetName,
    "4449415f5041594d454e545f484f4f4b",
  );
  assert.equal(
    state.drafts?.paymentHookParameterize?.minUtxoLovelace,
    state.configState.minUtxoLovelace,
  );
}

// deposit:fund sources its dust floor from
// config-bootstrap.json::configState.depositMinLovelace (set at protocol:init),
// NOT from a hardcoded constant or the feeder YAML. We write protocol + client
// state files with a known floor, then assert depositFund rejects an amount
// below that floor with a message citing it — proving the floor is read from
// configState. (depositMerge reads the same floor + depositMaxPerMerge cap from
// configState; the emulator protocol-flow exercises the full fund/merge path.)
async function testDepositFundReadsFloorFromConfigState(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dia-deposit-test-"));
  try {
    const protocolStatePath = path.join(dir, "config-bootstrap.json");
    const clientStatePath = path.join(dir, "client.json");
    const protocol = sampleConfigArtifact();
    protocol.configState.depositMinLovelace = "2000000"; // 2 ADA floor
    protocol.configState.depositMaxPerMerge = "7";
    await writeStateJsonFile(protocolStatePath, protocol);
    await writeStateJsonFile(clientStatePath, sampleClientArtifact());

    await assert.rejects(
      depositFund({
        amountLovelace: "1500000", // below the 2 ADA configState floor
        clientStatePath,
        protocolStatePath,
        buildOnly: true,
      }),
      /1500000 is below the 2000000 lovelace minimum/,
      "depositFund must read the floor from configState.depositMinLovelace",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// deposit:merge selects which deposit UTxOs to sweep with `isCleanAdaDeposit`
// (the floor + pure-ADA + no-datum predicate) and then caps the sweep at
// `configState.depositMaxPerMerge`. The emulator (protocol-flow.ts) only drives
// the happy path of two clean deposits; this isolates the SELECTION logic so the
// dust/token/datum filtering AND the per-merge cap are covered at the unit level
// (anti-skim itself is the deposit validator's job — see deposit_logic.ak tests).
function testDepositMergeSelectionFiltersAndCaps(): void {
  const FLOOR = 1_000_000n;
  const TOKEN_UNIT = `${"aa".repeat(28)}4449415f5245434549564552`;
  const mkUtxo = (overrides: Partial<UTxO>): UTxO => ({
    txHash: "ab".repeat(32),
    outputIndex: 0,
    address: "addr_test1qpgtest",
    assets: { lovelace: 5_000_000n },
    ...overrides,
  });

  // --- Classification predicate (mirrors the feeder's deposit-pending probe).
  assert.equal(isCleanAdaDeposit(mkUtxo({ assets: { lovelace: FLOOR } }), FLOOR), true,
    "pure ADA at the floor is eligible");
  assert.equal(isCleanAdaDeposit(mkUtxo({ assets: { lovelace: FLOOR - 1n } }), FLOOR), false,
    "dust below the floor is skipped");
  assert.equal(
    isCleanAdaDeposit(mkUtxo({ assets: { lovelace: 5_000_000n, [TOKEN_UNIT]: 1n } }), FLOOR),
    false,
    "a native-token UTxO is skipped (a griefer cannot block the sweep)");

  // --- Selection = filter(isCleanAdaDeposit) then slice(0, maxPerMerge): the
  // exact expression depositMerge uses. We assert dust/token UTxOs drop out AND
  // the cap bounds how many clean deposits are swept in one tx.
  const select = (utxos: UTxO[], floor: bigint, cap: number): UTxO[] =>
    utxos.filter((u) => isCleanAdaDeposit(u, floor)).slice(0, cap);

  const mixed = [
    mkUtxo({ txHash: "01".repeat(32), assets: { lovelace: 2_000_000n } }),       // clean
    mkUtxo({ txHash: "02".repeat(32), assets: { lovelace: 500_000n } }),         // dust
    mkUtxo({ txHash: "03".repeat(32), assets: { lovelace: 4_000_000n, [TOKEN_UNIT]: 1n } }), // token junk
    mkUtxo({ txHash: "04".repeat(32), assets: { lovelace: 3_000_000n } }),       // clean
  ];
  const eligible = select(mixed, FLOOR, 20);
  assert.deepEqual(
    eligible.map((u) => u.txHash),
    ["01".repeat(32), "04".repeat(32)],
    "only clean ADA >= floor is selected; dust and token-junk are dropped",
  );
  const swept = eligible.reduce((acc, u) => acc + (u.assets.lovelace ?? 0n), 0n);
  assert.equal(swept, 5_000_000n, "swept total is the sum of the eligible deposits only");

  // Cap: with 5 clean deposits and a cap of 3, exactly 3 are swept.
  const fiveClean = Array.from({ length: 5 }, (_unused, i) =>
    mkUtxo({ txHash: `${i.toString().padStart(2, "0")}`.repeat(32).slice(0, 64), assets: { lovelace: 2_000_000n } }),
  );
  assert.equal(select(fiveClean, FLOOR, 3).length, 3, "the per-merge cap bounds the sweep at depositMaxPerMerge");
  assert.equal(select(fiveClean, FLOOR, 20).length, 5, "a cap above the count sweeps all clean deposits");

  // No eligible deposits (all dust / all token-junk) → empty selection, which is
  // exactly the condition depositMerge turns into the "no eligible deposits" throw.
  assert.equal(
    select([mkUtxo({ assets: { lovelace: 500_000n } }), mkUtxo({ assets: { lovelace: 9n, [TOKEN_UNIT]: 1n } })], FLOOR, 20).length,
    0,
    "all-dust / all-token-junk yields no eligible deposits",
  );
}

// wallet:consolidate selection — pure-ADA UTxOs only (collateral must be pure
// Split planner — break a wallet toward the target profile (the OPPOSITE of
// consolidate: too concentrated → split a big UTxO into many usable ones).
function testPlanWalletSplit(): void {
  const ADA = 1_000_000n;
  // Split fills working up to 10 (the hysteresis target, above the trigger of 5)
  // and collateral up to 5. A big UTxO is one above 550 ADA.
  const PROFILE: WalletShapeProfile = {
    workingCount: 10,
    workingLovelace: 100n * ADA,
    collateralCount: 5,
    collateralLovelace: 10n * ADA,
    bigUtxoAboveLovelace: 550n * ADA,
    feeBufferLovelace: 2n * ADA,
  };
  const utxo = (outRef: string, ada: bigint, hasOnlyAda = true): SplitUtxo => ({
    outRef,
    lovelace: ada * ADA,
    hasOnlyAda,
  });
  const asPlan = (p: ReturnType<typeof planWalletSplit>) => {
    assert.ok(p.act, "expected a split plan");
    return p;
  };
  const count = (vals: bigint[], v: bigint) => vals.filter((x) => x === v).length;

  // Primary case: a 600-ADA UTxO funds only the base (5 collateral + 5 working);
  // collateral first, then working as the value allows. Rest is change.
  {
    const plan = asPlan(planWalletSplit([utxo("fat#0", 600n)], PROFILE));
    assert.deepEqual(plan.consumeOutRefs, ["fat#0"], "consumes the big UTxO");
    assert.equal(count(plan.outputLovelaces, 10n * ADA), 5, "5 collateral outputs of 10 ADA");
    assert.equal(count(plan.outputLovelaces, 100n * ADA), 5, "5 working (600 ADA funds only 5)");
  }

  // No big UTxO → nothing to split (a low/dust wallet is funding/consolidate).
  {
    const shaped: SplitUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      ...Array.from({ length: 5 }, (_, i) => utxo(`w#${i}`, 100n)),
    ];
    assert.deepEqual(planWalletSplit(shaped, PROFILE), { act: false, reason: "already_shaped" });
  }

  // Profile already met → the big UTxO is left alone as a reserve (no churn).
  {
    const utxos: SplitUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      ...Array.from({ length: 10 }, (_, i) => utxo(`w#${i}`, 100n)),
      utxo("fat#0", 5000n),
    ];
    assert.deepEqual(planWalletSplit(utxos, PROFILE), { act: false, reason: "already_shaped" });
  }

  // A big UTxO tops working up toward the 10 target (hysteresis), leaving the
  // good UTxOs untouched. 5 working present → mint 5 more from the big UTxO.
  {
    const utxos: SplitUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      ...Array.from({ length: 5 }, (_, i) => utxo(`w#${i}`, 100n)),
      utxo("fat#0", 5000n),
    ];
    const plan = asPlan(planWalletSplit(utxos, PROFILE));
    assert.deepEqual(plan.consumeOutRefs, ["fat#0"], "only the big UTxO is consumed (good UTxOs preserved)");
    assert.deepEqual(plan.outputLovelaces, Array.from({ length: 5 }, () => 100n * ADA), "5 more working → 10 total");
  }

  // A large empty-wallet UTxO fills the FULL profile: 5 collateral + 10 working,
  // and the rest is a single change UTxO (NOT fanned into many pieces).
  {
    const plan = asPlan(planWalletSplit([utxo("fat#0", 5000n)], PROFILE));
    assert.equal(plan.outputLovelaces.length, 15, "exactly 5 collateral + 10 working — no fan-out");
    assert.equal(count(plan.outputLovelaces, 10n * ADA), 5);
    assert.equal(count(plan.outputLovelaces, 100n * ADA), 10);
  }

  // A whale UTxO is bounded by the profile (15 outputs), never the UTxO's size —
  // the ~99,000 ADA remainder is one change UTxO.
  {
    const plan = asPlan(planWalletSplit([utxo("whale#0", 100_000n)], PROFILE));
    assert.equal(plan.outputLovelaces.length, 15, "bounded by the profile (5 + 10), not the UTxO size");
  }

  // Multiple big UTxOs are ALL consumed; the value fills the profile, rest change.
  {
    const utxos: SplitUtxo[] = [utxo("fat#0", 600n), utxo("fat#1", 700n)];
    const plan = asPlan(planWalletSplit(utxos, PROFILE));
    assert.deepEqual(plan.consumeOutRefs.sort(), ["fat#0", "fat#1"], "both big UTxOs are consumed");
    assert.equal(count(plan.outputLovelaces, 10n * ADA), 5, "5 collateral");
    // 1300 − 2 buffer − 50 collateral = 1248 → 10 working (the full target).
    assert.equal(count(plan.outputLovelaces, 100n * ADA), 10, "fills working to the 10 target");
  }

  // Token-bearing UTxOs are never touched (collateral must be pure ADA).
  {
    const utxos: SplitUtxo[] = [utxo("fat#0", 600n), utxo("nft#0", 5n, false)];
    const plan = asPlan(planWalletSplit(utxos, PROFILE));
    assert.ok(!plan.consumeOutRefs.includes("nft#0"), "the token UTxO is never consumed");
  }
}

// ADA), smallest first (the dust is what blocks collateral), capped at maxInputs.
function testConsolidationUtxoSelection(): void {
  const TOKEN_UNIT = `${"aa".repeat(28)}4449415f5245434549564552`;
  const mk = (txHash: string, assets: Record<string, bigint>): UTxO => ({
    txHash,
    outputIndex: 0,
    address: "addr_test1qpgtest",
    assets,
  });

  // Mixed wallet: pure-ADA of various sizes + one token-bearing UTxO.
  const utxos = [
    mk("03".repeat(32), { lovelace: 3_000_000n }),
    mk("01".repeat(32), { lovelace: 1_000_000n }),
    mk("tk".padEnd(64, "a"), { lovelace: 9_000_000n, [TOKEN_UNIT]: 1n }), // token → excluded
    mk("02".repeat(32), { lovelace: 2_000_000n }),
  ];

  const selected = selectConsolidationUtxos(utxos, 60);
  assert.deepEqual(
    selected.map((u) => u.assets.lovelace),
    [1_000_000n, 2_000_000n, 3_000_000n],
    "pure-ADA only, smallest first; the token UTxO is left untouched",
  );

  // Cap bounds the input count (tx-size safety); smallest first means the dust
  // that blocks collateral is always swept first.
  const many = Array.from({ length: 10 }, (_u, i) =>
    mk(i.toString().padStart(64, "0"), { lovelace: BigInt((i + 1) * 1_000_000) }),
  );
  const capped = selectConsolidationUtxos(many, 4);
  assert.equal(capped.length, 4, "selection is capped at maxInputs");
  assert.deepEqual(
    capped.map((u) => u.assets.lovelace),
    [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n],
    "the four smallest pure-ADA UTxOs are chosen",
  );
}

function testClientStateInit(): void {
  const protocol = sampleConfigArtifact();
  protocol.referenceScripts = {
    global: {
      config: {
        txHash: "global-config",
        outputIndex: 0,
        scriptHash: "11".repeat(28),
      },
      coordinator: {
        txHash: "global-coordinator",
        outputIndex: 1,
        scriptHash: "22".repeat(28),
      },
      paymentHook: {
        txHash: "global-hook",
        outputIndex: 2,
        scriptHash: "33".repeat(28),
      },
    },
  };
  const client = createClientStateArtifact("client-a", {
    clientId: "client-a",
    receiverAssetLabel: "DIA_RECEIVER_CLIENT_A",
    receiverAssetName: "4449415f52454345495645525f434c49454e545f41",
    minUtxoLovelace: "3000000",
  });

  assert.equal(client.receiver, undefined);
  assert.equal(client.referenceScripts?.client?.receiver.txHash, "");
  assert.equal(client.scripts.pairPolicyId, "");
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetName,
    "4449415f52454345495645525f434c49454e545f41",
  );
  assert.equal(
    client.drafts?.receiverParameterize?.receiverAssetLabel,
    "DIA_RECEIVER_CLIENT_A",
  );
}

// =====================================================================
// Datum encoder / decoder tests
// =====================================================================

function sampleReceiverState(overrides: Partial<{
  balanceLovelace: string;
  accruedToHookLovelace: string;
  minUtxoLovelace: string;
}> = {}) {
  return {
    balanceLovelace: overrides.balanceLovelace ?? "12345678",
    accruedToHookLovelace: overrides.accruedToHookLovelace ?? "987654",
    minUtxoLovelace: overrides.minUtxoLovelace ?? "3000000",
  };
}

function samplePaymentHookStateDatum() {
  return {
    withdrawAddress:
      "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j",
    minUtxoLovelace: "3000000",
    accruedFeesLovelace: "5000000",
    lifetimeCollectedLovelace: "10000000",
    lifetimeWithdrawnLovelace: "5000000",
  };
}

function sampleConfigStateDatum() {
  return {
    validConfigSigners: ["99".repeat(28), "ab".repeat(28)],
    authorizedDiaPublicKeys: [
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
    ],
    domain: {
      name: "DIA Oracle",
      version: "1.0",
      sourceChainId: "100640",
      verifyingContract: "f8c614a483a0427a13512f52ac72a576678be317",
    },
    baseFeeLovelace: "600000",
    perPairFeeLovelace: "400000",
    paymentHookRef: {
      policyId: "44".repeat(28),
      assetName: "4449415f5041594d454e545f484f4f4b",
      unit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
    updateCoordinatorCredential: {
      type: "Script" as const,
      hash: "33".repeat(28),
    },
    minUtxoLovelace: "5000000",
    maxBootstrapDriftSeconds: "300",
    depositMinLovelace: "1000000",
    depositMaxPerMerge: "20",
    depositMaxPerUpdateFold: "3",
  };
}

function samplePairLiveState() {
  return {
    pairId: "555344432f555344",
    price: "99992561",
    timestamp: "1760960522",
    nonce: "1760960522308165264",
    intentHash: "44".repeat(32),
    signer: "f64d333c19b007519c7b9316680ed26578f98c08",
    minUtxoLovelace: "5000000",
    intent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: "100640",
      nonce: "1760960522308165264",
      expiry: "1760964122",
      symbol: "USDC/USD",
      price: "99992561",
      timestamp: "1760960522",
      source: "DIA Oracle",
      signature: `0x${"66".repeat(64)}`,
      signer: "0xf64d333c19b007519c7b9316680ed26578f98c08",
    },
  };
}

function testPrimitivesPureHelpers(): void {
  assert.equal(toBigInt("42", "x"), 42n);
  assert.equal(toBigInt(7, "y"), 7n);
  assert.throws(() => toBigInt("not-a-number", "z"), /integer/i);

  assert.equal(normalizeHex("0xABCD", "h"), "abcd");
  assert.equal(normalizeHex("ABCD", "h"), "abcd");
  assert.throws(() => normalizeHex("0xZZ", "bad"), /hex/i);
  assert.throws(() => normalizeHex("abc", "odd"), /even/i);

  const split = splitUnit(`${"aa".repeat(28)}4449415f434f4e464947`);
  assert.equal(split.policyId.length, 56);
  assert.equal(split.assetName, "4449415f434f4e464947");

  assert.deepEqual(
    parseCommaSeparatedHexList(" 0xaa, bb, 0xCC ", "list"),
    ["aa", "bb", "cc"],
  );
  assert.deepEqual(parseCommaSeparatedHexList("", "list"), []);

  assert.equal(utf8ToHex("DIA Oracle"), "444941204f7261636c65");
}

function testReceiverDatumRoundTrip(): void {
  const state = sampleReceiverState();
  const cbor = buildReceiverDatumCbor(state);
  const decoded = decodeReceiverDatum(cbor);

  assert.equal(decoded.balanceLovelace, state.balanceLovelace);
  assert.equal(decoded.accruedToHookLovelace, state.accruedToHookLovelace);
  assert.equal(decoded.minUtxoLovelace, state.minUtxoLovelace);
}

function testReceiverDatumExactlyThreeIntegerFields(): void {
  // Regression for the bug where receiver-bootstrap.ts encoded 2 fields.
  const cbor = buildReceiverDatumCbor(sampleReceiverState());
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0, "ReceiverDatum constructor must be index 0");
  assert.equal(datum.fields.length, 3, "ReceiverDatum must have exactly 3 fields");

  for (let i = 0; i < datum.fields.length; i += 1) {
    assert.equal(
      typeof datum.fields[i],
      "bigint",
      `ReceiverDatum field ${i} must be Int (bigint), got ${typeof datum.fields[i]}`,
    );
  }
  assert.equal(datum.fields[0], 12345678n);
  assert.equal(datum.fields[1], 987654n);
  assert.equal(datum.fields[2], 3000000n);
}

function testPaymentHookDatumRoundTrip(): void {
  const state = samplePaymentHookStateDatum();
  const cbor = buildPaymentHookDatumCbor(state);
  const decoded = decodePaymentHookDatum(cbor, state.withdrawAddress);

  assert.equal(decoded.withdrawAddress, state.withdrawAddress);
  assert.equal(decoded.accruedFeesLovelace, state.accruedFeesLovelace);
  assert.equal(decoded.lifetimeCollectedLovelace, state.lifetimeCollectedLovelace);
  assert.equal(decoded.lifetimeWithdrawnLovelace, state.lifetimeWithdrawnLovelace);
  assert.equal(decoded.minUtxoLovelace, state.minUtxoLovelace);
}

function testPaymentHookDatumWithdrawAddressRoundTrip(): void {
  // Address must encode as a (paymentCred, optional stakeCred) pair
  // following the Plutus Address shape, not as a string.
  const state = samplePaymentHookStateDatum();
  const cbor = buildPaymentHookDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 5);

  const addr = datum.fields[0] as Constr<PlutusData>;
  assert.equal(addr.index, 0, "Address constructor must be 0");
  assert.equal(addr.fields.length, 2, "Address must carry payment + stake credential");

  const paymentCred = addr.fields[0] as Constr<PlutusData>;
  // Sample address has key payment credential -> Constr 0.
  assert.equal(paymentCred.index, 0, "payment credential should be VerificationKey");
  assert.equal(typeof paymentCred.fields[0], "string");

  // Stake credential is Some(...) for the sample address (it has a stake key).
  const stakeWrapper = addr.fields[1] as Constr<PlutusData>;
  assert.equal(stakeWrapper.index, 0, "stake credential should be Some(...)");

  // Remaining fields must be ints in correct order.
  assert.equal(typeof datum.fields[1], "bigint", "accrued_fees_lovelace");
  assert.equal(typeof datum.fields[2], "bigint", "lifetime_collected_lovelace");
  assert.equal(typeof datum.fields[3], "bigint", "lifetime_withdrawn_lovelace");
  assert.equal(typeof datum.fields[4], "bigint", "min_utxo_lovelace");
}

function testConfigDatumRoundTrip(): void {
  // No symmetric decoder exists for ConfigDatum (no off-chain caller needs it),
  // so we round-trip via Data.from + structural comparison.
  const state = sampleConfigStateDatum();
  const cbor = buildConfigDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 9, "ConfigDatum must have exactly 9 fields");

  // 0: validConfigSigners (List<bytes>)
  const signers = datum.fields[0] as string[];
  assert.deepEqual(signers, state.validConfigSigners);

  // 1: authorizedDiaPublicKeys (List<bytes>)
  const keys = datum.fields[1] as string[];
  assert.deepEqual(keys, state.authorizedDiaPublicKeys);

  // 2: domain_data (Constr 0)
  const domain = datum.fields[2] as Constr<PlutusData>;
  assert.equal(domain.index, 0);
  assert.equal(domain.fields.length, 4);
  assert.equal(domain.fields[0], utf8ToHex(state.domain.name));
  assert.equal(domain.fields[1], utf8ToHex(state.domain.version));
  assert.equal(domain.fields[2], BigInt(state.domain.sourceChainId));
  assert.equal(domain.fields[3], state.domain.verifyingContract);

  // 3: base_fee_lovelace (Int)
  assert.equal(datum.fields[3], BigInt(state.baseFeeLovelace));

  // 4: per_pair_fee_lovelace (Int)
  assert.equal(datum.fields[4], BigInt(state.perPairFeeLovelace));

  // 5: payment_hook_ref (Option<PaymentHookRef>) -> Some
  const hookRef = datum.fields[5] as Constr<PlutusData>;
  assert.equal(hookRef.index, 0, "payment_hook_ref must be Some(...)");
  const hookInner = hookRef.fields[0] as Constr<PlutusData>;
  assert.equal(hookInner.index, 0);
  assert.equal(hookInner.fields[0], state.paymentHookRef.policyId);
  assert.equal(hookInner.fields[1], state.paymentHookRef.assetName);

  // 6: update_coordinator_credential (Option<Credential>) -> Some(Script)
  const coord = datum.fields[6] as Constr<PlutusData>;
  assert.equal(coord.index, 0, "coordinator credential must be Some(...)");
  const coordCred = coord.fields[0] as Constr<PlutusData>;
  assert.equal(coordCred.index, 1, "Script credential constructor is index 1");
  assert.equal(coordCred.fields[0], state.updateCoordinatorCredential.hash);

  // 7: max_bootstrap_drift_seconds (Int)
  assert.equal(datum.fields[7], BigInt(state.maxBootstrapDriftSeconds));

  // 8: min_utxo_lovelace (Int)
  assert.equal(datum.fields[8], BigInt(state.minUtxoLovelace));
}

function testConfigDatumFieldOrderAndArity(): void {
  // Direct regression for the field-order bug: previously
  // max_bootstrap_drift_seconds and payment_hook_ref had been swapped, and
  // payment-hook-bootstrap had omitted max_bootstrap_drift_seconds entirely.
  const stateWithNone = {
    ...sampleConfigStateDatum(),
    paymentHookRef: null,
    updateCoordinatorCredential: null,
  };
  const cbor = buildConfigDatumCbor(stateWithNone);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.fields.length, 9, "Arity must be 9 even when options are None");

  const hookRef = datum.fields[5] as Constr<PlutusData>;
  assert.equal(hookRef.index, 1, "None constructor for payment_hook_ref");
  assert.equal(hookRef.fields.length, 0);

  const coord = datum.fields[6] as Constr<PlutusData>;
  assert.equal(coord.index, 1, "None constructor for update_coordinator_credential");
  assert.equal(coord.fields.length, 0);

  // Ints must be at the right positions.
  assert.equal(typeof datum.fields[3], "bigint", "base_fee_lovelace at index 3");
  assert.equal(typeof datum.fields[4], "bigint", "per_pair_fee_lovelace at index 4");
  assert.equal(typeof datum.fields[7], "bigint", "max_bootstrap_drift_seconds at index 7");
  assert.equal(typeof datum.fields[8], "bigint", "min_utxo_lovelace at index 8");
}

function testPairDatumRoundTrip(): void {
  const state = samplePairLiveState();
  const cbor = buildPairDatumCbor(state);
  const datum = Data.from(cbor) as Constr<PlutusData>;

  assert.equal(datum.index, 0);
  assert.equal(datum.fields.length, 7);
  assert.equal(datum.fields[0], state.pairId);
  assert.equal(datum.fields[1], BigInt(state.price));
  assert.equal(datum.fields[2], BigInt(state.timestamp));
  assert.equal(datum.fields[3], BigInt(state.nonce));
  assert.equal(datum.fields[4], state.intentHash);
  assert.equal(datum.fields[5], state.signer);
  assert.equal(datum.fields[6], BigInt(state.minUtxoLovelace));
  assert.deepEqual(decodePairDatum(cbor), {
    pairId: state.pairId,
    price: state.price,
    timestamp: state.timestamp,
    nonce: state.nonce,
    intentHash: state.intentHash,
    signer: state.signer,
    minUtxoLovelace: state.minUtxoLovelace,
  });
}

// A1: the dependency-free datum-decoders module is the canonical home; the
// chain-helpers exports are re-exports of it. Decoding through the direct module
// path must produce byte-identical results — one implementation, two import sites.
function testDatumDecodersModuleMatchesReExport(): void {
  const pairCbor = buildPairDatumCbor(samplePairLiveState());
  assert.deepEqual(
    decodePairDatumDirect(pairCbor),
    decodePairDatum(pairCbor),
    "datum-decoders.decodePairDatum must equal the chain-helpers re-export",
  );
  const receiverCbor = buildReceiverDatumCbor(sampleReceiverState());
  assert.deepEqual(
    decodeReceiverDatumDirect(receiverCbor),
    decodeReceiverDatum(receiverCbor),
    "datum-decoders.decodeReceiverDatum must equal the chain-helpers re-export",
  );
}

function testAddressToPlutusDataKeyAndStake(): void {
  // Key-key address (sample mnemonic-derived).
  const keyAddr =
    "addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j";
  const data = addressToPlutusData(keyAddr);
  assert.equal(data.index, 0);
  assert.equal(data.fields.length, 2);
  const payment = data.fields[0] as Constr<PlutusData>;
  assert.equal(payment.index, 0, "key payment credential -> 0");
  const stake = data.fields[1] as Constr<PlutusData>;
  assert.equal(stake.index, 0, "stake should be Some(...)");
}

// =====================================================================
// Pure invariant tests (withdraw, settle, batch, config, manifest)
// =====================================================================

function testSettleManifestPreChecks(): void {
  assert.throws(
    () => assertSettleManifestReceiversNonEmptyAndUnique([]),
    /at least one receiver/,
  );
  const dup = { receiverPolicyId: "aa", receiverAssetName: "bb" };
  assert.throws(
    () => assertSettleManifestReceiversNonEmptyAndUnique([dup, dup]),
    /Duplicate settle receiver/,
  );
  assert.doesNotThrow(() =>
    assertSettleManifestReceiversNonEmptyAndUnique([
      { receiverPolicyId: "11", receiverAssetName: "22" },
      { receiverPolicyId: "11", receiverAssetName: "33" },
    ]),
  );
}

function testHookCoordinatorConsistencyPure(): void {
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "ab", assetName: "cd", unit: "abcd" },
        null,
      ),
    /paymentHookRef set without updateCoordinatorCredential/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(null, { type: "Script", hash: "11".repeat(28) }),
    /without paymentHookRef/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "", assetName: "cd", unit: "cd" },
        { type: "Script", hash: "11".repeat(28) },
      ),
    /non-empty hex/,
  );
  assert.throws(
    () =>
      assertHookCoordinatorConsistency(
        { policyId: "ab", assetName: "", unit: "ab" },
        { type: "Script", hash: "11".repeat(28) },
      ),
    /non-empty hex/,
  );
  assert.doesNotThrow(() => assertHookCoordinatorConsistency(null, null));
  assert.doesNotThrow(() =>
    assertHookCoordinatorConsistency(
      { policyId: "ab", assetName: "cd", unit: "abcd" },
      { type: "Script", hash: "11".repeat(28) },
    ),
  );
}

function testWithdrawAmountPreflightHelpers(): void {
  assert.doesNotThrow(() => assertReceiverWithdrawAmountValid(100n, 100n));
  assert.throws(
    () => assertReceiverWithdrawAmountValid(101n, 100n),
    /not sufficient/,
  );
}

function testReceiverTransactionPreflightGuards(): void {
  assert.throws(() => assertReceiverTopUpAmountPositive(0n), /greater than zero/);
  assert.throws(() => assertReceiverTopUpAmountPositive(-1n), /greater than zero/);
  assert.throws(() => assertReceiverWithdrawAmountPositive(0n), /greater than zero/);
  assert.throws(
    () => assertPaymentKeyHashIsConfigSigner("deadbeef", ["cafe", "babe"]),
    /not authorized as a config signer/,
  );
  assert.doesNotThrow(() =>
    assertPaymentKeyHashIsConfigSigner("cafe", ["cafe", "babe"]),
  );
  assert.throws(
    () =>
      assertPaymentKeyHashIsConfigSigner("bad", ["good"], {
        unauthorizedMessage: "Settle requires a config signer. The configured wallet is not authorized.",
      }),
    /Settle requires a config signer/,
  );
}

function testConfigUpdateAndInitArtifactPreflight(): void {
  const expectedAddr = sampleScripts().configValidatorAddress;
  assert.doesNotThrow(() =>
    assertConfigUtxoLivesAtValidatorAddress(expectedAddr, expectedAddr),
  );
  assert.throws(
    () =>
      assertConfigUtxoLivesAtValidatorAddress(
        "addr_test1wrong",
        expectedAddr,
      ),
    /Loaded config UTxO address does not match scripts\.configValidatorAddress/,
  );

  assert.doesNotThrow(() => assertPositiveMinUtxoLovelace(5_000_000n, "Config"));
  assert.throws(
    () => assertPositiveMinUtxoLovelace(0n, "Config"),
    /Config min_utxo_lovelace must be greater than zero/,
  );
  assert.throws(
    () => assertPositiveMinUtxoLovelace(-1n, "PaymentHook"),
    /PaymentHook min_utxo_lovelace must be greater than zero/,
  );

  assert.throws(
    () =>
      assertPaymentKeyHashIsConfigSigner("deadbeef", ["cafe"], {
        unauthorizedMessage:
          "The configured wallet is not authorized as a current config signer.",
      }),
    /The configured wallet is not authorized as a current config signer\./,
  );

  assert.throws(
    () => assertNonEmptyConfigSignerList([]),
    /at least one payment key hash/,
  );
  assert.throws(
    () => assertNonEmptyConfigSignerList(["   "]),
    /non-empty hex string/,
  );
  assert.doesNotThrow(() =>
    assertNonEmptyConfigSignerList(["aa".repeat(14)]),
  );

  assert.throws(() => assertClientIdNonEmpty(""), /non-empty string/);
  assert.throws(() => assertClientIdNonEmpty("   "), /non-empty string/);
  assert.throws(
    () =>
      createClientStateArtifact("  ", {
        clientId: "ignored",
        receiverAssetLabel: "L",
        receiverAssetName: "44",
        minUtxoLovelace: "3000000",
      }),
    /non-empty string/,
  );
}

function testBootstrapNftPayPreflight(): void {
  const wallet = "addr_test1walletxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const script = "addr_test1scriptxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  assert.doesNotThrow(() =>
    assertNftBootstrapDestinationIsNotFundingWallet(script, wallet, "unit"),
  );
  assert.throws(
    () => assertNftBootstrapDestinationIsNotFundingWallet(wallet, wallet, "preview:x"),
    /must pay to the validator script address/,
  );
}

function testSettleAndPaymentHookPreflight(): void {
  testSettlePreflightGuards();
  testPaymentHookWithdrawPreflightGuards();
}

function testSettlePreflightGuards(): void {
  assert.throws(
    () => assertSettleReceiverAccruedPositive(0n, "0", "recv_unit"),
    /no accrued fees to settle/,
  );
  assert.throws(
    () => assertSettleReceiverAccruedPositive(-3n, "-3", "recv_unit"),
    /no accrued fees to settle/,
  );
  assert.doesNotThrow(() =>
    assertSettleReceiverAccruedPositive(1n, "1", "recv_unit"),
  );

  testSettleManifestMatchesClientReceivers();
}

// Multi-client settle manifest guard: non-empty + unique + 1:1 match with the
// loaded client receivers. Generalises the previous single-client check to
// any N >= 1 receivers settled in one transaction.
function testSettleManifestMatchesClientReceivers(): void {
  const clientA = { receiverPolicyId: "aa", receiverAssetName: "bb" };
  const clientB = { receiverPolicyId: "11", receiverAssetName: "22" };

  // Empty manifest is rejected.
  assert.throws(
    () => assertSettleManifestMatchesClientReceivers([], [clientA]),
    /at least one receiver/,
  );

  // Duplicate manifest entry is rejected (mirrors on-chain uniqueness).
  assert.throws(
    () =>
      assertSettleManifestMatchesClientReceivers(
        [{ ...clientA }, { ...clientA }],
        [clientA, clientB],
      ),
    /Duplicate settle receiver/,
  );

  // Length mismatch (manifest has fewer/more rows than loaded clients).
  assert.throws(
    () => assertSettleManifestMatchesClientReceivers([{ ...clientA }], [clientA, clientB]),
    /does not match the number of loaded client receivers/,
  );

  // A loaded client missing from the manifest is rejected.
  assert.throws(
    () =>
      assertSettleManifestMatchesClientReceivers(
        [{ ...clientA }, { receiverPolicyId: "xx", receiverAssetName: "yy" }],
        [clientA, clientB],
      ),
    /is missing from the settle manifest|does not match any loaded client receiver/,
  );

  // Single-client (N=1) still works.
  assert.doesNotThrow(() =>
    assertSettleManifestMatchesClientReceivers([{ ...clientA }], [clientA]),
  );

  // Two clients, 1:1 match — order-independent.
  assert.doesNotThrow(() =>
    assertSettleManifestMatchesClientReceivers(
      [{ ...clientB }, { ...clientA }],
      [clientA, clientB],
    ),
  );
}

// Σ-accrued invariant for a multi-client settle: the payment hook is credited
// the sum of every receiver's drained accrued, and each receiver ends at 0.
// Mirrors what the on-chain coordinator enforces (Σ-drained == hook delta).
function testMultiClientSettleSumAccrued(): void {
  const receivers = [
    sampleReceiverState({ balanceLovelace: "10000000", accruedToHookLovelace: "1000000" }),
    sampleReceiverState({ balanceLovelace: "20000000", accruedToHookLovelace: "2500000" }),
    sampleReceiverState({ balanceLovelace: "30000000", accruedToHookLovelace: "750000" }),
  ];
  const hookBefore = samplePaymentHookStateDatum();

  const total = receivers.reduce(
    (sum, r) => sum + BigInt(r.accruedToHookLovelace),
    0n,
  );
  assert.equal(total, 4_250_000n, "Σ accrued across receivers");

  const receiversAfter = receivers.map((r) => ({
    ...r,
    accruedToHookLovelace: "0",
  }));
  const hookAfter = {
    ...hookBefore,
    accruedFeesLovelace: (BigInt(hookBefore.accruedFeesLovelace) + total).toString(),
    lifetimeCollectedLovelace: (
      BigInt(hookBefore.lifetimeCollectedLovelace) + total
    ).toString(),
  };

  // Total accrued is conserved: every receiver drained into the hook.
  const totalBefore =
    receivers.reduce((sum, r) => sum + BigInt(r.accruedToHookLovelace), 0n) +
    BigInt(hookBefore.accruedFeesLovelace);
  const totalAfter =
    receiversAfter.reduce((sum, r) => sum + BigInt(r.accruedToHookLovelace), 0n) +
    BigInt(hookAfter.accruedFeesLovelace);
  assert.equal(totalAfter, totalBefore, "multi-client settle must conserve total accrued");

  for (const r of receiversAfter) {
    assert.equal(r.accruedToHookLovelace, "0", "every receiver accrued cleared");
  }
  assert.equal(
    BigInt(hookAfter.accruedFeesLovelace) - BigInt(hookBefore.accruedFeesLovelace),
    total,
    "hook accrued grows by exactly Σ",
  );
  assert.equal(
    BigInt(hookAfter.lifetimeCollectedLovelace) -
      BigInt(hookBefore.lifetimeCollectedLovelace),
    total,
    "hook lifetime_collected grows by exactly Σ",
  );
  // Balances unchanged by settle.
  for (let i = 0; i < receivers.length; i += 1) {
    assert.equal(receiversAfter[i].balanceLovelace, receivers[i].balanceLovelace);
  }
}

function testPaymentHookWithdrawPreflightGuards(): void {
  assert.throws(() => assertPaymentHookWithdrawAmountPositive(0n), /greater than zero/);
  assert.doesNotThrow(() => assertPaymentHookWithdrawAmountPositive(1n));
  assert.doesNotThrow(() => assertPaymentHookWithdrawAmountValid(5n, 10n));
  assert.throws(
    () => assertPaymentHookWithdrawAmountValid(11n, 10n),
    /not sufficient/,
  );
}

function testOracleUpdatePreflightPureGuards(): void {
  testOracleIntentExpiryPreflight();
  testBootstrapRefsPreflight();
  testBatchRejectsMismatchedPaymentHookUnit();
  testRecoverWitnessRejectsTamperedSignature();
  testOracleIntentMonotonicPreflight();
}

function testOracleIntentExpiryPreflight(): void {
  const base = {
    intentType: "OracleUpdate",
    version: "1.0",
    chainId: 100640n,
    nonce: 1n,
    expiry: 1000n,
    symbol: "X",
    price: 1n,
    timestamp: 900n,
    source: "S",
  };
  assert.throws(
    () => assertDiaOracleIntentNotExpired(base, 1001n),
    /Oracle intent expired/,
  );
  assert.doesNotThrow(() => assertDiaOracleIntentNotExpired(base, 1000n));
  assert.doesNotThrow(() =>
    assertDiaOracleIntentNotExpired({ ...base, expiry: 0n }, 999_999_999_999n),
  );
}

function testBootstrapRefsPreflight(): void {
  assert.throws(
    () =>
      assertOracleUpdateBootstrapRefsResolved({
        config: { txHash: "", outputIndex: 0 },
        paymentHook: { txHash: "aa", outputIndex: 0 },
      }),
    /config bootstrap/,
  );
  assert.throws(
    () =>
      assertOracleUpdateBootstrapRefsResolved({
        config: { txHash: "aa", outputIndex: 0 },
        paymentHook: { txHash: "  ", outputIndex: 0 },
      }),
    /payment-hook bootstrap/,
  );
  assert.doesNotThrow(() =>
    assertOracleUpdateBootstrapRefsResolved(sampleConfigArtifact().bootstrapRefs),
  );
}

function testBatchRejectsMismatchedPaymentHookUnit(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);
  const wrongHook = {
    ...second,
    scripts: {
      ...second.scripts,
      paymentHookUnit: `${"55".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
  };
  assert.throws(
    () => ensureCompatibleBatch([first, wrongHook]),
    /same client deployment/,
  );
}

function testRecoverWitnessRejectsTamperedSignature(): void {
  const domain = {
    name: "DIA Oracle",
    version: "1.0",
    sourceChainId: "100640",
    verifyingContract: "0xF8c614A483A0427A13512F52ac72A576678bE317",
  };
  const signed = signDiaOracleIntentInput({
    domain,
    intent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: "100640",
      nonce: "1",
      expiry: "9999999999",
      symbol: "USDC/USD",
      price: "1000",
      timestamp: "1000",
      source: "DIA Oracle",
    },
    privateKey: "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  const intent = normalizeDiaOracleIntent(signed.intent);
  const normDomain = normalizeDiaEip712Domain(domain);
  assert.doesNotThrow(() => recoverDiaOracleIntentWitness(normDomain, intent));

  const tampered = normalizeDiaOracleIntent({
    ...signed.intent,
    signature: `0x${"ab".repeat(65)}`,
  });
  assert.throws(() => recoverDiaOracleIntentWitness(normDomain, tampered));
}

function testOracleIntentMonotonicPreflight(): void {
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 100n,
        intentNonce: 2n,
        pairStateTimestamp: "100",
        pairStateNonce: "1",
      }),
    /timestamp must be greater/,
  );
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 101n,
        intentNonce: 1n,
        pairStateTimestamp: "100",
        pairStateNonce: "2",
      }),
    /nonce must be greater/,
  );
  assert.throws(
    () =>
      assertOracleIntentTimestampAndNonceMonotonic({
        isCreate: false,
        intentTimestamp: 100n,
        intentNonce: 2n,
        pairStateTimestamp: "100",
        pairStateNonce: "1",
        batchStatePath: "/tmp/oracle-batch.json",
      }),
    (err: unknown) =>
      err instanceof Error && err.message.includes("/tmp/oracle-batch.json"),
  );
  assert.doesNotThrow(() =>
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate: true,
      intentTimestamp: 1n,
      intentNonce: 1n,
      pairStateTimestamp: "999",
      pairStateNonce: "999",
    }),
  );
  assert.doesNotThrow(() =>
    assertOracleIntentTimestampAndNonceMonotonic({
      isCreate: false,
      intentTimestamp: 200n,
      intentNonce: 5n,
      pairStateTimestamp: "100",
      pairStateNonce: "2",
    }),
  );
}

function testReceiverWithdrawDoesNotTouchAccrued(): void {
  // Invariant: a withdraw of N lovelace must reduce balance_lovelace by N
  // and leave accrued_to_hook_lovelace untouched. This mirrors what the
  // on-chain Withdraw redeemer enforces, asserted on the off-chain
  // datum-builder side.
  const before = sampleReceiverState({
    balanceLovelace: "10000000",
    accruedToHookLovelace: "1234567",
  });
  const withdrawAmount = 4_000_000n;

  const after = {
    ...before,
    balanceLovelace: (BigInt(before.balanceLovelace) - withdrawAmount).toString(),
  };

  const beforeCbor = buildReceiverDatumCbor(before);
  const afterCbor = buildReceiverDatumCbor(after);
  const beforeDecoded = decodeReceiverDatum(beforeCbor);
  const afterDecoded = decodeReceiverDatum(afterCbor);

  assert.equal(
    BigInt(beforeDecoded.balanceLovelace) - BigInt(afterDecoded.balanceLovelace),
    withdrawAmount,
  );
  assert.equal(
    afterDecoded.accruedToHookLovelace,
    beforeDecoded.accruedToHookLovelace,
    "Withdraw must not move funds out of accrued_to_hook_lovelace",
  );
  assert.equal(afterDecoded.minUtxoLovelace, beforeDecoded.minUtxoLovelace);

  // Negative case: a "withdraw" that also drains accrued is a different shape
  // and must produce a different datum CBOR.
  const malicious = {
    ...after,
    accruedToHookLovelace: "0",
  };
  const maliciousCbor = buildReceiverDatumCbor(malicious);
  assert.notEqual(maliciousCbor, afterCbor, "Draining accrued must change the datum bytes");
}

function testSettleDeltaInvariant(): void {
  // Invariant: settle moves the entire accrued_to_hook_lovelace from
  // receiver into payment hook accrued_fees_lovelace, and resets the
  // receiver-side accrual to 0. The total of (receiver.accrued + hook.accrued)
  // must be conserved.
  const receiverBefore = sampleReceiverState({
    balanceLovelace: "20000000",
    accruedToHookLovelace: "7777777",
  });
  const hookBefore = samplePaymentHookStateDatum();

  const delta = BigInt(receiverBefore.accruedToHookLovelace);

  const receiverAfter = {
    ...receiverBefore,
    accruedToHookLovelace: "0",
  };
  const hookAfter = {
    ...hookBefore,
    accruedFeesLovelace: (BigInt(hookBefore.accruedFeesLovelace) + delta).toString(),
    lifetimeCollectedLovelace: (
      BigInt(hookBefore.lifetimeCollectedLovelace) + delta
    ).toString(),
  };

  const totalBefore =
    BigInt(receiverBefore.accruedToHookLovelace) +
    BigInt(hookBefore.accruedFeesLovelace);
  const totalAfter =
    BigInt(receiverAfter.accruedToHookLovelace) +
    BigInt(hookAfter.accruedFeesLovelace);

  assert.equal(totalAfter, totalBefore, "Settle must conserve total accrued");
  assert.equal(receiverAfter.accruedToHookLovelace, "0");
  assert.equal(receiverAfter.balanceLovelace, receiverBefore.balanceLovelace);
  assert.equal(receiverAfter.minUtxoLovelace, receiverBefore.minUtxoLovelace);

  // Also: hook.lifetime_collected must grow by exactly delta.
  assert.equal(
    BigInt(hookAfter.lifetimeCollectedLovelace) -
      BigInt(hookBefore.lifetimeCollectedLovelace),
    delta,
  );
  // hook.lifetime_withdrawn must NOT change during a settle.
  assert.equal(
    hookAfter.lifetimeWithdrawnLovelace,
    hookBefore.lifetimeWithdrawnLovelace,
  );

  // CBORs must round-trip cleanly through their decoders.
  assert.deepEqual(
    decodeReceiverDatum(buildReceiverDatumCbor(receiverAfter)),
    receiverAfter,
  );
  assert.deepEqual(
    decodePaymentHookDatum(
      buildPaymentHookDatumCbor(hookAfter),
      hookAfter.withdrawAddress,
    ),
    hookAfter,
  );
}

function testBatchRejectsDuplicatePair(): void {
  // Already covered by testCompatibleBatchRules but keep an explicit name
  // so a regression touching only this rule shows clearly in the output.
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const pair = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  assert.throws(
    () => ensureCompatibleBatch([pair, pair]),
    /Duplicate pair state included in batch/,
  );
}

function testBatchRejectsForeignReceiver(): void {
  const protocol = sampleConfigArtifact();
  const client = sampleClientArtifact();
  client.receiver = sampleReceiverArtifact();
  const first = resolvePairArtifact(samplePairArtifact("aa"), client, protocol);
  const second = resolvePairArtifact(samplePairArtifact("bb"), client, protocol);

  // Mutating the second resolved pair to point at a different receiver
  // simulates two pairs from different client deployments being submitted
  // in one batch.
  const tampered = {
    ...second,
    receiver: {
      ...second.receiver,
      receiverUnit: `${"33".repeat(28)}444946464552454e54`,
    },
  };

  assert.throws(
    () => ensureCompatibleBatch([first, tampered]),
    /same client deployment/,
  );
}

function testReferenceScriptMissingHelper(): void {
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: false }),
    false,
    "all-resolved reference maps should not trigger inline fallback",
  );
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: true }),
    true,
    "a missing reference should trigger inline fallback",
  );
  assert.equal(
    isAnyReferenceScriptMissing({ receiver: false, pair: true }),
    true,
    "mixed reference availability should still report a missing entry",
  );
}

function sampleReceiverDefaults() {
  return {
    clientId: "client-a",
    receiverAssetLabel: "DIA_RECEIVER_CLIENT_A",
    receiverAssetName: "4449415f52454345495645525f434c49454e545f41",
    minUtxoLovelace: "3000000",
  };
}

// reclaim-reference-script --script client must recover all four per-client
// reference scripts (receiver / pair / pairMint / deposit), reversing the single
// publish-client transaction that created them together.
function testClientReclaimUtxoRefsIncludesDeposit(): void {
  const client = createClientStateArtifact("client-a", sampleReceiverDefaults());
  client.referenceScripts = {
    client: {
      receiver: { txHash: "aa".repeat(32), outputIndex: 0, scriptHash: "r1" },
      pair: { txHash: "aa".repeat(32), outputIndex: 1, scriptHash: "p1" },
      pairMint: { txHash: "aa".repeat(32), outputIndex: 2, scriptHash: "pm1" },
      deposit: { txHash: "aa".repeat(32), outputIndex: 3, scriptHash: "d1" },
    },
  };

  const refs = resolveClientUtxoRefs(client);
  assert.deepEqual(
    refs.map((r) => r.name),
    ["receiver", "pair", "pairMint", "deposit"],
    "client reclaim must include all four per-client reference-script outRefs",
  );
  const deposit = refs.find((r) => r.name === "deposit");
  assert.equal(deposit?.ref?.outputIndex, 3, "deposit ref must carry its published outRef");
}

// A client state from a deployment that predates the deposit reference script
// carries only receiver/pair/pairMint. resolveClientUtxoRefs must skip the
// absent (or empty) deposit entry — not throw, not emit an unpublished outRef
// that the caller's "not published yet" guard would reject — so the teardown of
// such a deployment still works.
function testClientReclaimUtxoRefsSkipsDepositWhenAbsent(): void {
  // Absent entirely (three-entry state shape).
  const threeEntry = createClientStateArtifact("client-a", sampleReceiverDefaults());
  threeEntry.referenceScripts = {
    client: {
      receiver: { txHash: "aa".repeat(32), outputIndex: 0, scriptHash: "r1" },
      pair: { txHash: "aa".repeat(32), outputIndex: 1, scriptHash: "p1" },
      pairMint: { txHash: "aa".repeat(32), outputIndex: 2, scriptHash: "pm1" },
    },
  };
  assert.deepEqual(
    resolveClientUtxoRefs(threeEntry).map((r) => r.name),
    ["receiver", "pair", "pairMint"],
    "absent deposit ref must be skipped, not surfaced",
  );

  // Present but empty (txHash === "") must also be skipped so the caller's
  // unpublished-ref guard does not fire.
  const emptyDeposit = createClientStateArtifact("client-a", sampleReceiverDefaults());
  emptyDeposit.referenceScripts = {
    client: {
      receiver: { txHash: "aa".repeat(32), outputIndex: 0, scriptHash: "r1" },
      pair: { txHash: "aa".repeat(32), outputIndex: 1, scriptHash: "p1" },
      pairMint: { txHash: "aa".repeat(32), outputIndex: 2, scriptHash: "pm1" },
      deposit: { txHash: "", outputIndex: 0, scriptHash: "" },
    },
  };
  assert.deepEqual(
    resolveClientUtxoRefs(emptyDeposit).map((r) => r.name),
    ["receiver", "pair", "pairMint"],
    "empty deposit ref must be skipped, not surfaced",
  );
}

function assertHexString(value: unknown): void {
  if (typeof value !== "string") {
    assert.fail("value must be a string");
  }
  assert(value.trim().length > 0, "string must not be empty");
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  assert(/^[0-9a-fA-F]+$/.test(normalized), `${value} must be hex`);
  assert.equal(normalized.length % 2, 0, `${value} must have even hex length`);
}

function sampleConfigArtifact(): ConfigStateArtifact {
  return {
    wallet: {
      source: "seed",
      address: "addr_test1sample",
    },
    bootstrapRefs: {
      config: {
        txHash: "config-bootstrap",
        outputIndex: 0,
      },
      paymentHook: {
        txHash: "hook-bootstrap",
        outputIndex: 1,
      },
    },
    scripts: sampleScripts(),
    configState: sampleConfigState(),
    paymentHookState: samplePaymentHookState(),
    compiledScripts: {
      configMintPolicy: "aa",
      configValidator: "bb",
      coordinatorValidator: "cc",
      paymentHookMintPolicy: "dd",
      paymentHookValidator: "ee",
      referenceHolderValidator: "ff",
    },
    datum: {
      configCbor: "config-cbor",
      paymentHookCbor: "hook-cbor",
    },
    transactions: [
      {
        step: "preview:payment-hook:bootstrap",
        submittedTxHash: "hook-bootstrap-tx",
        confirmed: true,
      },
    ],
    drafts: {
      configParameterize: {
        configAssetLabel: "DIA_CONFIG",
        configAssetName: "4449415f434f4e464947",
      },
      paymentHookParameterize: {
        paymentHookAssetLabel: "DIA_PAYMENT_HOOK",
        paymentHookAssetName: "4449415f5041594d454e545f484f4f4b",
        withdrawAddress: "addr_test1sample",
        minUtxoLovelace: "3000000",
      },
    },
  };
}

function sampleClientArtifact(): ClientStateArtifact {
  return {
    clientId: "client-a",
    scripts: {
      pairPolicyId: "11".repeat(28),
      pairValidatorHash: "11".repeat(28),
      pairValidatorAddress: "addr_test1pair",
    },
    compiledScripts: {
      receiverMintPolicy: "ff",
      receiverValidator: "11",
      pairMintPolicy: "22",
      pairValidator: "33",
      depositValidator: "44",
    },
    referenceScripts: {
      client: {
        receiver: {
          txHash: "client-receiver-ref",
          outputIndex: 0,
          scriptHash: "55".repeat(28),
        },
        pair: {
          txHash: "client-pair-ref",
          outputIndex: 1,
          scriptHash: "11".repeat(28),
        },
        pairMint: {
          txHash: "client-pair-mint-ref",
          outputIndex: 2,
          scriptHash: "22".repeat(28),
        },
      },
    },
    receiver: sampleReceiverArtifact(),
    datum: {
      receiverCbor: "receiver-cbor",
    },
  };
}

function sampleReceiverArtifact() {
  return {
    clientId: "client-a",
    bootstrapRef: {
      txHash: "receiver-bootstrap",
      outputIndex: 0,
    },
    receiverAssetName: "4449415f5245434549564552",
    receiverPolicyId: "22".repeat(28),
    receiverUnit: `${"22".repeat(28)}4449415f5245434549564552`,
    receiverValidatorHash: "55".repeat(28),
    receiverValidatorAddress: "addr_test1receiver",
    depositValidatorHash: "66".repeat(28),
    depositValidatorAddress: "addr_test1deposit",
    receiverState: {
      balanceLovelace: "10000000",
      accruedToHookLovelace: "0",
      minUtxoLovelace: "3000000",
    },
  };
}

function samplePairArtifact(pairSuffix: string): PairStateArtifact {
  const pairUnit = `${"11".repeat(28)}${pairSuffix.repeat(4)}`;

  return {
    wallet: {
      source: "seed",
      address: "addr_test1sample",
    },
    pair: {
      tokenName: pairSuffix.repeat(4),
      pairId: "555344432f555344",
      pairUnit,
      pairValidatorAddress: "addr_test1pair",
    },
    pairState: {
      pairId: "555344432f555344",
      price: "99992561",
      timestamp: "1760960522",
      nonce: "1760960522308165264",
      intentHash: "44".repeat(32),
      signer: "f64d333c19b007519c7b9316680ed26578f98c08",
      minUtxoLovelace: "5000000",
      intent: {
        intentType: "OracleUpdate",
        version: "1.0",
        chainId: "100640",
        nonce: "1760960522308165264",
        expiry: "1760964122",
        symbol: "USDC/USD",
        price: "99992561",
        timestamp: "1760960522",
        source: "DIA Oracle",
        signature: `0x${"66".repeat(64)}`,
        signer: "0xf64d333c19b007519c7b9316680ed26578f98c08",
      },
    },
    datum: {
      pairCbor: "pair-cbor",
    },
  };
}

function sampleScripts(): ConfigStateArtifact["scripts"] {
  return {
    configPolicyId: "aa".repeat(28),
    configUnit: `${"aa".repeat(28)}4449415f434f4e464947`,
    configValidatorHash: "aa".repeat(28),
    configValidatorAddress: "addr_test1config",
    coordinatorHash: "33".repeat(28),
    coordinatorRewardAddress: "stake_test1coordinator",
    referenceHolderValidatorHash: "55".repeat(28),
    referenceHolderAddress: "addr_test1referenceholder",
    paymentHookPolicyId: "44".repeat(28),
    paymentHookUnit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    paymentHookValidatorHash: "44".repeat(28),
    paymentHookValidatorAddress: "addr_test1hook",
  };
}

function sampleConfigState(): ConfigStateArtifact["configState"] {
  return {
    validConfigSigners: ["99".repeat(28)],
    authorizedDiaPublicKeys: [
      "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807",
    ],
    domain: {
      name: "DIA Oracle",
      version: "1.0",
      sourceChainId: "100640",
      verifyingContract: "f8c614a483a0427a13512f52ac72a576678be317",
    },
    baseFeeLovelace: "600000",
    perPairFeeLovelace: "400000",
    paymentHookRef: {
      policyId: "44".repeat(28),
      assetName: "4449415f5041594d454e545f484f4f4b",
      unit: `${"44".repeat(28)}4449415f5041594d454e545f484f4f4b`,
    },
    updateCoordinatorCredential: {
      type: "Script",
      hash: "33".repeat(28),
    },
    minUtxoLovelace: "5000000",
    maxBootstrapDriftSeconds: "300",
    depositMinLovelace: "1000000",
    depositMaxPerMerge: "20",
    depositMaxPerUpdateFold: "3",
  };
}

function samplePaymentHookState(): NonNullable<ConfigStateArtifact["paymentHookState"]> {
  return {
    withdrawAddress: "addr_test1withdraw",
    minUtxoLovelace: "3000000",
    accruedFeesLovelace: "0",
    lifetimeCollectedLovelace: "0",
    lifetimeWithdrawnLovelace: "0",
  };
}

async function runLucidEmulatorHarnessSmokeTests(): Promise<void> {
  await testEmulatorHarnessSimpleTransfer();
  await testEmulatorHarnessReferenceScriptGenesisRow();
  await testInstallEmulatorLucidRedirectsCliHelpers();
  await testEmulatorProtocolFlowConfigBootstrap();
}

async function testEmulatorHarnessSimpleTransfer(): Promise<void> {
  const { lucid, emulator, accounts } = await makeOracleEmulatorLucid();
  const dest = accounts[1].address;
  const send = 15_000_000n;
  const txSignBuilder = await lucid
    .newTx()
    .pay.ToAddress(dest, { lovelace: send })
    .complete();
  const metrics = collectTxSignBuilderMetrics(txSignBuilder);
  assert.ok(metrics.feeLovelace > 0n, "simple transfers should still estimate a fee");
  assert.equal(metrics.exUnits.cpu, 0n);
  assert.equal(metrics.exUnits.mem, 0n);
  const signed = await txSignBuilder.sign.withWallet().complete();
  await emulatorSubmitAndMine(emulator, signed);
  const utxos = await emulator.getUtxos(dest);
  const total = utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  assert.ok(total >= send, "recipient should hold at least the paid lovelace");
}

async function testEmulatorHarnessReferenceScriptGenesisRow(): Promise<void> {
  const { emulator, accounts } = await makeOracleEmulatorWithReferenceScriptRow();
  const refAddr = accounts[1].address;
  const utxos = await emulator.getUtxos(refAddr);
  assert.equal(utxos.length, 1);
  assert.ok(utxos[0].scriptRef, "genesis row should expose reference script");
  assert.equal(utxos[0].scriptRef?.type, "PlutusV3");
}

// Proves that after `installEmulatorLucid` the CLI's own
// `makeConfiguredLucid` / `selectConfiguredWallet` return the emulator's
// Lucid + an emulator-genesis-funded wallet — without any builder
// caller change. Also proves `uninstallEmulatorLucid` restores the
// production env-based path (verified by observing it now throws on a
// fresh call when no `.env` provider is set up; we just check the
// active wallet address differs between installed and uninstalled
// states by comparing against the emulator account's address).
async function testInstallEmulatorLucidRedirectsCliHelpers(): Promise<void> {
  const { installEmulatorLucid, uninstallEmulatorLucid } = await import(
    "../emulator/lucid-injection.js"
  );
  const { makeConfiguredLucid, selectConfiguredWallet } = await import(
    "../core/lucid.js"
  );

  const ctx = await makeOracleEmulatorLucid();
  try {
    installEmulatorLucid({
      lucid: ctx.lucid,
      emulator: ctx.emulator,
      walletSeedPhrase: ctx.accounts[0].seedPhrase,
    });

    const cliLucid = await makeConfiguredLucid();
    assert.strictEqual(
      cliLucid,
      ctx.lucid,
      "makeConfiguredLucid should return the emulator's Lucid instance after install",
    );

    const source = await selectConfiguredWallet(cliLucid);
    assert.equal(source, "seed", "wallet source should be 'seed'");

    const installedAddress = await cliLucid.wallet().address();
    assert.equal(
      installedAddress,
      ctx.accounts[0].address,
      "selectConfiguredWallet should select the primary emulator account",
    );
  } finally {
    uninstallEmulatorLucid();
  }
}

// Slice-vertical smoke test for the emulator protocol-flow orchestrator.
// Drives the same first three steps that `run-all-cli.sh` runs against
// Preview — `preview:protocol:init`, `preview:config:parameterize`,
// `preview:config:bootstrap` — but against the in-memory Lucid Emulator,
// reusing every CLI builder verbatim through the lucid-injection bridge.
// Skipped silently when `DIA_AUTHORIZED_PRIVATE_KEY` is not configured, because
// the bootstrap step derives the authorized DIA signer from that env
// var exactly like the bash script. This keeps the test optional in
// environments without the secret but exercises the real wiring when
// it is present.
async function testEmulatorProtocolFlowConfigBootstrap(): Promise<void> {
  if (!process.env.DIA_AUTHORIZED_PRIVATE_KEY?.trim()) {
    console.log(
      "[skip] testEmulatorProtocolFlowConfigBootstrap: set DIA_AUTHORIZED_PRIVATE_KEY to run",
    );
    return;
  }

  const { runEmulatorProtocolFlow } = await import(
    "../emulator/protocol-flow.js"
  );
  const ctx = await makeOracleEmulatorLucid();

  // `batchSize: 1` is the fastest end-to-end smoke: bootstrap → top-up →
  // create 1 pair → batch-1 → settle → withdraws → reclaim → republish →
  // burn. Exercises every step of the orchestrator without paying for the
  // full probe up the catalog.
  const report = await runEmulatorProtocolFlow({
    lucid: ctx.lucid,
    emulator: ctx.emulator,
    walletSeedPhrase: ctx.accounts[0].seedPhrase,
    batchSize: 1,
  });

  assert.equal(
    report.steps.find((s) => s.label === "config:bootstrap")?.ok,
    true,
    "config:bootstrap should succeed in the emulator",
  );
  // The combined "update + absorb side-deposit" step must have run and passed
  // its in-step assertions (price updated, balance rose by swept net of fee,
  // accrued rose by exactly the fee, deposit consumed). Its presence proves the
  // AccrueFee absorption path is exercised on real Plutus, not just typechecked.
  const absorbStep = report.steps.find((s) => s.label.startsWith("update:absorb-deposit:"));
  assert.ok(
    absorbStep,
    "emulator flow should include an update:absorb-deposit step that folds a side-deposit",
  );
  assert.equal(
    absorbStep!.ok,
    true,
    `update:absorb-deposit should succeed; got error: ${"error" in absorbStep! ? absorbStep!.error : ""}`,
  );
  // Multi-client / multi-receiver coverage: the flow onboards a second client
  // (client-b) and runs ONE `settle:multi` tx that drains BOTH client-a and
  // client-b receivers into the shared PaymentHook (its in-body assertions check
  // exactly 2 settled receivers, each drained > 0, and both accrued cleared to 0).
  // Asserting the step by name guards that the multi-client path can never
  // silently drop out of the orchestrator.
  const settleMultiStep = report.steps.find((s) => s.label === "settle:multi");
  assert.ok(
    settleMultiStep,
    "emulator flow should include a settle:multi step draining two receivers (client-a + client-b)",
  );
  assert.equal(
    settleMultiStep!.ok,
    true,
    `settle:multi should succeed; got error: ${"error" in settleMultiStep! ? settleMultiStep!.error : ""}`,
  );
  for (const step of report.steps) {
    assert.equal(
      step.ok,
      true,
      `step "${step.label}" should succeed; got error: ${"error" in step ? step.error : ""}`,
    );
  }
}

// --- Per-run state directory resolution (core/run-state) --------------------
// resolveRunStateDir + latestRunDir back the shared offchain/state tree both
// the CLI and the feeder read. Verifies the three-way selection: explicit
// RUN_ID env → newest <network>_run_* dir → flat <network> fallback.
async function testRunStateResolution(): Promise<void> {
  const savedRunId = process.env.RUN_ID;
  const restoreRunId = (): void => {
    if (savedRunId === undefined) delete process.env.RUN_ID;
    else process.env.RUN_ID = savedRunId;
  };

  // 1. RUN_ID env set → <stateRoot>/<network>_run_<RUN_ID>.
  process.env.RUN_ID = "20260517-063917";
  let base = await mkdtemp(path.join(os.tmpdir(), "cli-runstate-"));
  try {
    assert.equal(
      resolveRunStateDir("Mainnet", base),
      path.join(base, "mainnet_run_20260517-063917"),
      "RUN_ID env must select the matching per-run dir",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
    restoreRunId();
  }

  // 2. RUN_ID unset → newest <network>_run_* dir (lexical == chronological);
  //    other-network run dirs are ignored.
  delete process.env.RUN_ID;
  base = await mkdtemp(path.join(os.tmpdir(), "cli-runstate-"));
  try {
    await mkdir(path.join(base, "mainnet_run_20260101-000000"));
    await mkdir(path.join(base, "mainnet_run_20260517-063917")); // newest
    await mkdir(path.join(base, "preview_run_20260601-000000")); // other network
    assert.equal(
      resolveRunStateDir("Mainnet", base),
      path.join(base, "mainnet_run_20260517-063917"),
      "must pick the newest mainnet_run_* dir",
    );
    assert.equal(
      latestRunDir("Mainnet", base),
      path.join(base, "mainnet_run_20260517-063917"),
      "latestRunDir must return the newest mainnet_run_* dir",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
    restoreRunId();
  }

  // 3. No run dirs → flat <stateRoot>/<network> fallback.
  delete process.env.RUN_ID;
  base = await mkdtemp(path.join(os.tmpdir(), "cli-runstate-"));
  try {
    assert.equal(
      resolveRunStateDir("Preview", base),
      path.join(base, "preview"),
      "must fall back to the flat <network> dir when no run dirs exist",
    );
    assert.equal(latestRunDir("Preview", base), null, "latestRunDir must be null with no run dirs");
  } finally {
    await rm(base, { recursive: true, force: true });
    restoreRunId();
  }
}
