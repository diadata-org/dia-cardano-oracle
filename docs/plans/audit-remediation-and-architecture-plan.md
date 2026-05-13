# Audit Remediation and Architecture Plan

## Purpose

This is the active plan for closing the actionable audit cleanup items, keeping the implementation and documentation aligned, and producing a clean canonical architecture story for milestone review.

This plan does not replace `docs/plans/protocol-improvements-plan.md`. The protocol plan stays active only for the remaining `registered_pairs` work. This audit plan tracks repository consistency, canonical ordering, batch evidence, and documentation refresh.

## Source inputs

- `docs/plans/audit-report.md` — current review findings and cleanup recommendations.
- `docs/plans/protocol-improvements-plan.md` — companion implementation plan; only `registered_pairs` remains open there.
- `docs/architecture/cardano-oracle-architecture.md` — target architecture reference.
- `docs/plans/work-plan.md` — project-wide workstream tracker.
- Latest Preview evidence under `docs/milestones/evidence/` — benchmark and milestone proof material.

## Current audit-remediation status

| Workstream | Status | Evidence |
| --- | --- | --- |
| All-datum min ADA coherence | Closed | Config, Receiver, Pair, and PaymentHook enforce positive `min_utxo_lovelace`; CLI supports admin update paths for all four; active docs describe the same behavior. |
| Repository story alignment | In progress | Min ADA contradictions are closed. The M1 preview evidence generator in `offchain/cli/scripts/run-all-cli.sh` now derives the failed-batch dimension (memory vs CPU) directly from the node's `over budget Mem … CPU …` line and emits a narrative that matches the logs. The existing `m1-preview-20260511-135140/milestone-1-preview-evidence.md` file on disk still carries the old CPU/ExUnits narrative and will be corrected by the next run of `run-all-cli.sh` (or by the next M1 evidence pack); it is not edited in place. |
| Canonical batch ordering | Closed | `sortBatchUpdatesByPairTokenName` normalizes each token name via `normalizeHex` and sorts bytewise (equivalent to on-chain `bytearray.compare`); `localeCompare` removed. Two regression tests pin the equivalence and the rejection of non-normalized inputs. Architecture doc §5.9 now carries a dedicated "Canonical batch order" subsection. |
| Batch efficiency closure | Closed | `valid_batch_update` validates the entire batch with one filter pass over `tx.outputs`, one filter pass over `tx.inputs`, and one walk over witnesses in lockstep with the canonical pair-output list. `pair_state.spend.ApplyUpdate` is now a minimal local-invariant check: NFT continuity, exact ADA locking using `current_datum.min_utxo_lovelace` (no `next_datum` decode), and a `coordinator_in_update_mode` fingerprint that decodes only the outer `CoordinatorRedeemer` constructor tag (rejecting `ApplySettle`). Receiver presence, intent expiry, datum semantics, signature recovery, and one-pair-input-per-witness accounting are all enforced once by `update_coordinator` and not duplicated per pair script. `PairSpendAction::ApplyUpdate` no longer carries a `witness_index` field. **Result on the emulator with this bytecode**: `batch-10` succeeds at `mem = 10,810,449 / 16M (67.6%)` and `cpu = 4,295,001,740 / 10B (42.9%)`. |
| Final architecture/evidence refresh | Not started | Tracked in Phases 4 and 5. |

## Current status of the protocol improvements plan

| Area | Status | Decision |
| --- | --- | --- |
| Reference script reclaim | Done | Keep as completed history in the protocol plan. |
| Fee formula `base + n × k` | Done | Keep as completed history in the protocol plan. |
| All-datum min ADA updates | Done | Receiver/Pair use `UpdateMinUtxo`; Config/PaymentHook use `AdminUpdate`; all require positive `min_utxo_lovelace`. |
| Batch efficiency target | Done as protocol-plan work | Keep audit follow-up here for canonical off-chain ordering and fresh batch evidence. |
| `registered_pairs` in `ReceiverDatum` | Not started | Keep `protocol-improvements-plan.md` active until this is implemented or explicitly deferred. |

## Architectural rule

The coordinator remains the only validator responsible for cross-UTxO logic.

Sub-validators must only enforce:

- local datum/state invariants
- script/NFT continuity for their own UTxO
- proof that the relevant authorization names the exact local object being changed

Any new optimization must preserve this rule.

## Repository coherence rule

The final repository must be internally consistent across code, tests, README files, architecture docs, CLI docs, scripts, and docstrings.

For every behavior implemented in code:

- the user-facing docs must describe the same behavior
- tests must cover the intended behavior and the main rejection cases
- README examples must not describe stale commands or stale invariants
- docstrings and inline command help must match the final CLI behavior
- active plans must reflect only current work

