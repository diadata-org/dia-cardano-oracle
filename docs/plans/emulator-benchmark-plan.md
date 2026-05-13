# Emulator Benchmark Plan

## Purpose

Build an end-to-end harness that runs the same protocol flow as `offchain/cli/scripts/run-all-cli.sh` (config + payment-hook + receiver bootstrap, N single pair creates, batch update, settle, withdraws, reclaim/republish) against the in-memory Lucid emulator — **reusing the existing CLI builder functions verbatim**, not re-implementing them.

Primary deliverable: a single test entry point (under `offchain/cli/src/__tests__/emulator/`) that drives the full protocol flow, captures Plutus exec-units (`cpu`, `mem`) and fees for every transaction (especially the batch with N pairs), and emits a structured report so we can answer questions like "does batch-10 fit under the per-tx memory budget on the current bytecode?" in seconds, locally, without Preview.

## Why this matters

- **Speed**: a Preview rerun via `run-all-cli.sh` takes ~30–45 minutes and burns testnet ADA. The emulator runs the same Plutus VM in seconds, repeatable, free.
- **CI**: once it exists, every PR can run this benchmark automatically and flag exec-unit regressions before they hit Preview.
- **Closes work-plan item**: workstream A in `docs/plans/work-plan.md` has an open task — "Off-chain Lucid emulator adversarial matrix: full update / batch / settle / receiver top-up / receiver withdraw / hook withdraw / config-update transactions submitted through the Plutus VM with golden + every documented attack-vector negative case". This plan delivers the happy-path part of that task. Adversarial cases (negative-test matrix) can be layered on later using the same harness.

## Non-goals

- **No production refactor for emulator support**: env-based wallet/provider configuration for the real CLI must keep working unchanged. The emulator path is a parallel injection, not a replacement.
- **No fee accuracy claims**: emulator protocol parameters may differ from Preview/mainnet. The benchmark reports exec-units (which ARE the same VM) and uses fees only for relative comparisons.
- **No adversarial matrix in v1**: this plan delivers the happy path. Negative cases are a follow-up using the same harness skeleton.

## Approach — least-invasive dependency injection

The CLI builders (`offchain/cli/src/deploys/*.ts`, `offchain/cli/src/transactions/*.ts`, `offchain/cli/src/init/*.ts`) are tightly coupled to:

1. `makeConfiguredLucid()` — reads env vars, builds `Lucid(Blockfrost|Koios, "Preview")`.
2. `selectConfiguredWallet(lucid)` — reads `CARDANO_WALLET_SEED` / `CARDANO_PRIVATE_KEY` env vars.
3. `awaitTxConfirmation(...)` — calls `lucid.awaitTx` (works on emulator) then falls back to Koios/Blockfrost HTTP (only reachable on fallback path).
4. `getNetworkNow(lucid)` — reads slot from lucid; emulator slot starts at 0 unless set.

Key discoveries already validated:
- **Builder functions are pure with respect to disk writes**: each returns a fresh state artifact; the CLI command layer (`src/index.ts`) is what writes JSON to disk. The emulator orchestrator can chain builders by passing returned state in memory.
- **`awaitTxConfirmation` works on emulator**: Lucid's `Emulator.awaitTx` is implemented to auto-mine when the tx is in mempool and return `Promise.resolve(true)` immediately (see `node_modules/@lucid-evolution/provider/dist/index.js:1233-1239`). So the `getCliConfig()` HTTP-fallback path is never reached on emulator and we don't need to set `BLOCKFROST_PROJECT_ID`.
- **Builders read state via optional `statePath`**: if undefined, an initial state object is used. Returning state objects in-memory is the natural mode for the test harness.
- **Existing emulator harness is minimal**: `offchain/cli/src/__tests__/emulator/harness.ts` already provides `makeOracleEmulatorLucid`, `emulatorMineBlock`, `emulatorSubmitAndMine`, `makeOracleEmulatorWithReferenceScriptRow`. Only two trivial smoke tests use it today.

## Implementation steps

Each step is independently committable. Acceptance is `npm run typecheck` + `npm test` green, except where noted. Do not skip steps.

### Step 1 — Injectable Lucid + wallet factories

Edit `offchain/cli/src/core/lucid.ts`:

- Introduce two module-level mutable factories defaulting to today's behavior:
  - `lucidFactory: () => Promise<LucidEvolution>` defaulting to `makeRealConfiguredLucid` (renamed from the existing body of `makeConfiguredLucid`).
  - `walletSelector: (lucid) => Promise<"seed" | "private-key">` defaulting to `selectRealConfiguredWallet`.
