// Orchestrator that drives the same protocol flow as
// `offchain/cli/scripts/run-all-cli.sh`, but against an in-memory Lucid
// Emulator. Reuses the existing CLI builders verbatim — every step
// here is a direct call into `src/init`, `src/deploys`,
// `src/transactions`, or `src/oracle`. The only adaptation is
// `installEmulatorLucid` in `src/emulator/lucid-injection.ts`, which
// redirects `makeConfiguredLucid` / `selectConfiguredWallet` at the
// emulator before this orchestrator runs.
//
// State is threaded through a temporary working directory exactly the
// way the bash script threads state through `state/preview_*`. Each
// builder reads its previous state from a JSON file and writes the
// updated state back to the same path. This mirrors what
// `src/index.ts` does at the CLI command layer, so the emulator
// orchestrator works without any builder-signature changes.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Emulator } from "@lucid-evolution/lucid";

import {
  installEmulatorLucid,
  uninstallEmulatorLucid,
} from "./lucid-injection.js";
import { writeStateJsonFile } from "../core/state.js";
import { setTxMetricsObserver } from "../core/tx-metrics.js";
import type { TxResourceMetrics } from "../core/tx-metrics.js";
import type { LucidInstance } from "../core/lucid.js";
import { getNetworkNow } from "../core/network-time.js";

const CLIENT_ID = "client-a";
// Second client onboarded far enough to accrue one fee, so the run can prove
// a single multi-client settle drains BOTH receivers into the shared payment
// hook in one transaction (the on-chain coordinator supports N receivers).
const CLIENT_B_ID = "client-b";
const DOMAIN_NAME = "DIA Oracle";
// Single, generous top-up. Sized to cover up to PAIR_CATALOG.length (20)
// probe iterations: each iteration is one create (`base + per_pair`) plus one
// batch-N (`base + N*per_pair`). With base=0.6 / per_pair=0.4, the worst-case
// probe burn is ~136 ADA; 200 ADA leaves room for the final withdraw step.
const RECEIVER_TOP_UP_LOVELACE = "200000000";
// Client-b only runs one pair update before the multi-client settle, so it
// needs far less than client-a. Sized to cover one create (`base + per_pair`)
// with comfortable head-room.
const CLIENT_B_TOP_UP_LOVELACE = "20000000";
// Side-deposit (Option A) exercise: fund two separate deposits, then merge both
// in one sweep — drives the deposit validator's anti-skim sum + the Receiver
// TopUp credit through real Plutus evaluation in the emulator.
const DEPOSIT_FUND_LOVELACE = "5000000";
// Update+absorb exercise: a single side-deposit funded just before an oracle
// update that folds it in. The update's AccrueFee spend must absorb this
// lovelace straight into balance_lovelace (net of the protocol fee) while the
// fee moves balance -> accrued — proving the combined "update + absorb" tx on
// real Plutus.
const DEPOSIT_FOLD_FUND_LOVELACE = "7000000";
const RECEIVER_WITHDRAW_LOVELACE = "5000000";
const PAYMENT_HOOK_WITHDRAW_LOVELACE = "10000000";

// The probe doesn't use a hardcoded pair list. Each iteration mints a fresh
// pair `pair-N` on the fly: the slug and symbol come from the counter, and
// prices are derived numerically so every intent is unique. The probe keeps
// going until a batch tx fails (over-budget exec-units, validator
// rejection, …) or — as a defensive guard — until `PROBE_SAFETY_CAP` is hit.
// The cap is set generously above any plausible Plutus V3 ceiling so a
// healthy run never bumps into it; it exists only so a regression in
// failure detection cannot turn the probe into an infinite loop.
const PROBE_SAFETY_CAP = 100;

type ProbePair = {
  slug: string;
  symbol: string;
  bootstrapPrice: string;
  batchPrice: string;
};

function makeProbePair(index1: number): ProbePair {
  // `index1` is 1-based ("pair-1" for the first probe iteration). Prices are
  // separated by 1 so create→update has a strictly-greater value on each
  // pair without colliding across pairs.
  const base = 1_000_000n + BigInt(index1) * 1_000n;
  return {
    slug: `pair-${index1}`,
    symbol: `PAIR${index1}/USD`,
    bootstrapPrice: base.toString(),
    batchPrice: (base + 1n).toString(),
  };
}

export type EmulatorProtocolFlowArgs = {
  lucid: LucidInstance;
  emulator: Emulator;
  walletSeedPhrase: string;
  workDir?: string;
  keepWorkDir?: boolean;
  reportProgress?: (message: string) => void;
  // When `undefined`, the orchestrator runs in **probe mode**: it grows the
  // pair set by one in lockstep with the batch size, attempting batch-1 →
  // batch-2 → … and stops at the first batch that fails. The report keeps
  // every attempt's exec-units so callers can see the cliff.
  // When set to N, the orchestrator runs in **single-shot mode**: it seeds
  // exactly N pairs (via single updates) and runs one batch-N. No probe,
  // no fallback. If batch-N fails the run reports failure for that size.
  batchSize?: number;
};

export type EmulatorStepReport = {
  label: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  metrics?: TxResourceMetrics;
};

export type EmulatorProtocolFlowReport = {
  workDir: string;
  workDirCleanedUp: boolean;
  steps: EmulatorStepReport[];
  batchAttempts: Array<{
    size: number;
    ok: boolean;
    metrics?: TxResourceMetrics;
    error?: string;
  }>;
};

