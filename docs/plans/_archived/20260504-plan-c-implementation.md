# Plan C Implementation Plan — Decoupled Fee Settlement + Security Hardening

This is the implementation plan for the redesign described in the archived
`docs/plans/_archived/20260504-payment-hook-contention-options.md` (Option C) plus four security fixes
identified during the security review of the milestone-1 contracts.

It is a **breaking change**: the on-chain Receiver datum gains a new field,
the coordinator gains a new redeemer, and the PaymentHook spend semantics
change. Existing on-chain artefacts (Config, PaymentHook, every Receiver,
every Pair) must be re-bootstrapped after deployment.

---

## 0. Scope and goals

### Goals

1. Eliminate the cross-client contention on the global PaymentHook UTxO so
   updates from different clients can run in parallel.
2. Close four security holes found in the milestone-1 contracts.
3. Keep the EVM-equivalent observable behaviour: a signed DIA intent
   produces a Pair state update and a protocol fee is owed by the client.
4. Update **every** surface that reflects the contracts: contracts, lib
   logic, off-chain CLI, transactions, blueprint plumbing, README, the
   architecture document, milestone documents, and tests.
5. Test exhaustively, including a negative test for **every** known attack
   vector.

### Non-goals

- Migration of existing on-chain state. We re-bootstrap.
- Changes to the EIP-712 intent shape. The signed payload is unchanged.
- Indexer / feeder workstreams. Those continue separately.

---

## 1. Security fixes (independent of Plan C)

These are applied in the same redeploy.

### 1.1 PaymentHook NFT exfiltration (CRITICAL)

- **File:** `contracts/aiken/validators/payment_hook.ak`
- **Change:** in the `spend` validator, add the assertion
  `next_output.address.payment_credential == Script(own_policy_id)`
  alongside the existing checks.
- **Change:** in `has_valid_payment_hook_output` (used by `mint Bootstrap`),
  also assert
  `hook_output.address.payment_credential == Script(hook_policy_id)`.
- **Why:** the current spend localizes the next output by NFT presence and
  forgets to constrain its address. An attacker triggering the
  coordinator's `ApplyFee` path can output the Hook NFT (and all accrued
  lovelace) to a wallet they control.

### 1.2 Config NFT exfiltration (HIGH)

- **File:** `contracts/aiken/validators/config_state.ak`
- **Change:** in the `spend` validator, add
  `config_output.address.payment_credential == Script(own_policy_id)`.
- **Change:** in `has_valid_config_bootstrap_output`, add the same check.
- **Why:** the current spend is admin-gated, but a single bad admin
  signature could put the Config NFT at a wallet, after which any party
  holding that wallet UTxO could attach a forged datum and impersonate the
  protocol Config to every script that reads it.

### 1.3 Pair NFT duplication via stale signed intents (MEDIUM) — option (d)

- **Files:**
  - `contracts/aiken/lib/dia_cardano_oracle/oracle_logic.ak`
- **Change A — expiry enforcement on every intent:**
  - `valid_intent` already checks `intent.expiry >= 0`.
  - We add an additional argument to `has_valid_signature` (or wrap a new
    helper) that asserts
    `intent.expiry >= tx.validity_range.upper_bound.bound_type.finite_value`,
    and require this check on every code path that consumes an intent
    (`initial_pair_matches_witness` and `next_pair_matches_witness`).
  - Off-chain we set the tx validity range explicitly so the upper bound
    is well defined.
- **Change B — bootstrap freshness floor:**
  - `initial_pair_matches_witness` additionally asserts
    `intent.timestamp >= tx.validity_range.lower_bound.bound_type.finite_value - max_bootstrap_drift_seconds`.
  - `max_bootstrap_drift_seconds` becomes a new field of `ConfigDatum`
    (e.g. default 86_400). This is config-controlled because what counts as
    "fresh enough" can change.
- **Why:** without (A), any historical signed intent can be replayed
  forever. Without (B), a duplicate Pair NFT can be bootstrapped even with
  an expiry-clean intent (the first bootstrap path has no freshness
  comparison against any prior state). Together they close the duplicate
  vector.

### 1.4 Receiver `TopUp` zero-add griefing (MEDIUM)

- **File:** `contracts/aiken/lib/dia_cardano_oracle/receiver_logic.ak`
- **Change:** in `top_up_transition`, change `added_lovelace >= 0` to
  `added_lovelace > 0`.
- **Why:** prevents anyone from churning a Receiver UTxO with a no-op
  TopUp to block legitimate updates.

---

## 2. Plan C — Decoupled fee settlement

### 2.1 Conceptual change

Today, a single update transaction:

1. Verifies the signed DIA intent.
2. Debits the client's Receiver `balance_lovelace` by `protocol_fee`.
3. **Credits the global PaymentHook `accrued_fees_lovelace` by
   `protocol_fee`.**

After Plan C, the update transaction does:

1. Verifies the signed DIA intent.
2. Debits the client's Receiver `balance_lovelace` by `protocol_fee`.
3. **Credits the same Receiver's `accrued_to_hook_lovelace` by
   `protocol_fee`.** Lovelace stays inside the Receiver UTxO.

A new transaction, **Settle**, periodically moves
`accrued_to_hook_lovelace` from one or more Receivers to the global
PaymentHook.

### 2.2 Receiver datum change

```aiken
pub type ReceiverDatum {
  ReceiverDatum {
    balance_lovelace: Int,
    accrued_to_hook_lovelace: Int,   // NEW
    min_utxo_lovelace: Int,
  }
}
```

