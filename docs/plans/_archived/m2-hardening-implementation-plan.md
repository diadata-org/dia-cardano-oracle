# Milestone 2 — Pre-Mainnet Hardening & Operability: Implementation Plan

> **Archived — complete.** Every item in this plan shipped (Part A incl. A1 + A2/Option B, and Part B incl. B1-B7). It is kept for historical/design context; for the as-built behavior see the architecture docs and the teardown audit [`docs/audit/20260607-contract-teardown-ada-recovery.md`](../../audit/20260607-contract-teardown-ada-recovery.md). The only follow-up that outlived this plan (the "new metrics dashboard") is tracked in [milestone-feeder-plan.md](./20260616-milestone-feeder-plan.md).

Detailed, code-grounded implementation plan for two bodies of work to land before
(or alongside) the M2 Mainnet feeder run:

- **Part A — Receiver funding (side-deposit + merge)** (Issue 1 / Option A from
  [docs/audit/20260605-receiver-concurrency-and-griefing.md](../../audit/20260605-receiver-concurrency-and-griefing.md)):
  let a client fund their balance with an ordinary wallet payment — the
  contract + feeder changes that delivers.
- **Part B — Monitoring, config, API, CLI & push policy** (the open
  `§ Monitoring, config & API` items in
  [docs/plans/_archived/20260616-milestone-feeder-plan.md](./20260616-milestone-feeder-plan.md)).

> **Out of scope:** Issue 2 of the audit (active update-griefing) is **not** part
> of this plan — it is a separate DIA policy discussion, tracked in the audit
> note, not engineering work scheduled here.

**Status (2026-06-07).** Landed + tested: B1 thresholds drift test (`21634ff`)
plus the `generate-monitoring.ts` generator (`make generate-monitoring`, a
prerequisite of `make up`, writes thresholds from `infrastructure.<network>.yaml::alerting.*`
into `alerts.yml` + the Grafana dashboard), B2 count panels (`89bd0ec`), B3
dashboard filters (`41b215d`), B4 OpenAPI+Redoc (`0a1ba53`), B6 deviation+heartbeat
policy (`1997025`), and **A1 contracts + CLI** — the `deposit` validator (`d576163`,
9 inline `deposit_logic` tests) and `deposit:address/fund/merge` (`0111dee`) wired
into `run-all-cli.sh` (`dec4248`). A1's contract path is proven end-to-end through
real Plutus in the emulator flow and on the live Preview testnet run. Also landed:
**A1 feeder-daemon auto-merge** (merge dispatched as a first-class lane task on the
per-lane submission queue, so it can never run concurrently with an update on the
same Receiver — the lane queue IS the mutual-exclusion lock; the old fail-safe
in-flight precheck was removed), the **deposit-pending monitoring** (gauge
`dia_bridge_cardano_deposit_pending_lovelace` + Grafana panel + the
`ReceiverDepositsPending` alert / `deposit_pending_merge_lovelace` threshold), and
**B5 multi-client settle** (repeatable `--client-state`, N-receiver `SettleManifest`,
one tx collecting all Receivers + the hook; exercised over 2 clients in the emulator
`settle:multi` step).

Also landed since: **A2 / Option B — generalized `AccrueFee`** (an oracle update can
now fold side-deposits into the SAME tx by absorbing the added lovelace into
`balance_lovelace`; `accrue_fee_transition` takes the prev/next outputs, `added ≥ 0`,
`accrued` pinned to `+fee`; call sites `receiver.ak` AccrueFee + `update_coordinator.ak`
`valid_receiver_accrue_fee` derive the fee from the accrued-delta; `deposit.ak`
unchanged). Off-chain: `depositMaxPerUpdateFold` in `config-bootstrap.json::configState`
(`protocol:init --deposit-max-per-update-fold`, default 3), CLI `update --fold-deposits`,
feeder best-effort fold with fallback to a pure update; emulator proves update+absorb.
Measured: blueprint +620 bytes, AccrueFee bench cpu/mem delta ≈ 0, batch-10 unaffected.
And **B7 — teardown burns + ADA recovery**: a `Burn` mint action + `Burn` spend redeemer
on `config_state` / `payment_hook` / `receiver` (mirroring `pair_state`, config-signer
gated, NFT burned −1, no continuation, zeroed value fields), the `reclaim-reference-script
--script client` fix that also reclaims the per-client `deposit` ref-script, the new
decommission runbook `offchain/cli/scripts/run-teardown-cli.sh` (chain-as-truth) +
helpers, and the audit/procedure doc
[`docs/audit/20260607-contract-teardown-ada-recovery.md`](../../audit/20260607-contract-teardown-ada-recovery.md).
The Preview OLD deployment `preview_run_20260606-082456` was actually torn down (~15 ADA
of non-burnable OLD-contract NFT min-UTxOs stay stuck, recovered only on next-gen
redeployments). A2 + B7 change the receiver/config/hook/coordinator hashes → a
re-bootstrap is the accepted path. `run-all-cli.sh` gained steps 36/37
(`deposit:fund` + `update --fold-deposits`), guard bumped 1..35 → 1..37.

**Remaining:** the "new metrics dashboard" (B-adjacent feeder-plan item) is the only
open piece. Suites: aiken `aiken check` 156/0, feeder `npm test` 555, cli emulator
(`deposit:fund`/`deposit:merge`/`settle:multi`/update+absorb/full teardown) — all green.

Every file/line reference below was verified against the current tree on
2026-06-06. Where a sketch is shown it is marked **[sketch — verify on impl]**.

## Contents