Old evidence folders and archived/historical plans must not be rewritten as part of this cleanup. If old material is superseded, current docs should point to the current evidence or explain the current behavior in active docs.

## Min-ADA policy decision

All protocol datums that carry `min_utxo_lovelace` must support admin-controlled minimum ADA changes through the correct administrative path.

The four datum families are:

- Config datum
- Receiver datum
- Pair datum
- PaymentHook datum

Required final behavior:

- Config min ADA changes are supported by the Config admin update flow.
- Receiver min ADA changes are supported by the Receiver `UpdateMinUtxo` flow.
- Pair min ADA changes are supported by the Pair `UpdateMinUtxo` flow.
- PaymentHook min ADA changes are supported by the PaymentHook admin update flow.
- The CLI exposes a complete administrative path for all four datum families.
- The locked lovelace in each output matches the final datum value required by the corresponding validator.
- Tests and documentation prove the same behavior.

Status: closed. Final verification passed with TypeScript typecheck, CLI tests, Aiken checks, and targeted stale-text searches.

## Phase 1 — Align the repository story

Goal: remove review-facing contradictions before deeper protocol changes.

### Phase 1 tasks

- Update the latest fee benchmark/evidence narrative so failed 8, 9, and 10 pair batches are described as memory-budget failures when the logs say memory, not CPU. **Done at the generator level**: `offchain/cli/scripts/run-all-cli.sh` now parses `execution went over budget Mem … CPU …` from each batch-attempt log and emits a narrative + table row that names the actual binding dimension (memory vs CPU) with the signed delta. The existing `m1-preview-20260511-135140/milestone-1-preview-evidence.md` is preserved as captured; the corrected narrative will appear in the next regenerated M1 evidence pack.
- Update `offchain/cli/scripts/fee-benchmark.sh` wording so it no longer says batch 7+ fail by definition if current evidence shows batch 7 succeeds. **Done**: the script benchmarks `batch-1 … batch-7` and its generated report names memory as the binding constraint with the measured percentage of the per-tx limit.
- Keep the all-datum min ADA implementation closed: Config/Receiver/Pair/PaymentHook updates remain supported, positive-only, tested, and documented. **Done**.
- Update `docs/plans/work-plan.md` to point at the latest evidence pack and this plan. **Done**.

### Phase 1 acceptance criteria

- No current document contradicts the latest benchmark logs.
- Min ADA behavior is consistent across on-chain code, CLI, tests, architecture docs, README files, command help, and docstrings for Config, Receiver, Pair, and PaymentHook.
- Active plans in `docs/plans/` only describe current work.

## Phase 2 — Canonical ordering and deterministic batch inputs

Goal: make batch ordering exactly match the on-chain rule.

### Phase 2 tasks

- Replace off-chain batch sorting based on `localeCompare` with a normalized bytewise comparison for pair token names. **Done** in `offchain/cli/src/transactions/update-batch.ts` (`sortBatchUpdatesByPairTokenName` + `compareHexBytewise`).
- Reject non-normalized token names before sorting if they are not lowercase even-length hex. **Done** — normalization runs through `normalizeHex` and rejects odd-length or non-hex inputs.
- Document the canonical batch order in the architecture doc. **Done** — new "Canonical batch order" subsection under §5.9 covers: token names are `blake2b_256(pair_id)` bytes, witnesses must be strictly ascending by `bytearray.compare`, duplicates and mixed pair policies are invalid.
- Add or update tests proving off-chain order matches `bytearray.compare` expectations on-chain. **Done** — `testBatchUpdatesSortMatchesBytewiseCompare` and `testBatchUpdatesSortRejectsNonNormalizedTokenName` in `offchain/cli/src/__tests__/run-tests.ts`.

### Phase 2 acceptance criteria

- CLI and coordinator agree on one canonical order.
- Bad order, duplicate token names, and mixed policies are covered by regression tests.
- Architecture docs describe the canonical ordering in one place.

## Phase 3 — Batch efficiency closure

Goal: determine whether batch-10 is realistic on current bytecode and current Preview protocol parameters.

### Phase 3 tasks

