> **ARCHIVED 2026-06-05** — superseded by [`../milestone-feeder-plan.md`](../milestone-feeder-plan.md).
> The deferred/excluded/wired register was folded into §5 of the new plan (some items marked 'deferred', e.g. head-tracker/gap-detection loops, are actually wired). Any still-open items were carried into that consolidated plan; the only live
> plans are `../work-plan.md` and `../milestone-feeder-plan.md`. Kept for history — do
> not use as the live plan.

---

# Milestone 3 — Deferred Features

> **What this is.** An inventory of every Spectra-bridge feature, config key
> or behaviour that is **typed and surfaced in the feeder's YAML / code**
> but **not wired to runtime behaviour yet**, plus a separate section for
> Spectra subsystems that are intentionally **excluded** (multi-chain
> coordination, EVM-destination tx submission) and will not move to M3.
>
> Every row here corresponds to something a future agent — or DIA — can
> find in the repo and reason about without re-deriving from Spectra. Keep
> it updated whenever you wire (or remove) one of these.
>
> **Scope policy:** "deferred to M3" means the YAML key + types are
> already in place so a Spectra-shaped config loads without
> unknown-property errors; the runtime is the only thing missing.
> "Excluded" means the feature does not apply to a Cardano-only feeder
> and we do not plan to implement it.

---

## A. Deferred to M3 (typed, surfaced, not wired)

These keys appear in `config/infrastructure.<network>.yaml` and in
`src/config/types.ts`. The loader accepts them, the validator does not
reject Spectra-shaped configs that set them, but no runtime consumer
reads them yet. Each row links to the file:line where the typed-but-inert
declaration lives.

### A.1 — Block-scanner sub-loops

| Spectra key | Location | What Spectra does | Why deferred | How to wire in M3 |
|---|---|---|---|---|
| `block_scanner.head_tracker_interval` | `src/config/types.ts:107-121` `BlockScannerConfig` | Dedicated head-tracker goroutine that polls `eth_blockNumber` independently of the main scan tick, so head freshness does not depend on the slower `scan_interval`. | The HTTP scanner refreshes head implicitly each scan tick; the WS scanner gets head inline from log delivery. No staleness observed at current event rates. | Add a `runHeadTracker` loop in `src/source/scanner-http.ts` driven by this interval; expose `scanner_head_block` gauge update independent of the main scan. |
| `block_scanner.gap_detection_interval` | `src/config/types.ts:107-121` | Dedicated gap-detection loop that periodically compares `head - cursor` and triggers a backfill if exceeded. | Inline gap recovery already triggers within the normal scan tick: when `head - cursor > max_block_gap` is observed mid-scan, the scanner switches to `backfill_chunk_blocks` chunks until caught up (`runHttpScanner` in `scanner-http.ts`). | Move the gap check out of the main scan tick and into a separate ticker on this interval; emit `scanner_gap_detection_runs_total` independently. |

### A.2 — Worker-pool generalisation

| Spectra key | Location | What Spectra does | Why deferred | How to wire in M3 |
|---|---|---|---|---|
| `worker_pool.parallel_*` extension | `src/config/types.ts:152-170` | Spectra supports unbounded worker counts across destinations; mid-task cancellation; per-pool retry policies tunable per router. | The feeder wires `UpdateWorkerPoolManager` (one pool per router) and supports `max_workers` / `task_queue_size` / `task_timeout`, **but** retry policy is currently global (`createDefaultRetryPolicy` in daemon-cmd.ts), not per-router. | Thread a per-router `RetryPolicy` override read from `router.processing.retry_policy` or from `router.worker_pool` (Spectra has the field at both levels) into `createUpdateWorkerPoolManager`. |

### A.3 — Replica failover (HA)