- Export `setLucidFactoryForTesting(factory)` and `setWalletSelectorForTesting(selector)` plus `resetLucidFactoriesForTesting()`.
- Keep the existing `makeConfiguredLucid` / `selectConfiguredWallet` exported signatures unchanged — they internally delegate to the current factory references. Callers don't change.
- The "real" implementations stay in this file and remain the default — production CLI behavior is bit-for-bit identical.

Acceptance:
- All existing call sites of `makeConfiguredLucid` / `selectConfiguredWallet` compile and behave identically.
- `npm test` still passes (existing emulator smoke tests untouched).

### Step 2 — Emulator-aware Lucid factory + wallet selector

Add to `offchain/cli/src/__tests__/emulator/harness.ts` (or a new sibling module):

- `installEmulatorLucidFactory(context: OracleEmulatorContext)` — calls `setLucidFactoryForTesting(() => Promise.resolve(context.lucid))` AND `setWalletSelectorForTesting(async (lucid) => { lucid.selectWallet.fromSeed(context.accounts[0].seedPhrase); return "seed"; })`. Picks the primary genesis account as the protocol-admin wallet.
- `uninstallEmulatorLucidFactory()` — calls `resetLucidFactoriesForTesting()`. Tests MUST call this in `finally`.
- Helper `advanceEmulator(emulator, slots)` to bump slot/time deterministically between batched txs (relevant for `getNetworkNow` and intent expiry validity bounds).

Acceptance: a smoke test in `run-tests.ts` calls `installEmulatorLucidFactory`, runs a trivial wallet-funded transfer through the CLI's `lucid` helpers, then uninstalls. Verifies install/uninstall are reversible.

### Step 3 — DIA signing key: reuse `DIA_EVM_PRIVATE_KEY` from `.env`

No fixture, no generation. The `run-all-cli.sh` bash script just reads `DIA_EVM_PRIVATE_KEY` from `.env` and uses it for both signing intents and registering the corresponding public key as authorized signer in the Config datum. The emulator benchmark does the same: read `process.env.DIA_EVM_PRIVATE_KEY`, fail with a clear error if missing.

This step is essentially a sanity check before Step 4: confirm the env var is present and document it as a prerequisite for the new `npm run benchmark:emulator` script.

### Step 4 — Build the orchestrator skeleton

New file: `offchain/cli/src/__tests__/emulator/protocol-flow.ts`.

Exports `runEmulatorProtocolFlow(options)` that, given an `OracleEmulatorContext`, runs the full happy-path flow in order, chaining state in memory:

1. `initializeProtocolState({ authorizedDiaPublicKey: fixture.publicKeyHex, ... })`.
2. `parameterizeConfigScripts({ statePath: undefined, previousState: protocol })` — accept the state object directly. (If the function only accepts `statePath`, add an alternative arg that takes the state object — pure additive change.)
3. `configBootstrap({ statePath: undefined, ..., previousState: ... })`.
4. `publishConfigReferenceScripts(...)`.
5. `parameterizePaymentHookScripts(...)`.
6. `paymentHookBootstrap(...)`.
7. `publishPaymentHookReferenceScript(...)`.
8. `initializeClientState(...)`.
9. `parameterizeReceiverScripts(...)`.
10. `receiverBootstrap(...)`.
11. `publishClientReferenceScripts(...)`.
12. `receiverTopUp(...)` — first top-up.
13. For each pair in the configured list (`USDC/USD`, `BTC/USD`, ... up to 11 pairs as the Preview run): sign intent via fixture, call `update(...)` to bootstrap the Pair UTxO.
14. `receiverTopUp(...)` — second top-up before batch.
15. For batch size N = 10, 9, 8, 7 (descending, matching `run-all-cli.sh`): build manifest in memory, call `updateBatch(...)`, capture exec-units + result. Break on the first success and continue from there.
16. `settle(...)`.
17. `receiverWithdraw(...)`.
18. `paymentHookWithdraw(...)`.
19. `reclaimReferenceScript(payment-hook)`.
20. `publishPaymentHookReferenceScript(...)` republish.

Each step calls `emulator.awaitBlock(1)` after submission (already inside the builder if it uses `awaitTxConfirmation`, which auto-mines on emulator).

The orchestrator returns a `FlowReport` with per-step `{ label, txHash, feeLovelace, exUnits: { cpu, mem }, success: boolean, error?: string }`.

**Likely required minor refactor**: some builder functions read only `args.statePath`. Add an optional `args.previousState` alongside, used when `statePath` is undefined. Zero behavior change for existing callers. Mark each touched file in this plan as it happens.