- [How to read this plan](#how-to-read-this-plan)
- [Quality bar (applies to every item)](#quality-bar-applies-to-every-item)
- [Part A — Receiver funding (side-deposit + merge)](#part-a--receiver-funding-side-deposit--merge)
  - [A0. The deployed-contract constraint (read first)](#a0-the-deployed-contract-constraint-read-first)
  - [A1. Option A — side-deposit address + feeder merge](#a1-option-a--side-deposit-address--feeder-merge)
  - [A2. Unified update + top-up (generalized AccrueFee)](#a2-unified-update--top-up-generalized-accruefee)
- [Part B — Monitoring, config, API, CLI & policy](#part-b--monitoring-config-api-cli--policy)
  - [B1. Thresholds — single source of truth](#b1-thresholds--single-source-of-truth)
  - [B2. Fix misleading rate panels](#b2-fix-misleading-rate-panels)
  - [B3. Dashboard filter variables ($client …)](#b3-dashboard-filter-variables-client-)
  - [B4. OpenAPI / Swagger from a route table](#b4-openapi--swagger-from-a-route-table)
  - [B5. Multi-client batch settle (CLI)](#b5-multi-client-batch-settle-cli)
  - [B6. Per-client deviation + heartbeat push policy](#b6-per-client-deviation--heartbeat-push-policy)
  - [B7. Teardown burns + deposit ref-script reclaim](#b7-teardown-burns--deposit-ref-script-reclaim)
- [Shared helpers to build](#shared-helpers-to-build)
- [Sequencing & dependencies](#sequencing--dependencies)
- [Consolidated open questions / decisions](#consolidated-open-questions--decisions)

## How to read this plan

Each item carries: **Goal**, **Current state** (file:line), **Design** (with the
real decisions called out), **Changes** (files), **Tests**, **Docs to update**,
**Open questions**. Items are tagged:

- 🔴 **M2-blocking** — should land before the Mainnet daemon run.
- 🟡 **M2 operability** — strongly wanted for M2, not strictly blocking.
- ⚪ **Decision-gated** — needs a DIA answer before code.

## Quality bar (applies to every item)

Non-negotiable, per repo conventions:

- **Tests first-class:** unit + adversarial. On-chain → inline Aiken tests next to
  the validator (the 126-test pattern). Off-chain → `node:test` suites beside the
  module. No item is "done" without the negative cases.
- **No hardcoded values:** every tunable comes from YAML or env, with a docstring
  and a README pointer to the config key.
- **Docstrings + READMEs + docs:** module header docstrings explain *why*; the
  feeder/CLI READMEs and `docs/architecture/feeder.md` updated where behavior
  changes; every new markdown gets a `## Contents` TOC.
- **Modular, reusable:** prefer extending existing helpers
  (`chain-helpers.ts`, `coalescer`, `policy.ts`, the metrics module) over copies;
  extract a new helper when two call sites would duplicate.
- **No compat/legacy framing** in code or comments — the feeder is not yet
  deployed; new modes are just modes (default OFF where noted).

---

## Part A — Receiver funding (side-deposit + merge)

Source of truth for the problem analysis:
[docs/audit/20260605-receiver-concurrency-and-griefing.md](../../audit/20260605-receiver-concurrency-and-griefing.md)
(**Issue 1 / Option A** only). That note treats **Option A (side-deposit + feeder
merge) as a requirement** on client-usability grounds: a client must be able to
fund their balance with an ordinary wallet payment, no CLI/SDK. (Issue 2 of the
audit — active griefing — is out of scope here; see the note at the top.)

### A0. The deployed-contract constraint (read first)

The protocol + client-A are **already bootstrapped on Mainnet**
(`docs/milestones/evidence/m1-mainnet-20260517-063917/`). A validator's on-chain
**address is a hash of its compiled code + parameters**. Therefore:

> **Any edit to `receiver.ak`, `update_coordinator.ak`, `payment_hook.ak`, or the
> libs they inline changes their script hash → changes the deployed address →
> the live Mainnet Receiver/Hook/Pair UTxOs would be stranded and require a full
> re-bootstrap.**

This single fact drives the Option A design below: **we add Option A without
editing any deployed validator.** A new, standalone *deposit* validator is purely
additive (new script, new address, new per-client artifact) and leaves every
deployed hash untouched.

The key enabler: the Receiver's existing **`TopUp`** redeemer already credits
balance by exactly the ADA added to the Receiver UTxO —
`top_up_transition` asserts `added = next_lovelace − previous_lovelace` and
`next.balance == previous.balance + added`, with `accrued`/`min_utxo` unchanged
([receiver_logic.ak:36-52](../../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak#L36-L52)).
So a "merge" tx can **reuse `TopUp`**: spend the Receiver + the deposit UTxOs,
recreate the Receiver with `balance += Σ deposits`. No new Receiver redeemer is
required.

> **Superseded for A2 + B7.** A0's "never edit a deployed validator" constraint
> shaped A1's purely-additive design. The later cost work — [A2](#a2-unified-update--top-up-generalized-accruefee)
> (generalized `AccrueFee`) and [B7](#b7-teardown-burns--deposit-ref-script-reclaim)
> (teardown burns) — **deliberately edits `receiver` / `config_state` /
> `payment_hook` / `update_coordinator`**, changing their hashes and requiring a
> full re-bootstrap. That is an accepted, planned re-deploy: the current
> deployments are decommissioned (recovering their ADA) and redeployed fresh, per
> the teardown procedure in
> [docs/audit/20260607-contract-teardown-ada-recovery.md](../../audit/20260607-contract-teardown-ada-recovery.md).

### A1. Option A — side-deposit address + feeder merge

🔴 **M2-blocking** (per the audit's "requirement" framing — confirm scope in
[open questions](#consolidated-open-questions--decisions)).
✅ **Implemented**: contracts + CLI (`deposit` validator + `deposit:address/fund/merge`)
and the **feeder-daemon auto-merge**. The daemon dispatches the merge as a
first-class **lane task** on the SAME per-lane serial submission queue the client's
oracle updates use, so a merge and an update on one Receiver can never run
concurrently — the lane queue IS the mutual-exclusion lock (the old fail-safe
in-flight precheck was removed). Wiring: discriminated `QueueEntry` (`submit` |
`task`) + `enqueueTask` (`submitter/queue.ts`), `enqueueLaneTask` on the manager
(`submitter/queue-manager.ts`), and `maybeAutoMergeDeposits` / `shouldAutoMergeDeposits`
in `cmd/feeder/daemon-cmd.ts` (triggered when a Receiver drops below
`receiver_balance_low_lovelace` or pending deposits reach `deposit_pending_merge_lovelace`),
holding only a per-lane `mergeInProgress` dedup guard to collapse duplicate enqueues.
Tests: `submitter/__tests__/queue.test.ts` (merge task + update share a lane, never
overlap), `submitter/__tests__/auto-merge-decision.test.ts`. The design notes below
are kept for reference.

**Goal.** A per-client **deposit script address**. Clients fund their balance by a
**plain wallet payment** to that address — no CLI, no datum, no script knowledge.
The feeder sweeps accumulated deposits into the Receiver's `balance_lovelace`
through its own serial lane, triggered before the balance runs dry, so the prepay
never stalls and there is no refill-time stale window.

#### Current state (grounded)

- Receiver is a single NFT-bearing UTxO; `TopUp` spends + recreates it
  ([receiver.ak:14-22 redeemer enum](../../../contracts/aiken/validators/receiver.ak#L14-L22),
  [:57-62 V3 `maybe_datum: Option<…>`](../../../contracts/aiken/validators/receiver.ak#L57-L62),
  [:68-89 NFT qty-1 continuation](../../../contracts/aiken/validators/receiver.ak#L68-L89)).
- `TopUp` branch = pure `top_up_transition`, **no config/signer lookup**
  (permissionless) — confirmed in the receiver dispatch.
- Today's top-up is protocol-aware: the CLI spends the canonical NFT UTxO and
  recreates it ([offchain/cli/src/transactions/receiver-top-up.ts:62-120](../../../offchain/cli/src/transactions/receiver-top-up.ts#L62-L120)).
  A naive wallet send to the **Receiver** address bricks the UTxO (its validator
  does `expect Some(datum)`). The deposit address is a *separate* script that
  tolerates `None`.
- Per-client parametrization pattern: `receiver` is parametrised by
  `(bootstrap_ref, expected_asset_name, config_policy_id, config_asset_name)`
  ([receiver.ak:22-27](../../../contracts/aiken/validators/receiver.ak#L22-L27));
  off-chain wiring is `makeReceiverValidator(...)` in
  `offchain/cli/src/core/contracts.ts`; the address is
  `scriptAddressFromValidator(...)`.
- The feeder serialises updates per lane
  `laneKey = client_state_path::protocol_state_path`
  ([offchain/feeder/src/submitter/lane-key.ts:8-10](../../../offchain/feeder/src/submitter/lane-key.ts#L8-L10))
  through the coalescer state machine
  ([offchain/feeder/src/submitter/coalescer.ts:100-384](../../../offchain/feeder/src/submitter/coalescer.ts#L100-L384)).
- UTxO queries: `lucid.utxosAt(address)` / `utxosAtWithUnit`, wrapped by
  `findSingleUtxoAtUnit` ([offchain/cli/src/core/chain-helpers.ts:110-136](../../../offchain/cli/src/core/chain-helpers.ts#L110-L136)).
- Balance polling already exists: `bridge.snapshotBalances(...)`
  ([offchain/feeder/src/lib-bridge/index.ts](../../../offchain/feeder/src/lib-bridge/index.ts)),
  and the trigger threshold `alerting.receiver_balance_low_lovelace` is already in
  the infra YAML, surfaced by `ReceiverBalanceLow`.

#### Design

**On-chain — one new validator, no edits to deployed scripts.**

`contracts/aiken/validators/deposit.ak` (NEW), parametrised **per client** with
the same identity inputs as the receiver so its address is per-client and it can
name the exact Receiver it must credit:

- params: `bootstrap_ref`, `receiver_policy_id`, `receiver_asset_name`
  (+ `config_policy_id`/`config_asset_name` reserved for symmetry/future use).
- `spend(maybe_datum: Option<Data>, redeemer: CollectDeposit, own_ref, self)` —
  **accepts `None`** (datum-less wallet payments are spendable in V3).
- **Spend condition (the whole security model):** the tx must consume the
  canonical Receiver (found by NFT qty 1) and **increase the Receiver UTxO's
  lovelace by ≥ the total ADA being swept from this deposit address**:

  ```aiken
  // [sketch — verify on impl]
  let swept =
    self.inputs
      |> list.filter(fn(i) { i.output.address == own_input.output.address })
      |> list.foldl(0, fn(i, acc) { acc + assets.lovelace_of(i.output.value) })
  let recv_delta =
    assets.lovelace_of(receiver_output.value) - assets.lovelace_of(receiver_input.output.value)
  and {
    swept > 0,
    recv_delta >= swept,                 // ANTI-SKIM: every swept lovelace lands on the Receiver
    qty1(receiver_input, recv_policy, recv_name),
    qty1(receiver_output, recv_policy, recv_name),
  }
  ```

  > **Critical invariant — anti-skim.** Checking only "balance ≥ prev + *this
  > deposit's* value" is a hole: with N deposits in one tx every instance would
  > pass while only one deposit's worth is credited and the rest is taken as
  > change. Because all deposits for a client share the **same** address, each
  > validator instance sums **all inputs at that address** and requires the
  > Receiver lovelace delta to cover the full sum. All instances then see the same
  > constraint and the tx can only succeed if the entire sweep is credited.

- The merge tx **reuses the Receiver `TopUp` redeemer** (see [A0](#a0-the-deployed-contract-constraint-read-first)).
  `top_up_transition` already forces `next.balance == prev.balance + recv_delta`
  and `accrued`/`min_utxo` unchanged, so the Receiver side needs **no change**.
  - *Implementation check:* confirm the Receiver `TopUp` branch places **no
    restriction on additional script inputs** in the tx (it shouldn't — it only
    asserts the NFT continuation + the balance delta). If it ever did, Option A
    would have required the heavier dedicated-redeemer path below.

**Rejected alternative (heavier) — a dedicated absorb-deposits redeemer.** Adding
a new redeemer variant + transition to the Receiver would give cleaner intent +
its own metrics, but it **edits `receiver.ak` → new address → full Mainnet
re-bootstrap**, only worth it on a re-deploy for other reasons. **Decision: reuse
`TopUp`.** No such redeemer was built — the shipped design has a single
balance-add (`TopUp`), and the merge reuses it.

**Off-chain — CLI.** *(Shipped: `makeDepositValidator` lives in `core/contracts.ts`;
the per-client deposit validator + `depositValidatorHash` + `depositValidatorAddress`
are derived and persisted inside `deploys/receiver-parameterize.ts` /
`receiver-bootstrap.ts` — there is no separate `deposit-parameterize.ts`. The
client-facing funding UX is the `deposit:address` command, with `deposit:fund` /
`deposit:merge` for the operator. The sketch below predates the final shape.)*

- `offchain/cli/src/core/contracts.ts`: `makeDepositValidator({...})` +
  `DEPOSIT_SPEND_TITLE` (mirror `makeReceiverValidator`).
- Derive the per-client deposit validator + address and persist into the
  client-state artifact (`receiver.depositValidatorAddress` /
  `depositValidatorHash` + `compiledScripts.depositValidator`), inside the existing
  `receiver-parameterize.ts` / `receiver-bootstrap.ts` flow.
- Command `deposit:address`: **print the client's deposit address** so DIA can hand
  it to the client. This is the entire client-facing funding UX: "send ADA here."
- `aiken build` regenerates `plutus.json` with `deposit.deposit.spend`; the CLI
  consumes it via the existing `getBlueprintValidator` + `applyParamsToScript`
  path (`offchain/cli/src/core/blueprint.ts`).

**Off-chain — feeder (the merge machinery).** New module
`offchain/feeder/src/deposits/` with:

1. **Watcher** — query `lucid.utxosAt(depositAddress)` per client (reuse the
   provider already wired for `snapshotBalances`).
2. **Filter** — accept only **ADA-only** UTxOs above the deposit dust floor;
   **skip** dust, native-token junk, and oversized-datum UTxOs (they stay
   harmlessly at the address). Pure function → easy unit tests. *(Shipped: the
   dust floor `depositMinLovelace` and per-merge cap `depositMaxPerMerge` are
   protocol tx-build params in `config-bootstrap.json::configState` — set at
   `protocol:init` via `--deposit-min-lovelace` / `--deposit-max-per-merge` — read
   by both the CLI and the feeder daemon via `readDepositMinLovelace`; they are
   NOT in `infrastructure.<network>.yaml`.)*
3. **Merge tx builder** — model on
   [receiver-top-up.ts:62-120](../../../offchain/cli/src/transactions/receiver-top-up.ts#L62-L120):
   `collectFrom([receiverUtxo], TopUp)` plus `collectFrom(selectedDeposits, CollectDeposit)`,
   recreating the Receiver with `balance += Σ`. Cap deposit count per tx (tx-size
   budget) and `log()` any deferred remainder.
4. **Submission** — *(shipped differently than this sketch:)* the merge is enqueued
   as a first-class **lane task** on the same per-lane serial submission queue as
   updates (`enqueueLaneTask` → discriminated `QueueEntry` `task`), NOT through the
   coalescer and NOT behind a separate in-flight lock — the serial lane queue itself
   guarantees a merge and an update on one Receiver never run concurrently.
5. **Trigger** — *(shipped: the pure `shouldAutoMergeDeposits` fires on
   `receiver_balance < alerting.receiver_balance_low_lovelace` OR pending deposits
   `>= alerting.deposit_pending_merge_lovelace` — a SECOND threshold was added, not
   "no new knob", so a large pile is folded in before it grows unbounded even while
   the Receiver is still well-funded.)* The original sketch was: when
   `snapshotBalances` shows `receiver_balance < alerting.receiver_balance_low_lovelace`,
   schedule a merge; optional periodic safety sweep.
6. **Metrics** — *(shipped: a single gauge
   `dia_bridge_cardano_deposit_pending_lovelace{deposit_address}` — the sum of clean,
   un-merged deposits per client — backing the `ReceiverDepositsPending` alert, NOT
   the swept/skipped counters sketched here.)* Original sketch:
   `dia_bridge_cardano_deposits_swept_total{client_id}`,
   `..._swept_lovelace_total{client_id}`, `..._deposits_skipped_total{client_id,reason}`.

#### Changes (files)

| Layer | File | Change |
| --- | --- | --- |
| Aiken | `contracts/aiken/validators/deposit.ak` | **NEW** validator + inline tests |
| Aiken | `contracts/aiken/plutus.json` | regenerated by `aiken build` |
| CLI | `offchain/cli/src/core/contracts.ts` | `makeDepositValidator` + title const |
| CLI | `offchain/cli/src/deploys/deposit-parameterize.ts` | **NEW** derive+persist deposit address |
| CLI | client-state artifact type + writer | add `receiver.depositValidatorAddress` |
| CLI | command registry + `receiver:deposit-address` | print address for the client |
| Feeder | `offchain/feeder/src/deposits/{watcher,filter,merge}.ts` | **NEW** module |
| Feeder | daemon wiring (`cmd/feeder/daemon-cmd.ts`) | start the watcher/merge loop |
| Feeder | `src/api/metrics.ts` | new deposit metrics |
| Config | `infrastructure.<network>.yaml` | (reuse `receiver_balance_low_lovelace`; add only if a separate sweep cadence is wanted) |

#### Tests

*(Shipped — see the matching items in
[milestone-feeder-plan.md](./20260616-milestone-feeder-plan.md). The sketch below is what was
planned; the actual coverage is noted per line.)*

- **Aiken (inline, in the 126-test style of
  [receiver_logic.ak](../../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak)):**
  *shipped as 9 `deposit_logic` tests* — happy sweep credits balance; multi-deposit
  fully credited; **anti-skim** (N deposits, under-credit rejected); Receiver not
  credited / lovelace decreased rejected; Receiver not consumed rejected; zero-swept
  rejected; token-wrapped deposit must credit full ADA; `total_swept` only counts
  inputs at the deposit address.
- **CLI:** *shipped* — the deposit validator + merge run through real Plutus in the
  emulator protocol flow (`deposit:fund` ×2 then `deposit:merge`); `isCleanAdaDeposit`
  is exported for the dust/token/min-utxo selection predicate.
- **Feeder:** *shipped* — `auto-merge-decision.test.ts` (the pure
  `shouldAutoMergeDeposits`), `queue.test.ts` / `queue-manager.test.ts` (a merge task
  and an update share one lane and never overlap), `deposit-floor-source.test.ts`
  (`readDepositMinLovelace` reads `config-bootstrap.json::configState`, not YAML).

#### Docs to update — *all shipped*

- `docs/architecture/cardano-oracle-architecture.md` §5.14 "Side-deposit funding &
  merge (per client)" + the `deposit` validator in the contract set (§1.5). ✅
- `docs/architecture/feeder.md` — "Client funding: side-deposit address + merge"
  subsection. ✅
- `offchain/feeder/README.md` — "Client funding (side-deposits)" operator section
  (trigger thresholds, what gets skipped, the auto-merge). ✅
- `offchain/cli/README.md` — `deposit:address` / `deposit:fund` / `deposit:merge`
  + the "fund with a plain payment" UX + the deposit tx-build params. ✅
- `contracts/aiken/README.md` — the `deposit` validator + the anti-skim invariant
  (links §5.14). ✅
- Audit note Issue 1 status: still a `draft for DIA review` — update once DIA signs
  off (a doc-tracking follow-up, not engineering).

#### Open questions (A1)

1. **Scope/timing:** is full Option A required *before* the first Mainnet daemon
   run, or can the daemon run on Mainnet (CLI-funded top-ups) while Option A lands
   in parallel? (Affects the M2 critical path.)
2. **Merge authorization:** keep the merge **permissionless** (anyone can credit a
   client — only ever helps them), or gate it to the feeder/admin? Permissionless
   is simpler and safe by construction; confirm DIA is comfortable.
3. **min-UTxO / dust floor** for accepted deposits, and the **max deposits per
   merge tx** (tx-size budget) — *resolved & shipped:* both live as protocol
   tx-build params `depositMinLovelace` / `depositMaxPerMerge` in
   `config-bootstrap.json::configState`, set at `protocol:init`
   (`--deposit-min-lovelace` / `--deposit-max-per-merge`), read by the CLI and the
   feeder daemon (`readDepositMinLovelace`) — NOT in `infrastructure.<network>.yaml`.
4. Sweep cadence — *resolved & shipped:* TWO trigger arms, not a periodic sweep:
   `shouldAutoMergeDeposits` fires on `receiver_balance < receiver_balance_low_lovelace`
   OR pending `>= deposit_pending_merge_lovelace`. Both thresholds live in
   `infrastructure.<network>.yaml::alerting.*`.

### A2. Unified update + top-up (generalized AccrueFee)

⚪ **Design-of-record (Option B).** ✅ **Implemented & verified.** This is the
chosen design; the rejected Option A (a dedicated 6th `ReceiverRedeemer`) is recorded
under [Cost rationale](#cost-rationale-why-b-not-a-new-redeemer-a) below for the record.
Unlike [A1](#a1-option-a--side-deposit-address--feeder-merge) (a brand-new standalone
validator, no edits to deployed scripts), A2 **edits deployed validators** — see the
[deployment note](#deployment-note); acceptable only pre-launch.

**Shipped (verified).** `accrue_fee_transition`
([receiver_logic.ak:73-92](../../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak#L73-L92))
now takes the receiver **input + output** Outputs, computes
`added = lovelace_of(next_output) − lovelace_of(previous_output)`, and pins
`balance' = balance − fee + added`, `accrued' = accrued + fee`, `min_utxo'` unchanged,
under `fee ≥ 0`, **`added ≥ 0`**, `fee ≤ balance + added`. The two call sites changed:
`validators/receiver.ak` (AccrueFee branch now derives the fee from the
**accrued-delta**, not the balance-delta) and `validators/update_coordinator.ak`
(`valid_receiver_accrue_fee` passes the receiver input.output + output to the
transition). `deposit.ak` is **UNCHANGED** (its anti-skim `receiver_delta ≥ swept`
sees the same physical increase whether it came via `TopUp` or via `AccrueFee`).
Off-chain: `depositMaxPerUpdateFold` is a protocol tx-build param in
`config-bootstrap.json::configState`, set at `protocol:init`
(`--deposit-max-per-update-fold`, default 3) and read via `readDepositMaxPerUpdateFold`;
the CLI `update` command gained a `--fold-deposits` flag
(`build-oracle-update.ts` / `build-batch-oracle-update.ts` `collectFrom(foldDeposits,
CollectDeposit)`); the feeder folds best-effort, falling back to a pure update if the
combined tx fails. The emulator proves an update that also absorbs a deposit
(`run-all-cli.sh` steps 36/37). **Measured:** blueprint **+620 bytes**
(178,933 → 179,553); the AccrueFee bench (`receiver_spend_accrue_fee_decodes_batch_redeemer`)
cpu/mem delta ≈ 0 (both `lovelace_of` values are already computed by
`exact_locked_lovelace`); batch-10 capacity unaffected. The design notes below are kept
for reference.

#### Goal / cost lever

Let a **single transaction** perform an oracle update **and** raise the client's
Receiver `balance_lovelace`, so a side-deposit can be **folded into an update that is
happening anyway** — cutting the number of fixed-cost stand-alone top-up/merge
transactions a client must pay for. Each avoided merge is a whole tx of base fee +
script execution saved; folding the credit into an already-witnessed update tx makes
that credit nearly free.

This does **NOT replace** the standalone `deposit:merge` ([A1](#a1-option-a--side-deposit-address--feeder-merge)).
A large sweep of many deposit UTxOs combined with a batch update would blow the tx
budget (CPU/MEM + size); the fold is **opportunistic and bounded** — a small number of
clean deposits folded into an update, with the bulk path still served by `deposit:merge`.

#### The base invariant

Every Receiver spend already pins, on **both input and output**
(`receiver_logic.exact_locked_lovelace`,
[receiver_logic.ak:32-34](../../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak#L32-L34)):

```text
physical_lovelace == min_utxo + balance + accrued
```

This holds for the input datum against the input UTxO and for the output datum against
the output UTxO. A2 keeps this invariant verbatim; it only changes which deltas the
`accrue_fee_transition` permits between the two pinned states.

#### Formulas — current vs proposed

Let `L = physical lovelace at the Receiver UTxO`, and `A = L' − L` the absorbed amount
(`A ≥ 0`). `fee` is the coordinator-computed protocol fee.

| Field | Current `accrue_fee_transition` | Proposed (generalized, absorb `A`) |
| --- | --- | --- |
| `balance'` | `balance − fee` | `balance − fee + A` |
| `accrued'` | `accrued + fee` | `accrued + fee` |
| `min_utxo'` | `min_utxo` (unchanged) | `min_utxo` (unchanged) |
| physical `L'` | `L` (unchanged) | `L + A` |

Guards on the generalized form: `fee ≥ 0`, **`A ≥ 0`**, and `fee ≤ balance + A`
(⇒ `balance' ≥ 0`). When `A = 0` the proposed form is **identical** to today.

#### The key math impact

Today all three deltas are equal: `fee = balance-delta = accrued-delta`. After the
change they diverge:

- **`accrued-delta = fee`** — the **ONLY reliable reading of the fee.**
- `balance-delta = A − fee` (can be positive, zero, or negative).
- `physical-delta = A`.

So **any code that derived the fee from the balance-delta MUST switch to the
accrued-delta.** Exactly **two call sites change**:

1. **`validators/receiver.ak` — `AccrueFee` branch.** Today it derives the fee as
   `current_datum.balance_lovelace - next_datum.balance_lovelace`
   ([receiver.ak:123-127](../../../contracts/aiken/validators/receiver.ak#L123-L127)) — this
   breaks the moment `A > 0`. Pass the receiver **input + output** to the (generalized)
   transition and derive the fee as **`next.accrued − current.accrued`** instead of
   `current.balance − next.balance`.
2. **`validators/update_coordinator.ak::valid_receiver_accrue_fee`.** Pass the receiver
   `input.output` + `output` to the transition
   ([update_coordinator.ak:87-136](../../../contracts/aiken/validators/update_coordinator.ak#L87-L136)).
   It still **computes** `fee = base + N·k` and **forces** `accrued += fee`; the
   generalized transition then lets the physical delta `A` flow into balance.

**`deposit.ak` / `deposit_logic.ak` is UNCHANGED.** It is redeemer-agnostic:
`collect_deposit_ok` requires `receiver_delta ≥ swept`, and with A2 the
`receiver_delta` simply equals `A` (the absorbed amount). The anti-skim check sees the
same physical Receiver-lovelace increase whether that increase came via `TopUp` or via
a generalized `AccrueFee`.

#### Worked examples

State: `min_utxo = 2`, `balance = 10`, `accrued = 0` → physical `12` ADA.
Batch `N = 3`, `base = 0.6`, `k = 0.4` → `fee = base + N·k = 0.6 + 3·0.4 = 1.8`.

**(a) Pure update (`A = 0`) — identical to today.**
`balance: 10 → 8.2`; `accrued: 0 → 1.8`; physical `2 + 8.2 + 1.8 = 12` (no ADA moved).

**(b) Update + absorb a 5 ADA deposit (`A = 5`).**
`balance: 10 − 1.8 + 5 = 13.2`; `accrued: 0 → 1.8`;
physical `2 + 13.2 + 1.8 = 17 = 12 + 5`.
`deposit.ak`: `receiver_delta = 5 ≥ swept (5)` ✓. The fee accrued exactly as always; the
full 5 ADA went into `balance` — none of it leaked to `accrued` or to the hook.

#### Off-chain policy (merge stays)

On-chain A2 only **PERMITS** absorption — it never forces a fold. Policy lives off-chain:

- The feeder folds only a **small, bounded** number of deposits into an update — the cap
  is chosen by **tx-budget headroom, measured in the emulator alongside a batch-10
  update** (the cap is the headroom left after the dominant cost — the N secp256k1
  verifications — is paid).
- **Bulk sweeps still use the standalone `deposit:merge`** ([A1](#a1-option-a--side-deposit-address--feeder-merge)).
- **Feeder fold MUST be best-effort:** if the combined tx fails, retry the **update
  WITHOUT the deposit** (a pure update). Fold only **confirmed, clean (ADA-only)**
  deposits — reuse A1's `isCleanAdaDeposit` predicate.

#### Attack vectors + mitigations

1. **Authorization unchanged.** The `AccrueFee` path still requires the coordinator
   witness (DIA-signed EIP-712 intents, via `coordinator_intent_matches`); a third party
   cannot forge an update.
2. **Deposit cannot be diverted to the hook.** `accrued'` is pinned to exactly
   `accrued + fee` (the coordinator-computed `fee`), so `A` can **only** land in
   `balance`, never in `accrued`/the hook.
3. **Anti-skim intact.** `deposit.ak` is unchanged; `receiver_delta ≥ swept` still forces
   full credit of every swept lovelace (including token-wrapped deposits).
4. **No balance drain.** `A ≥ 0` forbids any physical decrease; `accrued` only grows by
   `fee`; `balance' ≥ 0` is guaranteed by `fee ≤ balance + A`. Settle/Withdraw remain
   separate redeemers — A2 does not touch them.
5. **No fee inflation / evasion.** `fee = base + N·k` with `N` bounded by the real signed
   intents, **independent of `A`** — absorbing a deposit cannot change the fee charged.
6. **No churn / no-op.** A valid update needs valid intents; `ApplyBatch []` is rejected
   (`valid_batch_receiver_accrue_fee` returns `False` on the empty list).
7. **No slack for `A`.** `exact_locked_lovelace` pins **both** input and output to their
   datums, so `A = L' − L` has no wiggle room — it is exactly the declared balance
   increase, nothing can hide in the UTxO.
8. **NEW real risk — off-chain liveness coupling.** A bad fold can fail the *update* (not
   just the top-up). Mitigation: the best-effort fold + fallback-to-pure-update policy
   above (fold only confirmed clean deposits; on failure resubmit the update alone).

#### Cost rationale (why B, not a new redeemer A)

The rejected **Option A** = a dedicated 6th `ReceiverRedeemer` constructor + its own
spend branch + transition; the chosen **Option B** = generalize the existing
`accrue_fee_transition`.

- **Contract SIZE:** **B is smaller than A**, not smaller than today. Measured: the
  blueprint grows **+620 bytes** vs the current contracts (178,933 → 179,553), because the
  absorb logic inlines into `receiver.spend`'s AccrueFee branch and
  `update_coordinator.valid_receiver_accrue_fee`. Option A would add that **same** logic
  **plus** a 6th `ReceiverRedeemer` constructor and a duplicate spend branch → A > B.
- **CPU / MEM:** B's only extra work is `added = lovelace_of(next_output) −
  lovelace_of(own_input)`. **Both `lovelace_of` values are ALREADY computed** by
  `exact_locked_lovelace`, so the evaluator shares them. Measured: the
  `receiver_spend_accrue_fee_decodes_batch_redeemer` bench is **identical before/after**
  (e.g. size-0: mem 401,011 / cpu 175,326,385 unchanged) → **CPU/MEM delta = 0**. Option A
  keeps the pure-update path byte-identical too but pays with a larger script for the same
  zero CPU/MEM gain.
- **Batch-10 capacity:** dominated by the `N` secp256k1 verifications in `oracle_logic`,
  so **neither option moves it**; the only real differentiator is script size → **B**.
- **Verify with** `aiken build` (compare script bytes) and `aiken bench` on
  `receiver_spend_accrue_fee_decodes_batch_redeemer` (size 10,
  [receiver.ak:505-516](../../../contracts/aiken/validators/receiver.ak#L505-L516)) before/after.

#### Deployment note

A2 changes the **`receiver`** and **`update_coordinator`** script hashes → it requires a
**full re-bootstrap** (acceptable pre-launch; contrast [A0](#a0-the-deployed-contract-constraint-read-first)).
`deposit.ak`'s **source is unchanged**, but its per-client parametrization (and therefore
its address) **re-derives** because it depends on the Receiver NFT policy — which moves
when `receiver` is recompiled.

#### Test plan

- **`receiver_logic.ak` (inline):** generalized-transition tests — absorb `A > 0` into
  balance; **reject `A < 0`**; **reject diversion of `A` into `accrued`**; **`A = 0`
  identical to today** (re-asserts the current cases unchanged).
- **`update_coordinator.ak`:** a combined **update + absorb** tx validates; the existing
  pure-update tests still pass.
- **`deposit_logic.ak`:** a combined **`AccrueFee` + `CollectDeposit`** tx (anti-skim
  holds — `receiver_delta = A ≥ swept`).
- **Emulator:** an update that **also absorbs a deposit**, plus the **bounded-cap
  measurement vs a batch-10** update (find the safe fold cap from tx-budget headroom).
- **Bench / build:** size + cost comparison (`aiken build` bytes; `aiken bench` on the
  batch-10 case) to confirm the negligible CPU/MEM delta and the smaller script.

---

## Part B — Monitoring, config, API, CLI & policy

These are the open `§ Monitoring, config & API` items in
[milestone-feeder-plan.md](./20260616-milestone-feeder-plan.md), now with grounded designs.

### B1. Thresholds — single source of truth

🟡 **M2 operability.** ✅ **Implemented 2026-06-06** (commit `21634ff`): BOTH
layers from the design below shipped — the `generate-monitoring.ts` generator
(`make generate-monitoring`, a prerequisite of `make up`) writes the thresholds
from `infrastructure.<network>.yaml::alerting.*` into `monitoring/alerts.yml` + the
Grafana dashboard, and the drift test (`make check-thresholds`) is the
belt-and-suspenders enforcer. `reorg_rate_high_per_hour` added; the three dead
template vars removed. Design notes below kept for reference.

**Goal.** `infrastructure.<network>.yaml::alerting.*` is the only place thresholds
are written; Prometheus rules + Grafana panels never drift from it.

**Current state (grounded).** Canonical YAML keys exist and are validated
([infrastructure.preview.yaml:267-288](../../../offchain/feeder/config/infrastructure.preview.yaml#L267-L288);
`AlertingConfig` in [types.ts:214-249](../../../offchain/feeder/src/config/types.ts#L214-L249);
`validateAlerting` in [validate.ts:186-222](../../../offchain/feeder/src/config/validate.ts#L186-L222)).
But:

- `monitoring/alerts.yml` hardcodes each threshold inline, and converts
  **lovelace→ADA in the expr** (e.g. `… / 1000000 < 2` for `ReceiverBalanceLow`)
  while the YAML key is in lovelace — a **unit-mismatch drift trap**. Confirmed
  for `OraclePairStale` (3600 s), `ReceiverBalanceLow` (2 ADA), `SettleOverdue`
  (10 ADA), `PaymentHookWithdrawReady` (50 ADA), `AdminWalletLow` (5 ADA),
  `PriceDeviationHigh` (5 %), `PriceAgeHigh` (600 s), plus `for:` windows.
- `feeder.json` hardcodes the same numbers in panel `thresholds.steps`; template
  vars `stale_threshold_seconds`, `receiver_warn_lovelace` exist **but panels
  don't use them**; `coordinator_warn_lovelace` is **unused** (no coordinator
  balance concept in this feeder).
- Only the in-process evaluator reads the YAML, and even it takes
  `pairStalenessThresholdMs` as a **constructor param**, not directly from YAML
  ([evaluator.ts:1-124](../../../offchain/feeder/src/alerting/evaluator.ts#L1-L124)).

**Design (two layers, do both).**

1. **Generate at build/deploy** — a small generator
   `offchain/feeder/scripts/monitoring/generate-monitoring.ts` reads the
   network-selected infra YAML and emits `alerts.yml` + the threshold-bearing
   panels of `feeder.json` from templates. Wire into a `make generate-monitoring`
   target, run before `make build`. Keep generated files committed (review-able)
   but stamped "generated — edit the YAML".
2. **Drift test (belt-and-suspenders)** —
   `src/config/__tests__/threshold-drift.test.ts` parses YAML + `alerts.yml` +
   `feeder.json` and asserts equality (with the lovelace↔ADA conversion encoded
   once), and asserts the declared template vars are actually referenced by
   panels. Fails CI on drift even if someone hand-edits.

Also: make the evaluator read `alerting.oracle_pair_stale_seconds` from config
(remove the redundant constructor param, or assert they agree) so the in-process
path shares the single source.

**Decisions:** unused `coordinator_warn_lovelace` → **remove**; unused
`stale_threshold_seconds` / `receiver_warn_lovelace` → **wire** to panels (the
generator does this).

**Tests:** the drift test above; generator golden-output test (YAML → expected
rules snapshot). **Docs:** README "Thresholds and alerts" — document "edit YAML,
run `make generate-monitoring`"; note the ADA-display / lovelace-config convention.

**Open question:** generate-and-commit vs generate-at-container-start? (Commit the
generated files plus the drift test — most review-friendly; recommended.)

### B2. Fix misleading rate panels

🟡 **M2 operability.** ✅ **Implemented 2026-06-06** (`89bd0ec`): the three panels
now use `increase[5m]` counts (not `rate[5m]`), keep `symbol` (the failed panel had
dropped it), with truthful titles/units; a drift-test assertion locks them to
`increase()` + `symbol`.

**Goal.** Panels show truthful counts with the right labels and units.

**Current state (grounded, [feeder.json](../../../offchain/feeder/monitoring/grafana/dashboards/feeder.json)):**
"Tx confirmed rate (5m)" = `sum by (symbol) (rate(…confirmed_total[5m]))`;
"Tx failed rate (5m)" = `sum by (error_code) (rate(…failed_total[5m]))` — **drops
`symbol`**; "Intents filtered by reason" = `sum by (reason) (rate(…filtered_total[5m]))`.
All are per-second averages labeled like throughput. Underlying metrics carry more
labels than the panels keep: `transactions_failed_total{symbol,client_id,error_code}`,
`transactions_confirmed_total{symbol,client_id}`,
`intents_filtered_total{symbol,router_id,reason}`
([metrics.ts](../../../offchain/feeder/src/api/metrics.ts)).

**Design.** Switch to `increase(…[$__rate_interval])` **counts** (or per-minute),
unit `tx`/`intent` not `ops`; keep `symbol` (and add `client_id` once B3 lands).
e.g. failed: `sum by (symbol, error_code) (increase(dia_bridge_transactions_failed_total[$__rate_interval]))`.

**Changes:** `feeder.json` panel exprs/units/legends (and via B1's generator if a
panel reads a threshold). **Tests:** add these panels to the drift/lint check
(valid PromQL, expected `by` labels). **Docs:** none beyond the dashboard.

**Open question:** counts vs per-minute rate as the default view? (Counts read
more honestly for low-volume oracles; recommend counts.)

### B3. Dashboard filter variables ($client …)

🟡 **M2 operability.** ✅ **Implemented 2026-06-06** (`41b215d`):
`$client` / `$symbol` / `$customer` / `$error_code` template vars (`label_values`,
`All = .*`) wired into the client-filterable panels with `{client_id=~"$client", …}`
+ `sum by(…)`; global panels marked "(all clients)"; the drift test asserts each var
is actually used.

**Goal.** Template vars `$client` → `$symbol` / `$customer` / `$error_code`; each
per-label panel filters `{client_id=~"$client", …}` + `sum by(…)`; `All` (`.*`)
aggregates instead of vanishing.

**Current state (grounded label sets from
[metrics.ts](../../../offchain/feeder/src/api/metrics.ts)) — verified & corrected:**

- **Client-filterable (carry `client_id`):** transactions submitted/confirmed/
  failed/reorg; latency **phases 3-5** (`scan_to_processing`,
  `processing_to_submission`, `submission_to_confirmation`) + `end_to_end`;
  `oracle_last_confirmed_timestamp`; receiver `balance`/`accrued`;
  `receiver_topup_warnings`; `pair_is_create`; `cron_resubmissions`;
  `intents_{submitted,confirmed,failed}_lifecycle`; `transaction_fee`.
- **Per-symbol only (NO client):** `intents_scanned/routed/filtered`; latency
  **phases 1-2** (`intent_to_registration`, `registration_to_scan`); `price_deviation`;
  `price_age`. → document as not client-filterable.
- **Global:** `admin_wallet`, `payment_hook_accrued`, scanner/http/db/worker
  families, events, component_health. → document as global.

> Correction vs the draft: latency **phases 3-5 are client-filterable** (they carry
> `client_id`), phases **1-2 are not** (symbol only). The draft had this right;
> this confirms it against the code.

**Design.** Add Grafana template variables (`$client`, `$symbol`, `$customer`,
`$error_code`) sourced via `label_values(...)`; default `All` = `.*`. Update each
panel's expr to filter + `sum by(...)`. Mark global panels "(all clients)".
Best produced via the **B1 generator** so the label wiring stays consistent.

**Tests:** drift/lint — every panel that uses `$client` queries a metric that
actually has `client_id` (cross-check against the metrics module). **Docs:**
README dashboard section — what's filterable vs global, and why.

### B4. OpenAPI / Swagger from a route table

🟡 **M2 operability.** ✅ **Implemented 2026-06-06** (`0a1ba53`): a `src/api/routes.ts`
metadata table (TypeBox schemas) drives an OpenAPI 3.0.3 doc at `/api/v1/openapi.json`;
`/docs` serves Redoc from a vendored `public/redoc.standalone.js` (offline, no CDN; the
Dockerfile copies it). A test asserts the table and the dispatch can't diverge.

**Goal.** A metadata-driven route table that drives routing **and** a generated
`/api/v1/openapi.json` + offline Swagger UI/Redoc at `/docs` (works in Docker, no
CDN). Drift-proof by construction.

**Current state (grounded).** Raw `node:http`; all 24 routes in a `RouteMatch`
union ([server.ts:56-80](../../../offchain/feeder/src/api/server.ts#L56-L80)),
`matchRoute()` regex + a big `switch(route.kind)` dispatch (server.ts:204-554).
Response shapes are typed in per-resource builders; **`zod` is not a dependency**;
query parsing is manual (`parseLimit`, etc.). Tests:
[`api/__tests__/server.test.ts`](../../../offchain/feeder/src/api/__tests__/server.test.ts).

**Design.** Introduce `src/api/routes.ts`: an array of route descriptors
`{ method, path, kind, summary, params, query, responseSchema, handler }`. Drive
`matchRoute` + dispatch from it (handlers move out of the switch into the table,
incrementally). Generate the OpenAPI doc from the same table. **Schema lib:**
since `zod` is absent, use **TypeBox** (`@sinclair/typebox` + its JSON-Schema →
OpenAPI) — schema *is* JSON Schema, near-zero runtime cost, no validator rewrite
forced. Bundle Swagger UI (or Redoc) static assets under `offchain/feeder/public/`
and serve `/docs` + `/api/v1/openapi.json`; ship assets in the Docker image
(offline).

**Migrate incrementally:** table + generator + `/docs` first with response
schemas declared; keep the existing handlers; optionally add response validation
behind a debug flag.

**Changes:** `src/api/routes.ts` (NEW), `server.ts` (dispatch from table),
`src/api/openapi.ts` (NEW generator), `public/` assets, `package.json`
(`@sinclair/typebox`), Dockerfile (copy `public/`). **Tests:** every route in the
table resolves; generated spec validates (OpenAPI schema); `/docs` + `openapi.json`
return 200 offline; existing server tests stay green. **Docs:** README "HTTP API"
→ point at `/docs`; architecture note on the route-table pattern.

**Open question:** Swagger UI vs Redoc (both offline-bundle-able; Redoc is a single
JS file — lighter for Docker). Recommend Redoc.

### B5. Multi-client batch settle (CLI)

🟡 **M2 operability** (cost amortization; not blocking). ✅ **Implemented**: the
CLI now settles N clients' accrued fees in one tx, as the coordinator already
supported.

**Goal.** Settle N clients' accrued fees in one tx (the coordinator already
supports it), instead of one tx per client.

**Shipped (grounded).** Coordinator validates an N-receiver `SettleManifest`
(non-empty + unique + Σ drained == hook delta)
([coordinator_logic.ak SettleManifest/SettleReceiver](../../../contracts/aiken/lib/dia_cardano_oracle/coordinator_logic.ak),
[update_coordinator.ak:198-225](../../../contracts/aiken/validators/update_coordinator.ak#L198-L225)).
The CLI now matches: `settle` takes repeatable `--client-state`
(`settle.ts::settleAccruedFees` accepts `clientStatePaths: string[]`, rejecting an
empty set + duplicate paths), loads every client, and `build-settle.ts::buildSettleTransaction`
builds the N-entry manifest, `collectFrom`s all N Receivers + the single shared hook,
drains each Receiver's accrued to zero (balance unchanged), and credits Σ to the hook.
The exactly-1 preflight is replaced by
`preflight/settle.ts::assertSettleManifestMatchesClientReceivers` (non-empty +
unique + 1:1 with the loaded clients, order-independent). CLI parsing reads
`--client-state` as a repeatable flag (`index.ts::allFlagValues("--client-state")`).

**Tests (shipped).** `run-tests.ts::testSettleManifestMatchesClientReceivers`
(preflight matrix) + `testMultiClientSettleSumAccrued` (N-receiver collect +
per-receiver clearing + Σ to hook). The emulator `protocol-flow.ts` onboards a
second client (`client-b`) and runs a `settle:multi` step that drains BOTH receivers
in one tx through real Plutus, asserting each receiver's `accrued_to_hook_lovelace`
== 0 afterward.

**Open question (still open):** cap N per tx (tx-size/exec budget) — measure and
document a safe max.

### B6. Per-client deviation + heartbeat push policy

🟡 **M2 operability** (fewer tx, lower Cardano fees). **Default OFF.**
✅ **Implemented 2026-06-06** (`1997025`): opt-in per-destination `max_staleness`;
with `time_threshold: 0s` the gate passes only on price deviation OR age >
`max_staleness`, and the cron uses `max_staleness` as the resubmission ceiling.
`time_threshold > 0` keeps the classic OR-gate unchanged. The consumer trade-off is
documented in `policy.ts`.

**Goal.** A per-client mode that pushes **only on price deviation** OR a
**much-longer max-staleness/heartbeat**, instead of the current short periodic
push — for clients who don't need a tight time cadence.

**Current state (grounded).** Gate is `time_threshold || price_deviation`
([policy.ts createPolicyGate](../../../offchain/feeder/src/router/policy.ts)); the
cron re-submits every `time_threshold` regardless of price change
([cron-service.ts:118-207](../../../offchain/feeder/src/cron/cron-service.ts#L118-L207)),
so a flat price still pushes every few minutes. Per-destination config flows from
the router YAML through `router.ts` into the gate.

**Design.** Add a per-destination `max_staleness` (duration) and treat
`time_threshold: "0s"` as "no periodic heartbeat". New mode = **push on deviation
OR when age > max_staleness**. Extend `PolicyGateOptions` with `maxStalenessMs`;
the gate passes on `pricePasses || ageExceedsMaxStaleness`. The cron, when
`time_threshold==0` and `max_staleness` set, resubmits only past `max_staleness`.
Reuse `parseDurationMs`. **No contract change.**

**Document the consumer trade-off** (this is the important bit): an unchanged
on-chain price can't, by itself, be told apart from "feeder skipped it (no
deviation)" vs "feeder down". Mitigate with the `max_staleness` bound + `/health`
liveness + the `OraclePairStale` alert. It is an **operational decision DIA makes
per client.**

**Changes:** `policy.ts` (option + gate branch + parser), `cron-service.ts`
(max-staleness branch), router YAML schema/types (`max_staleness`), router wiring.
**Tests:** gate — deviation-only passes on deviation, blocks on flat-within-window,
passes when age>max; cron — `time_threshold==0`+max enforces max only; existing
modes unchanged ([policy.test.ts](../../../offchain/feeder/src/router/__tests__/policy.test.ts),
[cron-service.test.ts](../../../offchain/feeder/src/cron/__tests__/cron-service.test.ts)).
**Docs:** README cron/policy section + the trade-off note; router YAML docstrings;
infra YAML cron comment.

**Open question:** is the trade-off acceptable to DIA per client, and what default
`max_staleness` to suggest? (Default the mode OFF; opt-in per client.)

### B7. Teardown burns + deposit ref-script reclaim

🟡 **M2 operability** (ADA recovery on decommission; not blocking).
✅ **Implemented**: a `Burn` path on the three remaining NFT families and a fix that
folds the per-client `deposit` reference script into the client reclaim.

**Goal.** Recover every UTxO's min-ADA when a deployment is torn down. The
[teardown audit](../../audit/20260607-contract-teardown-ada-recovery.md) found two
leaks on the deployed contracts: `config_state` / `payment_hook` / `receiver` NFTs
were non-burnable (so each UTxO's min-UTxO — a ~15 ADA/deployment floor — was lost),
and the per-client `deposit` reference script was published but never reclaimed by
the CLI. Both leak **recoverable** ADA on every teardown.

**Shipped (grounded).** Each of `config_state`, `payment_hook`, and `receiver`
gained a mint `Burn` action and a spend `Burn` redeemer mirroring the existing
`pair_state` burn (`config_logic.ak` `ConfigRedeemer::Burn`,
`payment_hook_logic.ak` `PaymentHookRedeemer::Burn`, `receiver_logic.ak`
`ReceiverRedeemer::Burn`; validators `config_state.ak`, `payment_hook.ak`,
`receiver.ak`). Every burn is config-signer gated, burns the NFT `-1`, forbids a
continuation output carrying the NFT, and zeroes the value fields it guards
(receiver: `balance == 0 && accrued_to_hook == 0`; hook: `accrued_fees == 0`;
config: none). Redeemer indices: `ReceiverRedeemer::Burn = 5`,
`ConfigRedeemer::Burn = 1`, `PaymentHookRedeemer::Burn = 3`; mint-action `Burn = 1`
in each. New CLI verbs `receiver:burn` / `payment-hook:burn` / `config:burn` mirror
`pair:burn`. The reclaim fix extends `reclaim-reference-script --script client` to
also spend the `deposit` reference output when the client state recorded one
(`reclaim-reference-script.ts` `resolveClientUtxoRefs` + the cleared-entry block),
skipping it for pre-deposit client states.

**Why it required the re-bootstrap Option B already forces.** A burn changes each
validator's compiled hash → its on-chain address, so it **cannot** be added to the
live Preview/Mainnet deployments — their UTxOs would be stranded. The teardown of
the *current* contracts is therefore unchanged (still loses ~15 ADA + the deposit
ref-script). But the [A2 / Option B](#a2-unified-update--top-up-generalized-accruefee)
generalized `AccrueFee` already re-bootstraps every contract, so the next
generation ships with the burn path and recovers the full min-UTxO on every future
teardown.

**Tests (shipped).** Inline Aiken burn tests beside each validator
(`config_state.ak`, `payment_hook.ak`, `receiver.ak`), mirroring `pair_state`'s
`BurnPairs` / `BurnPair` cases: happy burn recovers min-ADA; non-signer rejected;
positive mint quantity under `Burn` rejected; continuation-output carrying the NFT
rejected; non-zero value-field (balance / accrued / accrued_fees) rejected.

**Decommission runbook + executed teardown (shipped).** New
`offchain/cli/scripts/run-teardown-cli.sh` (chain-as-truth: queries the live on-chain
UTxOs, acts only on what is live, records each into the entity JSON, marks orphans;
`--run-id` / `--from-step` / `--skip-singleton-burns`) plus helpers
`scripts/teardown-helpers/{query-live,record-teardown}.ts`. The Preview OLD deployment
`preview_run_20260606-082456` was **actually torn down** — recovered the receiver
balance + hook accrued + 10 pairs + all reference scripts (incl. config + coordinator);
~15 ADA stayed stuck = the 3 non-burnable NFT min-UTxOs on the OLD contracts (expected,
since the OLD deployments predate the `Burn` action; recovered only on next-gen
redeployments).

**Docs (shipped).** Architecture §5.15 (decommission/teardown) + §7 redeemer index;
the teardown audit
([`docs/audit/20260607-contract-teardown-ada-recovery.md`](../../audit/20260607-contract-teardown-ada-recovery.md):
current-vs-next-gen recovery, both gaps marked fixed, the `run-teardown-cli.sh` runbook);
CLI README maintenance verbs + the §32 reclaim table; aiken + feeder README
validator/admin notes.

---

## Shared helpers to build

Cross-cutting, so we build once and reuse:

- **`monitoring/generate-monitoring.ts`** (B1) — also emits B2 panels + B3 filter
  wiring; the threshold-drift test consumes the same parser.
- **Deposit filter** (A1) — pure UTxO classifier (ADA-only / above-min / reject
  dust+tokens+oversized-datum); reusable by any "sweep an address" feature.
- **`findReceiversByUnit(clients)`** (B5) — multi-UTxO lookup; the A1 merge can
  reuse the single-receiver variant.
- **Route-table + OpenAPI** (B4) — the table is the contract for future endpoints
  (e.g. an A1 "deposit address" read endpoint).

## Sequencing & dependencies

1. **B1 first** (single-source thresholds) — it underpins B2 + B3 (the generator
   produces those panels) and is low-risk.
2. **B2 + B3** on top of B1's generator.
3. **B4** independent — can run in parallel.
4. **B6** independent — small, off-chain only.
5. **B5** independent — CLI only.
6. **A1** is the big one. On-chain change is additive (no re-bootstrap) **iff** we
   reuse `TopUp` (confirm the implementation check). Gate its *scope/timing* on
   open question 1 below before committing it to the M2 critical path.

## Consolidated open questions / decisions

**For DIA (operational / policy):**

1. **Option A scope/timing for M2** — required before the Mainnet daemon run, or
   land in parallel while the daemon runs CLI-funded top-ups? *(A1)*
2. **Per-client heartbeat trade-off** acceptable, and default `max_staleness`?
   *(B6)*

**For us (engineering, decide & record):**

1. A1: reuse `TopUp` (chosen, no re-bootstrap) vs a dedicated absorb-deposits
   redeemer (needs re-bootstrap) — confirm the `TopUp`-allows-extra-inputs check.
2. A1: merge permissionless vs feeder-gated; min-UTxO/dust floor; max deposits per
   tx; trigger (threshold-only vs +periodic).
3. B1: generate-and-commit vs generate-at-startup (recommend commit + drift test);
   remove `coordinator_warn_lovelace`.
4. B4: TypeBox (recommended, no `zod` today) + Redoc (single-file, offline).
5. B5: safe max N receivers per settle tx (measure).

---

*Plan authored 2026-06-06. Implements Issue 1 / Option A of
[the receiver audit](../../audit/20260605-receiver-concurrency-and-griefing.md)
(Issue 2 is out of scope here) and the `§ Monitoring, config & API` items in
[milestone-feeder-plan.md](./20260616-milestone-feeder-plan.md).*
