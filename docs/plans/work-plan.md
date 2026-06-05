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
  Single consolidated plan: verified-done baseline, M2 pending (evidence pack, monitoring
  polish), Mainnet rollout (corrected), open DIA questions, and what's deferred to M3/M4.
  Supersedes the former HANDOFF / milestone-2-final-plan / milestone-2-feeder-strategy /
  mainnet-rollout / m3-deferred-features (all now under `_archived/`).
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
- [x] CLI commands to publish reusable reference-script UTxOs at the `reference_holder` address: 3 global and 3 per client.

## Workstream C — Data feeder (bridge)

The Cardano-side feeder service that reads DIA-signed `OracleIntent`
payloads from `OracleIntentRegistry` (DIA Lasernet), routes each intent to
the matching Cardano client receiver, and submits the corresponding Cardano
oracle update transactions, plus the operational surface (health, metrics,
inflight tracking, evidence packaging) required by the M2 acceptance
criteria in [`final-cardano-milestones.md`](../milestones/final-cardano-milestones.md).

The full operational breakdown, verified status, evidence layout, Mainnet
rollout, and the open DIA dependencies (signer set, WebSocket creds, wallet
custody, update cadence) all live in the consolidated
[`milestone-feeder-plan.md`](./milestone-feeder-plan.md). The original R0–R10
breakdown and conceptual reference are archived under `_archived/`.

High-level deliverables tracked here:

- [x] Feeder service under `offchain/feeder/`: registry scanner (HTTP + WS),
  router, coalescer, queue manager, worker pools (event + update),
  inflight tracker, ops surface (API, metrics, health, alert evaluator).
- [x] CLI tx builders refactored into a reusable library imported in-process
  by the feeder via `OracleIntentBridge`.
- [x] DB-as-source-of-truth persistence (6-table SQLite/Postgres schema);
  crash-safe checkpoint; no JSON state files at runtime.
- [x] Spectra-parity API (14 endpoints) and metrics (6-phase latency histograms,
  Prometheus aliases, Cardano extensions).
- [x] Cron service for time-threshold re-submissions.
- [x] Alert evaluator (`OraclePairStale`, `PriceDeviationHigh`) writing to `alert_log`.
- [x] Security hardening: rate limiter, path-length caps, log injection sanitizer,
  `synchronous = FULL`, path traversal check, WS exponential backoff.
- [x] Mainnet rollout guide and rollback plan (`docs/plans/mainnet-rollout.md`).
- [ ] M2 evidence packs (sustained Preview window, all 10 pairs, Grafana screenshots,
  error-counts TSV, alert firing demonstration) — pending live run. Tracked in detail in
  [milestone-feeder-plan.md](./milestone-feeder-plan.md) §2 (the feeder core itself is
  done and verified; 475 tests pass).

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
- [x] Grafana dashboards: `feeder-overview.json`, `feeder-latency.json`,
  `feeder-cardano.json` (provisioned at `monitoring/grafana/`).
- [ ] QA validation report and anomaly-detection evidence (requires a sustained live run).
- [ ] Dashboard screenshots capturing real data from the live evidence window.

## Workstream F — Deployment, operations and developer documentation

Tasks:

- [x] **Preview evidence pack — fresh capture** on the current bytecode: full bootstrap (Config, PaymentHook, Receiver), reference-script publication, Receiver top-up, single oracle update, batch oracle update, **Settle**, Receiver withdraw, PaymentHook withdraw, reference-script reclaim + republish. Latest capture under `docs/milestones/evidence/m1-preview-20260516-090057/`. Historical packs `docs/milestones/evidence/m1-preview-20260427/` and `preview_20260504/` predate the current contracts and are kept only as historical proof.
- [ ] Mainnet deployment scripts and evidence (contract addresses, reference-script UTxOs, verified mainnet tx hashes).
- [x] Operator runbook (onboarding a new client, subscribing a new pair, rotating signers, withdrawing accrued fees).
- [ ] Developer documentation published via DIA's developer documentation website, covering:
  - configuration of the oracle
  - on-chain contracts available for consumption
  - procedure to request any of DIA's 2,500+ price feeds or 10,000+ real-world asset feeds
- [ ] Final closeout report and video.

---

## Mapping to Catalyst milestones

Catalyst milestone text is in `final-cardano-milestones.md`; this mapping only indicates which workstreams feed which milestone deliverable. Workstreams can span multiple milestones.

| Catalyst milestone | Primary workstreams | Expected deliverables |
|---|---|---|
| M1 — Port DIA Oracle Smart Contract to Aiken | A, B, F (partial) | compiled contracts, unit/integration tests, deployment scripts, verified mainnet deployment hashes, developer docs |
| M2 — Data Feeder and Documentation | C, B, F (partial) | feeder, QA review logs, integration examples, verified mainnet update tx logs |
| M3 — Monitoring Library | E, F (partial) | monitoring stack, alerting, QA validation report, dashboards |
| M4 — End-to-End Integration and Mainnet Deployment | A, B, C, D, E, F | mainnet addresses, live feeds, final closeout report and video |