Acceptance: the orchestrator runs end-to-end in the emulator without errors up to and including the first single-pair update. Capture this as the "first checkpoint" — even partial completion is meaningful, because each step that passes proves the script context, datum encoding, and intent signing are all wired correctly in emulator mode.

### Step 5 — Batch benchmark reporter

Wrap the orchestrator: `runEmulatorBenchmark(options)` that:

1. Runs the bootstrap path (steps 1–13) once.
2. After all single-pair creates are done, repeatedly builds batch txs from size 7 → 10 (matching the Preview narrative), but DOES NOT submit them. Instead calls `.complete()` (build-only) to capture exec-units, then logs and discards. This avoids polluting the ledger state between attempts.
3. Emits a Markdown + JSON report (same shape as `docs/milestones/evidence/m1-fee-benchmark-<id>/fee-report.{md,json}`) but generated by JS from the in-memory results.

Acceptance:
- `npm run cli:emulator:benchmark` (new script in `package.json`) runs in under 60 seconds and writes the report under `docs/milestones/evidence/m1-emulator-benchmark-<id>/`.
- Each batch size's actual exec-units are present in the JSON.
- Failures (over-budget) are reported with the specific `Mem` / `CPU` overage.

### Step 6 — Wire into test suite

Add the benchmark as a regular Node test (executed by `npm test`) but guarded by an env var `EMULATOR_BENCHMARK=1` so it doesn't slow normal test runs.

Update `docs/plans/work-plan.md` to mark the happy-path portion of "Off-chain Lucid emulator adversarial matrix" as complete and point to this plan.

### Step 7 — Documentation pass

