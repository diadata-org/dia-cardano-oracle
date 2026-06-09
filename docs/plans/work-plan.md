# Work Plan

Single work plan for the Cardano port of DIA's push-oracle contracts.

## Contents

- [Related documents](#related-documents)
- [Scope](#scope)
- [Workstream A — On-chain contracts](#workstream-a--on-chain-contracts)
- [Workstream B — Off-chain CLI and deployment tooling](#workstream-b--off-chain-cli-and-deployment-tooling)
- [Workstream C — Data feeder (bridge)](#workstream-c--data-feeder-bridge)
- [Workstream D — Indexer](#workstream-d--indexer)
- [Workstream E — Monitoring](#workstream-e--monitoring)
- [Workstream F — Deployment, operations and developer documentation](#workstream-f--deployment-operations-and-developer-documentation)
- [Mapping to Catalyst milestones](#mapping-to-catalyst-milestones)

## Related documents

- [Cardano Oracle Architecture](../architecture/cardano-oracle-architecture.md) — single architecture reference.
- [Cardano Integration Requirement [PF]](../requirements/cardano-integration-requirement-pf.md) — DIA requirement document.
- [Final Cardano Milestones](../milestones/final-cardano-milestones.md) — Catalyst milestone text.
- [Milestone 1 Preview Evidence](../milestones/evidence/m1-preview-20260516-090057/milestone-1-preview-evidence.md) — M1 Preview verification log.
- [Milestone 1 Mainnet Evidence](../milestones/evidence/m1-mainnet-20260517-063917/milestone-1-mainnet-evidence.md) — M1 Mainnet verification log (latest run).
- [**Milestone Feeder Plan**](./milestone-feeder-plan.md) — **start here for the feeder.**
  Done / M2 pending / Mainnet / deferred / open DIA decisions.
- [**M3 & M4 Plan**](./m3-m4-plan.md) — what's left for Monitoring (M3) and End-to-End
  Mainnet (M4), grounded in the official milestone text.
- [Audit report](../audit/20260515-audit-report.md) — `20260515-audit-report.md`.

## Scope

This plan covers all work required to deliver the Cardano integration end to end:

- on-chain contracts
- off-chain submission and tooling
- data feeder (bridge)
- indexer
- monitoring
- deployment, operations, and developer documentation

The work is organized by workstream, not by Catalyst milestone. Catalyst milestones remain the payment gates and are defined in `final-cardano-milestones.md`. A mapping from this plan to those milestones is in the last section.

---

## Workstream A — On-chain contracts

Target contract set, per the architecture:

- `config_state` — multivalidator (mint + spend), 1 global.
- `update_coordinator` — stake validator (withdraw), 1 global.
- `payment_hook` — multivalidator (mint + spend), 1 global.
- `receiver` — multivalidator (mint + spend), 1 per client.
- `pair_state` — multivalidator (mint + spend), 1 per client.
- `reference_holder` — spend validator, 1 global address for reference-script UTxOs.
- `deposit` — spend validator, 1 per client. The per-client **side-deposit address**: a client funds their balance with an ordinary wallet payment (no CLI, datum-less — spendable in Plutus V3), and the feeder/CLI later folds the deposits into the Receiver balance by reusing the Receiver `TopUp` redeemer (the standalone `deposit:merge`) or, since A2, by absorbing them into an `AccrueFee` update in the same tx (`update --fold-deposits`). The `deposit` validator's source is itself additive (no edit to it), but its per-client address re-derives because A2 + the teardown burns DO edit `receiver` / `config_state` / `payment_hook` / `update_coordinator` (changing their hashes) — an accepted pre-launch re-bootstrap (see [`docs/audit/20260607-contract-teardown-ada-recovery.md`](../audit/20260607-contract-teardown-ada-recovery.md)). The earlier "purely additive — no deployed-hash change" property held for A1 alone.

Tasks:

- [x] Implement the oracle scripts in Aiken.
- [x] Implement `reference_holder` for reusable reference-script UTxOs — parameterized with config policy, admin-gated spend so DIA can reclaim ADA when upgrading contracts.
- [x] Implement datum types and redeemers per the architecture (`Config`, `PaymentHook`, `Receiver`, `Pair`).
- [x] Implement `secp256k1` ECDSA + EIP-712 intent verification against the authorized DIA signer set.
- [x] Implement continuity rules for Config, Hook, Receiver and Pair UTxOs, including `min_utxo_lovelace` invariants.
- [x] Implement decoupled fee flow: every price update spends the Receiver with `AccrueFee` (moving the protocol fee from `balance_lovelace` into `accrued_to_hook_lovelace`); a separate admin-initiated Settle transaction (`receiver: Settle`, `payment_hook: ApplySettle`, `coordinator: ApplySettle`) drains the accrued lovelace from one or more Receivers into the global PaymentHook in a single batch. The PaymentHook is not touched during oracle updates.
- [x] Coordinator redeemers `ApplySingle`, `ApplyBatch`, and `ApplySettle`.
- [x] Unit tests for Config, Hook, Receiver, Pair, and coordinator logic, with real DIA `OracleIntent` fixtures for signature validation. Inline Aiken `test` blocks cover every redeemer transition and the documented attack vectors (NFT exfiltration, accrued-fee drain via withdraw, expired/replayed intents, stale bootstrap, zero-add griefing, settle manifest mismatch, cross-script redeemer confusion).
- [x] Finalize pair-NFT asset-name derivation as `blake2b_256(pair_id)`.
- [x] Finalize batch-update fee unit as Config-defined `base_fee_lovelace + n × per_pair_fee_lovelace` (two-component fee model).
- [x] Admin-gated Pair NFT creation and burn paths in `pair_state` (see architecture §5.13 and `docs/security/security-notes.md`).
- [x] Per-client `deposit` validator + `deposit_logic` for side-deposit funding (architecture §5.14): a `CollectDeposit` spend is authorised only when the tx consumes the canonical Receiver (found by its NFT) and raises the Receiver UTxO's lovelace by ≥ the **full** swept total at the deposit address. The anti-skim invariant — every deposit input at the shared address runs the same validator instance against the same `swept` sum — closes the multi-deposit skim hole. The merge reuses the Receiver `TopUp` redeemer (no new Receiver redeemer, no deployed-hash change). 9 inline Aiken tests (full sweep credited, multi-deposit credited, anti-skim partial-credit rejected, Receiver-not-credited / lovelace-decrease rejected, no-Receiver rejected, zero-swept rejected, token-wrapped deposit must credit full ADA, `total_swept` address scoping).
- [x] Generalized `AccrueFee` (Option B / A2): an oracle update can fold side-deposits into the SAME tx by absorbing the added lovelace into `balance_lovelace`. `accrue_fee_transition` (`receiver_logic.ak`) now takes the receiver prev/next outputs, requires `added ≥ 0`, and pins `accrued += fee` (so the fee is read off the accrued-delta, never the balance-delta). Call sites updated: `receiver.ak` AccrueFee branch + `update_coordinator.ak::valid_receiver_accrue_fee`; `deposit.ak` unchanged (anti-skim `receiver_delta ≥ swept` sees the same physical increase). Inline tests cover absorb `added > 0`, reject `added < 0`, reject diversion of `added` into `accrued`, and `added = 0` identical-to-today. Measured: blueprint +620 bytes, AccrueFee bench cpu/mem delta ≈ 0, batch-10 unaffected. Changes the `receiver` + `update_coordinator` hashes → accepted re-bootstrap.
- [x] Teardown / decommission burns: a `Burn` mint action + `Burn` spend redeemer on `config_state` / `payment_hook` / `receiver` (mirroring `pair_state`) — config-signer gated, NFT burned −1, no continuation output, zeroed value fields (receiver `balance == 0 && accrued == 0`, hook `accrued_fees == 0`). Recovers each UTxO's min-ADA on decommission. Inline Aiken burn tests beside each validator (happy burn recovers min-ADA; non-signer rejected; positive mint under `Burn` rejected; continuation carrying the NFT rejected; non-zero value-field rejected). Overall `aiken check` 156/0. The burns change the config/hook/receiver hashes → they ship on the next-gen re-bootstrap (see the [teardown audit](../audit/20260607-contract-teardown-ada-recovery.md)).
- [~] Off-chain Lucid emulator adversarial matrix: happy-path orchestrator delivered via `npm run benchmark:emulator` (see `_archived/20260516-emulator-benchmark-plan.md`; latest evidence `docs/milestones/evidence/m1-emulator-benchmark-20260515124543/`). Adversarial negative-case matrix (two-client parallelism, expired intent, stale bootstrap duplicate, NFT redirect on settle and config-update, accrued drain via withdraw, settle without admin signature, non-admin withdraw, duplicate live pair) is still open.

## Workstream B — Off-chain CLI and deployment tooling

Tasks:

- [x] TypeScript CLI scaffolding with persisted state under `state/preview/`, guided init commands, and interactive Preview intent prompts.
- [x] Preview wallet and provider verification commands.
- [x] Commands for Config parameterization from an existing wallet UTxO, bootstrap, reference-script publication, and Config update.
- [x] Commands for PaymentHook parameterization from an existing wallet UTxO, bootstrap, reference-script publication, and withdraw.
- [x] Commands for Receiver/Pair parameterization from an existing wallet UTxO, Receiver bootstrap, client reference-script publication, and signed-intent pair create/update.
- [x] Commands for Receiver top-up and Receiver withdraw (per client).
- [x] Commands for batch update.
- [x] Per-client state layout under `state/<network>/clients/<client>/`.
- [x] CLI commands to publish reusable reference-script UTxOs at the `reference_holder` address: 3 global and 4 per client (receiver, pair spend, pair mint, **deposit** — the deposit reference script is published at `reference-scripts:publish-client` under `referenceScripts.client.deposit`).
- [x] Side-deposit funding commands (per client): `deposit:address` (print the per-client deposit script address to hand to the client), `deposit:fund` (plain ADA payment to that address — runbook/test convenience), `deposit:merge` (sweep clean ADA deposits into the Receiver in one tx; `collectFrom([receiver], TopUp)` + `collectFrom(selectedDeposits, CollectDeposit)`, skipping dust / native-token / datum-bearing UTxOs). `makeDepositValidator` derives the per-client address from the Receiver NFT; the compiled script + `depositValidatorHash` + `depositValidatorAddress` are persisted in the client artifact at `receiver:parameterize` / `receiver:bootstrap`.
- [x] Multi-client batch settle: `settle` takes repeatable `--client-state` and builds one N-receiver `SettleManifest`, collecting all N Receivers + the single shared payment hook in one tx (each Receiver's accrued drained to zero, Σ credited to the hook). The exactly-1 preflight is gone, replaced by `assertSettleManifestMatchesClientReceivers` (non-empty + unique + 1:1 with the loaded clients, order-independent).
- [x] Deposit tx-build parameters are single-sourced and never hardcoded: `depositMinLovelace` (dust floor, default 1 ADA) + `depositMaxPerMerge` (per-merge cap, default 20) live in `config-bootstrap.json::configState`, set at `protocol:init` (`--deposit-min-lovelace` / `--deposit-max-per-merge`), read by both the CLI and the feeder daemon.
- [x] `update --fold-deposits` (Option B / A2): the `update` command can absorb a bounded number of clean side-deposits into the oracle-update tx itself (`build-oracle-update.ts` / `build-batch-oracle-update.ts` `collectFrom(foldDeposits, CollectDeposit)`), capped by `depositMaxPerUpdateFold` in `config-bootstrap.json::configState` (set at `protocol:init --deposit-max-per-update-fold`, default 3, read via `readDepositMaxPerUpdateFold`). The standalone `deposit:merge` stays for bulk sweeps; the feeder fold is best-effort with fallback to a pure update. Exercised by `run-all-cli.sh` steps 36/37 (guard bumped 1..35 → 1..37).
- [x] Decommission / teardown tooling: CLI verbs `receiver:burn` / `payment-hook:burn` / `config:burn` (mirror `pair:burn`) that burn each singleton NFT and recover its min-ADA; `reclaim-reference-script --script client` fixed to also reclaim the per-client `deposit` reference script. New chain-as-truth runbook `offchain/cli/scripts/run-teardown-cli.sh` (queries live on-chain UTxOs, acts only on what is live, records each into the entity JSON, marks orphans; `--run-id` / `--from-step` / `--skip-singleton-burns`) + helpers `scripts/teardown-helpers/{query-live,record-teardown}.ts`. Audit/procedure doc: [`docs/audit/20260607-contract-teardown-ada-recovery.md`](../audit/20260607-contract-teardown-ada-recovery.md). The Preview OLD deployment `preview_run_20260606-082456` was actually torn down (recovered receiver balance + hook accrued + 10 pairs + all reference scripts incl. config + coordinator; ~15 ADA stuck = the 3 non-burnable OLD-contract NFT min-UTxOs, expected).

## Workstream C — Data feeder (bridge)

The Cardano-side feeder service that reads DIA-signed `OracleIntent`
payloads from `OracleIntentRegistry` (DIA Lasernet), routes each intent to
the matching Cardano client receiver, and submits the corresponding Cardano
oracle update transactions, plus the operational surface (health, metrics,
inflight tracking, evidence packaging) required by the M2 acceptance
criteria in [`final-cardano-milestones.md`](../milestones/final-cardano-milestones.md).

The full task breakdown, status, evidence layout, Mainnet rollout, and open
DIA dependencies live in [`milestone-feeder-plan.md`](./milestone-feeder-plan.md).

High-level deliverables tracked here:

- [x] Feeder service under `offchain/feeder/`: registry scanner (HTTP + WS),
  router, coalescer, queue manager, worker pools (event + update),
  inflight tracker, ops surface (API, metrics, health, alert evaluator).
- [x] CLI tx builders refactored into a reusable library imported in-process
  by the feeder via `OracleIntentBridge`.
- [x] Persisted-state model: DB for scanner/tx/alert history plus reconciled
  pair-state files for Cardano confirmed pair snapshots and `priceCache` cold-start;
  crash-safe checkpoint.
- [x] Spectra-parity API (14 endpoints) and metrics (6-phase latency histograms,
  Prometheus aliases, Cardano extensions).
- [x] Cron service for time-threshold re-submissions.
- [x] Alert evaluator (`OraclePairStale`, `PriceDeviationHigh`) writing to `alert_log`.
- [x] Security hardening: rate limiter, path-length caps, log injection sanitizer,
  `synchronous = FULL`, path traversal check, WS exponential backoff.
- [x] Mainnet rollout guide and rollback plan (`docs/plans/mainnet-rollout.md`).
- [x] Side-deposit auto-merge in the daemon: when a Receiver drops below
  `alerting.receiver_balance_low_lovelace` OR pending deposits reach
  `alerting.deposit_pending_merge_lovelace`, the daemon enqueues `bridge.mergeDeposits(...)`
  as a first-class **lane task** on the SAME per-lane serial submission queue the client's
  oracle updates use (`enqueueLaneTask` → discriminated `QueueEntry` `submit`|`task`), so a
  merge and an update on one Receiver can never run concurrently — mutual exclusion is
  structural (the serial lane queue), not a best-effort lock. The pure decision lives in
  `shouldAutoMergeDeposits`; a per-lane `mergeInProgress` flag is a dedup guard only (collapses
  duplicate enqueues across refresh ticks), not the safety mechanism. The deposit floor is read
  from `config-bootstrap.json::configState.depositMinLovelace` via `readDepositMinLovelace`.
- [x] OpenAPI/Swagger surface: a metadata route table (`src/api/routes.ts`, TypeBox schemas)
  drives an OpenAPI 3.0.3 doc at `/api/v1/openapi.json` and an offline Redoc UI at `/docs`
  (vendored, no CDN; shipped in the Docker image).
- [x] M2 Preview evidence pack captured — `docs/milestones/evidence/m2-preview-20260609-093407/`
  (10 pairs, Grafana PNGs from both dashboards, error-counts TSV, alerts section).
  564 feeder tests pass. Tracked in detail in [milestone-feeder-plan.md](./milestone-feeder-plan.md) §2.
  Remaining for the M2 submission: the `milestone-2-poa.md` PoA doc and the demo video (mainnet
  feeder tx logs are the formal evidence, tracked under Mainnet).

## Workstream D — Indexer

Tasks:

- [ ] Indexer exposing per-pair latest price, timestamp, nonce, signer, and intent hash from live Pair UTxOs.
- [ ] Client-level query surface (Receiver balance, subscribed pairs, accrued fees per Hook).
- [ ] Integration examples for Cardano dApp developers.

## Workstream E — Monitoring

Tasks:

- [x] Monitoring for feed freshness (6-phase latency histograms), Receiver balance warnings,
  and failed-transaction rate via Prometheus metrics (`dia_bridge_*`).
- [x] In-process alert evaluator writing `OraclePairStale` and `PriceDeviationHigh`
  events to `alert_log`; Prometheus alert rules in `monitoring/alerts.yml`.
- [x] Grafana dashboards (provisioned at `monitoring/grafana/dashboards/`): `feeder.json`
  (operational overview — balances, staleness, per-symbol throughput, latency, price quality,
  billing) and `feeder.json`'s companion `feeder-tx.json` (the per-transaction axis — tx-stage
  latency, confirmed-vs-failed, success ratio, batch size). Both cascade-filter by
  customer → client → symbol.
- [x] Thresholds single-sourced from `infrastructure.<network>.yaml::alerting.*`: the
  `generate-monitoring.ts` generator (`make generate-monitoring`, a prerequisite of `make up`)
  writes the thresholds into `monitoring/alerts.yml` and the Grafana dashboard, and a drift
  test (`make check-thresholds`) fails CI if any mirror diverges or a dashboard template var is
  left dead. Rate panels switched to `increase[5m]` counts; `$client`/`$symbol`/`$customer`/`$error_code`
  filter vars wired into the client-filterable panels.
- [x] Side-deposit monitoring: gauge `dia_bridge_cardano_deposit_pending_lovelace`
  (sum of clean un-merged deposits per client, labelled with the deposit address), a Grafana
  "Deposit pending — ADA (per client)" panel, the Prometheus alert `ReceiverDepositsPending`,
  and the threshold key `deposit_pending_merge_lovelace`.
- [x] Per-transaction dashboard `feeder-tx.json` (tx-stage latency, confirmed-vs-failed, success
  ratio, batch size) + per-tx metric family (`transactions_total`, `transaction_pairs`,
  `tx_pair_membership_total`, tx-stage latency histograms), counted once per tx.
- [ ] **Broad metrics dashboard** (still open; separate from the two above) covering the remaining
  registered-but-unshown families: the 5 per-symbol latency phases, scanner RPC errors + backfill,
  worker pool counters, HTTP/db/component-health, cron resubmissions, node/process defaults.
- [x] Dashboard screenshots capturing real data — captured in the M2 Preview evidence pack
  (`m2-preview-20260609-093407/dashboards/`, both dashboards).
- [ ] QA validation report and anomaly-detection evidence — this is an **M3** deliverable (QA
  validation report, alert-trigger logs, sanity checks per feed). Tracked in
  [`m3-m4-plan.md`](./m3-m4-plan.md).

## Workstream F — Deployment, operations and developer documentation

Tasks:

- [x] **Preview evidence pack — fresh capture** on the current bytecode: full bootstrap (Config, PaymentHook, Receiver), reference-script publication, Receiver top-up, single oracle update, batch oracle update, **Settle**, Receiver withdraw, PaymentHook withdraw, reference-script reclaim + republish. Latest capture under `docs/milestones/evidence/m1-preview-20260516-090057/`. Historical packs `docs/milestones/evidence/m1-preview-20260427/` and `preview_20260504/` predate the current contracts and are kept only as historical proof.
- [ ] Mainnet deployment scripts and evidence (contract addresses, reference-script UTxOs, verified mainnet tx hashes).
- [x] Operator runbook (onboarding a new client, subscribing a new pair, rotating signers, withdrawing accrued fees).
- [ ] Developer documentation published via DIA's developer documentation website — **deferred to
  M4** per the accepted M1 PoA (`m1-mainnet-20260517-063917/milestone-1-poa.md` §AC #3): the
  publication clause is identical in M2/M3/M4, in-repo docs are complete and meet the substantive
  content requirement, and publishing the final stable surface once at M4 avoids a moving target.
  M4 scope of the published page:
  - configuration of the oracle
  - on-chain contracts available for consumption
  - procedure to request any of DIA's 2,500+ price feeds or 10,000+ real-world asset feeds
- [x] Per-milestone PoA documents mapping AC → evidence (accepted format): M1 done
  (`m1-mainnet-20260517-063917/milestone-1-poa.md`). M2 PoA pending (tracked in milestone-feeder-plan).
- [ ] Final closeout report and video (M4).

---

## Mapping to Catalyst milestones

Catalyst milestone text is in `final-cardano-milestones.md`; this mapping only indicates which workstreams feed which milestone deliverable. Workstreams can span multiple milestones.

| Catalyst milestone | Primary workstreams | Expected deliverables |
|---|---|---|
| M1 — Port DIA Oracle Smart Contract to Aiken | A, B, F (partial) | compiled contracts, unit/integration tests, deployment scripts, verified mainnet deployment hashes, developer docs |
| M2 — Data Feeder and Documentation | C, B, F (partial) | feeder, QA review logs, integration examples, verified mainnet update tx logs |
| M3 — Monitoring Library | E, F (partial) | monitoring stack, alerting, QA validation report, dashboards |
| M4 — End-to-End Integration and Mainnet Deployment | A, B, C, D, E, F | mainnet addresses, live feeds, final closeout report and video |