New invariant:

```text
output.lovelace == min_utxo_lovelace + balance_lovelace + accrued_to_hook_lovelace
```

`valid_receiver_state` now also requires `accrued_to_hook_lovelace >= 0`.

### 2.3 Receiver redeemer set

| Redeemer | Auth | Effect on `balance` | Effect on `accrued_to_hook` | Effect on UTxO lovelace |
| --- | --- | --- | --- | --- |
| `TopUp` | none | `+ added` (added > 0) | unchanged | `+ added` |
| `AccrueFee` (was `PayFee`) | coordinator | `- fee` | `+ fee` | unchanged |
| `Settle` | coordinator | unchanged | `→ 0` | `- accrued_to_hook` |
| `Withdraw {amount, recipient}` | admin | `- amount` | unchanged | `- amount` |

Notes:

- `AccrueFee` is the renamed `PayFee`, with a different transition
  (does not move lovelace out, accrues into the new field).
- `Settle` is new. It is gated on coordinator presence so that it can be
  bundled atomically with the matching PaymentHook spend.
- `Withdraw` keeps the current admin-custodial model. The recipient is
  free-form. The two new invariants are: `amount <= prev.balance` and
  `next.accrued_to_hook == prev.accrued_to_hook` (admin must not be able
  to drain the protocol's pending fees through the client's withdraw
  path).

### 2.4 PaymentHook redeemer set

| Redeemer | Auth | Effect on `accrued_fees` | Effect on `lifetime_collected` | Effect on `lifetime_withdrawn` |
| --- | --- | --- | --- | --- |
| `ApplySettle` (was `ApplyFee`) | coordinator + admin | `+ delta` | `+ delta` | unchanged |
| `AdminUpdate` | admin | unchanged | unchanged | unchanged |
| `Withdraw {amount}` | admin | `- amount` | unchanged | `+ amount` |

Notes:

- `ApplyFee` is renamed to `ApplySettle` to reflect the new role.
- The `delta` is the sum of `accrued_to_hook_lovelace` zeroed across all
  Receivers consumed in the same tx.
- `ApplySettle` is **admin-gated** in addition to coordinator-gated, per
  the decision in the design discussion (full DIA control over when fees
  move to the hook).
- The address of every output holding the Hook NFT is constrained to
  `Script(own_policy_id)` (see section 1.1).

### 2.5 Coordinator redeemer set

```aiken
pub type CoordinatorRedeemer {
  ApplySingle(UpdateWitness)
  ApplyBatch(List<UpdateWitness>)
  ApplySettle(SettleManifest)   // NEW
}
```

`SettleManifest` is the structured input that lets the coordinator validate
the settle tx in O(witnesses) without scanning the whole tx:

```aiken
pub type SettleManifest {
  SettleManifest {
    receivers: List<SettleReceiver>,
  }
}

pub type SettleReceiver {
  SettleReceiver {
    receiver_policy_id: PolicyId,
    receiver_asset_name: AssetName,
  }
}
```

The coordinator's `ApplySingle` and `ApplyBatch` paths change as follows:

- They no longer consume or recreate the PaymentHook UTxO. They no longer
  expect a hook input or output. They only interact with the Receiver and
  the Pair UTxOs.
- The fee transition on the Receiver is now `accrue_fee_transition`
  (matches the new `AccrueFee` redeemer), not `pay_fee_transition`.

The coordinator's `ApplySettle` validates:

- Exactly one PaymentHook input and one PaymentHook output in the tx.
- For each receiver in the manifest: exactly one matching input and
  matching output, both at the receiver's script address, with
  `prev.accrued_to_hook > 0` and `next.accrued_to_hook == 0`,
  `next.balance == prev.balance`, lovelace decreased by
  `prev.accrued_to_hook`.
- The PaymentHook delta equals the sum of receiver
  `prev.accrued_to_hook` values.
- Manifest receivers are unique (no double-count).
- An admin signature is present (admin-gated decision).

### 2.6 Pair / pair_state changes

`pair_state` does **not** change semantically, but it gets the same expiry
hardening as section 1.3 (the freshness check is in `oracle_logic`, used by
both the coordinator and the pair_state spend).

### 2.7 Config datum

Adds one field:

```aiken
pub type ConfigDatum {
  ConfigDatum {
    config_admins: List<VerificationKeyHash>,
    authorized_dia_public_keys: List<ByteArray>,
    domain_data: Domain,
    protocol_fee_lovelace: Int,
    payment_hook_ref: Option<PaymentHookRef>,
    update_coordinator_credential: Option<Credential>,
    max_bootstrap_drift_seconds: Int,    // NEW
    min_utxo_lovelace: Int,
  }
}
```

`valid_config_state` requires `max_bootstrap_drift_seconds >= 0`.

---

## 3. File-by-file change list

### 3.1 Aiken contracts (`contracts/aiken/`)