| Spectra key | Location | What Spectra does | Why deferred | How to wire in M3 |
|---|---|---|---|---|
| `replica.enabled` / `replica.role` / `replica.monitor_chain_id` | `src/config/types.ts:251-256` `ReplicaConfig`; `config/infrastructure.<network>.yaml` `replica:` block | Two feeder instances coordinate: primary submits, secondary monitors a heartbeat tx on a designated chain and only takes over when the heartbeat ages past a threshold. Prevents double-submission and split-brain. | Single-instance Cardano deployments are sufficient for Catalyst M2. Multi-instance coordination would require a separate persistent heartbeat (e.g. a Cardano UTxO with a timestamp) plus leader-election logic. | (1) Implement a heartbeat write path (the primary updates a designated UTxO every `heartbeat_interval`). (2) Add a secondary loop that watches it and takes over if the timestamp ages out. (3) Wire `replica.role` to gate the submission paths in daemon-cmd.ts. |

### A.4 — Distributed cron / event-processor parity details

| Spectra key | Location | What Spectra does | Why deferred | How to wire in M3 |
|---|---|---|---|---|
| `cron_service` distributed lock | `src/cron/cron-service.ts` | Spectra acquires a Postgres advisory lock so only one instance runs the cron loop. | Single-instance assumption (A.3). | Pair with replica work: introduce a DB advisory lock (Postgres) or a leader-elect file/UTxO (SQLite) so only one running daemon performs cron submissions. |
| Event-processor `validation_timeout` | omitted by design — see [README parity table](../../offchain/feeder/README.md) lines 638-655 | Spectra has a per-event validation phase with its own timeout. | The feeder's enrichment + routing happens inside `processOneEvent`; its budget is the parallel-mode `parallel_timeout` when on, or implicit when off. | If a separate validation-phase budget becomes useful, surface it as `event_processor.validation_timeout` and apply it inside the enricher before the router dispatch. |

### A.5 — API extensions

| Spectra key | Location | What Spectra does | Why deferred | How to wire in M3 |
|---|---|---|---|---|
| `api.listen_addr` (composite form) | `src/config/types.ts:185-198` `APIConfig.listen_addr` | Spectra accepts `listen_addr: "<host>:<port>"` as the canonical bind setting. | The feeder accepts both `host`+`port` and `listen_addr`; `host`+`port` win when both are present (loader-time alias only). The composite form is accepted but not yet promoted to the canonical primary in the YAMLs. | Decide whether to deprecate `host`+`port` and move to Spectra's `listen_addr`. Update both YAMLs and the validator if so. |

---

## B. Excluded permanently (not deferred — out of scope)

These exist in Spectra because Spectra is a multi-chain EVM-destination
bridge. The Cardano feeder is single-source (DIA Lasernet) and
single-destination (Cardano Preview or Mainnet) by design. We do not
plan to implement these in any future milestone of this repo.

| Spectra subsystem | Why excluded | Where the absence is documented |
|---|---|---|
| `chains.yaml::default_gas_limit`, `gas_multiplier`, `max_gas_price` | EVM-destination gas semantics. Cardano txs are min-fee + size-fee per Praos, computed by the SDK at build time. There is no "gas". | `src/config/types.ts:283-291` — fields typed for Spectra YAML parity, never read by Cardano destinations. |
| `contracts.yaml::methods.<...>` (EVM method ABIs) | Cardano destinations are addressed by `(network, client_state_path, protocol_state_path)`, not by EVM ABI calls. | `CardanoDestinationConfig` in `src/config/types.ts:449-453`; router validator rejects `method:` ↔ `cardano:` confusion. |
| `routers/*.yaml::destinations[].method` | Same as above (EVM-only). | Router YAMLs always use the `cardano:` block; presence of `method:` is rejected by the validator. |
| Multi-chain `replica.monitor_chain_id` cross-chain heartbeat | The feeder runs against one source and one destination; cross-chain heartbeat coordination is irrelevant here. The `replica` block under "A.3 Deferred" covers the single-chain version. | This file, §A.3 note. |
| Spectra's EVM-side gas estimator / fee oracle clients | Cardano fees are deterministic from tx size; no oracle/estimator needed. | Not surfaced in feeder types at all. |
| `event_processor.batch_size` (EVM enrichment batching) | Spectra's enrichment performs an EVM `multicall` to fetch many intents in one RPC. The Cardano feeder's enricher fetches one intent at a time (the registry view is per-hash) and parallel-mode is wired separately. | `src/config/types.ts:123-150` — only the parallel-mode keys are typed; `batch_size` is intentionally absent. |
| `worker_pool.task_queue_size` per-EVM-chain shaping | Spectra splits queue depth by destination chain. The Cardano feeder has one destination chain, so per-chain shaping collapses to per-router shaping (which IS wired). | `WorkerPoolConfig` in `src/config/types.ts`. |
| EVM `health_check.timeout`, `recovery.*` block | Spectra-internal RPC health probes and recovery state. The Cardano feeder's readiness is driven by `readiness.max_last_confirmed_age`, `max_processing_lag`, and `max_queue_size`. | `HealthCheckConfig` in `src/config/types.ts`; README parity table. |
| `routers/*.yaml::processing.transformations` | **EVM payload reshaping.** In Spectra, transformations rewrite the destination method's call params. The Cardano payload IS the DIA-signed intent; the on-chain coordinator verifies the EIP-712 signature over its exact fields (price, timestamp, nonce, …). Rewriting any field invalidates the signature → on-chain rejection. The validator **rejects** a non-empty `transformations` block with this reason (it is not silently ignored). | `validateProcessing` in `src/config/validate.ts`; `ProcessingConfig.transformations` typed for YAML parity only. The `createTransformer` op set in `src/pipeline/transformer.ts` remains available for any future non-payload use (e.g. routing-context derivation) but is not wired to submission. |
| `routers/*.yaml::processing.datasource: "processed"` | Depends on the EVM-only transformations stage above; there is no "processed" payload for a signed intent. The validator rejects it; `event` and `enrichment` (default) are accepted. | `validateProcessing` in `src/config/validate.ts`. |
| `routers/*.yaml::processing.validationenabled: false` | The feeder ALWAYS recovers and authorises the EIP-712 signer of every intent; validation cannot be disabled without accepting unsigned prices. The validator rejects `false`; `true` (default) is accepted. | `validateProcessing` in `src/config/validate.ts`. |

