# Multi-wallet pool, per-UTxO locking, and main→pool funding

Status: **in progress**. Owner: feeder. On-chain change: **none**.

This plan is written to be executed step by step. Each phase lists the exact
files, function signatures, tests, acceptance criteria, and a QA gate. Follow the
[norms checklist](#norms-checklist) on every change.

## Contents

- [Problem](#problem)
- [Goal and invariants](#goal-and-invariants)
- [Terminology](#terminology)
- [Money loop (end to end)](#money-loop-end-to-end)
- [Architecture](#architecture)
- [Configuration model: YAML vs constants](#configuration-model-yaml-vs-constants)
  - [YAML (operator-facing)](#yaml-operator-facing)
  - [Constants (structural defaults)](#constants-structural-defaults)
- [Core components](#core-components)
- [The funding logic: when, how much, how](#the-funding-logic-when-how-much-how)
- [Lifecycle generalization (per wallet)](#lifecycle-generalization-per-wallet)
- [Observability (per wallet)](#observability-per-wallet)
- [Phases](#phases)
  - [Phase 0 — Wallet-pool config](#phase-0--wallet-pool-config)
  - [Phase 1 — Arbiter core (pure, TDD)](#phase-1--arbiter-core-pure-tdd)
  - [Phase 2 — Build-seam integration](#phase-2--build-seam-integration)
  - [Phase 3 — Per-wallet lifecycle and main→pool funding](#phase-3--per-wallet-lifecycle-and-mainpool-funding)
  - [Phase 4 — Per-wallet observability](#phase-4--per-wallet-observability)
  - [Phase 5 — Docs and verification](#phase-5--docs-and-verification)
- [Patterns to mirror](#patterns-to-mirror)
- [QA gates](#qa-gates)
- [Norms checklist](#norms-checklist)
- [Audit anchors](#audit-anchors)

## Problem

The feeder signs every Cardano oracle-update tx with one shared signer wallet.
Lanes are serial per receiver but run in parallel across clients, and every lane's
tx draws fee + collateral inputs from that one wallet. Two lanes building
concurrently let Lucid auto-select the same wallet UTxO; the first tx to confirm
consumes it and the second is rejected with `BadInputsUTxO` / `UtxoNotFound`. The
infrequent client keeps losing the race and stalls.

Per-receiver lane parallelism is correct and must stay. The fix is a shared
arbitration layer over the wallet inputs, plus a pool of signer wallets and an
intelligent funding loop that keeps every pool wallet usable.

## Goal and invariants

- Pay fee + collateral from a **pool of N signer wallets**, choosing per tx with
  this priority: **(1) a free wallet, then (2) free UTxOs of a busy wallet, then
  (3) a transient "unavailable" that the lane retries shortly** — never a failed
  intent.
- **Per-receiver lane parallelism is preserved**, and improved: even a one-wallet
  pool runs lanes in parallel by partitioning that wallet's UTxOs.
- Generalize the whole single-wallet lifecycle (consolidate, settle, withdraw,
  balance/collateral tracking, alerts) to N wallets — every metric and alert
  carries a `wallet` label.
- Keep pool wallets funded from the **main** wallet automatically and
  intelligently (when/how-much/how below), all tunable from YAML.
- **No on-chain change**: the protocol PaymentHook keeps its single
  `withdrawAddress` (the main wallet).

## Terminology

- **Main wallet** — the single wallet registered on-chain as the PaymentHook
  `withdrawAddress`. Protocol-fee withdraws land here. Exactly one. Role `main`.
- **Pool wallets** — additional signer wallets that only pay tx fees + collateral.
  Role `pool`. Zero or more. The main wallet is also usable for paying fees.
- **Reservation** — `{ walletId, signer, address, utxos }` handed out by the
  arbiter for one build; released on confirm/fail.
- **Spendable lovelace** — a wallet's total lovelace in pure-ADA UTxOs that are
  not currently locked, i.e. what a new tx can actually draw on.

## Money loop (end to end)

```
client deposit ──▶ Receiver.balance ──(AccrueFee per update)──▶ Receiver.accrued
        │
        ▼ settle (admin)                              auto-settle when accrued high
   PaymentHook.accrued ──(payment-hook:withdraw)──▶ MAIN wallet
        │                                            auto-withdraw when accrued high
        ▼ fund-pool (main → pool)                    fan-out when a pool wallet is low
   POOL wallets ──(pay fee + collateral)──▶ oracle update txs
```

Settle and withdraw already exist and already self-fund the single wallet. This
plan adds the last hop: **fund-pool** (main → pool wallets) and the arbitration so
N wallets pay fees in parallel.

## Architecture

New code is isolated under `offchain/feeder/src/submitter/wallet/`. Nothing in the
oracle-update build/submit path changes shape except the wallet it signs with,
which moves from a static per-router lookup to an arbiter reservation.

- `utxo-lock-table.ts` — per-UTxO locks (mirror of `inflight.ts`).
- `wallet-pool.ts` — wallet registry + per-wallet UTxO cache + flags.
- `wallet-arbiter.ts` — `acquire()` / `release()` with the 3-tier priority.
- `pool-funding.ts` — **pure** trigger deciding when/how-much to fund a pool
  wallet from the main (mirror of `auto-remediation.ts`).
- `fund-pool-wallet` CLI tx — the main→pool payment, reused by the bridge.

The arbiter, lock table, and pool are constructed once in `daemon-cmd.ts` and
threaded into the queue manager / write client exactly like `inflightTable` and
`symbolInflight` are today.

## Configuration model: YAML vs constants

Two tiers, no inline values anywhere.

### YAML (operator-facing)

In `infrastructure.<network>.yaml`. These are the knobs an operator tunes per
deployment and must be visible.

```yaml
# The signer-wallet pool. Exactly one role: main. Order is cosmetic.
wallets:
  - id: main
    role: main
    private_key_env: CARDANO_WALLET_SEED_TESTNET
  - id: pool-1
    role: pool
    private_key_env: CARDANO_WALLET_SEED_TESTNET_POOL_1
  - id: pool-2
    role: pool
    private_key_env: CARDANO_WALLET_SEED_TESTNET_POOL_2

# Main → pool funding band + guards. All lovelace.
wallet_pool:
  pool_wallet_low_lovelace: 50000000        # below this a pool wallet is topped up
  pool_wallet_target_lovelace: 200000000    # fill brings it up to this
  main_wallet_reserve_lovelace: 100000000   # main never funds below this
  pool_fund_min_interval_ms: 300000         # per-wallet cooldown between fund txs
```

Rules (mirror the existing `alerting.*` / `worker_pool.*` handling):

- Every YAML key has a **named constant default** in `config/constants.ts`
  (`DEFAULT_…`). A missing key falls back to the constant; a missing `wallets:`
  block degenerates to a one-wallet pool built from `CARDANO_WALLET_SEED_<NET>`
  (today's single-wallet behaviour, now expressed as a 1-entry pool).
- `pool_wallet_low_lovelace`, `pool_wallet_target_lovelace`,
  `main_wallet_reserve_lovelace` feed alert thresholds and dashboard panels and
  are covered by the threshold-drift test (extend it).

### Constants (structural defaults)

In `offchain/feeder/src/config/constants.ts`, each with a docstring naming its
YAML key (if any) or why it is constant-only. NO magic numbers in code.

- Defaults for the YAML keys: `DEFAULT_POOL_WALLET_LOW_LOVELACE`,
  `DEFAULT_POOL_WALLET_TARGET_LOVELACE`, `DEFAULT_MAIN_WALLET_RESERVE_LOVELACE`,
  `DEFAULT_POOL_FUND_MIN_INTERVAL_MS`.
- Structural tunables (constant-only, deliberately NOT in YAML to keep it lean):
  - `RESERVED_UTXOS_PER_TX` — how many pure-ADA UTxOs the arbiter reserves per
    build (default 2: one fee input + one collateral-capable input).
  - `MIN_COLLATERAL_UTXO_LOVELACE` — smallest UTxO eligible as collateral
    (aligns with `admin_wallet_min_collateral_lovelace`; reuse if already exported).
  - `WALLET_SELECTION_STRATEGY` — `"round-robin"` ordering of free wallets.
  - The UTxO-lock TTL reuses `worker_pool.inflight_timeout_ms` (no new key).

## Core components

| Module | Responsibility | Mirrors |
|---|---|---|
| `utxo-lock-table.ts` ✅ | lock/release individual wallet UTxOs by `walletId:outRef`, TTL | `inflight.ts` |
| `wallet-pool.ts` ✅ | registry (1 main, unique ids), UTxO cache, consolidation flag | — |
| `wallet-arbiter.ts` | `acquire()` 3-tier priority + `release()` | `inflight` + `symbol-inflight` usage |
| `pool-funding.ts` | pure `shouldFundPoolWallet()` decision | `auto-remediation.ts` |
| `fund-pool-wallet` (CLI) | main→pool payment tx | `settle.ts` / `payment-hook-withdraw.ts` |

## The funding logic: when, how much, how

A **pure** decision function (so it is fully unit-testable, like the
`auto-remediation.ts` triggers), evaluated per pool wallet on the existing
balance-refresh tick.

```ts
// pool-funding.ts
export type FundDecision =
  | { act: true; amountLovelace: bigint }
  | { act: false; reason: "above_low" | "in_progress" | "cooldown"
        | "main_insufficient" | "disabled" };

export function shouldFundPoolWallet(input: {
  poolWalletSpendableLovelace: bigint;
  mainWalletSpendableLovelace: bigint;
  lowLovelace?: bigint;          // YAML pool_wallet_low_lovelace
  targetLovelace?: bigint;       // YAML pool_wallet_target_lovelace
  mainReserveLovelace?: bigint;  // YAML main_wallet_reserve_lovelace
  inProgress: boolean;
  lastFundedAtMs?: number;
  nowMs: number;
  minIntervalMs?: bigint;        // YAML pool_fund_min_interval_ms
}): FundDecision;
```

- **WHEN**: act when `poolWalletSpendable < low` AND not `inProgress` AND the
  per-wallet cooldown elapsed (`now - lastFundedAt >= minInterval`). The low→target
  band gives hysteresis so a wallet is not refilled on every tick.
- **HOW MUCH**: `amount = target - poolWalletSpendable` (fill to target). One fill
  lasts many updates, minimising funding txs. Capped so the main keeps its reserve.
- **MAIN GUARD**: only act if `mainSpendable - amount >= mainReserve`. Otherwise
  `reason: "main_insufficient"` and raise `MainWalletCannotFundPool` (critical) —
  the operator must top up the main (settle + withdraw, or external).
- **HOW**: a `fundPoolWallet(mainSigner, toAddress, amount)` tx = a plain payment
  from the main to the pool wallet's address. Built/signed by the main wallet,
  arbitrated through the same wallet arbiter (the main is a pool participant), and
  enqueued on a maintenance lane via `enqueueLaneTask`, exactly like settle /
  withdraw / consolidate are today. `inProgress` is a per-wallet guard (mirror the
  single `consolidateInProgress` / `withdrawInProgress`, now keyed by wallet).

The main itself is replenished by the existing auto-withdraw (PaymentHook accrued
→ main). So no new on-chain mechanism is needed — fund-pool is the only new tx and
it is an ordinary payment.

## Lifecycle generalization (per wallet)

Everything single-wallet today becomes per-wallet, keyed by `walletId`:

- `snapshotBalances` / `capturePostConfirmState` → return one snapshot per wallet.
- `consolidateWallet`, `settle`, `payment-hook-withdraw` bridge + CLI functions →
  take a **wallet selector** (today none; they implicitly use the global wallet).
- Auto-remediation loops over all wallets: each pool/main wallet consolidates when
  fragmented; per-wallet in-progress guards replace the single flags.
- Keep-alive: consolidation + funding guarantee each wallet retains a
  collateral-capable UTxO and stays above its low band.

## Observability (per wallet)

- Add a `wallet` label to `cardano_admin_wallet_lovelace` and
  `cardano_admin_wallet_max_utxo_lovelace`; the balance-refresh tick emits one
  series per wallet.
- Alerts `AdminWalletLow` / `AdminWalletFragmented` carry the `wallet` label (fire
  per wallet). New alerts: `MainWalletCannotFundPool` (critical),
  `PoolWalletLow` (warning — fan-out should self-heal), and a pool-utilization /
  lock-contention gauge for visibility.
- New metrics: `cardano_wallet_pool_reservations` (per wallet, gauge),
  `cardano_wallet_pool_acquire_unavailable_total` (counter),
  `cardano_pool_fund_total{wallet,outcome}` (counter).
- Dashboard: a `$wallet` template variable; the two admin-wallet panels become
  per-wallet; a pool-overview row (free/busy, spendable per wallet, fund events).
- Thresholds stay per-network in YAML; `generate-monitoring` writes them and the
  threshold-drift test guards them (extend for the new keys).

## Phases

Each phase ends with a [QA gate](#qa-gates). Do not start the next phase until the
gate is green.

### Phase 0 — Wallet-pool config

- `config/types.ts`: `WalletPoolConfig` (`wallets: WalletConfigEntry[]`,
  `wallet_pool: { pool_wallet_low_lovelace?, pool_wallet_target_lovelace?,
  main_wallet_reserve_lovelace?, pool_fund_min_interval_ms? }`).
- `config/validate.ts`: exactly one `role: main`; unique ids; each
  `private_key_env` present; band sanity (`low < target`, `reserve >= 0`).
- `config/constants.ts`: the `DEFAULT_*` + structural constants above.
- Loader (`daemon-cmd.ts` or a new `wallet/load-pool.ts`): build `PoolWallet[]`,
  resolving each `private_key_env` via the existing signer-kind inference; derive
  each address with the existing Lucid helper. Degenerate to a 1-entry pool when
  `wallets:` is absent.
- **Tests**: validation (missing/duplicate main, dup ids, bad band), loader
  (degenerate single wallet, multi-wallet, env resolution), constants present.
- **Acceptance**: `make` config loads on Preview + Mainnet yaml unchanged
  (degenerate path), and with a multi-wallet block.

### Phase 1 — Arbiter core (pure, TDD)

- `utxo-lock-table.ts` ✅ (8/8). `wallet-pool.ts` ✅ (5/5) — rename role
  `treasury`→`main` for protocol coherence.
- `wallet-arbiter.ts`:
  ```ts
  export type WalletReservation = {
    reservationId: string; walletId: string;
    signer: RouterSigner; address: string; utxos: WalletUtxo[];
  };
  export type AcquireResult = WalletReservation | { unavailable: true };
  export type WalletArbiter = {
    acquire(): AcquireResult;
    release(r: WalletReservation, settled: {
      consumedOutRefs: string[]; producedUtxos: WalletUtxo[];
    }): void;
    stats(): { wallets: Array<{ walletId: string; reservations: number; spendableLovelace: bigint }> };
  };
  export function createWalletArbiter(deps: {
    pool: WalletPool; lockTable: UtxoLockTable;
    reservedUtxosPerTx?: number; minCollateralLovelace?: bigint;
    lockTtlMs: number; now?: () => number;
  }): WalletArbiter;
  ```
  `acquire()`: compute each wallet's spendable = cache − locked; pick a **free**
  usable wallet (round-robin), else a **busy** wallet with enough free pure-ADA
  UTxOs; reserve `RESERVED_UTXOS_PER_TX` UTxOs (incl. ≥1 collateral-capable) under
  a fresh `reservationId`; else `{ unavailable: true }`. `release()`: drop locks
  for the reservation, then refresh the wallet's cache (remove consumed, add
  produced change).
- **Tests (many)**: free-first; fallback to busy wallet's free UTxOs; two acquires
  on a one-wallet pool → disjoint subsets, both with collateral; locked outRef
  never re-allocated; exhaustion → unavailable; main excluded when below reserve;
  release returns capacity and refreshes cache; TTL eviction unblocks; round-robin
  fairness; consolidating wallet skipped.
- **Acceptance**: arbiter + lock table + pool fully unit-tested, no chain deps.

### Phase 2 — Build-seam integration

Architect-reviewed, line-precise. The bridge is stateless/per-call: every
`submitOracleUpdate` / `submitOracleUpdateBatch` builds a fresh Lucid. So the
arbiter is injected into `createRealOracleIntentBridge` (not the write client),
and each call acquires at the connect step and releases in a `finally`.

1. **Acquire + wallet selection** — in `lib-bridge/index.ts` replace the connect
   block (`:521-531` single; `:939-947` batch): `acquire()` right after
   `onStep("connecting")`; if `{ unavailable: true }` throw `WalletUnavailableError`
   (done) before any chain work. Build Lucid from the base `getCliConfig()` (no
   per-router signer); select the key with `selectWallet.fromSeed/fromPrivateKey`
   from `reservation.signer`; set `walletAddress = reservation.address`.
2. **overrideUTxOs needs full Lucid `UTxO`** (the arbiter's `WalletUtxo` is
   minimal) → keep the live `wallet.getUtxos()` fetch (`:527`) and **filter it to
   `reservation.utxos` outRefs** to get real `UTxO[]` for `lucid.overrideUTxOs(...)`.
   If a reserved outRef is missing from the live fetch (provider lag) and that
   leaves too few inputs, throw `WalletUnavailableError` → retry.
3. **Single-wallet pool skips `overrideUTxOs`** (`pool.all().length === 1`): still
   acquire/release for bookkeeping, but let Lucid select from the whole wallet so
   coin selection is byte-for-byte identical to today (avoids a "reserved subset
   too small" regression on large folds).
4. **Batch caveat**: `withStaleInputReconcile` (`:1154-1213`) will NOT self-heal a
   stale wallet input once pinned by `overrideUTxOs`; pin once before the closure.
   Per-process locks + reservation TTL + the balance-tick refresh bound staleness.
5. **release() in `finally`** wrapping `:521→return` (single) / `:939→return`
   (batch). Use `let settled = { consumedOutRefs: [], producedUtxos: [] }`,
   reassigned right after the tx is built (just after `txSignBuilder` is known),
   so a tx that landed on chain still marks its inputs consumed even if
   confirmation/reorg throws.
6. **consumed/produced helpers** in `cli/src/core/chain-helpers.ts`:
   `computeSpentWalletOutRefs(previousUtxos, transaction)` (extract from
   `waitForWalletSettlement` `:481-491`, reuse `utxoSnapshot`) and
   `computeWalletChangeOutputs(transaction, txHash, walletAddress)` (the body's
   outputs at the wallet address → `WalletUtxo[]`, `hasOnlyAda` from empty
   multiasset). The bridge assembles `settled` from these.
7. **Pool UTxO cache feed**: the arbiter reserves from `pool.getUtxos`. Prime it at
   startup and refresh on the balance tick (`daemon-cmd.ts:2036-2106`) via a new
   bridge method that does `lucid.utxosAt(wallet.address)` per pool wallet →
   `pool.setUtxos`. `utxosAt` needs only the address (no wallet select). Safe vs
   live reservations because the lock table still excludes reserved outRefs from
   `spendable()` and `release` re-applies its delta.
8. **Remove `request.signer`** (no backward shim — not deployed): drop `signer`
   from `SubmitRequest` (`types.ts:47`), the dispatch (`daemon-cmd.ts:2780`), both
   write-client forwards (`cardano-write-client.ts:121,208`), the bridge params,
   and delete `applySigner` (`lib-bridge:449-458`) + its call sites. The pool owns
   all keys via `resolveWalletPoolSigners`; the single-wallet env vars still feed
   the degenerate pool, so single-client deployments need no config change. Verify
   `resolveRouterSigners` has no other consumer; delete if not.
9. **WalletUnavailable** ✅ done: code in `errors/codes.ts`, classified by
   `err.name === "WalletUnavailableError"`, NOT in `NON_RETRIABLE_CODES` → the
   queue retries (`queue.ts:159-172`) with a fresh `acquire()`. Thrown before
   build, so no inflight stamp / no state write — the intent stays eligible.
10. **Daemon wiring** (`daemon-cmd.ts`, between `:1036` and `:1058`): resolve pool
    signers; derive each address (`walletFromSeed` offline, or the existing
    Lucid select+`wallet.address()`); `createUtxoLockTable` + `createWalletPool` +
    `createWalletArbiter({ lockTtlMs: inflightTimeoutMs })`; inject the arbiter +
    pool into `RealBridgeOptions`; prime the cache before the queue starts; wire
    the periodic refresh; `dryRun` keeps `makeDryRunBridge` with no arbiter.

- **Tests**: two parallel lanes on a one-wallet pool both confirm against a fake
  chain (disjoint UTxOs, no `UtxoNotFound`); N-wallet pool distributes;
  unavailable → retried; reservation released on success and on failure; the
  consumed/produced helpers over a fixture tx body.
- **Acceptance**: the original concurrency hazard is gone in an integration test;
  full feeder suite green.

### Phase 3 — Per-wallet lifecycle and main→pool funding

- `pool-funding.ts`: pure `shouldFundPoolWallet()` (above) + tests for every
  branch.
- CLI `fund-pool-wallet` tx (mirror settle/withdraw): main → pool payment; bridge
  method `fundPoolWallet({ toWalletId, amountLovelace })`; arbitrated + enqueued
  like the other maintenance ops.
- Generalize `snapshotBalances`, `consolidateWallet`, `settle`,
  `withdrawFromPaymentHook` to take a wallet selector; loop auto-remediation over
  all wallets; per-wallet in-progress guards.
- Daemon balance-refresh tick: for each wallet, evaluate consolidate + (pool only)
  fund decisions; run via `enqueueLaneTask`.
- **Tests**: funding decision matrix; main-reserve guard; cooldown; fund tx build;
  per-wallet consolidate loop; selector plumbing.
- **Acceptance**: a low pool wallet is topped up to target from the main in an
  integration test; main reserve respected; cooldown honoured.

### Phase 4 — Per-wallet observability

- `metrics.ts`: add `wallet` label to the two admin-wallet gauges; new pool
  metrics. All `.set()`/`.inc()` sites pass the label.
- `monitoring/alerts.yml`: `wallet` label on existing admin alerts; add
  `MainWalletCannotFundPool`, `PoolWalletLow`. `generate-monitoring.ts` + the
  threshold-drift test cover the new YAML keys.
- `feeder.json`: `$wallet` variable; per-wallet panels; pool-overview row.
- **Tests**: metric label presence; threshold-drift; generate-monitoring idempotence.
- **Acceptance**: dashboards render per wallet; alerts carry the label; drift test green.

### Phase 5 — Docs and verification

- Architecture doc section (pool + arbiter + funding loop + diagram); feeder
  README; config README (the YAML block + constants pointer); grafana-dashboards
  (new panels/alerts). Proportionate — only where a reader looks.
- Full `offchain/feeder` + `offchain/cli` suites green; lint/typecheck clean.

## Patterns to mirror

- **Lock table**: `inflight.ts` (factory, injected clock, `make…Entry` with a
  required timeout, lazy expiry). `utxo-lock-table.ts` already follows it.
- **Pure triggers**: `auto-remediation.ts` (`shouldSettle` / `shouldWithdraw` /
  `shouldConsolidate` return `{act,reason}`). `pool-funding.ts` follows it.
- **Maintenance tx**: `settle.ts` / `payment-hook-withdraw.ts` (CLI builder +
  bridge method + `enqueueLaneTask`). `fund-pool-wallet` follows it.
- **Config threshold**: `alerting.*` keys → constants default → `generate-monitoring`
  → `threshold-drift.test.ts`. New `wallet_pool.*` keys follow it.
- **Singletons wired in `daemon-cmd.ts`**: `inflightTable` / `symbolInflight`
  construction + threading. The arbiter follows it.

## QA gates

After each phase, before moving on, spawn QA agents (Explore / review) in parallel
to verify — and act on their findings:

1. **Pattern adherence** — the new code mirrors the named pattern (factory shape,
   docstrings, injected clock, no inline magic numbers).
2. **Tidiness / placement** — files live where siblings live; helpers reused, not
   duplicated; no dead code; no legacy/backward/meta-language.
3. **Docs coherence** — every new module/metric/alert/config key is documented
   where a reader would look, and this plan still matches the code.
4. **Test coverage** — every new function has tests incl. edge cases; suite green;
   output pristine.

Record each gate's outcome in the phase's PR/commit description.

## Norms checklist

Apply to every change (these are the standing rules):

- No hardcoded values — every tunable comes from YAML or a named constant, with a
  docstring and a README pointer to the key. Constants in `config/constants.ts`.
- No legacy / no backward-compat shims / no aliases — this is the system; rename
  and integrate directly.
- No meta-language in comments — say what the code does, not what it does not do
  or used to do. No "Phase X adds…" in code; use `NOTE:` / `TODO:` and the PR body.
- Follow existing patterns and helpers; new code is not special. Proportionate docs.
- Many tests, TDD (red → green), verify every claim by running it.
- Shared state stays under `offchain/state`; no copy/import steps.
- Per-wallet everywhere a single wallet is assumed today (metrics, alerts, ops).

## Audit anchors

- Signer already threaded per request: `lib-bridge` `applySigner` (449-458, 523-525);
  request signer set in `daemon-cmd.ts` (2774-2781).
- Build/UTxO seam: `.complete()` in `build-oracle-update.ts:311`; chosen inputs
  via `toTransaction().body().inputs()` (`chain-helpers.ts:482-491`); Lucid
  `overrideUTxOs` + `CompleteOptions` (`@lucid-evolution/lucid` 0.4.29).
- Lock-table pattern: `inflight.ts`, `symbol-inflight.ts`.
- Concurrency: worker pool (`daemon-cmd.ts:1628`) → per-lane serial queues
  (`queue.ts`, `queue-manager.ts`); `laneKey = client_state_path::protocol_state_path`.
- Lifecycle singletons: `wallet-consolidate.ts`, `settle.ts`,
  `payment-hook-withdraw.ts`; `capturePostConfirmState` / `snapshotBalances`
  (`lib-bridge.ts` 1334, 1523); auto-remediation triggers (`auto-remediation.ts`).
- Observability singletons: admin-wallet gauges (`metrics.ts:556-567`), set sites
  (`daemon-cmd.ts:1360, 2066-2070`); alerts `AdminWalletLow` / `AdminWalletFragmented`.
- PaymentHook single `withdrawAddress` (`state.ts:92`, fixed at bootstrap) = the
  main wallet.
