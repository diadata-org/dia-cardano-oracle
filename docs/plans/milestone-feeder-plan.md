# Milestone — Feeder Plan (consolidated)

**Status date:** 2026-06-05 · **Tests:** 475 pass, 0 fail (`cd offchain/feeder && npm test`) · **Branch:** main

This is the single source of truth for the DIA Cardano Oracle **feeder** (Catalyst
Milestone 2) and its path to Mainnet. It **supersedes and consolidates**:

- `milestone-2-final-plan.md` — operational R0–R10 breakdown (its checkboxes were
  stale; verified status is captured here).
- `milestone-2-feeder-strategy.md` — conceptual reference + open DIA questions.
- `HANDOFF.md` — current-state / how-to-verify.
- `mainnet-rollout.md` — Mainnet runbook (its CLI commands were broken; corrected here).
- `m3-deferred-features.md` — deferred/excluded/wired classification.

All five are archived under `docs/plans/_archived/` with a header note. The only live
plans are this file and `work-plan.md` (the cross-workstream rolling plan).

Statuses below were **verified against the codebase on 2026-06-05**, not copied from
the old checkboxes.

---

## 1. Verified DONE baseline (do not re-litigate)

The core feeder is built, tested, and operational. Verified in code:

- **Persistence (DB as source of truth).** 6-table SQLite/Postgres schema, crash-safe
  `chain_state` checkpoint, no runtime JSON state. (`src/persistence/db.ts`)
- **Source pipeline.** HTTP + WS scanner with head-tracker and gap-detection loops
  (`src/source/scanner-http.ts:139-164`), dedup cache, exponential backoff + jitter.
- **Processing / routing / coalescer.** Enricher, router policy gate, per-lane coalescer
  with supersession + batch buffer (`src/submitter/coalescer.ts`).
- **Worker pools WIRED.** Event + update pools, `enable_parallel_mode`, per-router stats
  (`cmd/feeder/daemon-cmd.ts:521,720`).
- **Cron** re-submission service; **alert evaluator** writing `alert_log`.
- **API.** Spectra-aligned endpoints incl. `/api/v1/pools`, `/status`, `/events`,
  `/transactions`, `/alerts`, `/performance` (`src/api/server.ts`).
- **Metrics.** `dia_bridge_*` incl. **6-phase latency** (all 5 phases emitted,
  `daemon-cmd.ts:651,751,1405,1409,1414`), Cardano balance gauges, Prometheus aliases.
- **Security hardening** (R5) and **R10 adversarial-audit remediation** — all done; 475 tests.
- **In-process tx waits.** Confirmation → wallet-settlement (derives spent wallet inputs
  from the tx) → script-side replacement. (this session)

### Done THIS session (2026-06-04/05) — monitoring & ops correctness
- `make evidence`: one-folder packs, network read from `feeder/.env` CARDANO_NETWORK.
- Alert thresholds units bug (`receiver_balance_low`, `admin_wallet_low` were ×1000 off)
  corrected in both `infrastructure.*.yaml`; ADA-denominated alert exprs.
- Grafana balance panels in ADA; per-metric thresholds on the accrued stat panel.
- All alert descriptions rewritten against the **real fee flow** (Receiver top-up →
  AccrueFee → settle → payment-hook:withdraw → admin wallet) with Docker **and** npm
  commands; `AdminWalletLow` now says "collect accrued revenue", not "use a faucet".
- `ReceiverBalanceLow` names the client's exact Receiver address (`receiver_address`
  label) and warns funding is via `receiver:top-up`, not a direct transfer.
- Label-less balance gauges no longer report a default 0 (no spurious `AdminWalletLow`
  on restart); **periodic balance refresh** decoupled from update traffic.
- **CLI flag unification:** `--protocol-state` / `--client-state` / `--pair-state`
  everywhere (no more overloaded `--state`).
- `make down` activates all profiles; `init: true` so Ctrl+C / stop reach the container.

---

## 2. PENDING — Milestone 2 (priority order)

### P0 — M2 evidence pack (the Catalyst acceptance gate)
The scripts and one-folder pipeline exist; what's missing is a real long run.
- [ ] **48–72 h continuous Preview run** with uptime, intent counts, fee totals, worker
  stats (current packs are short ~4 h windows).
- [ ] **All 10 pairs** present in the evidence tables (incl. USDT/USD).
- [ ] **Real Grafana PNGs** in the pack (renderer already produces real 1400×900 PNGs).
- [ ] **Alert-firing demonstration** captured (`OraclePairStale` + `PriceDeviationHigh`).
- [ ] **Embed the dashboard images (or links) into the evidence writeup `.md`.**
- [ ] **Resolve the two `m2-preview-*` folders** — one complete pack
  (writeup + db + logs + stats + real PNGs); unify `package-m2-evidence.sh` with
  `render-dashboards.ts`.
- [ ] **Demo video** (operator flow + live dashboard + confirmed tx + alert firing).

### P1 — Monitoring correctness & coverage (found this session)
- [ ] **Threshold single-source-of-truth (drift fix).** Numbers in `monitoring/alerts.yml`
  and `grafana/dashboards/feeder.json` (2/5/10/50 ADA, 3600 s, 5 %, 600 s, `for:`
  durations) are **hardcoded copies** of `infrastructure.<network>.yaml::alerting.*` and
  do NOT auto-sync. Generate alerts.yml + dashboard thresholds **from** the YAML at
  build/deploy, or add a test that fails on drift. Only the in-process evaluator reads the
  YAML today.
  - Also: dashboard template vars `stale_threshold_seconds` and `receiver_warn_lovelace`
    exist in the UI but panels hardcode the values; `coordinator_warn_lovelace` is unused.
    Wire them from the YAML or remove them.