- Update `contracts/aiken/README.md` and `offchain/cli/README.md` if any new commands are added.
- Update `docs/plans/audit-remediation-and-architecture-plan.md` Phase 3 → mark the "Benchmark batches 7, 8, 9, and 10" task as Done when the orchestrator reports the new exec-units.
- Add a "Local emulator benchmark" section to `docs/architecture/cardano-oracle-architecture.md` (or to the architecture's appendix) explaining what is measured and what guarantees the emulator gives (Plutus VM identity) and does not give (network fees).

## Structure (decided)

The benchmark is a **standalone TS script**, not a test. Reasons: tests pass/fail (benchmarks report numbers regardless), tests must stay fast, and the existing repo convention is scripts under `offchain/cli/scripts/` (`run-all-cli.sh`, `fee-benchmark.sh`). No bash wrapper — the emulator runs in one TS process, so bash adds nothing.

```text
offchain/cli/
├── scripts/
│   ├── fee-benchmark.sh           (untouched)
│   ├── run-all-cli.sh             (untouched)
│   └── emulator-benchmark.ts      ← NEW. Entry point of `npm run benchmark:emulator`.
│
├── src/
│   ├── emulator/                  ← NEW. Reusable helpers (NOT test-only).
│   │   ├── lucid-injection.ts     (install/uninstall the emulator as the CLI's lucid backend)
│   │   ├── protocol-flow.ts       (orchestrator — calls existing CLI builders in order)
│   │   └── report.ts              (writes fee-report.{md,json} mirroring fee-benchmark.sh output)
│   │
│   └── __tests__/
│       └── emulator/
│           ├── harness.ts          (existing — kept here for now, smoke tests still use it)
│           └── smoke.test.ts       ← OPTIONAL. Runs the orchestrator with batch-1 only.
```

`package.json`:

```json
"scripts": {
  "benchmark:emulator": "tsx scripts/emulator-benchmark.ts"
}
```

## Files most likely to be touched

Production code (additive only, no behavior change on the env path):

- `offchain/cli/src/core/lucid.ts` — injectable factories.
- `offchain/cli/src/init/protocol-init.ts` — already accepts explicit `authorizedDiaPublicKey`; verify and use.
- `offchain/cli/src/deploys/*.ts` — add optional `previousState` arg alongside `statePath` where needed.
- `offchain/cli/src/transactions/*.ts` — same as above.

New emulator helpers (not test-only):

- `offchain/cli/src/emulator/lucid-injection.ts` — `installEmulatorLucid(context)` + `uninstallEmulatorLucid()`.
- `offchain/cli/src/emulator/protocol-flow.ts` — orchestrator that drives the same sequence of CLI builders that `run-all-cli.sh` invokes.
- `offchain/cli/src/emulator/report.ts` — report generator (MD + JSON, same shape as `fee-benchmark.sh`).

Entry point:

- `offchain/cli/scripts/emulator-benchmark.ts` — new standalone TS script. Runs the orchestrator, captures exec-units, writes the report.

Test-only:

- `offchain/cli/src/__tests__/emulator/smoke.test.ts` — optional fast smoke test (batch-1) for CI, sharing the orchestrator from `src/emulator/`.
- `offchain/cli/src/__tests__/run-tests.ts` — register the smoke test if added.

Config:

- `offchain/cli/package.json` — add `benchmark:emulator` script.

Docs:

- `docs/plans/work-plan.md` — mark progress.
- `docs/plans/audit-remediation-and-architecture-plan.md` — Phase 3 follow-up.
- `docs/architecture/cardano-oracle-architecture.md` — appendix on emulator benchmarking.
- `contracts/aiken/README.md` — optional pointer to the local benchmark.
- `offchain/cli/README.md` — optional pointer to the local benchmark command.

## Open technical questions to resolve as you go

- **Slot / time progression in emulator**: do `intent_expiry_satisfied` checks need `validFrom`/`validTo` ranges that fit inside the emulator's clock? The existing single/batch update builders call `getNetworkNow(lucid)` and then set `validFrom`/`validTo` around that. On emulator, `getNetworkNow` should return the current emulator slot — verify with a one-off test before assuming it works.
- **Reference inputs**: bootstrap publishes reference scripts at the `reference_holder` address. The batch update reads them as reference inputs. Verify the emulator handles reference-input UTxOs correctly (it should — `awaitBlock` settles outputs to the ledger including the script ref).
- **Mint policy parameterization**: `parameterizeConfigScripts` etc. compute script hashes from the seed UTxO ref. The seed UTxO ref in emulator is whatever the bootstrap input is; chain it through correctly.
- **Collateral**: emulator should handle collateral automatically given a funded wallet. Watch for "no collateral available" errors and pre-seed a small UTxO if needed.

## Suggested commit boundaries

1. Step 1 — "feat(cli): make Lucid + wallet factories injectable (additive, no behavior change)."
2. Step 2 — "test(emulator): install/uninstall Lucid factory + harness smoke test."
3. Step 3 — "test(emulator): DIA EVM key fixture + signing smoke test."
4. Step 4 — "test(emulator): protocol-flow orchestrator (bootstrap + first single update)."
5. Step 4 cont. — "test(emulator): full protocol-flow orchestrator (all 11 singles + batch + settle + withdraws)."
6. Step 5 — "test(emulator): batch benchmark reporter + JSON/MD output."
7. Step 6 — "test: register emulator benchmark behind EMULATOR_BENCHMARK=1 env flag."
8. Step 7 — "docs: document local emulator benchmark."

Each commit independently passes `npm run typecheck` + `npm test`.

## Status

Step 0 — analysis: **Done**. Findings captured in this plan.

Step 1+ — implementation: **Implemented for local run-all coverage**. The emulator entry point drives the same builder modules as the CLI flow, bootstraps 11 pairs, attempts batch sizes `10,9,8,7,6,5` in descending order, continues after failed larger batches, and emits `fee-report.json` / `fee-report.md`.

## Pointers for the next agent

- The current refactor work on `valid_batch_update` (Phase 3 of `audit-remediation-and-architecture-plan.md`) is **complete** at the on-chain level: one filter pass over outputs, one over inputs, one walk over witnesses in lockstep; the same walk now validates shared receiver, shared pair policy, strict order, and intent expiry.
- `pair_state.spend.ApplyUpdate` no longer carries a `witness_index` field. The per-pair coordinator-redeemer decode that earlier interfaces (witness-index + `pair_intent_satisfied_at`) still paid is replaced by `coordinator_in_update_mode`, which uses the `CoordinatorRedeemerFingerprint` type to decode only the outer `CoordinatorRedeemer` constructor tag (rejecting `ApplySettle`). The spend body also dropped its `next_datum` decoding, the duplicate `receiver_input_present` check, and the local intent-expiry re-assertion — all of those are owned by the coordinator's batch walk.
- Latest local emulator evidence on the current bytecode: batch-10 succeeds with `cpu=4,295,001,740 (42.9% of 10B)` and `mem=10,810,449 (67.6% of 16M)`; settle, withdraws, reclaim and republish all run after the batch with the usual margins.
- The user prefers terse responses, no trailing summaries, and surgical edits. Memory feedback rules (`~/.claude/projects/.../memory/`) apply.
- Never touch evidence directories `m1-preview-20260427/` or `preview_20260504/` (preserved baselines).
- Plutus V3 ledger reorders `tx.inputs` by `OutputReference`; the new `valid_batch_update` accounts for this. Off-chain pair outputs ARE in canonical witness order because the builder emits them in `sortBatchUpdatesByPairTokenName` order and the ledger preserves output order.