| File | Change |
| --- | --- |
| `lib/dia_cardano_oracle/config_logic.ak` | Add `max_bootstrap_drift_seconds`, update `valid_config_state`, update sample config and tests |
| `lib/dia_cardano_oracle/receiver_logic.ak` | Add `accrued_to_hook_lovelace` field, new invariant in `exact_locked_lovelace`, change `top_up_transition` (`added > 0`, `accrued` invariant), rename `pay_fee_transition` → `accrue_fee_transition` and rewrite, add `settle_transition`, update `withdraw_transition` to also assert `accrued` invariant |
| `lib/dia_cardano_oracle/payment_hook_logic.ak` | Rename `fee_charge_transition` → `apply_settle_transition` (semantics unchanged but accepts a delta), update tests |
| `lib/dia_cardano_oracle/oracle_logic.ak` | Add `intent_expiry_satisfied(intent, tx)` and `intent_freshness_satisfied(intent, tx, max_drift_seconds)`, plumb both into `has_valid_signature`, `next_pair_matches_witness`, `initial_pair_matches_witness`. New tests for expired and stale-bootstrap intents. |
| `validators/config_state.ak` | Add script-address check in `spend` and in `has_valid_config_bootstrap_output` |
| `validators/payment_hook.ak` | Add script-address check in `spend` and in `has_valid_payment_hook_output`. Rename `ApplyFee` → `ApplySettle`. Require `has_config_signer` in the new `ApplySettle` path. |
| `validators/receiver.ak` | Implement the four-redeemer set (`TopUp`, `AccrueFee`, `Settle`, `Withdraw`). `Settle` and `AccrueFee` require `coordinator_witness_present`; `Withdraw` requires `has_config_signer`. The new accrued-invariant must hold across all spends. |
| `validators/pair_state.ak` | No structural change, picks up the new expiry/freshness checks via `oracle_logic` |
| `validators/update_coordinator.ak` | Add `ApplySettle(SettleManifest)` variant. Strip Hook input/output from `ApplySingle`/`ApplyBatch` paths. Use the new accrue-fee transition on Receiver. Validate the settle manifest. |
| `validators/reference_holder.ak` | No change |

### 3.2 Aiken tests (in-line in `*_logic.ak` and validator-level tests)

Each `*_logic.ak` already carries Aiken `test` blocks. We extend each of
them with positive and negative cases for every new transition. Where
validator-level tests don't exist as Aiken tests today, they live as
off-chain tests in section 3.4.

### 3.3 Off-chain CLI — TS sources

For every contract change, the off-chain code that builds, signs and
submits the corresponding tx changes too. Concretely:

| File | Change |
| --- | --- |
| `offchain/cli/src/core/contracts.ts` | New parametrizers for the redeployed scripts. Same shape, new compiled blueprint. |
| `offchain/cli/src/core/blueprint.ts` | Pick up new validator titles if any. Verify hashes against the new build. |
| `offchain/cli/src/core/state.ts` | New per-receiver state field `accruedToHookLovelace`. Settle tx output recorded. |
| `offchain/cli/src/core/dia-intent.ts` | No structural change — intent payload unchanged. |
| `offchain/cli/src/init/protocol-init.ts` | Adds `maxBootstrapDriftSeconds` to the bootstrap config datum |
| `offchain/cli/src/init/config-update-create.ts` | Allow rotating `maxBootstrapDriftSeconds` |
| `offchain/cli/src/init/client-init.ts` | Receiver datum carries the new accrued field initialized to 0 |
| `offchain/cli/src/init/batch-update-create.ts` | Drops PaymentHook from update plan; emits `AccrueFee` on Receiver |
| `offchain/cli/src/transactions/update.ts` | Drops Hook input/output. Receiver redeemer becomes `AccrueFee`. Coordinator redeemer is `ApplySingle`. Sets a finite tx validity range so the on-chain `expiry` check has a concrete upper bound. |
| `offchain/cli/src/transactions/update-batch.ts` | Same as `update.ts`, batched |
| `offchain/cli/src/transactions/receiver-top-up.ts` | Enforce `added > 0` in the builder (input validation, defence in depth) |
| `offchain/cli/src/transactions/receiver-withdraw.ts` | New invariant: produced datum keeps `accrued_to_hook` unchanged |
| `offchain/cli/src/transactions/payment-hook-withdraw.ts` | No big change beyond the new datum + admin-gated `Withdraw` |
| `offchain/cli/src/transactions/settle.ts` (NEW) | Build the settle tx: pick up to N receivers with `accrued_to_hook > 0`, attach hook input + output, attach coordinator withdraw with `ApplySettle` redeemer, require admin signer |
| `offchain/cli/src/transactions/config-update.ts` | Carry new `maxBootstrapDriftSeconds` field |
| `offchain/cli/src/index.ts` | Add a new CLI command: `preview:settle`. Wire `--receivers <list>` and `--max <N>` flags. |
| `offchain/cli/src/__tests__/run-tests.ts` | Add tests, including attack-vector negative cases (see section 4) |

### 3.4 Documentation surfaces

| File | Change |
| --- | --- |
| `docs/architecture/cardano-oracle-architecture.md` | **EXTEND section 5 "Transactions"** with: enumerated validations `[1]`, `[2]` for every redeemer; Mermaid diagrams showing cross-script communication per tx type; "Who Knows What" table per tx; trust model explanation. Update subsections 5.7–5.9 (price update flow no longer touches Hook), add subsection 5.11 "Settle". Also update: sections 1 (script set), 4 (datums — new Receiver field, new Config field), section 6 (finalized design decisions) |
| `docs/plans/work-plan.md` | Add Plan-C / security fixes as workstream A2; mark prior payment-hook-contention as resolved |
| `docs/plans/_archived/20260504-payment-hook-contention-options.md` | Archived design discussion (Options A–C); superseded by current architecture |
| `docs/milestones/final-cardano-milestones.md` | Adjust language about milestone-1 fee accrual to reflect the new flow |
| `docs/milestones/milestone-1-preview-evidence.md` | Note that prior evidence is from before Plan C; new evidence will be regenerated post-redeploy |
| `README.md` (root) | Update description, quick start, refer to Settle |
| `contracts/aiken/README.md` | Update validator list, redeemers, datums |
| `offchain/cli/README.md` | Update command catalogue, add `preview:settle`, document the new datum field |
| `offchain/cli/state/README.md` | Note the new state field per receiver |