export async function runEmulatorProtocolFlow(
  args: EmulatorProtocolFlowArgs,
): Promise<EmulatorProtocolFlowReport> {
  const reportProgress = args.reportProgress ?? (() => undefined);
  const workDir =
    args.workDir ??
    (await mkdtemp(path.join(os.tmpdir(), "dia-emulator-flow-")));
  const protocolStatePath = path.join(workDir, "config-bootstrap.json");
  const clientsDir = path.join(workDir, "clients");
  const clientStatePath = path.join(clientsDir, `${CLIENT_ID}.json`);
  const pairsDir = path.join(clientsDir, CLIENT_ID, "pairs");
  // Second client, onboarded just before settle to prove the multi-client path.
  const clientBStatePath = path.join(clientsDir, `${CLIENT_B_ID}.json`);
  const clientBPairsDir = path.join(clientsDir, CLIENT_B_ID, "pairs");
  const intentsDir = path.join(workDir, "intents");
  const manifestsDir = path.join(workDir, "update-batches");
  await mkdir(clientsDir, { recursive: true });
  await mkdir(pairsDir, { recursive: true });
  await mkdir(clientBPairsDir, { recursive: true });
  await mkdir(intentsDir, { recursive: true });
  await mkdir(manifestsDir, { recursive: true });

  const steps: EmulatorStepReport[] = [];
  const batchAttempts: EmulatorProtocolFlowReport["batchAttempts"] = [];
  // Mode: probe (default) walks N=1,2,3,…; single-shot uses exactly N.
  const fixedBatchSize = args.batchSize;
  if (fixedBatchSize !== undefined) {
    if (!Number.isInteger(fixedBatchSize) || fixedBatchSize < 1) {
      throw new Error(`batchSize must be a positive integer (got: ${fixedBatchSize})`);
    }
    if (fixedBatchSize > PROBE_SAFETY_CAP) {
      throw new Error(
        `batchSize ${fixedBatchSize} exceeds PROBE_SAFETY_CAP (${PROBE_SAFETY_CAP}); raise the cap if you really need this size.`,
      );
    }
  }
  // Track which pairs were actually created so we can:
  //   - generate batch intents for them (and only them) at each step;
  //   - pick the burn target at the end of the run as the last live pair.
  const createdPairs: ProbePair[] = [];

  installEmulatorLucid({
    lucid: args.lucid,
    emulator: args.emulator,
    walletSeedPhrase: args.walletSeedPhrase,
  });

  try {
    // ── Protocol bootstrap ──────────────────────────────────────────
    await runStep(steps, "protocol:init", reportProgress, async () => {
      const { initializeProtocolState } = await import("../init/protocol-init.js");
      const state = await initializeProtocolState({
        useDefaults: true,
        mergeSelfSignKey: true,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runStep(steps, "config:parameterize", reportProgress, async () => {
      const { parameterizeConfigScripts } = await import(
        "../deploys/config-parameterize.js"
      );
      const state = await parameterizeConfigScripts({ statePath: protocolStatePath });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "config:bootstrap", reportProgress, async () => {
      const { configBootstrap } = await import("../deploys/config-bootstrap.js");
      const state = await configBootstrap({ statePath: protocolStatePath, buildOnly: false });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "config:reference-scripts", reportProgress, async () => {
      const { publishConfigReferenceScripts } = await import(
        "../deploys/config-reference-scripts.js"
      );
      const state = await publishConfigReferenceScripts({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runStep(steps, "payment-hook:parameterize", reportProgress, async () => {
      const { parameterizePaymentHookScripts } = await import(
        "../deploys/payment-hook-parameterize.js"
      );
      const state = await parameterizePaymentHookScripts({ statePath: protocolStatePath });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "payment-hook:bootstrap", reportProgress, async () => {
      const { paymentHookBootstrap } = await import(
        "../deploys/payment-hook-bootstrap.js"
      );
      const state = await paymentHookBootstrap({ statePath: protocolStatePath, buildOnly: false });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "payment-hook:reference-script", reportProgress, async () => {
      const { publishPaymentHookReferenceScript } = await import(
        "../deploys/payment-hook-reference-script.js"
      );
      const state = await publishPaymentHookReferenceScript({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    // ── Client onboarding ───────────────────────────────────────────
    await runStep(steps, "client:init", reportProgress, async () => {
      const { initializeClientState } = await import("../init/client-init.js");
      const state = await initializeClientState({
        statePath: protocolStatePath,
        clientId: CLIENT_ID,
        useDefaults: true,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runStep(steps, "receiver:parameterize", reportProgress, async () => {
      const { parameterizeReceiverScripts } = await import(
        "../deploys/receiver-parameterize.js"
      );
      const state = await parameterizeReceiverScripts({
        statePath: clientStatePath,
        protocolStatePath,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "receiver:bootstrap", reportProgress, async () => {
      const { receiverBootstrap } = await import("../deploys/receiver-bootstrap.js");
      const state = await receiverBootstrap({
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "reference-scripts:publish-client", reportProgress, async () => {
      const { publishClientReferenceScripts } = await import(
        "../deploys/client-reference-scripts.js"
      );
      const state = await publishClientReferenceScripts({
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    await runTxStep(steps, "receiver:top-up", reportProgress, async () => {
      const { receiverTopUp } = await import("../transactions/receiver-top-up.js");
      const state = await receiverTopUp({
        amountLovelace: RECEIVER_TOP_UP_LOVELACE,
        statePath: clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, state);
    });

    // ── Side-deposit funding (Option A) ─────────────────────────────
    // Two plain payments to the per-client deposit address, then one merge
    // that sweeps both into the Receiver balance (reusing the TopUp redeemer).
    // The merge tx must satisfy BOTH the deposit validator (anti-skim: the
    // Receiver lovelace must rise by the full swept total) and the Receiver
    // spend validator — so a passing step is end-to-end proof of Option A.
    await runTxStep(steps, "deposit:fund", reportProgress, async () => {
      const { depositFund } = await import("../transactions/deposit.js");
      await depositFund({
        amountLovelace: DEPOSIT_FUND_LOVELACE,
        clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
    });
    await runTxStep(steps, "deposit:fund:2", reportProgress, async () => {
      const { depositFund } = await import("../transactions/deposit.js");
      await depositFund({
        amountLovelace: DEPOSIT_FUND_LOVELACE,
        clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
    });
    await runTxStep(steps, "deposit:merge", reportProgress, async () => {
      const { depositMerge } = await import("../transactions/deposit.js");
      const { artifact } = await depositMerge({
        clientStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientStatePath, artifact);
    });

    // ── Update + absorb side-deposit (combined "update + fold") ──────
    // Fund ONE fresh side-deposit, then run an oracle update that opportunisti-
    // cally folds it into the SAME tx. This drives the on-chain AccrueFee
    // transition with `added = swept`: the protocol fee moves balance->accrued
    // while the deposit lovelace lands entirely in balance. Asserts (a) the
    // pair/price updated, (b) the Receiver balance rose by swept net of the fee,
    // (c) accrued rose by exactly the fee, (d) the deposit UTxO was consumed.
    {
      const foldPair = makeProbePair(0); // "pair-0" — dedicated to this exercise
      const foldIntentPath = path.join(intentsDir, `${foldPair.slug}.signed.json`);
      const foldPairStatePath = path.join(pairsDir, `${foldPair.slug}.json`);

      // Resolve the deposit address + receiver coordinates from the client state.
      const { decodeReceiverDatum, findSingleUtxoAtUnit, requireInlineDatum } =
        await import("../core/chain-helpers.js");
      const { makeDepositValidator, scriptAddressFromValidator } = await import(
        "../core/contracts.js"
      );
      const clientStateForFold = JSON.parse(await readFile(clientStatePath, "utf8"));
      const receiverForFold = clientStateForFold.receiver as {
        receiverPolicyId: string;
        receiverAssetName: string;
        receiverUnit: string;
        receiverValidatorAddress: string;
      };
      const depositValidatorForFold = await makeDepositValidator({
        receiverPolicyId: receiverForFold.receiverPolicyId,
        receiverAssetName: receiverForFold.receiverAssetName,
      });
      const depositAddressForFold = scriptAddressFromValidator(depositValidatorForFold);

      // Read the Receiver state from chain immediately before the update, so the
      // assertions compare against the true pre-update balance/accrued.
      const readReceiver = async (): Promise<{ balance: bigint; accrued: bigint }> => {
        const utxo = await findSingleUtxoAtUnit(
          args.lucid as never,
          receiverForFold.receiverValidatorAddress,
          receiverForFold.receiverUnit,
          "receiver",
        );
        const decoded = decodeReceiverDatum(requireInlineDatum(utxo, "receiver"));
        return {
          balance: BigInt(decoded.balanceLovelace),
          accrued: BigInt(decoded.accruedToHookLovelace),
        };
      };

      await runTxStep(steps, "deposit:fund:fold", reportProgress, async () => {
        const { depositFund } = await import("../transactions/deposit.js");
        await depositFund({
          amountLovelace: DEPOSIT_FOLD_FUND_LOVELACE,
          clientStatePath,
          protocolStatePath,
          buildOnly: false,
        });
      });

      await runStep(steps, `intent:create-and-sign:${foldPair.slug}`, reportProgress, async () => {
        const { createAndSignPreviewOracleIntent } = await import(
          "../oracle/intent-create.js"
        );
        const signed = await createAndSignPreviewOracleIntent({
          statePath: protocolStatePath,
          intentType: "OracleUpdate",
          symbol: foldPair.symbol,
          price: foldPair.bootstrapPrice,
          source: DOMAIN_NAME,
        });
        await writeStateJsonFile(foldIntentPath, signed);
      });

      // Snapshot pending deposit total + pre-update Receiver state.
      const depositUtxosBefore = await (args.lucid as {
        utxosAt(addr: string): Promise<Array<{ assets: Record<string, bigint> }>>;
      }).utxosAt(depositAddressForFold);
      const sweptExpected = depositUtxosBefore.reduce(
        (acc, u) => acc + (u.assets.lovelace ?? 0n),
        0n,
      );
      const receiverBefore = await readReceiver();
      // The protocol fee is base + per_pair (one pair in this update). Read from
      // the protocol artifact, the source of truth for the fee formula.
      const protocolStateForFold = JSON.parse(await readFile(protocolStatePath, "utf8"));
      const protocolFee =
        BigInt(protocolStateForFold.configState.baseFeeLovelace) +
        BigInt(protocolStateForFold.configState.perPairFeeLovelace);

      await runTxStep(steps, `update:absorb-deposit:${foldPair.slug}`, reportProgress, async () => {
        const { submitOracleUpdate } = await import("../transactions/update.js");
        const state = await submitOracleUpdate({
          intentPath: foldIntentPath,
          statePath: foldPairStatePath,
          clientStatePath,
          protocolStatePath,
          buildOnly: false,
          foldDeposits: true,
        });
        await writeStateJsonFile(foldPairStatePath, state);

        // (a) Pair/price updated to the folded intent's price.
        if (state.pairState.price !== foldPair.bootstrapPrice) {
          throw new Error(
            `update:absorb-deposit price mismatch: got ${state.pairState.price}, expected ${foldPair.bootstrapPrice}`,
          );
        }

        const receiverAfter = await readReceiver();

        // (b) Receiver balance rose by swept net of the fee:
        //     after = before - fee + swept.
        const expectedBalance = receiverBefore.balance - protocolFee + sweptExpected;
        if (receiverAfter.balance !== expectedBalance) {
          throw new Error(
            `update:absorb-deposit balance mismatch: got ${receiverAfter.balance}, ` +
              `expected ${expectedBalance} (before=${receiverBefore.balance} fee=${protocolFee} swept=${sweptExpected})`,
          );
        }
        if (sweptExpected <= 0n) {
          throw new Error("update:absorb-deposit expected a pending deposit to fold, found none");
        }

        // (c) accrued rose by exactly the fee.
        const expectedAccrued = receiverBefore.accrued + protocolFee;
        if (receiverAfter.accrued !== expectedAccrued) {
          throw new Error(
            `update:absorb-deposit accrued mismatch: got ${receiverAfter.accrued}, expected ${expectedAccrued}`,
          );
        }

        // (d) the deposit UTxO(s) were consumed (deposit address now drained of
        //     the clean deposit we funded).
        const depositUtxosAfter = await (args.lucid as {
          utxosAt(addr: string): Promise<Array<{ assets: Record<string, bigint> }>>;
        }).utxosAt(depositAddressForFold);
        const remaining = depositUtxosAfter.reduce(
          (acc, u) => acc + (u.assets.lovelace ?? 0n),
          0n,
        );
        if (remaining !== 0n) {
          throw new Error(
            `update:absorb-deposit expected the folded deposit(s) consumed, ${remaining} lovelace remains`,
          );
        }

        reportProgress(
          `[emulator-flow] update:absorb-deposit folded ${sweptExpected} lovelace: ` +
            `balance ${receiverBefore.balance} -> ${receiverAfter.balance} (fee ${protocolFee}), ` +
            `accrued ${receiverBefore.accrued} -> ${receiverAfter.accrued}`,
        );
      });
      // NOTE: foldPair ("pair-0") is intentionally NOT added to `createdPairs`.
      // The probe loop relies on `createdPairs.length === batch size`, and the
      // batch intents/burn target are keyed off that list. This standalone
      // exercise leaves its pair UTxO live and out of the batch composition.
    }

    // ── Probe / single-shot phase ───────────────────────────────────
    // Default (probe): walk N = 1, 2, 3, … Each iteration:
    //   1. Generate + sign a bootstrap intent for `PAIR_CATALOG[N-1]`.
    //   2. Run `update` to create that Pair UTxO.
    //   3. Generate fresh batch intents for ALL N created pairs (using
    //      monotone (timestamp, nonce) so the on-chain freshness check
    //      passes regardless of how fast the emulator runs).
    //   4. Attempt batch-N. Record exec-units. On failure → break;
    //      `maxBatch` is the last successful N.
    //
    // Single-shot (`args.batchSize = N`): pre-seed N pairs without
    // probing in between, then run batch-N once. The pre-seed creates
    // are recorded as `update:<slug>:seed` steps (not probed individually),
    // and a single `update:batch:N` step captures the actual attempt.
    const ceilingForProbe = fixedBatchSize ?? PROBE_SAFETY_CAP;
    let maxBatch = 0;
    let probeFailedAt: number | null = null;

    for (let i = 0; i < ceilingForProbe; i++) {
      const pair = makeProbePair(i + 1);
      const size = i + 1;
      const intentPath = path.join(intentsDir, `${pair.slug}.signed.json`);
      const pairStatePath = path.join(pairsDir, `${pair.slug}.json`);

      // (1) bootstrap intent → (2) create the pair
      await runStep(steps, `intent:create-and-sign:${pair.slug}`, reportProgress, async () => {
        const { createAndSignPreviewOracleIntent } = await import(
          "../oracle/intent-create.js"
        );
        const signed = await createAndSignPreviewOracleIntent({
          statePath: protocolStatePath,
          intentType: "OracleUpdate",
          symbol: pair.symbol,
          price: pair.bootstrapPrice,
          source: DOMAIN_NAME,
        });
        await writeStateJsonFile(intentPath, signed);
      });

      await runTxStep(steps, `update:${pair.slug}`, reportProgress, async () => {
        const { submitOracleUpdate } = await import("../transactions/update.js");
        const state = await submitOracleUpdate({
          intentPath,
          statePath: pairStatePath,
          clientStatePath,
          protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(pairStatePath, state);
      });
      createdPairs.push(pair);

      // In single-shot mode we only run batch-N at the very end, not at
      // every intermediate size — those creates are "seeding".
      const runBatchHere = fixedBatchSize === undefined || size === fixedBatchSize;
      if (!runBatchHere) continue;

      // (3) fresh batch intents for every pair created so far, with
      // strictly-monotone (timestamp, nonce). One sub-step per intent.
      const batchIntentNow = await getNetworkNow(args.lucid);
      let batchIntentOffset = 60n + BigInt(size) * 10n;
      for (const created of createdPairs) {
        const batchIntentPath = path.join(intentsDir, `${created.slug}-batch-${size}.signed.json`);
        await runStep(
          steps,
          `intent:create-and-sign:${created.slug}:batch-${size}`,
          reportProgress,
          async () => {
            const { createAndSignPreviewOracleIntent } = await import(
              "../oracle/intent-create.js"
            );
            const timestamp = batchIntentNow.unixTimeSec + batchIntentOffset;
            // Nonce in nanoseconds (unixTimeMs ×1e6) — the same scale
            // `resolveIntentTimingFromNetwork` uses for the single-pair updates
            // above (DIA's real OracleIntent nonce unit). The per-pair offset keeps
            // each batch intent strictly above that pair's current on-chain nonce.
            const nonce =
              BigInt(batchIntentNow.unixTimeMs) * 1_000_000n + batchIntentOffset;
            batchIntentOffset += 1n;
            const signed = await createAndSignPreviewOracleIntent({
              statePath: protocolStatePath,
              intentType: "OracleUpdate",
              timestamp: timestamp.toString(),
              nonce: nonce.toString(),
              expiry: (timestamp + 3600n).toString(),
              symbol: created.symbol,
              price: created.batchPrice,
              source: DOMAIN_NAME,
            });
            await writeStateJsonFile(batchIntentPath, signed);
          },
        );
      }

      // (4) attempt batch-N
      const manifestPath = path.join(manifestsDir, `batch-${size}.manifest.json`);
      const resultPath = path.join(manifestsDir, `batch-${size}.result.json`);
      const updates = createdPairs.map((created) => ({
        statePath: path.join(pairsDir, `${created.slug}.json`),
        intentPath: path.join(intentsDir, `${created.slug}-batch-${size}.signed.json`),
      }));
      await writeFile(
        manifestPath,
        JSON.stringify({ updates }, null, 2) + "\n",
        "utf8",
      );

      let attemptOk = false;
      let attemptMetrics: TxResourceMetrics | undefined;
      let attemptError: string | undefined;

      try {
        await runTxStep(
          steps,
          `update:batch:${size}`,
          reportProgress,
          async () => {
            const { submitBatchOracleUpdate } = await import(
              "../transactions/update-batch.js"
            );
            const result = await submitBatchOracleUpdate({
              manifestPath,
              clientStatePath,
              protocolStatePath,
              buildOnly: false,
            });
            await writeStateJsonFile(resultPath, result);
            attemptOk = true;
          },
          (m) => {
            attemptMetrics = m;
          },
        );
      } catch (error) {
        attemptError = error instanceof Error ? error.message : String(error);
      }

      batchAttempts.push({
        size,
        ok: attemptOk,
        metrics: attemptMetrics,
        error: attemptError,
      });

      if (attemptOk) {
        maxBatch = size;
      } else {
        probeFailedAt = size;
        break;
      }
    }

    if (maxBatch === 0) {
      // Either probe failed at size 1, or single-shot batch-N failed. The
      // settle/withdraw/reclaim/republish/burn cluster needs accrued fees
      // from a successful batch, so we short-circuit and let the report
      // explain what happened.
      reportProgress(
        `[emulator-flow] no batch succeeded${
          probeFailedAt ? ` (failed at batch-${probeFailedAt})` : ""
        }; skipping settle + downstream steps`,
      );
      return finalize();
    }

    // ── Second client (client-b): onboard + accrue one fee ─────────
    // Minimal onboarding so a single multi-client settle can drain BOTH
    // client-a and client-b receivers into the shared payment hook in one tx:
    //   client:init → receiver:parameterize → receiver:bootstrap →
    //   reference-scripts:publish-client → receiver:top-up → ONE pair update.
    // The pair update charges `base + per_pair` to the receiver's
    // accrued_to_hook_lovelace, giving client-b a positive accrued balance to
    // settle alongside client-a.
    await runStep(steps, "client-b:client:init", reportProgress, async () => {
      const { initializeClientState } = await import("../init/client-init.js");
      const state = await initializeClientState({
        statePath: protocolStatePath,
        clientId: CLIENT_B_ID,
        useDefaults: true,
      });
      await writeStateJsonFile(clientBStatePath, state);
    });

    await runStep(steps, "client-b:receiver:parameterize", reportProgress, async () => {
      const { parameterizeReceiverScripts } = await import(
        "../deploys/receiver-parameterize.js"
      );
      const state = await parameterizeReceiverScripts({
        statePath: clientBStatePath,
        protocolStatePath,
      });
      await writeStateJsonFile(clientBStatePath, state);
    });

    await runTxStep(steps, "client-b:receiver:bootstrap", reportProgress, async () => {
      const { receiverBootstrap } = await import("../deploys/receiver-bootstrap.js");
      const state = await receiverBootstrap({
        statePath: clientBStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientBStatePath, state);
    });

    await runTxStep(steps, "client-b:reference-scripts:publish-client", reportProgress, async () => {
      const { publishClientReferenceScripts } = await import(
        "../deploys/client-reference-scripts.js"
      );
      const state = await publishClientReferenceScripts({
        statePath: clientBStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientBStatePath, state);
    });

    await runTxStep(steps, "client-b:receiver:top-up", reportProgress, async () => {
      const { receiverTopUp } = await import("../transactions/receiver-top-up.js");
      const state = await receiverTopUp({
        amountLovelace: CLIENT_B_TOP_UP_LOVELACE,
        statePath: clientBStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientBStatePath, state);
    });

    const clientBPair = makeProbePair(1);
    const clientBIntentPath = path.join(intentsDir, `client-b-${clientBPair.slug}.signed.json`);
    const clientBPairStatePath = path.join(clientBPairsDir, `${clientBPair.slug}.json`);
    await runStep(steps, "client-b:intent:create-and-sign", reportProgress, async () => {
      const { createAndSignPreviewOracleIntent } = await import(
        "../oracle/intent-create.js"
      );
      const signed = await createAndSignPreviewOracleIntent({
        statePath: protocolStatePath,
        intentType: "OracleUpdate",
        symbol: clientBPair.symbol,
        price: clientBPair.bootstrapPrice,
        source: DOMAIN_NAME,
      });
      await writeStateJsonFile(clientBIntentPath, signed);
    });

    await runTxStep(steps, "client-b:update", reportProgress, async () => {
      const { submitOracleUpdate } = await import("../transactions/update.js");
      const state = await submitOracleUpdate({
        intentPath: clientBIntentPath,
        statePath: clientBPairStatePath,
        clientStatePath: clientBStatePath,
        protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(clientBPairStatePath, state);
    });

    // ── Multi-client settle, withdraws, reclaim + republish ─────────
    // One tx drains BOTH client-a and client-b receivers (accrued -> 0) and
    // credits the sum to the shared payment hook. The coordinator validates
    // the SettleManifest (non-empty + unique + Σ-drained == hook delta). The
    // step asserts ok, and the post-settle reads below confirm both receivers
    // ended with accrued cleared.
    await runTxStep(steps, "settle:multi", reportProgress, async () => {
      const { settleAccruedFees } = await import("../transactions/settle.js");
      const result = await settleAccruedFees({
        protocolStatePath,
        clientStatePaths: [clientStatePath, clientBStatePath],
        buildOnly: false,
      });
      if (result.settledReceivers.length !== 2) {
        throw new Error(
          `settle:multi expected 2 settled receivers, got ${result.settledReceivers.length}`,
        );
      }
      for (const settled of result.settledReceivers) {
        if (BigInt(settled.drainedLovelace) <= 0n) {
          throw new Error(
            `settle:multi receiver ${settled.clientId} drained ${settled.drainedLovelace} (expected > 0)`,
          );
        }
      }
      // Both receivers must end with accrued cleared on disk.
      for (const [label, statePath] of [
        [CLIENT_ID, clientStatePath],
        [CLIENT_B_ID, clientBStatePath],
      ] as const) {
        const after = JSON.parse(await readFile(statePath, "utf8"));
        const accrued = BigInt(
          after?.receiver?.receiverState?.accruedToHookLovelace ?? "0",
        );
        if (accrued !== 0n) {
          throw new Error(
            `settle:multi ${label} accrued_to_hook_lovelace should be 0 after settle, got ${accrued}`,
          );
        }
      }
      reportProgress(
        `[emulator-flow] settle:multi drained 2 receivers (client-a + client-b), Σ=${result.totalSettledLovelace} lovelace -> payment hook`,
      );
    });

    // Withdraw amounts must respect what's actually available on-chain:
    //   - receiver: amount ≤ receiver.balance_lovelace
    //   - payment-hook: amount ≤ payment_hook.accrued_fees_lovelace
    // The constants above are "preferred" upper bounds. Clamp down to what
    // settle just deposited so this flow works for any batchSize (the smoke
    // test calls with batchSize: 1 which only accrues ~2 ADA, while a full
    // probe accrues much more). A 1 ADA buffer is kept to avoid bumping
    // into edge cases where the protocol leaves dust.
    const clampWithdraw = (preferred: string, availableLovelace: bigint): bigint => {
      const pref = BigInt(preferred);
      const buffer = 1_000_000n;
      const cap = availableLovelace > buffer ? availableLovelace - buffer : 0n;
      return pref < cap ? pref : cap;
    };

    const clientStateAfterSettle = JSON.parse(
      await readFile(clientStatePath, "utf8"),
    );
    const receiverBalance = BigInt(
      clientStateAfterSettle?.receiver?.receiverState?.balanceLovelace ?? 0,
    );
    const receiverWithdrawAmount = clampWithdraw(RECEIVER_WITHDRAW_LOVELACE, receiverBalance);
    if (receiverWithdrawAmount > 0n) {
      await runTxStep(steps, "receiver:withdraw", reportProgress, async () => {
        const { receiverWithdraw } = await import("../transactions/receiver-withdraw.js");
        const state = await receiverWithdraw({
          amountLovelace: receiverWithdrawAmount.toString(),
          statePath: clientStatePath,
          protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(clientStatePath, state);
      });
    } else {
      reportProgress("[emulator-flow] receiver:withdraw skipped (insufficient balance)");
    }

    const protocolStateAfterSettle = JSON.parse(
      await readFile(protocolStatePath, "utf8"),
    );
    const hookAccrued = BigInt(
      protocolStateAfterSettle?.paymentHookState?.accruedFeesLovelace ?? 0,
    );
    const hookWithdrawAmount = clampWithdraw(PAYMENT_HOOK_WITHDRAW_LOVELACE, hookAccrued);
    if (hookWithdrawAmount > 0n) {
      await runTxStep(steps, "payment-hook:withdraw", reportProgress, async () => {
        const { paymentHookWithdraw } = await import(
          "../transactions/payment-hook-withdraw.js"
        );
        const { artifact } = await paymentHookWithdraw({
          amountLovelace: hookWithdrawAmount.toString(),
          statePath: protocolStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(protocolStatePath, artifact);
      });
    } else {
      reportProgress("[emulator-flow] payment-hook:withdraw skipped (insufficient accrued)");
    }

    await runTxStep(steps, "reclaim:payment-hook-reference-script", reportProgress, async () => {
      const { reclaimProtocolReferenceScript } = await import(
        "../transactions/reclaim-reference-script.js"
      );
      const state = await reclaimProtocolReferenceScript({
        script: "payment-hook",
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "republish:payment-hook-reference-script", reportProgress, async () => {
      const { publishPaymentHookReferenceScript } = await import(
        "../deploys/payment-hook-reference-script.js"
      );
      const state = await publishPaymentHookReferenceScript({
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    // ── Full decommission / teardown ──────────────────────────────────
    // Exercises the whole recovery path on real Plutus and asserts it:
    //   settle (already drained accrued -> 0 via settle:multi above) →
    //   receiver:withdraw (drain each receiver balance to exactly 0) →
    //   payment-hook:withdraw (drain hook accrued to exactly 0) →
    //   pair:burn for every live pair (both clients) →
    //   receiver:burn for each client (now balance == 0 && accrued == 0) →
    //   payment-hook:burn (accrued_fees == 0) → config:burn →
    //   reclaim every reference script (client receiver/pair/pairMint/deposit
    //   for both clients, then the global payment-hook and config+coordinator).
    //
    // Each burn asserts the NFT supply dropped to zero (no UTxO with the unit
    // remains at its validator address) AND the operator wallet recovered the
    // locked min-ADA of the destroyed UTxO. Reclaims assert the reference-
    // holder UTxO is gone. Every step also rides the global "all steps ok"
    // assertion in the test harness.
    const { findSingleUtxoAtUnit: findUnitUtxo } = await import("../core/chain-helpers.js");
    const lucidForTeardown = args.lucid as never;

    // Resolve how many lovelace the wallet currently holds, so each burn can
    // assert the wallet grew by ~the recovered min-ADA (net of fees).
    const walletLovelace = async (): Promise<bigint> => {
      const utxos = await (args.lucid as {
        wallet(): { getUtxos(): Promise<Array<{ assets: Record<string, bigint> }>> };
      }).wallet().getUtxos();
      return utxos.reduce((acc, u) => acc + (u.assets.lovelace ?? 0n), 0n);
    };

    // Assert no UTxO carrying `unit` remains at `address` (NFT supply == 0
    // after a successful burn -1). Returns the recovered lovelace that had
    // been locked in the now-destroyed UTxO.
    const assertUnitGone = async (
      address: string,
      unit: string,
      label: string,
    ): Promise<void> => {
      const remaining = await (args.lucid as {
        utxosAtWithUnit(addr: string, u: string): Promise<unknown[]>;
      }).utxosAtWithUnit(address, unit);
      if (remaining.length !== 0) {
        throw new Error(
          `teardown: expected ${label} NFT ${unit} burned (no UTxO at ${address}), found ${remaining.length}`,
        );
      }
    };

    // Per-client teardown: drain the receiver to 0, burn all its pairs, then
    // burn the receiver. Returns nothing; throws on any assertion failure.
    const teardownClient = async (
      label: string,
      thisClientStatePath: string,
      thisPairsDir: string,
    ): Promise<void> => {
      const clientStateNow = JSON.parse(await readFile(thisClientStatePath, "utf8"));
      const receiver = clientStateNow.receiver as {
        receiverUnit: string;
        receiverValidatorAddress: string;
      };

      // (1) Drain the receiver balance to exactly 0 (settle already cleared
      // accrued). Read the live balance from chain so the amount is exact.
      const { decodeReceiverDatum, requireInlineDatum } = await import(
        "../core/chain-helpers.js"
      );
      const receiverUtxo = await findUnitUtxo(
        lucidForTeardown,
        receiver.receiverValidatorAddress,
        receiver.receiverUnit,
        "receiver",
      );
      const liveReceiver = decodeReceiverDatum(requireInlineDatum(receiverUtxo, "receiver"));
      const remainingBalance = BigInt(liveReceiver.balanceLovelace);
      if (remainingBalance > 0n) {
        await runTxStep(steps, `teardown:${label}:receiver:withdraw-all`, reportProgress, async () => {
          const { receiverWithdraw } = await import("../transactions/receiver-withdraw.js");
          const state = await receiverWithdraw({
            amountLovelace: remainingBalance.toString(),
            statePath: thisClientStatePath,
            protocolStatePath,
            buildOnly: false,
          });
          await writeStateJsonFile(thisClientStatePath, state);
        });
      }

      // (2) Burn every live pair for this client. Pair state files live in
      // `thisPairsDir`; a burned pair has its `datum.pairCbor` cleared by
      // pairBurn, so we skip those when re-running.
      let pairFiles: string[] = [];
      try {
        pairFiles = (await readdir(thisPairsDir)).filter((f) => f.endsWith(".json"));
      } catch {
        pairFiles = [];
      }
      for (const file of pairFiles) {
        const pairStatePath = path.join(thisPairsDir, file);
        const pairState = JSON.parse(await readFile(pairStatePath, "utf8"));
        if (!pairState?.pair?.pairUnit || !pairState?.datum?.pairCbor) {
          continue; // not a live pair (already burned or malformed)
        }
        const pairUnit = pairState.pair.pairUnit as string;
        const pairAddr = pairState.pair.pairValidatorAddress as string;
        await runTxStep(steps, `teardown:${label}:pair:burn:${file}`, reportProgress, async () => {
          const { pairBurn } = await import("../transactions/pair-burn.js");
          const state = await pairBurn({
            protocolStatePath,
            clientStatePath: thisClientStatePath,
            pairStatePath,
            buildOnly: false,
          });
          await writeStateJsonFile(pairStatePath, state);
          await assertUnitGone(pairAddr, pairUnit, `${label} pair`);
        });
      }

      // (3) Burn the receiver (balance == 0 && accrued == 0 now). Assert the
      // Receiver NFT is gone and the wallet recovered the locked min-ADA.
      await runTxStep(steps, `teardown:${label}:receiver:burn`, reportProgress, async () => {
        const before = await walletLovelace();
        const lockedMinUtxo = receiverUtxo.assets.lovelace ?? 0n;
        const { receiverBurn } = await import("../transactions/receiver-burn.js");
        const state = await receiverBurn({
          protocolStatePath,
          clientStatePath: thisClientStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(thisClientStatePath, state);
        if (state.receiver !== undefined) {
          throw new Error(`teardown:${label}:receiver:burn should clear the live receiver from client state`);
        }
        await assertUnitGone(
          receiver.receiverValidatorAddress,
          receiver.receiverUnit,
          `${label} receiver`,
        );
        const after = await walletLovelace();
        // Wallet must have grown overall (recovered the locked min-ADA net of
        // the tx fee). The recovered min-ADA dwarfs the emulator fee.
        if (after <= before) {
          throw new Error(
            `teardown:${label}:receiver:burn expected wallet to recover min-ADA (locked=${lockedMinUtxo}); before=${before} after=${after}`,
          );
        }
      });
    };

    await teardownClient(CLIENT_ID, clientStatePath, pairsDir);
    await teardownClient(CLIENT_B_ID, clientBStatePath, clientBPairsDir);

    // (4) Drain the payment hook accrued to exactly 0, then burn it. Read the
    // live hook datum so the withdraw amount is exact.
    {
      const { decodePaymentHookDatum, requireInlineDatum } = await import(
        "../core/chain-helpers.js"
      );
      const protocolNow = JSON.parse(await readFile(protocolStatePath, "utf8"));
      const hookUnit = protocolNow.scripts.paymentHookUnit as string;
      const hookAddr = protocolNow.scripts.paymentHookValidatorAddress as string;
      const hookUtxo = await findUnitUtxo(lucidForTeardown, hookAddr, hookUnit, "payment hook");
      const liveHook = decodePaymentHookDatum(
        requireInlineDatum(hookUtxo, "payment hook"),
        protocolNow.paymentHookState.withdrawAddress,
      );
      const hookAccrued = BigInt(liveHook.accruedFeesLovelace);
      if (hookAccrued > 0n) {
        await runTxStep(steps, "teardown:payment-hook:withdraw-all", reportProgress, async () => {
          const { paymentHookWithdraw } = await import(
            "../transactions/payment-hook-withdraw.js"
          );
          const { artifact } = await paymentHookWithdraw({
            amountLovelace: hookAccrued.toString(),
            statePath: protocolStatePath,
            buildOnly: false,
          });
          await writeStateJsonFile(protocolStatePath, artifact);
        });
      }

      await runTxStep(steps, "teardown:payment-hook:burn", reportProgress, async () => {
        const before = await walletLovelace();
        const { paymentHookBurn } = await import("../transactions/payment-hook-burn.js");
        const state = await paymentHookBurn({ protocolStatePath, buildOnly: false });
        await writeStateJsonFile(protocolStatePath, state);
        if (state.paymentHookState !== null) {
          throw new Error("teardown:payment-hook:burn should clear paymentHookState");
        }
        await assertUnitGone(hookAddr, hookUnit, "payment hook");
        const after = await walletLovelace();
        if (after <= before) {
          throw new Error(
            `teardown:payment-hook:burn expected wallet to recover min-ADA; before=${before} after=${after}`,
          );
        }
      });
    }

    // (5) Reclaim every published reference script back to the wallet —
    // BEFORE config:burn. The reference_holder validator reads the admin
    // signer off the live Config datum, so reclaims must run while the Config
    // UTxO still exists; once the Config NFT is burned the ref scripts could
    // never be reclaimed again. The per-client reclaim covers receiver + pair
    // + pairMint + deposit in one tx (proving the deposit ref-script reclaim
    // now that it is included). The global reclaims cover payment-hook and
    // config+coordinator.
    for (const [label, thisClientStatePath] of [
      [CLIENT_ID, clientStatePath],
      [CLIENT_B_ID, clientBStatePath],
    ] as const) {
      await runTxStep(steps, `teardown:reclaim:client:${label}`, reportProgress, async () => {
        const { reclaimClientReferenceScript } = await import(
          "../transactions/reclaim-reference-script.js"
        );
        const state = await reclaimClientReferenceScript({
          script: "client",
          protocolStatePath,
          statePath: thisClientStatePath,
          buildOnly: false,
        });
        await writeStateJsonFile(thisClientStatePath, state);
        // The deposit ref-script must have been part of the reclaim set: a
        // client that funded a side-deposit has a populated deposit outRef,
        // and a successful reclaim clears it.
        const deposit = state.referenceScripts?.client?.deposit;
        if (deposit && deposit.txHash) {
          throw new Error(
            `teardown:reclaim:client:${label} should clear the deposit reference-script outRef`,
          );
        }
      });
    }

    await runTxStep(steps, "teardown:reclaim:payment-hook-reference-script", reportProgress, async () => {
      const { reclaimProtocolReferenceScript } = await import(
        "../transactions/reclaim-reference-script.js"
      );
      const state = await reclaimProtocolReferenceScript({
        script: "payment-hook",
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    await runTxStep(steps, "teardown:reclaim:config-reference-script", reportProgress, async () => {
      const { reclaimProtocolReferenceScript } = await import(
        "../transactions/reclaim-reference-script.js"
      );
      const state = await reclaimProtocolReferenceScript({
        script: "config",
        statePath: protocolStatePath,
        buildOnly: false,
      });
      await writeStateJsonFile(protocolStatePath, state);
    });

    // (6) Burn the singleton Config NFT — the LAST teardown step (no value
    // precondition). The config reference script was just reclaimed, so this
    // builder attaches the config validator + mint policy inline. Assert the
    // Config NFT is gone and the wallet recovered the locked min-ADA.
    {
      const protocolNow = JSON.parse(await readFile(protocolStatePath, "utf8"));
      const configUnit = protocolNow.scripts.configUnit as string;
      const configAddr = protocolNow.scripts.configValidatorAddress as string;
      await runTxStep(steps, "teardown:config:burn", reportProgress, async () => {
        const before = await walletLovelace();
        const { configBurn } = await import("../transactions/config-burn.js");
        const state = await configBurn({ protocolStatePath, buildOnly: false });
        await writeStateJsonFile(protocolStatePath, state);
        await assertUnitGone(configAddr, configUnit, "config");
        const after = await walletLovelace();
        if (after <= before) {
          throw new Error(
            `teardown:config:burn expected wallet to recover min-ADA; before=${before} after=${after}`,
          );
        }
      });
    }

    return finalize();
  } finally {
    uninstallEmulatorLucid();
    if (!args.keepWorkDir && !args.workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  function finalize(): EmulatorProtocolFlowReport {
    return {
      workDir,
      workDirCleanedUp: !args.keepWorkDir && !args.workDir,
      steps,
      batchAttempts,
    };
  }
}

// Step variants — non-tx steps (init / parameterize / intent signing).
async function runStep(
  steps: EmulatorStepReport[],
  label: string,
  reportProgress: (message: string) => void,
  body: () => Promise<void>,
): Promise<void> {
  reportProgress(`[emulator-flow] ${label} start`);
  const startedAt = Date.now();
  try {
    await body();
    const durationMs = Date.now() - startedAt;
    steps.push({ label, durationMs, ok: true });
    reportProgress(`[emulator-flow] ${label} ok (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ label, durationMs, ok: false, error: message });
    reportProgress(`[emulator-flow] ${label} FAILED (${durationMs}ms): ${message}`);
    throw error;
  }
}

// Step variant for tx-submitting builders — captures exec-units via
// the `setTxMetricsObserver` hook. The observer fires synchronously
// inside `reportTxSignBuilderMetrics`, so we install it before the
// builder runs and clear it after, even on failure.
async function runTxStep(
  steps: EmulatorStepReport[],
  label: string,
  reportProgress: (message: string) => void,
  body: () => Promise<void>,
  metricsHook?: (metrics: TxResourceMetrics) => void,
): Promise<void> {
  reportProgress(`[emulator-flow] ${label} start`);
  const startedAt = Date.now();
  let captured: TxResourceMetrics | undefined;
  setTxMetricsObserver((m) => {
    captured = m;
    metricsHook?.(m);
  });
  try {
    await body();
    const durationMs = Date.now() - startedAt;
    steps.push({ label, durationMs, ok: true, metrics: captured });
    if (captured) {
      reportProgress(
        `[emulator-flow] ${label} ok (${durationMs}ms) fee=${captured.feeAda} ADA cpu=${captured.exUnits.cpu} mem=${captured.exUnits.mem}`,
      );
    } else {
      reportProgress(`[emulator-flow] ${label} ok (${durationMs}ms)`);
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ label, durationMs, ok: false, error: message, metrics: captured });
    reportProgress(`[emulator-flow] ${label} FAILED (${durationMs}ms): ${message}`);
    throw error;
  } finally {
    setTxMetricsObserver(null);
  }
}
