# Milestone 2 — Pre-Mainnet Hardening & Operability: Implementation Plan

Detailed, code-grounded implementation plan for two bodies of work to land before
(or alongside) the M2 Mainnet feeder run:

- **Part A — Receiver funding (side-deposit + merge)** (Issue 1 / Option A from
  [docs/audit/20260605-receiver-concurrency-and-griefing.md](../audit/20260605-receiver-concurrency-and-griefing.md)):
  let a client fund their balance with an ordinary wallet payment — the
  contract + feeder changes that delivers.
- **Part B — Monitoring, config, API, CLI & push policy** (the open
  `§ Monitoring, config & API` items in
  [docs/plans/milestone-feeder-plan.md](milestone-feeder-plan.md)).

> **Out of scope:** Issue 2 of the audit (active update-griefing) is **not** part
> of this plan — it is a separate DIA policy discussion, tracked in the audit
> note, not engineering work scheduled here.

Every file/line reference below was verified against the current tree on
2026-06-06. Where a sketch is shown it is marked **[sketch — verify on impl]**.

## Contents

- [How to read this plan](#how-to-read-this-plan)
- [Quality bar (applies to every item)](#quality-bar-applies-to-every-item)
- [Part A — Receiver funding (side-deposit + merge)](#part-a--receiver-funding-side-deposit--merge)
  - [A0. The deployed-contract constraint (read first)](#a0-the-deployed-contract-constraint-read-first)
  - [A1. Option A — side-deposit address + feeder merge](#a1-option-a--side-deposit-address--feeder-merge)
- [Part B — Monitoring, config, API, CLI & policy](#part-b--monitoring-config-api-cli--policy)
  - [B1. Thresholds — single source of truth](#b1-thresholds--single-source-of-truth)
  - [B2. Fix misleading rate panels](#b2-fix-misleading-rate-panels)
  - [B3. Dashboard filter variables ($client …)](#b3-dashboard-filter-variables-client-)
  - [B4. OpenAPI / Swagger from a route table](#b4-openapi--swagger-from-a-route-table)
  - [B5. Multi-client batch settle (CLI)](#b5-multi-client-batch-settle-cli)
  - [B6. Per-client deviation + heartbeat push policy](#b6-per-client-deviation--heartbeat-push-policy)
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
  the validator (the 117-test pattern). Off-chain → `node:test` suites beside the
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
[docs/audit/20260605-receiver-concurrency-and-griefing.md](../audit/20260605-receiver-concurrency-and-griefing.md)
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
([receiver_logic.ak:36-52](../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak#L36-L52)).
So a "merge" tx can **reuse `TopUp`**: spend the Receiver + the deposit UTxOs,
recreate the Receiver with `balance += Σ deposits`. No new Receiver redeemer is
required.

### A1. Option A — side-deposit address + feeder merge

🔴 **M2-blocking** (per the audit's "requirement" framing — confirm scope in
[open questions](#consolidated-open-questions--decisions)).

**Goal.** A per-client **deposit script address**. Clients fund their balance by a
**plain wallet payment** to that address — no CLI, no datum, no script knowledge.
The feeder sweeps accumulated deposits into the Receiver's `balance_lovelace`
through its own serial lane, triggered before the balance runs dry, so the prepay
never stalls and there is no refill-time stale window.

#### Current state (grounded)

- Receiver is a single NFT-bearing UTxO; `TopUp` spends + recreates it
  ([receiver.ak:14-22 redeemer enum](../../contracts/aiken/validators/receiver.ak#L14-L22),
  [:57-62 V3 `maybe_datum: Option<…>`](../../contracts/aiken/validators/receiver.ak#L57-L62),
  [:68-89 NFT qty-1 continuation](../../contracts/aiken/validators/receiver.ak#L68-L89)).
- `TopUp` branch = pure `top_up_transition`, **no config/signer lookup**
  (permissionless) — confirmed in the receiver dispatch.
- Today's top-up is protocol-aware: the CLI spends the canonical NFT UTxO and
  recreates it ([offchain/cli/src/transactions/receiver-top-up.ts:62-120](../../offchain/cli/src/transactions/receiver-top-up.ts#L62-L120)).
  A naive wallet send to the **Receiver** address bricks the UTxO (its validator
  does `expect Some(datum)`). The deposit address is a *separate* script that
  tolerates `None`.
- Per-client parametrization pattern: `receiver` is parametrised by
  `(bootstrap_ref, expected_asset_name, config_policy_id, config_asset_name)`
  ([receiver.ak:22-27](../../contracts/aiken/validators/receiver.ak#L22-L27));
  off-chain wiring is `makeReceiverValidator(...)` in
  `offchain/cli/src/core/contracts.ts`; the address is
  `scriptAddressFromValidator(...)`.
- The feeder serialises updates per lane
  `laneKey = client_state_path::protocol_state_path`
  ([offchain/feeder/src/submitter/lane-key.ts:8-10](../../offchain/feeder/src/submitter/lane-key.ts#L8-L10))
  through the coalescer state machine
  ([offchain/feeder/src/submitter/coalescer.ts:100-384](../../offchain/feeder/src/submitter/coalescer.ts#L100-L384)).
- UTxO queries: `lucid.utxosAt(address)` / `utxosAtWithUnit`, wrapped by
  `findSingleUtxoAtUnit` ([offchain/cli/src/core/chain-helpers.ts:110-136](../../offchain/cli/src/core/chain-helpers.ts#L110-L136)).
- Balance polling already exists: `bridge.snapshotBalances(...)`
  ([offchain/feeder/src/lib-bridge/index.ts](../../offchain/feeder/src/lib-bridge/index.ts)),
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
    would require the heavier `AbsorbDeposits` path below.

**Alternative (heavier) — dedicated `AbsorbDeposits` redeemer.** Add a redeemer
variant + `absorb_deposits_transition` to the Receiver. Cleaner intent + its own
metrics, but it **edits `receiver.ak` → new address → full Mainnet re-bootstrap**.
Only worth it if we re-deploy Mainnet for other reasons. **Recommended: reuse
`TopUp`; keep `AbsorbDeposits` as a noted alternative.**

**Off-chain — CLI.**

- `offchain/cli/src/core/contracts.ts`: `makeDepositValidator({...})` +
  `DEPOSIT_SPEND_TITLE` (mirror `makeReceiverValidator`).
- `offchain/cli/src/deploys/deposit-parameterize.ts` (NEW): derive the per-client
  deposit validator + address; persist into the client-state artifact, e.g.
  `receiver.depositValidatorAddress`. Wire into the client init/parameterize flow
  next to `receiver-parameterize.ts`.
- New command `receiver:deposit-address` (or extend `receiver`): **print the
  client's deposit address** so DIA can hand it to the client. This is the entire
  client-facing funding UX: "send ADA here."
- `aiken build` regenerates `plutus.json` with `deposit.deposit.spend`; the CLI
  consumes it via the existing `getBlueprintValidator` + `applyParamsToScript`
  path (`offchain/cli/src/core/blueprint.ts`).

**Off-chain — feeder (the merge machinery).** New module
`offchain/feeder/src/deposits/` with:

1. **Watcher** — query `lucid.utxosAt(depositAddress)` per client (reuse the
   provider already wired for `snapshotBalances`).
2. **Filter** — accept only **ADA-only** UTxOs above min-UTxO; **skip** dust,
   native-token junk, and oversized-datum UTxOs (they stay harmlessly at the
   address). Pure function → easy unit tests.
3. **Merge tx builder** — model on
   [receiver-top-up.ts:62-120](../../offchain/cli/src/transactions/receiver-top-up.ts#L62-L120):
   `collectFrom([receiverUtxo], TopUp)` plus `collectFrom(selectedDeposits, CollectDeposit)`,
   recreating the Receiver with `balance += Σ`. Cap deposit count per tx (tx-size
   budget) and `log()` any deferred remainder.
4. **Submission** — enqueue through the **same coalescer lane** as updates so the
   merge never races the feeder's own txs (reuse `laneKey`, the in-flight lock).
5. **Trigger** — when `snapshotBalances` shows
   `receiver_balance < alerting.receiver_balance_low_lovelace`, schedule a merge;
   optional periodic safety sweep. **Reuse the existing threshold — no new knob.**
6. **Metrics** — `dia_bridge_cardano_deposits_swept_total{client_id}`,
   `..._swept_lovelace_total{client_id}`, `..._deposits_skipped_total{client_id,reason}`;
   reuse the `client_id` label convention from
   [metrics.ts](../../offchain/feeder/src/api/metrics.ts).

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

- **Aiken (inline, mirror the 117-test style in
  [receiver_logic.ak](../../contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak)):**
  happy sweep credits balance; **anti-skim** (N deposits, under-credit rejected);
  wrong Receiver NFT rejected; Receiver not consumed rejected; datum-less deposit
  accepted; dust/native-token deposit cannot force a bad credit; tx that routes
  swept ADA to change instead of the Receiver rejected.
- **CLI:** `makeDepositValidator` determinism (address per client); artifact
  round-trip; merge-tx builder datum/NFT preservation (extend the existing
  build-tx test patterns in `offchain/cli/src/__tests__`).
- **Feeder:** filter unit tests (dust/token/datum/min-utxo matrix); watcher
  selection caps; merge enqueues on the correct lane and never overlaps an
  in-flight update (extend `coalescer.test.ts` patterns).

#### Docs to update

- `docs/architecture/feeder.md` — new "Deposit & merge" subsection.
- `offchain/feeder/README.md` — operator section: the deposit watcher, the
  trigger threshold, metrics, what gets skipped.
- `offchain/cli/README.md` — `receiver:deposit-address` + how to give it to a
  client; the "fund with a plain payment" UX.
- `contracts/aiken/README` (or contracts doc) — the deposit validator + anti-skim
  invariant.
- Resolve the audit note: once shipped, update Issue 1 status.

#### Open questions (A1)

1. **Scope/timing:** is full Option A required *before* the first Mainnet daemon
   run, or can the daemon run on Mainnet (CLI-funded top-ups) while Option A lands
   in parallel? (Affects the M2 critical path.)
2. **Merge authorization:** keep the merge **permissionless** (anyone can credit a
   client — only ever helps them), or gate it to the feeder/admin? Permissionless
   is simpler and safe by construction; confirm DIA is comfortable.
3. **min-UTxO / dust floor** for accepted deposits, and the **max deposits per
   merge tx** (tx-size budget) — pick defaults, put them in YAML.
4. Sweep cadence: trigger purely on `receiver_balance_low`, or also a periodic
   safety sweep? (One knob vs two.)

---

## Part B — Monitoring, config, API, CLI & policy

These are the open `§ Monitoring, config & API` items in
[milestone-feeder-plan.md](milestone-feeder-plan.md), now with grounded designs.

### B1. Thresholds — single source of truth

🟡 **M2 operability.** ✅ **Implemented 2026-06-06** (commit `21634ff`): the
drift test (`make check-thresholds`) is the enforcer; `reorg_rate_high_per_hour`
added; dead template vars removed. The build-time generator was not needed — the
test guarantees the mirrors agree. Design notes below kept for reference.

**Goal.** `infrastructure.<network>.yaml::alerting.*` is the only place thresholds
are written; Prometheus rules + Grafana panels never drift from it.

**Current state (grounded).** Canonical YAML keys exist and are validated
([infrastructure.preview.yaml:267-288](../../offchain/feeder/config/infrastructure.preview.yaml#L267-L288);
`AlertingConfig` in [types.ts:214-249](../../offchain/feeder/src/config/types.ts#L214-L249);
`validateAlerting` in [validate.ts:186-222](../../offchain/feeder/src/config/validate.ts#L186-L222)).
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
  ([evaluator.ts:1-124](../../offchain/feeder/src/alerting/evaluator.ts#L1-L124)).

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

🟡 **M2 operability.**

**Goal.** Panels show truthful counts with the right labels and units.

**Current state (grounded, [feeder.json](../../offchain/feeder/monitoring/grafana/dashboards/feeder.json)):**
"Tx confirmed rate (5m)" = `sum by (symbol) (rate(…confirmed_total[5m]))`;
"Tx failed rate (5m)" = `sum by (error_code) (rate(…failed_total[5m]))` — **drops
`symbol`**; "Intents filtered by reason" = `sum by (reason) (rate(…filtered_total[5m]))`.
All are per-second averages labeled like throughput. Underlying metrics carry more
labels than the panels keep: `transactions_failed_total{symbol,client_id,error_code}`,
`transactions_confirmed_total{symbol,client_id}`,
`intents_filtered_total{symbol,router_id,reason}`
([metrics.ts](../../offchain/feeder/src/api/metrics.ts)).

**Design.** Switch to `increase(…[$__rate_interval])` **counts** (or per-minute),
unit `tx`/`intent` not `ops`; keep `symbol` (and add `client_id` once B3 lands).
e.g. failed: `sum by (symbol, error_code) (increase(dia_bridge_transactions_failed_total[$__rate_interval]))`.

**Changes:** `feeder.json` panel exprs/units/legends (and via B1's generator if a
panel reads a threshold). **Tests:** add these panels to the drift/lint check
(valid PromQL, expected `by` labels). **Docs:** none beyond the dashboard.

**Open question:** counts vs per-minute rate as the default view? (Counts read
more honestly for low-volume oracles; recommend counts.)

### B3. Dashboard filter variables ($client …)

🟡 **M2 operability.**

**Goal.** Template vars `$client` → `$symbol` / `$customer` / `$error_code`; each
per-label panel filters `{client_id=~"$client", …}` + `sum by(…)`; `All` (`.*`)
aggregates instead of vanishing.

**Current state (grounded label sets from
[metrics.ts](../../offchain/feeder/src/api/metrics.ts)) — verified & corrected:**

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

🟡 **M2 operability.**

**Goal.** A metadata-driven route table that drives routing **and** a generated
`/api/v1/openapi.json` + offline Swagger UI/Redoc at `/docs` (works in Docker, no
CDN). Drift-proof by construction.

**Current state (grounded).** Raw `node:http`; all 24 routes in a `RouteMatch`
union ([server.ts:56-80](../../offchain/feeder/src/api/server.ts#L56-L80)),
`matchRoute()` regex + a big `switch(route.kind)` dispatch (server.ts:204-554).
Response shapes are typed in per-resource builders; **`zod` is not a dependency**;
query parsing is manual (`parseLimit`, etc.). Tests:
[`api/__tests__/server.test.ts`](../../offchain/feeder/src/api/__tests__/server.test.ts).

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

🟡 **M2 operability** (cost amortization; not blocking).

**Goal.** Settle N clients' accrued fees in one tx (the coordinator already
supports it), instead of one tx per client.

**Current state (grounded).** Coordinator validates an N-receiver `SettleManifest`
(non-empty + unique + Σ drained == hook delta)
([coordinator_logic.ak SettleManifest/SettleReceiver](../../contracts/aiken/lib/dia_cardano_oracle/coordinator_logic.ak),
[update_coordinator.ak:198-225](../../contracts/aiken/validators/update_coordinator.ak#L198-L225)).
But the CLI is single-client: `settle` builds a 1-entry manifest
([build-settle.ts:92-100](../../offchain/cli/src/lib/transactions/build-settle.ts#L92-L100)),
collects one Receiver + the hook ([:132-134](../../offchain/cli/src/lib/transactions/build-settle.ts#L132-L134)),
and the preflight rejects length≠1 ([preflight/settle.ts:22-41](../../offchain/cli/src/preflight/settle.ts#L22-L41)).
The uniqueness helper already exists
([preflight/settle-manifest.ts:1-23](../../offchain/cli/src/preflight/settle-manifest.ts#L1-L23)).

**Design.** Accept repeatable `--client-state <path>` (array). Load each client;
build the N-entry manifest; `collectFrom` all N Receivers + the single hook;
recreate each Receiver with `accrued := 0` (balance unchanged); the coordinator
checks Σ drained == hook delta. Replace the exactly-1 preflight with
"manifest matches the provided clients (non-empty, unique, 1:1)". Reuse
`findSingleUtxoAtUnit` per client; new helper `findReceiversByUnit(clients)`.

**Changes:** `settle.ts` (signature → `clientStatePaths: string[]`), `build-settle.ts`
(N receivers), `preflight/settle.ts` (multi-client assertion), CLI arg parsing
(repeatable flag), `run-all-cli.sh` if it invokes settle. **Tests:** multi-client
manifest length/uniqueness/Σ-accrued; N-receiver collect + per-receiver clearing;
1-client path unchanged. **Docs:** CLI README settle section — repeatable flag +
example + "all N receivers and the hook must be live (no partial sets)".

**Open question:** cap N per tx (tx-size/exec budget) — measure and document a
safe max.

### B6. Per-client deviation + heartbeat push policy

🟡 **M2 operability** (fewer tx, lower Cardano fees). **Default OFF.**

**Goal.** A per-client mode that pushes **only on price deviation** OR a
**much-longer max-staleness/heartbeat**, instead of the current short periodic
push — for clients who don't need a tight time cadence.

**Current state (grounded).** Gate is `time_threshold || price_deviation`
([policy.ts createPolicyGate](../../offchain/feeder/src/router/policy.ts)); the
cron re-submits every `time_threshold` regardless of price change
([cron-service.ts:118-207](../../offchain/feeder/src/cron/cron-service.ts#L118-L207)),
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
modes unchanged ([policy.test.ts](../../offchain/feeder/src/router/__tests__/policy.test.ts),
[cron-service.test.ts](../../offchain/feeder/src/cron/__tests__/cron-service.test.ts)).
**Docs:** README cron/policy section + the trade-off note; router YAML docstrings;
infra YAML cron comment.

**Open question:** is the trade-off acceptable to DIA per client, and what default
`max_staleness` to suggest? (Default the mode OFF; opt-in per client.)

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

1. A1: reuse `TopUp` (recommended, no re-bootstrap) vs dedicated `AbsorbDeposits`
   (needs re-bootstrap) — confirm the `TopUp`-allows-extra-inputs check.
2. A1: merge permissionless vs feeder-gated; min-UTxO/dust floor; max deposits per
   tx; trigger (threshold-only vs +periodic).
3. B1: generate-and-commit vs generate-at-startup (recommend commit + drift test);
   remove `coordinator_warn_lovelace`.
4. B4: TypeBox (recommended, no `zod` today) + Redoc (single-file, offline).
5. B5: safe max N receivers per settle tx (measure).

---

*Plan authored 2026-06-06. Implements Issue 1 / Option A of
[the receiver audit](../audit/20260605-receiver-concurrency-and-griefing.md)
(Issue 2 is out of scope here) and the `§ Monitoring, config & API` items in
[milestone-feeder-plan.md](milestone-feeder-plan.md).*