### 3.5 Build / blueprint / fixtures

- Run `aiken build` to regenerate `plutus.json`.
- Re-run the bootstrap chain on Preview to produce a fresh evidence
  package under `docs/milestones/evidence/m1-preview-<DATE>/`.
- Update fixture files if the CLI tests have any hard-coded blueprint
  hashes.

---

## 4. Test plan

The user's directive is "many many tests, exhaustive, every attack vector
as a negative test". Tests live in three layers.

### 4.1 Aiken `test` blocks (`*_logic.ak`)

Per file, **at minimum**:

#### `config_logic.ak`

- Positive: valid config with all fields set, valid config without optional refs.
- Negative: empty admins; empty DIA pubkeys; duplicate DIA pubkey; invalid domain; negative fee; negative `max_bootstrap_drift_seconds`; inconsistent hook/coordinator (one set, the other not).
- Transitions: `admin_update_transition` accepts fee rotation, accepts drift rotation, rejects `min_utxo` change.

#### `receiver_logic.ak`

- Positive: `valid_receiver_state` accepts `(balance, accrued, min_utxo)` non-negative.
- Negative: `valid_receiver_state` rejects negative balance, negative accrued, negative min_utxo.
- `top_up_transition`: positive (added > 0); negative (added == 0 → REJECT — vector 1.4); negative (next.accrued != prev.accrued → REJECT); negative (next.min_utxo != prev.min_utxo → REJECT).
- `accrue_fee_transition`: positive; negative (fee > balance → REJECT); negative (next.balance != prev.balance - fee → REJECT); negative (next.accrued != prev.accrued + fee → REJECT); negative (lovelace moved out of the UTxO → REJECT).
- `settle_transition`: positive (accrued > 0, drained to zero); negative (accrued == 0 → REJECT); negative (next.balance != prev.balance → REJECT); negative (lovelace decrease != prev.accrued → REJECT).
- `withdraw_transition`: positive; negative (amount > balance → REJECT); negative (next.accrued != prev.accrued → REJECT, prevents draining accrued via withdraw — important).

#### `payment_hook_logic.ak`

- Positive: `valid_payment_hook_state` accepts non-negative fields.
- Negative: rejects negative accrued / negative lifetime values.
- `apply_settle_transition`: positive; negative (delta == 0 should be rejected at the validator level — coordinator enforces that the manifest is non-empty); negative (next.accrued != prev.accrued + delta); negative (next.lifetime_collected mis-incremented); negative (lifetime_withdrawn changed).
- `withdraw_transition`: positive; negative (amount > accrued); negative (next.accrued != prev.accrued - amount); negative (lifetime_withdrawn miss).
- `admin_update_transition`: positive; negative (any of the three locked fields changed).

#### `oracle_logic.ak`

- Positive: real DIA signature accepted with our reference vector.
- Negative: tampered intent rejected.
- Negative: unauthorized DIA signer rejected (existing test).
- Negative: stale timestamp / nonce rejected on update path.
- **NEW** Negative (vector 1.3-A): expired intent rejected — `intent.expiry < tx.upper_bound`.
- **NEW** Negative (vector 1.3-B): bootstrap with fresh-signature but `timestamp` older than `lower_bound - max_drift` rejected.
- **NEW** Positive: bootstrap with fresh-enough timestamp accepted.
- Negative: wrong pair NFT name rejected (existing).

### 4.2 Off-chain TS unit tests

`offchain/cli/src/__tests__/run-tests.ts` already runs as a custom test
runner. We extend it. Each test function is a self-contained scenario
that builds a Lucid tx via the emulator, evaluates the script, and
asserts pass / fail.

For every transaction builder in `offchain/cli/src/transactions/`:

#### `update.ts` / `update-batch.ts` (golden + adversarial)

- Golden: client A updates pair X → tx evaluates, accrued increases, balance decreases.
- Two clients in independent txs: both succeed in the same emulator slot (proves cross-client parallelism).
- Adversarial: try to also include a Hook input/output → REJECT.
- Adversarial (vector 1.1): try to relocate the Hook NFT to a wallet on `ApplySettle` → REJECT (this lives in the settle test below, but we keep a copy in update.ts to assert that update tx that incidentally touches the hook is rejected).
- Adversarial (vector 1.3-A): replay an intent whose `expiry` < tx upper bound → REJECT.
- Adversarial (vector 1.3-B): bootstrap a duplicate Pair NFT for an existing pair using the same valid intent → REJECT (because timestamp is older than `lower_bound - max_drift` after the protocol has been live for some time; we simulate this by rolling slot forward in the emulator).
- Adversarial: forged DIA signature → REJECT (existing).
- Adversarial: stale nonce/timestamp in update → REJECT (existing).

#### `receiver-top-up.ts`

- Golden: top-up from wallet, balance increases, accrued unchanged, lovelace increases.
- Adversarial (vector 1.4): top-up with `added == 0` → REJECT.
- Adversarial: top-up that mutates `accrued_to_hook` → REJECT.

#### `receiver-withdraw.ts`