- Review current `update_coordinator.valid_batch_update` for remaining repeated scans. **Done** — the redundant scans were the create/update count pass and the per-witness `find_unique_pair_input` / `find_unique_pair_output` over the full `tx.inputs` / `tx.outputs`.
- Remove the remaining extra create-count scan if it can be folded into the main witness validation without reducing safety. **Done** — replaced by a single `list.filter` over `tx.outputs`, a single `list.filter` over `tx.inputs`, and one lockstep walk of witnesses against the canonical pair-output list. The `assets.tokens` invocation that dominates the cost is now paid once per `tx.inputs`/`tx.outputs` entry (M_in + M_out total) instead of once per witness per item (~2 × N × M). `create_count` is accumulated inline. `create_witness_count` (and the previous per-witness scans) are deleted. The dead helper `first_pair_policy_id` is also removed. The same per-witness conditions (mint quantity, lovelace, payment credential, intent freshness on creates, datum continuity on updates, signature recovery) are still asserted, plus three new global accounting equalities (`length(pair_outputs) == N`, `N - create_count == length(pair_inputs)`, `minted_pair_token_count == create_count`) that reject any spurious or duplicate pair input/output/mint without changing the security model.
- Benchmark batches 7, 8, 9, and 10 after the ordering cleanup. **Done locally** — emulator run `20260513155004` attempted `10,9,8,7,6,5`; batch-10 failed narrowly on memory budget (`Mem -763`, CPU margin `4797686954`), batch-9 succeeded (`cpu=5183166809`, `mem=13603499`, `fee=2.667151 ADA`).
- Keep the coordinator-binding safety model intact. **Done** — refactor is structural; no condition was dropped. The new accounting equalities are stricter than the previous `unique_pair_units` / `minted_pair_token_count == create_count` pair, so any pre-existing test of the old invariants still passes.
- If batch-10 still does not fit, document the exact bottleneck and define the next interface-level optimization separately. **Done — batch-10 now fits.** The remaining bottleneck (after the witness-index pass left `Mem -763`) was the per-pair full decode of `CoordinatorRedeemer`, which deserializes `List<UpdateWitness>` (N witnesses × `OracleIntent` × many nested fields) inside every `pair_state.spend` script execution. Replaced by `CoordinatorRedeemerFingerprint`, a structurally identical type with `Data` payload that decodes only the outer constructor tag. The `pair_state.spend.ApplyUpdate` redeemer dropped its `witness_index` field; the spend body no longer decodes the witness list, the `next_datum: PairDatum` of the continuation output, or repeats the receiver-presence / intent-expiry checks already enforced by the coordinator. Emulator evidence: `batch-10 ok cpu=4,295,001,740 mem=10,810,449` (`mem/limit = 67.6%`, `cpu/limit = 42.9%`).

### Phase 3 acceptance criteria

- New evidence records the exact execution units for batch 7 through 10.
- The result is stated as evidence-bound, not permanent protocol truth.
- If batch-10 succeeds, docs say under which assumptions it succeeds.
- If batch-10 fails, docs explain whether the limiting dimension is memory, CPU, size, or collateral/fee constraints.

## Phase 4 — Documentation refresh

Goal: make the docs explain the current architecture as one consistent story.

### Phase 4 tasks

- Update `docs/architecture/cardano-oracle-architecture.md` with:
  - coordinator-witness pattern
  - single update flow
  - batch update flow
  - settle flow
  - reference-script reclaim flow
  - canonical batch ordering
  - protocol fee vs network fee distinction
- Update milestone evidence summaries after new benchmark runs.
- Update operator/developer docs if any CLI behavior changes.
- Keep historical evidence folders immutable except for clearly marked summary corrections when needed.

### Phase 4 acceptance criteria

- A reviewer can read the architecture doc and understand the current bytecode behavior without opening old plans.
- Evidence files describe what actually happened in the logs.
- Plan docs do not contain stale implementation promises.

## Phase 5 — Final verification

Goal: close the audit remediation work with proof.

### Phase 5 tasks

- Run Aiken tests.
- Run TypeScript tests.
- Run targeted batch/evidence scripts.
- Capture fresh evidence if bytecode or tx-building behavior changes.
- Update this plan with final checkboxes or archive it once complete.

### Phase 5 acceptance criteria

- Tests pass.
- Latest evidence matches current bytecode and CLI behavior.
- Active docs point to current architecture and current evidence.
- Plans are either active with current status or archived with notes.

## Recommended implementation order

1. Repository story alignment.
2. Canonical batch ordering in the CLI.
3. Batch efficiency cleanup and benchmark rerun.
4. Architecture and evidence doc refresh.
5. Final verification.

## Relationship to `protocol-improvements-plan.md`

Do not archive `protocol-improvements-plan.md` yet.

Reason:

- It still owns the `registered_pairs` work.
- Everything else in that plan should be treated as completed.
- Once `registered_pairs` is implemented or explicitly deferred, the protocol plan can be archived with a note that the remaining audit cleanup was tracked here.
