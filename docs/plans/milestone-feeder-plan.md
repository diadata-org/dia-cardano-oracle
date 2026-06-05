# Milestone — Feeder Plan

**Status date:** 2026-06-05 · **Tests:** 475 pass, 0 fail (`cd offchain/feeder && npm test`) · **Branch:** main

This is the single source of truth for the DIA Cardano Oracle **feeder** (Catalyst
Milestone 2) and its path to Mainnet. The only live
plans are this file and `work-plan.md` (the cross-workstream rolling plan).

Statuses below were **verified against the codebase on 2026-06-05**.

---

## Contents

- [Milestone — Feeder Plan](#milestone--feeder-plan)
  - [Contents](#contents)
  - [1. Verified DONE baseline (do not re-litigate)](#1-verified-done-baseline-do-not-re-litigate)
    - [Done THIS session (2026-06-04/05) — monitoring \& ops correctness](#done-this-session-2026-06-0405--monitoring--ops-correctness)
  - [2. PENDING — Milestone 2 (priority order)](#2-pending--milestone-2-priority-order)
    - [P0 — M2 evidence pack (the Catalyst acceptance gate)](#p0--m2-evidence-pack-the-catalyst-acceptance-gate)
    - [P1 — Monitoring correctness \& coverage (found this session)](#p1--monitoring-correctness--coverage-found-this-session)
    - [P2 — Plan hygiene (this task)](#p2--plan-hygiene-this-task)
  - [3. PENDING — Mainnet rollout (R8)](#3-pending--mainnet-rollout-r8)
  - [4. OPEN questions pending DIA (carried from feeder-strategy)](#4-open-questions-pending-dia-carried-from-feeder-strategy)
  - [5. Deferred to M3 / M4 (NOT M2)](#5-deferred-to-m3--m4-not-m2)
  - [6. Known stale references to clean up (low priority)](#6-known-stale-references-to-clean-up-low-priority)

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
The scripts and one-folder pipeline exist; what's missing is a sustained Preview run to
populate the evidence.
- [ ] **Sustained Preview run** long enough to show uptime, intent counts, fee totals and
  worker stats across all 10 pairs (current packs are short ~4 h windows). The milestone
  does not fix a duration — M2 asks for a lightweight preview / early signal, not a
  production deployment.
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
- [ ] **Dashboard filter variables — `$client` first, then every label we can split by.**
  Right now panels show raw aggregates; an operator can't ask "show me ONLY client-a". Add
  Grafana template variables and rewrite every per-label panel to honour them. When a
  filter is left at **All**, the panel must AGGREGATE across that label (sum / multi-series),
  not vanish.
  - **Implementation (verified against `src/api/metrics.ts` label sets, 2026-06-05):**
    - Add template vars (type=query, `includeAll`, multi-value): `$client`
      (`label_values(dia_bridge_cardano_receiver_balance_lovelace, client_id)`), `$symbol`
      (`label_values(dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds, symbol)`),
      and where useful `$customer`, `$error_code`. Set each var's All-value to `.*`.
    - In every per-label query, filter with regex-match and aggregate excluding the filtered
      label, e.g. counters: `sum by (symbol) (rate(dia_bridge_transactions_confirmed_total{client_id=~"$client", symbol=~"$symbol"}[5m]))`;
      histograms: `histogram_quantile(0.95, sum by (le, symbol) (rate(dia_bridge_end_to_end_latency_seconds_bucket{client_id=~"$client"}[5m])))`.
      All → `.*` matches every client and `sum by` aggregates across them; one client →
      just that client. This is the "filter, else aggregate" pattern the operator asked for.
  - **Metrics that CAN be filtered by client** (have `client_id`): transactions
    submitted/confirmed/failed(+`error_code`)/reorg; latency phases 3–5
    (`scan_to_processing`, `processing_to_submission`, `submission_to_confirmation`,
    `end_to_end_latency`); `cardano_oracle_last_confirmed_timestamp_seconds`;
    `cardano_receiver_balance_lovelace`(+`receiver_address`); `cardano_receiver_accrued_lovelace`;
    `cardano_receiver_topup_warnings_total`; `cardano_pair_is_create`;
    `cron_resubmissions_total`(+`router_id`,`outcome`); `intents_{submitted,confirmed,failed}_lifecycle_total`(+`customer`);
    `transaction_fee_lovelace`(+`customer`). These MUST get the `$client` filter.
  - **Metrics that are GLOBAL (no `client_id`, document as not client-filterable):**
    `cardano_admin_wallet_lovelace`, `cardano_payment_hook_accrued_lovelace` (protocol-wide);
    `scanner_*`, `http_*`, `db_*`, `worker_*`, `component_health` (infra); `price_deviation_percent`,
    `price_age_seconds` (by `symbol`, source-data); latency phases 1–2
    (`intent_to_registration`, `registration_to_scan`) are pre-routing, `symbol`-only.
  - Apply to BOTH the existing `feeder.json` and the new metrics dashboard.
- [ ] **Network-scoped router config (config correctness).** Today routers are NOT
  network-aware: `loadRouterDirectory` reads **every** `*.yaml` under `config/routers/`
  and merges them, ignoring both the filename suffix and the `cardano.network` field
  (`loader.ts:136,189-190`). The `.preview` in `client-a.preview.yaml` is a human label
  only; `cardano.network` is type-checked (`validate.ts:740` `oneOf`) but never compared to
  the active `CARDANO_NETWORK`. Consequence: under `CARDANO_NETWORK=Mainnet` the preview
  router (preview state paths + `CARDANO_WALLET_SEED_TESTNET`) still loads and runs; adding
  a mainnet router would load BOTH at once. Only "works" today because there is one router
  file and we run Preview. (Contrast: `infrastructure.<network>.yaml` IS network-selected.)
  - **Decision (chosen design):** **per-network subfolders**, not a filename suffix
    (subfolders scale when there are many routers). Layout:
    `config/routers/preview/*.yaml` and `config/routers/mainnet/*.yaml`. The loader reads
    **only** the active network's subfolder (`routers/${networkTag}/`) — no filename check
    needed; the folder is the source of truth.
  - **Keep the `cardano.network` field as a secondary guard:** within the active subfolder,
    if a router's `network` ≠ the active network, **log a WARNING and skip it** (do not use
    it) rather than silently running it. Belt-and-suspenders against a misfiled router.
  - **Work involved:** change `loadRouterDirectory` to take the network tag and read
    `routers/<networkTag>/` (`loader.ts:136,184-211`); add the warn-and-skip guard
    (extend the `validate.ts:740` network check into a cross-check vs active network); move
    `config/routers/client-a.preview.yaml` → `config/routers/preview/client-a.yaml` (drop
    the suffix); create `config/routers/mainnet/` for the Mainnet client(s) at rollout (R8);
    update `config/README.md` and the feeder README config-layout section; adjust any tests
    that point at `config/routers/`. No router-content change (state paths stay
    `state/<network>/...`).
- [ ] **OpenAPI / Swagger for the HTTP API — single-source, generated (chosen: Option B).**
  The API has no machine-readable contract today; for a client deliverable it needs one,
  plus an interactive `/docs`. The server is raw `node:http` (`createServer`, no framework)
  and every route is already enumerated in one `Route` union (`src/api/server.ts:57-80`,
  ~24 endpoints, all GET except `POST /api/v1/alerts/:id/ack`). Rather than hand-write a
  spec that can drift, **generate the OpenAPI document from the routes themselves**:
  - Refactor the `Route` union + the dispatch `switch` into a **route table** where each
    entry carries metadata: method, path template, path/query params, summary/tags, and a
    **response schema** (zod via `@asteasolutions/zod-to-openapi`, or TypeBox which is
    JSON-Schema-native). One table drives routing, the generated spec, and (optionally)
    runtime response validation — so the docs cannot drift from the code by construction.
  - Generate an **OpenAPI 3.1** doc from that table and serve it at
    `GET /api/v1/openapi.json` (build-time or first-request).
  - Serve **Swagger UI or Redoc at `/docs`** from bundled static assets (no CDN) so it works
    air-gapped inside Docker.
  - **Scope/impact:** invasive — touches `src/api/server.ts` (route union + matchRoute +
    handler switch) and the `src/api/*.ts` handlers (attach schemas); adds a dep
    (zod + zod-to-openapi, or TypeBox). Payoff: drift-proof docs, a real client contract,
    and optional output validation from the same source. (The lighter hand-authored-spec
    alternative was considered and rejected in favour of single-source.)
- [ ] **Multi-client (batch) `settle` in the CLI.** The on-chain protocol supports settling
  **multiple Receivers in one tx** — coordinator `ApplySettle(SettleManifest { receivers:
  List<SettleReceiver> })` (`contracts/aiken/lib/dia_cardano_oracle/coordinator_logic.ak:18-34`),
  which validates the manifest is non-empty + unique and that the summed receiver drains
  equal the PaymentHook delta. The CLI does **not** expose this: `settleAccruedFees` takes a
  single `--client-state` and builds a 1-element manifest, and the preflight
  `assertSettleManifestMatchesSingleClientReceiver` (`offchain/cli/src/transactions/settle.ts:50,132`)
  **rejects any manifest whose length ≠ 1**. Not a security bug (on-chain arithmetic can't be
  bypassed), but a real capability gap — documented in the audits but NOT surfaced anywhere
  in the live plans (`docs/audit/20260515-audit-report.md:209-211,290`;
  `docs/audit/202605230-deep-research-report.md:56` lists it **P0, effort Low**).
  - **Why it matters:** one settle that drains N clients **amortizes the coordinator +
    PaymentHook cost across all of them** in a single tx, instead of one settle tx (and one
    network fee) per client. Directly relevant once there is more than one client.
  - **Work:** extend `settle` to accept **multiple clients** — repeatable `--client-state`
    (or a `--manifest` file listing client state paths); build the `SettleManifest` from all
    N receivers, `collectFrom` every receiver UTxO + the hook in one tx; replace the
    "exactly 1" preflight with the manifest non-empty + unique check (the on-chain coordinator
    already enforces sum-of-drains == hook delta). Update the `SettleOverdue` alert
    remediation + README to mention batching multiple clients in one settle.

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
- **QA validation report + anomaly-detection evidence (M3)** — needs a sustained live run.
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