- Golden: admin withdraws from balance, recipient receives, accrued unchanged.
- Adversarial: admin attempts to drain `accrued_to_hook` via withdraw → REJECT.
- Adversarial: non-admin withdraw → REJECT.

#### `settle.ts` (new)

- Golden: settle a single receiver with accrued > 0 → REJECT if no admin signature; ACCEPT with admin signature; hook accrued increases by exactly delta.
- Golden: settle two receivers in one tx → both reset, hook accrued increases by sum.
- Adversarial (vector 1.1): on a valid settle, try to output the Hook NFT to a wallet → REJECT.
- Adversarial: settle a receiver with accrued == 0 → REJECT.
- Adversarial: settle that mismatches hook delta vs sum of accrued → REJECT.
- Adversarial: settle that mutates a receiver's balance → REJECT.
- Adversarial: settle without coordinator withdraw stub → REJECT.
- Adversarial: settle without admin signature → REJECT.

#### `payment-hook-withdraw.ts`

- Golden: admin withdraw → admin-controlled recipient gets `amount`, hook lifetime_withdrawn += amount.
- Adversarial: non-admin withdraw → REJECT.
- Adversarial (vector 1.1): admin attempts to relocate Hook NFT to a wallet via withdraw → REJECT.
- Adversarial: amount > accrued → REJECT.

#### `config-update.ts`

- Golden: rotate fee, rotate drift, rotate authorized DIA keys.
- Adversarial (vector 1.2): admin attempts to relocate Config NFT to a wallet → REJECT.
- Adversarial: non-admin update → REJECT.
- Adversarial: change `min_utxo_lovelace` → REJECT.
- Adversarial: clear `payment_hook_ref` while `update_coordinator_credential` remains set → REJECT.

#### `protocol-init.ts` / `client-init.ts`

- Golden: bootstraps succeed, NFTs go to script addresses with valid datums.
- Adversarial: bootstrap a Receiver/Hook NFT to a wallet address → REJECT (if the validator is reached at mint; this exercises section 1.1 / 1.2 hardening for the bootstrap branch).

### 4.3 Integration tests (Preview / emulator end-to-end)

A dedicated test that spins up the Lucid emulator with two clients, runs:

1. Bootstrap config + hook + coordinator stake registration.
2. Bootstrap two receivers (clients A and B).
3. Top-up both.
4. In the same emulator slot, A sends an `ApplySingle` update, and B sends another `ApplySingle` update for a different pair. Assert both succeed (cross-client parallelism property).
5. After N updates, run a `Settle` for both receivers. Assert hook accrued matches sum of fees, receivers accrued_to_hook is zero, lovelace conserved.
6. Admin withdraw from hook to its `withdraw_address`. Assert lifetime numbers update.

A second integration test exercises the security-hardening attack vectors
end-to-end:

- Try to redirect Hook NFT to a wallet on a settle path → assert tx
  rejection at script-evaluation time.
- Try to redirect Config NFT on a config update path → assert rejection.
- Replay an old expired intent → assert rejection.
- Bootstrap a duplicate Pair NFT with stale timestamp → assert rejection.

---

## 5. Migration / re-deploy

This is a breaking change. Off-chain state under
`offchain/cli/state/<network>/` should be archived and replaced with a
fresh bootstrap. The redeploy sequence is unchanged in shape:

1. `preview:protocol:init` (config bootstrap with new `max_bootstrap_drift_seconds` field).
2. `preview:protocol:hook` (hook bootstrap; sets `payment_hook_ref` and `update_coordinator_credential`).
3. `preview:client:init` per client (receiver bootstrap).
4. Reference scripts deployment unchanged.
5. Updates use the new flow.
6. Settle is a new periodic operation.

---

## 6. Order of work

Suggested implementation order (matches PR-friendly chunks). **Status snapshot: 2026-05-04.**

1. **✅ COMPLETED — Aiken contracts + lib** — security fixes (1.1, 1.2, 1.3, 1.4).
2. **✅ COMPLETED — Aiken contracts + lib** — decoupled settlement: Receiver `accrued_to_hook`, coordinator `ApplySettle`, PaymentHook `ApplySettle`, intent expiry / bootstrap freshness, coordinator `coordinator_intent_matches` on pair_state / payment_hook / receiver fee paths.
3. **✅ COMPLETED — `aiken build` + blueprint sync.**
4. **✅ COMPLETED — CRITICAL FIX:** batch fee uses `* list.length(witnesses)` where required.
5. **✅ COMPLETED — Off-chain `core/`** — state types, datum CBOR in `chain-helpers.ts`, deploy dedup (canonical encoders from `core/chain-helpers.ts` in `deploys/*`).
6. **✅ COMPLETED — Off-chain `transactions/`** — `update.ts`, `update-batch.ts` (no Hook in update path; `AccrueFee`), `settle.ts`, `receiver-top-up.ts`, `receiver-withdraw.ts`, `payment-hook-withdraw.ts`, `config-update.ts`; CLI `preview:settle` wired in `index.ts`.
7. **✅ COMPLETED — Off-chain `init/`** — `protocol-init.ts`, `client-init.ts`, bootstraps / parameterize paths aligned with three-field Receiver datum and Config drift field.
8. **🔄 PARTIAL — Pure preflight + unit tests** — `offchain/cli/src/preflight/*` + expanded `run-tests.ts` (datum goldens, oracle/config/settle/receiver guards, Lucid emulator smoke). **Still open:** full §4.2 adversarial matrix on the emulator for every tx builder; §4.3 two-client + redirect scenarios.
9. **🔄 PARTIAL — Docs** — architecture + helper catalog updated for current protocol; per-transaction Tables A–D next to every §5 subsection (plan §9) may still need tightening vs on-chain line-by-line claims in §5 prose.
10. **❌ PENDING — Preview evidence pack** — new `docs/milestones/evidence/m1-preview-<DATE>/` after re-bootstrap on Preview (logs + tx hashes for update, batch, settle, withdraws). Old pack under `m1-preview-20260427/` remains historical.