---

## C. Cardano-only extensions (not in Spectra)

For completeness — these have no Spectra parallel because they address
Cardano-specific semantics. None of these is deferred; all are wired.

| Feeder-specific key | What it does | Why Cardano-only |
|---|---|---|
| `cardano.confirmation_depth` | Number of Cardano blocks the feeder waits past inclusion before marking `tx_confirmed`. | Ouroboros Praos finality model — there is no equivalent in the EVM world (where `confirmations` is per-chain dependent and lives in the source `block_scanner` block). |
| `worker_pool.inflight_timeout_ms` | Lane-lock ceiling for a submitted Cardano tx. | EUTxO contention: the Receiver UTxO is locked while a tx is in flight. No EVM equivalent. |
| `alerting.*_lovelace`, `alerting.payment_hook_withdraw_ready_lovelace`, etc. | Operational thresholds for Cardano-specific balance / fee-accrual states. | Receiver / PaymentHook / settle flow are Cardano-only contracts. |
| `routers/*.yaml::destinations[].cardano` block | Addresses a Cardano destination by `(network, client_state_path, protocol_state_path)`. | Replaces Spectra's EVM `method:` block. |
| `event_processor.coalesce_window`, `max_intent_age`, `max_batch_size`, `size_fallback_enabled` | Lane coalescer parameters (per-symbol supersession + batching). | Cardano-only: EVM destinations submit one-at-a-time, no per-lane coalescing needed. |

---

## D. Honest debt — known limitations as of last update

Things this feeder does NOT do, even though they're not Spectra-parity items:

| Limitation | Where | What it would take |
|---|---|---|
| No persistent dedup across restarts | `src/processor/dedup-cache.ts` — in-memory LRU. The DB `processed_events` row IS persistent and the dedup check on startup re-reads recent rows, but the LRU itself resets. | A startup hydrate step that loads N most-recent `processed_events.intentHash` into the LRU. |
| `private_key` / `private_key_env` in `InfrastructureConfig` | `src/config/types.ts:59-60` — typed for Spectra parity but the Cardano feeder always uses `routers.<id>.private_key_env`. The infra-level keys are silently ignored. | Either drop them from types (breaks Spectra YAML parity) or document explicitly that Cardano destinations only read router-level signers (currently documented only in this file). |
| Per-router metric labels for queue depth | The queue manager reports a single `totalPending()` across lanes. | Add `pendingPerLane()` and label `dia_bridge_queue_depth{router_id}` instead of the unlabeled current value. |
| Crash-recovery beyond `pending → failed` | `cmd/feeder/daemon-cmd.ts` startup loop marks any `pending`/`submitted` tx as `failed`. There is no resumption logic (we never retry a half-confirmed tx after restart). | Add a "verify on chain" step: for each `submitted` tx, look up its hash via the registry/explorer before deciding whether to mark it `failed` vs `confirmed`. |
| SQLite block-number precision ceiling of 2^53 | `src/persistence/db.ts` — block columns are INTEGER (required for numeric range/order queries); better-sqlite3 returns INTEGER as a JS number, so a SQLite block height above 2^53 would lose precision. Postgres (BIGINT→string) preserves to 2^63. | Physically unreachable (≈285 M years at 1 block/s; highest live EVM height ≈10^7). If ever needed, apply per-statement `.safeIntegers()` to the block-reading statements and adjust the row mappers. Pinned by a test in `db-methods.test.ts`. |

---

## F. Clarifications — questions that keep coming up

These are not "deferred" or "excluded" features. They are questions about
how the Cardano version handles things that look different from Spectra at
first glance, but are actually fully implemented — sometimes with **more**
machinery than Spectra has, just shaped differently because the underlying
chain is different.

### F.1 — "But what about gas? Spectra has `gas_multiplier`, `max_gas_price`, etc."

**Short answer:** Cardano has no gas market. The Spectra knobs are about
bidding for inclusion on a congested EVM chain. They have no equivalent
because **Cardano fees are deterministic** — there is nothing to tune.
Fee tracking and accounting, on the other hand, IS fully implemented in
lovelace, with **more** detail than Spectra (two distinct fee flows).

**Long answer:**

| Concept | EVM (Spectra) | Cardano (this feeder) |
|---|---|---|
| Pricing model | `gas_used × gas_price` — bid against other txs for inclusion | `min_fee_a × size_bytes + min_fee_b + scripts(mem × price + steps × price)` — deterministic from protocol params |
| Operator knobs | `gas_multiplier`, `max_gas_price`, `default_gas_limit` — control the bidding strategy | None needed — Lucid computes the exact fee at build time. The wallet pays whatever the formula returns. |
| Currency | wei / gwei (native chain token) | lovelace (1 ADA = 1,000,000 lovelace) |
| "Boost a stuck tx" (RBF) | Yes — resubmit with higher gas | No — Cardano mempool dynamics are different; txs that pass validation enter the next block barring saturation. |

**What we DO have, in lovelace** — two distinct fee flows:

1. **Network tx fee** (paid by the feeder wallet to Cardano validators):
   - `transaction_log.fee_paid_lovelace` — recorded per tx in the DB.
   - `contract_symbol_updates.total_fee_paid_lovelace` — running total per pair.
   - Metrics: `dia_bridge_cardano_fee_paid_lovelace_total`.
   - Alert: `admin_wallet_low_lovelace` (the operator wallet that pays this is running out).

2. **Protocol fee** (charged by the DIA oracle protocol on every update — does NOT exist in Spectra):
   - Every update spends the Receiver UTxO with `AccrueFee`, moving
     `base_fee_lovelace + N × per_pair_fee_lovelace` from `balance_lovelace`
     to `accrued_to_hook_lovelace`. Both values come from the on-chain Config datum.
   - A separate **Settle** tx (admin-initiated, batched across receivers)
     drains the accrued lovelace to the global PaymentHook UTxO.
   - Alerts: `receiver_balance_low_lovelace` (client ran out — pause updates),
     `settle_overdue_lovelace` (DIA should run a settle),
     `payment_hook_withdraw_ready_lovelace` (DIA can drain to the bank).