- [ ] **Fix misleading rate panels** on the current dashboard (`feeder.json`): "Tx failed
  rate" does `sum by (error_code)` (drops `symbol`) and shows `rate[5m]` (per-second avg).
  Switch to `increase[5m]` **count** (or per-minute), keep `symbol`, unit `tx` not `ops`.
  Same for "Tx confirmed rate" and "Intents filtered by reason".
- [ ] **New, SEPARATE dashboard** for the ~37 registered-but-unshown metric families
  (the main `feeder.json` stays as is). Priority panels: per-stage latency (the 5 phases),
  `scanner_rpc_errors_total` + backfill, worker active/queue/pool + task counters,
  `transaction_fee_lovelace`, `http_request_duration_seconds`, `component_health`,
  `recovery_attempts_total`, ingest/sanitation counters, `cron_resubmissions_total`,
  db ops, plus node/process defaults. Align panel windows with alert windows
  (PriceAge/PriceDeviation alert at 10 m; panels currently 1 h).

### P2 — Plan hygiene (this task)
- [x] Consolidate into this plan + `work-plan.md`; archive the rest with header notes.

---

## 3. PENDING — Mainnet rollout (R8)

Folds in (and corrects) the old `mainnet-rollout.md`.

> ⚠️ The old runbook's commands were **broken** and must not be used as written:
> `init bootstrap`, `protocol init`, `router init` do **not** exist. Correct verbs are
> `config:bootstrap`, `protocol:init`, `client:init`, and first-pair creation is via
> `update --intent … --protocol-state … --client-state … --pair-state …`. All commands
> use the unified `--protocol-state/--client-state/--pair-state` flags.

- [ ] **Re-point the Cardano Mainnet `Config` datum** to the DIA Mainnet domain before any
  Mainnet run (admin-signed `config:update`):
  - `source_chain_id`: `1050` (was bootstrapped with an old/invalid testnet value).
  - `verifying_contract`: `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7` (canonical DIA
    Mainnet registry). Until done, signature validation against DIA Mainnet intents fails.
- [ ] Validate `infrastructure.mainnet.yaml` / `contracts.yaml` / mainnet client YAMLs
  against the current code (post flag-rename + config changes).
- [ ] Generate + fund the Mainnet operator wallet (store address only; never the seed).
- [ ] Mainnet bootstrap: `config:bootstrap` → `protocol:init` → publish reference scripts
  → `client:init` → `receiver:bootstrap` → first `update` (mints the pair). Record every
  tx hash.
- [ ] Mainnet feeder run + verified update tx logs (M2 acceptance for Mainnet).
- [x] Rollback plan (documented; carried over from the old runbook).

---

## 4. OPEN questions pending DIA (carried from feeder-strategy)

- [ ] **Authorized signer set completeness.** Two keys/env recovered from live
  `IntentRegistered` events (2026-05-21); DIA has not confirmed the set is exhaustive.
- [ ] **Change-notification policy.** How DIA will communicate future changes to chain ids,
  registry addresses, or signer sets so the feeder never runs against stale values.
- [ ] **Daemon key management.** The long-running daemon reads the updater seed from
  `.env`; a production custody strategy (Vault/KMS/secrets) is undecided.

Canonical endpoints (confirmed by DIA 2026-05-20): Testnet chain `10050`,
RPC `https://testnet-rpc.diadata.org`, registry `0xF8c614A483A0427A13512F52ac72A576678bE317`;
Mainnet chain `1050`, RPC `https://rpc.diadata.org`,
registry `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`.

---

## 5. Deferred to M3 / M4 (NOT M2)

From `m3-deferred-features.md` (reconciled against code):

- **Indexer (workstream D, M3/M4):** per-pair latest price/timestamp/nonce/signer/intent
  hash; client query surface (Receiver balance, subscribed pairs, accrued fees); dApp
  integration examples.
- **HA / replica failover (M3/M4):** `replica.*` typed but not wired; no leader election /
  heartbeat / failover handler / `bridge_failover_*` metrics.
- **Per-router retry policy:** retry is global today (`createDefaultRetryPolicy`); per-router
  override is deferred.
- **Distributed cron lock:** cron is single-instance safe only; no Postgres advisory lock /
  leader election for multi-instance.
- **Per-destination cron schedules** (single global tick in M2).
- **Developer documentation published on DIA's dev site (M4)** — operator runbook exists
  locally; publication pending.
- **QA validation report + anomaly-detection evidence (M3)** — needs the 48–72 h run.
- **Final closeout report + video (M4).**
- **M1 leftover:** off-chain Lucid emulator **adversarial** negative-case matrix (happy path
  done; two-client parallelism, expired intent, NFT redirect on settle/config-update,
  accrued drain via withdraw, settle without admin signature, non-admin withdraw, duplicate
  live pair).

**Excluded by design (not pending):** EVM gas semantics; EVM method ABIs; router
`transformations` (validator rejects them — would break EIP-712); `validation_enabled:false`
(intent signature is mandatory); `datasource: processed`. See archived
`m3-deferred-features.md` for the full register.

---

## 6. Known stale references to clean up (low priority)

- `work-plan.md` referenced `m1-preview-20260515-130925/`; the real latest M1 Preview pack
  is `m1-preview-20260516-090057/`.
- Old `mainnet-rollout.md` CLI commands (see §3 warning) — fixed here; archived original.