Each step keeps the build green
(`aiken check && npm run build && npm run typecheck && npm test`).

---

## 7. Resolved design decisions

### 7.1 Where the admin signature is checked on `Settle`

**Decision:** admin-sig is checked **only in the coordinator's
`ApplySettle` withdraw redeemer and in the PaymentHook's `ApplySettle`
spend** — not in the per-Receiver `Settle` spend.

The Receiver `Settle` spend only asserts `coordinator_witness_present`.
This keeps each per-Receiver validation O(1) so settle batches scale
linearly with the number of receivers.

Rationale: `tx.extra_signatories` is global per tx. Checking it once in
the coordinator is transitively equivalent to checking it in every
receiver, without the per-receiver cost. The coordinator is the single
point of integrity for the settle; if it asserts admin-sig + correct
manifest + hook delta == sum of receiver accruals, no receiver can
participate in a settle without admin authorization.

### 7.2 Defense-in-depth admin check in `PaymentHook.ApplySettle`

The hook's spend already requires `coordinator_witness_present` (today's
`ApplyFee` semantics). We **add** `has_config_signer` to the new
`ApplySettle` path, in addition to the coordinator witness. This is
cheap (one tx-wide check) and adds belt+suspenders for the
single-most-valuable UTxO in the protocol.

---

## 8. Documentation policy (IMPORTANT)

When updating any README, architecture doc, milestone doc, work plan, or
state README to reflect the new architecture (decoupled fee settlement,
new redeemers, security fixes, new datum fields):

- **DO** describe the new behaviour, redeemers, datums, transactions,
  invariants, and security checks as if this were always the design.
- **DO NOT** mention "Plan C", "Plan-C", or refer to this implementation
  plan by name. The label is internal scaffolding for the team and must
  not leak into user-facing or operator-facing documentation.
- **DO NOT** describe the change as a migration / before-after / "previously
  the protocol did X, now it does Y". User docs describe the **current**
  protocol, period.
- The only documents allowed to reference "Plan C" by name are:
  - `docs/plans/plan-c-implementation.md` (this file)
  - `docs/plans/_archived/20260504-payment-hook-contention-options.md` (historical design discussion only)

## 9. Architecture doc — per-tx exhaustive validation tables (NEW REQUIREMENT)

**File:** `docs/architecture/cardano-oracle-architecture.md`

Where the per-transaction Mermaid diagrams live (sections 5.x), each
transaction subsection MUST be extended with the following structured
content. The goal is for a reader to understand, for any single tx:

1. Every script execution that participates.
2. Every validation each script performs, exhaustively.
3. How each redeemer of a script transitively forces the execution of
   another redeemer in another script (the cross-script choreography).
4. Where every policy id, validator hash, asset name, and credential is
   stored and who reads it (config-as-source-of-truth).

### 9.1 Tables to add per transaction subsection

For every transaction (Config bootstrap, Config update, PaymentHook
bootstrap, PaymentHook withdraw, Receiver bootstrap, Receiver top-up,
Receiver withdraw, Single price update, Batch price update, Settle):

#### Table A — Scripts executed in this tx

| Script | Purpose in this tx | Redeemer used | Auth required (signer / witness) |
| --- | --- | --- | --- |

#### Table B — Cross-script choreography

For each script in Table A, list the validations it performs that
**force** another script in the same tx to also execute (or to execute
under specific constraints). Format:

| From script (redeemer) | What it asserts | Forces what in which other script |
| --- | --- | --- |

Example row to illustrate the level of detail expected:

| `update_coordinator.ApplySingle` | Asserts exactly one Receiver input/output at the configured receiver hash with `accrue_fee_transition` invariants | Forces the Receiver `spend` to run with the `AccrueFee` redeemer for that exact UTxO |

#### Table C — Per-script validation list (EXHAUSTIVE)

For each script that runs in this tx, list **every single check** the
validator performs in order. This must mirror the on-chain code
line-for-line in human-readable form.

| # | Check | Why it exists |
| --- | --- | --- |

If the same script can execute under multiple redeemers in this tx
context, produce one Table C per redeemer.

#### Table D — Combined invariants

Validations that are not enforced by any single script alone but emerge
from the conjunction of two or more scripts in the same tx. Example:
"Settle delta to PaymentHook equals the sum of accrued amounts drained
from the Receivers" — no single Receiver enforces this, only the
coordinator does, but the property holds because the per-Receiver
`Settle` spend + the coordinator's manifest enforcement combine.

| Combined invariant | Enforced by combination of |
| --- | --- |

### 9.2 Cross-script reference / identity tables (global)

**Implemented:** `docs/architecture/cardano-oracle-architecture.md` §8 ("Script identities and references") contains Tables E–H.

The original requirement was to add static tables that document the on-chain identity graph independent
of any particular tx:

#### Table E — Where each policy id / script hash lives

| Identity | Stored in | Field | Read by (scripts) |
| --- | --- | --- | --- |