**Net conclusion:** "no gas market knobs" is a feature of Cardano, not a
gap. The fee accounting work that DOES exist in this feeder has no
Spectra equivalent (Spectra-on-EVM does not charge a protocol fee out of
the destination contract's balance — that flow is Cardano-specific).

### F.2 — "There are multiple receivers (one per client). How do alerts and dashboards handle that?"

**Short answer:** every per-client metric carries a `client_id` label.
Prometheus stores one time-series per client, alerts fire per client,
and Grafana panels split lines by client. The threshold (e.g.
`receiver_balance_low_lovelace`) is one number applied to every client's
series independently — there is no per-client threshold override yet (see §D).

**How it works end-to-end** (using `ReceiverBalanceLow` as the example):

**Step 1 — Tx confirmation for `client-a`.** `cmd/feeder/daemon-cmd.ts:702-709`
reads the post-tx Receiver datum:

```ts
metrics.cardanoReceiverBalanceLovelace.set(
  { client_id: "client-a" }, balance,
);
```

**Step 2 — Prometheus storage.** One time-series per `client_id` label:

```text
dia_bridge_cardano_receiver_balance_lovelace{client_id="client-a"} 1850000000
dia_bridge_cardano_receiver_balance_lovelace{client_id="client-b"} 4200000000
dia_bridge_cardano_receiver_balance_lovelace{client_id="client-c"}  800000000
```

**Step 3 — Alert evaluation.** `monitoring/alerts.yml` `ReceiverBalanceLow`:

```yaml
expr: dia_bridge_cardano_receiver_balance_lovelace < 2000000000
```

Prometheus evaluates the expression **per series**. With three clients
below threshold, three alerts fire — each carrying its own
`{{ $labels.client_id }}` in the summary so the on-call engineer knows
which client needs `dia-cli receiver:top-up`.

**Step 4 — Grafana dashboard.** `monitoring/grafana/dashboards/feeder.json:169-170`
plots `dia_bridge_cardano_receiver_balance_lovelace` with
`legendFormat: "{{client_id}}"`. One coloured line per client in the
same panel.

**Other per-client signals follow the same pattern:**

| Metric / alert | Label | Notes |
|---|---|---|
| `cardano_receiver_balance_lovelace` | `client_id` | Receiver's spendable balance per client. |
| `cardano_receiver_accrued_lovelace` | `client_id` | Receiver's `accrued_to_hook_lovelace` — drives `SettleOverdue`. |
| `cardano_receiver_topup_warnings_total` | `client_id` | Counter: how many times we saw a client below threshold post-tx. |
| `transactions_reorg_total` | `symbol`, `client_id` | Drops by reorg, labelled per client. |

**Where `client_id` comes from:** it is the router id (`routers.<id>` in
the YAML; one router file per client). The label name `client_id` is
preserved across metrics, dashboards and alerts so cross-correlation in
Grafana / PromQL just works.

**Threshold shape (current vs future):** thresholds in
`infrastructure.<network>.yaml::alerting.*` are **global**: one number
applied uniformly. If DIA needs per-client thresholds (e.g. a high-volume
client tolerates a higher accrued balance before triggering `SettleOverdue`),
that requires:

1. Extending the YAML schema to `alerting.per_client: { client-a: { ... } }`.
2. Wiring per-client overrides into the feeder so it can emit a per-client
   warning counter (the Prometheus rule would still pick whichever
   threshold is highest on a series basis — Prometheus does not do
   per-label thresholds natively, so the simpler path is to emit a
   `receiver_balance_below_threshold{client_id}` boolean gauge from the
   feeder and alert on that).

That extension is not currently in scope — it would be a §A row if DIA
decides they need it.

---

## E. How to keep this file in sync

When you wire a deferred feature, move its row from §A → §C (or delete
if it no longer applies). When you add a new typed-but-inert config key,
add a row to §A. When the Spectra parity register in
`milestone-2-final-plan.md` lists a subsystem as **M3**, that subsystem
must have a corresponding row in §A here.

Cross-references:

- Architecture: [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md) §9 (feeder architecture).
- Spectra parity register: [`./milestone-2-final-plan.md`](./milestone-2-final-plan.md) (search "Spectra Parity Disposition Register").
- Feeder config types: [`../../offchain/feeder/src/config/types.ts`](../../offchain/feeder/src/config/types.ts).
- Active YAMLs: [`../../offchain/feeder/config/infrastructure.preview.yaml`](../../offchain/feeder/config/infrastructure.preview.yaml), [`../../offchain/feeder/config/infrastructure.mainnet.yaml`](../../offchain/feeder/config/infrastructure.mainnet.yaml).