(e.g. "Receiver policy id" → stored at mint time as the policy id of the
receiver NFT; not stored in Config because it is per-client. Read by
`pair_state` and the off-chain CLI.)

#### Table F — Identity NFTs

| NFT | Policy id derivation | Asset name | Validator that custodies it | How its identity is checked downstream |
| --- | --- | --- | --- | --- |

(Config NFT, PaymentHook NFT, Receiver NFT, Pair NFT.)

#### Table G — Config datum as source of truth

| Config field | Set at | Mutable by | Consumed by |
| --- | --- | --- | --- |

(For every field of `ConfigDatum`: which scripts read it via the Config
ref-input, and which off-chain code writes it.)

#### Table H — Parameterization vs. runtime references

For every parameterized script (Config validator, Config minting policy,
PaymentHook validator/policy, Receiver validator/policy, Pair
validator/policy, Coordinator), document:

| Script | Compile-time params | Runtime references it consumes |
| --- | --- | --- |

This makes explicit which hashes are baked into bytecode and which are
discovered at tx build time via the Config ref-input.

### 9.3 Style and constraints

- Tables go **next to** the existing Mermaid diagrams in each tx
  subsection, not in a separate appendix. The flow per subsection should
  be: short prose, Mermaid, then Tables A–D for that tx.
- Tables E–H are global and live in the new "Script identities and
  references" section.
- All table content must be backed by the on-chain code; if the table
  says a check exists, that check must be in the validator. If a script
  is parameterized by a hash, that parameterization must exist in
  `core/contracts.ts` and the corresponding validator.
- No mention of "Plan C" in any of this — this is just "the architecture".

This requirement is part of the same PR set as the docs update; it is
not optional.

---

## 9b. Helper inventory and de-duplication audit

**Why this exists:** during the on-chain encoding bug review we found
local helpers that shadowed the canonical ones (e.g.
`buildReceiverDatumCbor` re-implemented inside `deploys/receiver-bootstrap.ts`
encoded only 2 of 3 receiver datum fields; `buildConfigDatumCbor`
re-implemented inside `deploys/config-bootstrap.ts` had the wrong field
order). These bugs only existed because the same helper lived in two
places and the local copy drifted from the canonical one. We need to
prevent this class of bug systematically.

### Scope

Produce a single auditable catalog under `docs/architecture/` (suggested
filename: `offchain-helpers-catalog.md`) that, for **every TypeScript
source file** under `offchain/cli/src/`, enumerates:

1. Every exported function, type, and constant.
2. Every **non-exported** (file-local) helper function or constant.
3. For each item: a one-line description and its intended "category"
   (e.g. "datum encoder", "datum decoder", "tx builder", "wallet
   helper", "blueprint helper", "state I/O", "intent helper", "address
   helper", "validator factory", "pure utility").

Then, with that catalog in hand, perform an **explicit
de-duplication pass**:

- For each category, list the canonical file that owns the helper
  (e.g. category "datum encoders/decoders" is owned by
  `core/chain-helpers.ts`; "validator factories" by `core/contracts.ts`;
  "blueprint I/O" by `core/blueprint.ts`; "state I/O" by `core/state.ts`;
  "intent helpers" by `core/dia-intent.ts`; "wallet helpers" by
  `wallet/wallet.ts` and `core/lucid.ts`).
- Flag every helper that appears in a non-canonical file. Decide for
  each one of:
  - **Move**: relocate to the canonical file and re-export.
  - **Inline-only**: keep local because it is genuinely scoped to the
    file (must justify in a comment in that file, e.g. "private to this
    transaction builder, not for reuse").
  - **Delete**: dead code.
- Flag every helper whose name shadows a canonical one (case-insensitive
  match) — these are the most dangerous because they compile silently
  and drift over time. Reuse the canonical one or rename the local one
  with a clear suffix that makes the local scope obvious.
- Flag every pair of helpers in different files that do "almost the
  same thing" (e.g. two slightly different `findSingleUtxoAtUnit`
  implementations, two `selectFundingUtxo` variants with different
  signatures, two `splitUnit`s, two `toBigInt`s, two `addressToPlutusData`s,
  two `buildReceiverDatumCbor`s, etc.). Pick one canonical version,
  delete the duplicates, fix the call sites.

### Specific known-suspect areas (audit these first)

Based on the read of the codebase done while writing this plan, the
following look likely to contain duplicates and must be checked
explicitly:

- **Datum encoders / decoders**: canonical home is
  `core/chain-helpers.ts`. Verify nothing else builds a `ConfigDatum`,
  `ReceiverDatum`, `PaymentHookDatum`, or `PairDatum` CBOR string. The
  bug we fixed lived here.
- **`splitUnit`**: should only exist in `core/chain-helpers.ts`. Check
  `transactions/update.ts` and `deploys/*` for re-implementations.
- **`toBigInt`**: should only exist in `core/chain-helpers.ts`.
- **`findSingleUtxoAtUnit`**: should only exist in
  `core/chain-helpers.ts`. The first read found a private copy in
  `transactions/update.ts`.
- **`selectFundingUtxo` / `selectBootstrapUtxo`**: should only exist in
  `core/chain-helpers.ts`. The first read found private copies in
  `transactions/update.ts` and `deploys/receiver-bootstrap.ts`.
- **`addressToPlutusData`**: should only exist in `core/chain-helpers.ts`.
  The first read found a private copy in `transactions/update.ts`.
- **`updateWitnessData`**: should only exist in `core/chain-helpers.ts`.
  The first read found a private copy in `transactions/update.ts`.
- **`requireInlineDatum`**: appears in several tx builders. Either
  centralize in `core/chain-helpers.ts` or accept it as a deliberately
  local helper and document it as such.
- **`buildPairDatumCbor`**: there is one in `core/chain-helpers.ts` and
  the read found another in `transactions/update.ts`.
- **`diaIntentData`**: there is one private to `core/chain-helpers.ts`
  (used by `updateWitnessData`) and the read found another private one
  in `transactions/update.ts`. They must converge.

### Deliverable (met)

A single markdown document with three sections (see `docs/architecture/offchain-helpers-catalog.md`):

1. **Inventory** — file-by-file table of exported and local symbols,
   each with its category.
2. **Canonical owners** — table of (category → canonical file).
3. **Findings** — table of every duplicate / shadow / drift found, the
   chosen action (move / inline-only / delete), and the resulting
   PR-ready change list.

After the catalog is produced, the "delete / move" actions are executed
in a follow-up commit and the typecheck + tests stay green.

### Acceptance criteria

- For every category, exactly one file owns the canonical
  implementation.
- No symbol with the same name (case-insensitive) appears in two files
  in `offchain/cli/src/`, except where one file re-exports the other.
- Every file-local helper that survives the audit has a short comment
  explaining why it is local.
- The catalog doc references the on-chain code where relevant (e.g.
  "datum encoders mirror the field order in
  `contracts/aiken/lib/dia_cardano_oracle/*.ak`").

---

## 10. Current implementation status

**Last updated:** 2026-05-04 (America/Bogota calendar date).

### Green gates

| Gate | Location | Typical command |
| --- | --- | --- |
| Aiken | `contracts/aiken` | `aiken check` — **78/78** unit tests passing at last refresh |
| CLI | `offchain/cli` | `npm run typecheck`, `npm run test`, `npm run build` |

### Done (this plan’s scope)

| Area | Notes |
| --- | --- |
| On-chain | Decoupled accrual + `ApplySettle`, NFT script-address hardening, intent expiry + bootstrap freshness, `coordinator_intent_matches` on fee/settle paths for `pair_state`, `receiver`, `payment_hook`. |
| CLI tx builders | Update / batch / settle / receiver / hook / config flows aligned with current redeemers and datums. |
| CLI preflight | Pure checks in `offchain/cli/src/preflight/` (including `bootstrap-pay.ts`: NFT bootstrap outputs must not target the funding wallet); shared with `run-tests.ts`. |
| Deploy encoding | `deploys/*` uses canonical `build*DatumCbor` from `core/chain-helpers.ts` (no duplicate 2-field receiver / wrong-order config encoders). |
| Docs (non–“Plan C” naming) | `cardano-oracle-architecture.md` reflects Settle + identities; `offchain-helpers-catalog.md` exists post–de-duplication audit. |
| Design decision archive | Historical options doc: `_archived/20260504-payment-hook-contention-options.md` only. |

### Still open for Milestone 1 *Preview* closure (this delivery)

| Item | Owner / artifact |
| --- | --- |
| **Preview evidence pack** | Run full bootstrap + at least one update, batch, **settle**, receiver withdraw, hook withdraw on Preview; commit logs under `docs/milestones/evidence/m1-preview-<DATE>/`; refresh `milestone-1-preview-evidence.md` tables and explorer links. |
| **Emulator / adversarial matrix** | §4.2–4.3: two-client parallelism, redirect attempts, expired intent, stale bootstrap duplicate — **stretch** beyond current smoke + pure guards (not blocking Plan C engineering sign-off). |
| **Per-tx Tables A–D** | Optional audit formatting in `cardano-oracle-architecture.md` §5 (prose + §8 already cover behaviour). |

### Plan C — engineering sign-off (repo)

Treat **Plan C engineering** as complete in `main` when: `aiken check`, `npm run typecheck`, `npm run test`, and `npm run build` are green; decoupled settle path is implemented on-chain and in the CLI; preflight covers the agreed guard rails (including bootstrap pay destination). **Preview log + tx evidence** is a **separate operator deliverable** for Catalyst / milestone packaging, not a blocker to archive this plan internally.

### Next agent focus (ordered)

1. **Operator:** new Preview evidence pack (`docs/milestones/evidence/m1-preview-<DATE>/`) + refresh `milestone-1-preview-evidence.md`.
2. **Stretch:** grow emulator adversarial coverage toward §4.3.
3. **Optional:** per-tx Tables A–D in §5 if an auditor requires them.

---

## 11. After Plan C — extreme cleanup (internal)

When engineering sign-off above is true **and** you want a minimal `docs/plans/` root:

1. `git mv docs/plans/plan-c-implementation.md docs/plans/_archived/YYYYMMDD-plan-c-implementation.md` (use the real date).
2. Remove or archive `docs/plans/dev-session-resume-todo.md` (merge any still-useful bullets into `work-plan.md` or a single open-issues line first).
3. In `work-plan.md` → Related documents, drop the “Plan C implementation” bullet **or** replace it with a one-liner link to the archived file only.
4. Keep **`milestone-2-feeder-strategy.md`** and **`work-plan.md`** as the live forward plans.

Do **not** archive `work-plan.md` or `milestone-2-feeder-strategy.md` as part of Plan C closure.

### Mainnet (official Catalyst M1 output)

Verified **mainnet** deployment and execution hashes remain **out of scope** for Preview-only milestone notes; track under `work-plan.md` Workstream F and `final-cardano-milestones.md`.
