# Feeder M2 — Architecture Guide (quick read)

> Support document to explain the current state of the feeder. Written to be read
> top-to-bottom before a meeting. Concepts build on each other, so the order matters.
>
> At its core the feeder is a **port of DIA's Spectra bridge** to a Cardano
> destination: same modular YAML config layout, same
> `scanner → enricher → router → write-client` pipeline, same HTTP API surface, same
> `dia_bridge_*` metric prefix. What **diverges** is the Cardano side, where the
> EUTxO model forces us to serialize on-chain writes.

---

## 1. What the feeder is (high level)

The feeder is a **single Node.js process** that:

1. Watches DIA's EVM chain (Lasernet) for `IntentRegistered` events.
2. Enriches each event into a full intent (symbol, price, timestamp, nonce).
3. Decides whether that intent is worth an on-chain update.
4. Groups intents per client and writes an oracle-update transaction to Cardano.
5. Tracks the result, exposes metrics/health over HTTP, and guarantees liveness.

There is **no "intent file" being polled** — the source of truth is the EVM chain.

---

## 2. End-to-end flow (from an intent to a Cardano tx)

```text
DIA Lasernet (EVM, chain_id 10050)
   │  IntentRegistered event
   ▼
Scanner (HTTP poll + WS, run in parallel) ── reads logs via eth_getLogs
   ▼
Extractor + dedup cache ── drops repeats (in-memory LRU)
   ▼
Enricher ── calls getIntent() over RPC → "fullIntent" (symbol, price, timestamp, nonce)
   ▼
Router ── filters by trigger conditions (symbol ∈ list) + applies the policy gate
   ▼
Lane Coalescer ── per-symbol buffer, supersede, accumulation window
   ▼
Queue Manager ── ONE serial queue per lane = (client, receiver UTxO)
   ▼
Cardano Write Client (lib-bridge) ── load state → build tx → sign → submit → await confirm
   ▼
Result Handler ── writes DB (transaction_log + contract_symbol_updates) + priceCache + metrics
```

---

## 3. Ingestion: HTTP + WebSocket "in parallel"

**These are NOT two processes.** The feeder is **one Node.js process** (one thread,
one event loop). Inside it, two async tasks run **concurrently** via
`Promise.all([...])`. They are two promises the event loop interleaves — not two OS
processes.

| Path | Has a loop? | How it works | Config |
| --- | --- | --- | --- |
| **HTTP scanner** | **Yes**, a polling loop | `while`: ask for the chain head → `eth_getLogs` by ranges → process → save checkpoint → **sleep 10s** → repeat | `block_scanner.scan_interval: 10s`, `block_range: 500`, `confirmations: 6` |
| **WS scanner** | No polling | Opens **one WebSocket connection** that stays open; the server **pushes** events in real time. Its `while` only handles **reconnection** if the link drops | `event_monitor.reconnect_interval: 5s`, `max_reconnect_attempts: 60` |

Both feed the **same handler**. The **dedup cache** guarantees an event arriving on
both paths is processed **exactly once**.

> **One-liner:** *"One process with two simultaneous ingestion paths: an HTTP poller
> that checks the chain every 10 seconds as a reliable baseline, and an open
> WebSocket that receives events in real time. If the WebSocket drops, HTTP still
> guarantees we lose nothing; and if an event arrives on both, dedup processes it
> once."*

---

## 4. The update decision: two filter stages

An intent passes through **two independent filters** before it ever becomes a tx. Both
increment `intents_filtered_total`, but with a different `reason` label, so you can
tell *why* an intent was dropped.

### Stage 1 — trigger conditions (relevance filter) — `reason: "condition"`

Each router has `triggers.conditions`, evaluated with **AND** logic, fail-fast
(`src/router/router.ts`). For client-a the single condition is:

```text
Symbol ∈ [BTC/USD, ETH/USD, USDC/USD, USDT/USD, DOGE/USD, LTC/USD, ARB/USD, SHIB/USD, NEIRO/USD, XVG/USD]
```

An intent whose symbol is **not in that list** fails the condition and is dropped as
**"filtered by condition"**. This is the first question: *"is this intent even
relevant to this client?"* — it runs **before** the OR-gate. (Conditions can match any
enriched field, not just symbol; all listed conditions must pass.)

### Stage 2 — the OR-gate (freshness filter) — `reason: "time_threshold" | "price_deviation" | "timestamp_*"`

For a symbol that *is* relevant, two thresholds are evaluated (`src/router/policy.ts`):

- `time_threshold` — minimum time since the last on-chain confirm.
- `price_deviation` — minimum relative price change vs. the last recorded price.

| Configured | Passes if… |
| --- | --- |
| Neither | always |
| Time only | `time_threshold` elapsed |
| Price only | deviation ≥ `price_deviation` |
| **Both** (client-a: `5m` + `0.1%`) | **time OR price** (whichever happens first) |
| No prior cached price | always (first update) |

Before the OR-gate there is a **timestamp monotonicity** check: a smaller timestamp →
suppress (`timestamp_regression`); an equal timestamp → suppress
(`timestamp_duplicate`).

> **One-liner:** *"We push an update when the price moves more than 0.1%, OR when 5
> minutes have passed without an update — whichever happens first."*

(A third `reason` value exists — a **preflight** check that runs right before
submission, e.g. balance/state sanity — but the two stages above are the ones that
shape day-to-day filtering.)

---

## 5. Batching & submission: Coalescer vs Queue Manager

These are **two distinct stages**, often confused:

- **Coalescer = decides WHAT to send and WHEN.** It groups and filters.
- **Queue Manager = executes the write, ONE tx at a time per lane.** It writes to Cardano.

### Analogy: a shipping counter

- **Coalescer = the packer.** Many loose intents arrive. Per symbol it keeps **only
  the newest** (*supersede*: if a fresher BTC arrives, the old one is dropped) and
  assembles **one package** (the batch: up to `max_batch_size: 10` symbols). It gathers
  symbols in two situations: a short `coalesce_window` (2s) **only when the lane was
  empty/idle**, and — more importantly — **for free while the previous tx is still
  confirming** (the lane is busy, so intents pile up at no extra latency cost). See the
  state machine below for the exact rule.
- **Queue Manager = the single cashier per client.** It takes the assembled package
  and sends it to Cardano **one at a time**: grabs the Receiver UTxO, builds the tx,
  signs it, submits it, **waits for confirmation**, and only then handles the next
  package for that same client. While a tx is in flight, **nobody else touches that
  UTxO**.

### Why both exist

| | Coalescer | Queue Manager |
| --- | --- | --- |
| **Question it answers** | Which intents are worth it, and how do I group them? | How do I write this on-chain without conflicts? |
| **Problem it solves** | Avoid sending stale prices; send 1 tx instead of 10 | EUTxO: two txs spending the same Receiver UTxO **conflict** → must serialize |
| **Works with** | symbols in memory (a `Map`) | the real on-chain UTxO + signing + confirmation |
| **Output** | a ready batch | a confirmed on-chain tx |

### The core reason: the UTxO lock

In Cardano a transaction **spends** a specific UTxO (the client's Receiver). If you
send two txs at once both trying to spend the **same** UTxO, one fails. So the Queue
Manager keeps **one serial queue per lane** (= per client/receiver): submit → wait for
confirmation → release the lock → submit the next.

A **lane = (client, receiver UTxO)**. Parallelism across clients comes from having
**multiple lanes** (multiple receivers), NOT multiple workers within one lane.

> **One-liner:** *"The coalescer gathers a client's intents and keeps the freshest
> price per symbol in a single transaction; the queue manager takes that transaction
> and writes it to Cardano one at a time per client, waiting for confirmation before
> the next, because EUTxO does not allow two simultaneous writes against the same
> UTxO."*

### Where does the client come in? (both stages are per-client)

A common confusion: *which* stage knows the client? **Both do**, and they use the
**exact same key** to partition their work (`src/submitter/lane-key.ts`):

```text
lane = client_state_path :: protocol_state_path   →  one client (its Receiver UTxO)
```

The client is attached **upstream**: the router emits each `SubmitRequest` already
carrying its `destination` (which points at one client's state files). So by the time
anything reaches the coalescer, every request already knows its client. Nothing has to
"sort by client" afterward — work is **partitioned by client**, not ordered:

- **Coalescer** keeps **one buffer per lane (= per client)**. Inside each buffer it's
  `Map<symbol, newest>`. When a lane flushes, it flushes **that one client's symbols**
  → that's the batch. It **never mixes two clients in a batch**.
- **Queue Manager** keeps **one serial queue per lane (= per client)**, routing each
  request to its client's queue by the same key. `submitBatch` even **rejects** a
  batch whose requests don't all share one lane.

So client-A and client-B run on **separate queues → concurrently**; within client-A,
**serial**. Neither stage is "the client-aware one" — both partition by the same lane.
The real difference between them is the *job* (group/filter vs. write safely), not the
client.

### Batch vs simple update — decided automatically, per client

There is **no manual "batch mode"**. At flush time the write client looks at **how many
symbols that one client accumulated during the window**
(`src/submitter/cardano-write-client.ts`):

| Symbols buffered for the client | What is sent |
| --- | --- |
| **1** | a **simple update** (1 tx, 1 pair) |
| **2–10** | **one batch tx** updating several pairs of the **same client** |
| **>10** (`max_batch_size`) | split into multiple txs |

Calm market → mostly simple updates. A burst across several of a client's pairs — or
several pairs arriving **while the previous tx was still confirming** — flushes as a
batch. Either way it's always **one client per tx** (one Receiver UTxO, one signer).

### The coalescer state machine

The lane buffer is **not FIFO** — it's a `Map<symbol, newest-intent>`. Three states:
`idle → accumulating → in-flight`.

- **`idle` → first intent arrives → `accumulating`**: starts the `coalesce_window` (2s)
  timer. This 2s wait happens **only here** — when the lane was empty. Whatever lands
  in those 2s flushes together.
- **`in-flight` (a tx is confirming) → intents arrive**: they just accumulate
  (supersede per symbol), **no timer**. The lane is already "waiting" on the chain, so
  this costs zero extra latency.
- **tx confirms with a non-empty buffer**: flush **immediately** — no second 2s window.
  This is where most multi-symbol batches come from: everything that piled up while the
  previous tx was confirming goes out in one batch.
- `max_intent_age: 15m` — drops buffered intents that are too old at flush time.

> **One-liner:** *"We only pause 2 seconds when the lane is idle. Once a transaction is
> in flight, new prices accumulate for free — keeping the newest per symbol — and the
> moment the chain confirms, the whole accumulated batch goes out with no extra wait."*

---

## 6. Latency: the 6 phases

Instead of measuring only "it took 45s end-to-end", the feeder splits the total time
a price takes — from DIA generating it to Cardano confirming it — into **6 separate
segments**, so we know *where* time is spent (a Spectra idea).

```text
  DIA creates       registered      scanner          processing       sent to          confirmed
  the price    →    on-chain (EVM) → delivers it  →  starts       →   Cardano      →   on Cardano
      │                  │                │              │               │                  │
      └─── phase 1 ──────┘                │              │               │                  │
                         └─── phase 2 ────┘              │               │                  │
                                          └─ phase 3 ────┘               │                  │
                                                         └─ phase 4 ─────┘                  │
                                                                         └─── phase 5 ──────┘
      └──────────────────────── phase 6: end-to-end (feeder side) ───────────────────────────┘
```

| Phase | Segment | Latency it reveals |
| --- | --- | --- |
| **1** | price created → registered on-chain (EVM) | **DIA / EVM** side (before the feeder sees anything) |
| **2** | registered → scanner delivers it | **transport + polling** (the 10s HTTP loop, or the WS) |
| **3** | delivered → processing starts | feeder **internal backlog** |
| **4** | processing → sent to Cardano | time for **enrich + route + coalesce** |
| **5** | sent → confirmed on Cardano | **pure Cardano chain** latency |
| **6** | processing → confirmed (whole feeder segment) | **end-to-end** on the feeder side |

**Why it matters:** if total latency spikes, the phases tell you *whose fault* it is:
DIA slow to register (phase 1)? RPC slow (phase 2)? Cardano congested (phase 5)?

> Today Grafana shows **only phase 6** (end-to-end). Phases 1–5 **are emitted but not
> dashboarded** — they're in the "metrics to add" list (§20).

---

## 7. Caches & the price cache

**Principle: the DB is the source of truth for anything that must survive a restart.**
The in-memory caches are just the fast path.

| Cache | Holds | Used by | On restart |
| --- | --- | --- | --- |
| **dedup cache** | seen intent hashes (LRU, TTL 1h) | the hot-path dedup check | empty; the checkpoint skips already-scanned blocks |
| **priceCache** | the **last confirmed price** per (router, dest, symbol) | the policy gate (OR-gate) + the cron | empty; **re-seeded from `contract_symbol_updates`** in the DB |
| **latestIntentCache** | the **last intent seen** (confirmed or not) | the cron (to know *what* to resubmit) | empty; refills within seconds from live events |

### The price cache, specifically

It's an in-memory (RAM) table of **the last on-chain-confirmed price of each pair**.
Key `(router, dest, symbol)` → last price + timestamp + when it was updated.

Two consumers:

1. **The policy gate.** When a new BTC/USD intent arrives, the gate compares against
   the last confirmed price/time to decide *"did it move >0.1%? has 5m passed?"*. That
   "last" comes from the price cache.
2. **The cron service.** To know whether a pair is stale (last confirmed older than
   `time_threshold`), it reads the age from the price cache.

**Why RAM and not the DB every time:** it's the hot path — queried on every intent,
thousands of times. RAM is instant. On restart it's re-seeded from the DB, so the DB
stays the source of truth and the cache is the fast copy.

> Don't confuse it with **latestIntentCache**: that one holds the last intent *seen*
> (used by the cron to know *what* to resubmit). The price cache holds the last
> *confirmed* price (used to decide *whether* to submit).
>
> **One-liner:** *"The price cache is an in-memory copy of each pair's last confirmed
> price; we use it to decide in milliseconds whether a new intent warrants an update,
> without hitting the database on every event."*

---

## 8. The database

### The 6 tables

| Table | Purpose |
| --- | --- |
| `processed_events` | Audit log of every `IntentRegistered` + persistent dedup |
| `chain_state` | **The checkpoint**: up to which block we've scanned — where the scanner resumes |
| `transaction_log` | In-flight and confirmed Cardano txs (pending→submitted→confirmed/failed) |
| `contract_symbol_updates` | Last confirmed price per (chain, contract, symbol) |
| `performance_metrics` | Time-series of metrics (feeds `/api/v1/performance`) |
| `alert_log` | Alerts fired / resolved |

### Restart / crash recovery

1. Migrate/validate the 6 tables.
2. **Crash recovery**: txs left `pending`/`submitted` are marked `failed` (we don't
   know if they hit the chain). No double-apply: the contract rejects with
   `NonMonotonicNonce` if it was already on-chain.
3. Read the **checkpoint** from `chain_state` and resume scanning from there (old
   blocks are not re-processed).
4. Caches start empty; priceCache is re-seeded from the DB. The event-driven flow (or
   the cron) re-pushes whatever is needed.

---

## 9. Loops & cadences

| Loop | Cadence | What it does |
| --- | --- | --- |
| HTTP scanner | `scan_interval` **10s** | EVM block polling (baseline) |
| WS scanner | real time, reconnect **5s** | event fast-path (concurrent with HTTP) |
| **Cron service** | `tick_interval` **30s** | resubmits stale pairs |
| Alert evaluator | continuous | evaluates rules → `alert_log` table |
| Health check / queue-depth | `check_interval` **30s** | refreshes queue depth → `/health/ready` |
| Balance refresh | cron cadence **30s** | refreshes wallet-balance gauges (independent of traffic) |

---

## 10. Cron service

The "liveness insurance". The OR-gate can filter **every** event if the price doesn't
move (a flat market for hours). Without the cron, the pair would go stale on-chain
even though DIA keeps emitting. (`src/cron/cron-service.ts`)

Every **30s** it walks each destination with `cron: true`, and per symbol:

1. Look at the last **confirmed** (priceCache). Never confirmed → skip (`skipped_uninitialised`).
2. Fresher than `time_threshold` → nothing to do.
3. Stale → take the last known intent (latestIntentCache) and **resubmit it through
   the same queue** as the event-driven flow.
4. If the last intent equals what's already on-chain → skip (`skipped_already_fresh`);
   the contract would reject it with `NonMonotonicNonce`.

> ⚠️ Today `client-a.preview.yaml` has **no `cron: true`** on its destination. The
> service is globally enabled but is **opt-in per destination**. Without it, the
> feeder only updates on events. Confirm whether to show the cron active.

---

## 11. Confirmation depth (Cardano finality)

`cardano.confirmation_depth` = **how many Cardano blocks the feeder waits past the
inclusion block before declaring the tx confirmed.** (`src/lib-bridge/index.ts:599`)

- **`confirmation_depth: 1` (current):** as soon as the tx lands in a block, we
  declare it confirmed. Practically final for oracle feeds, lowest latency.
- **`confirmation_depth: N > 1`:** the feeder waits an approximation of
  `(N - 1) × 20s` (Cardano's ~20s slot time) past inclusion, then **re-checks the tx
  is still on-chain**. If a rollback dropped it, it throws and the daemon counts a
  `transactions_reorg_total` and treats it as failed.

**Why this exists:** Cardano (Ouroboros Praos) can have short rollbacks where a block
is briefly accepted then replaced. A higher depth trades **latency for rollback
safety**. Depth 1 is fine for testnet/preview; a production deployment that wants
extra safety raises it. The actual depth waited is exposed in `/api/v1/prices` as
`confirmedAtDepth`.

> **One-liner:** *"Confirmation depth is how many Cardano blocks we wait before
> trusting a transaction. We run at depth 1 — effectively final for an oracle — and
> can raise it to ride out short rollbacks at the cost of a little latency."*

---

## 12. Sequential vs parallel processing

Today the feeder processes events **one at a time (sequential)**: finish enriching +
routing event A, then start event B. `enable_parallel_mode` (off by default) would let
it process up to `parallel_worker_count: 4` events **at once**.

**"It's a ceiling, not a problem":** at the current volume (10 Catalyst pairs, low
frequency) sequential processing keeps up easily — there's no backlog. It would only
become a bottleneck if event volume grew a lot. So it's a **scaling ceiling we can
raise later by flipping one flag**, not a problem today.

**Key nuance:** even with parallel mode ON, the **writes to Cardano stay serial per
lane** (EUTxO). Parallel mode only speeds up the enrichment/routing stage (the
`getIntent` RPC calls), never the on-chain writes.

---

## 13. Worker pools

Two pools exist:

- **EventWorkerPool** (parallel enrichment/routing): gated by `enable_parallel_mode` →
  **OFF by default** (see §12). When on: up to 4 workers, queue 256, 30s timeout — but
  all submissions still flow through the serial per-lane coalescer (EUTxO-safe).
- **UpdateWorkerPool** (submission staging, **one pool per router**): **always
  instantiated** (`daemon-cmd.ts:967`). `max_workers 4`, `task_queue_size 128`,
  `task_timeout 60s`. Workers don't submit directly — they call `coalescer.accept()`,
  which serializes per lane. Lets a saturated router not starve the others.

**Invariant:** parallelism in processing, **serialization in the per-lane write**.

---

## 14. Single-instance vs multi-instance (HA / failover)

**Single-instance (today):** exactly **one** feeder process runs. If it dies, oracle
updates stop until it restarts. Docker restarts it automatically, but there's a gap.

**Multi-instance / HA (High Availability):** run **two or more** feeder instances. One
is **primary** (active, doing the work), the other(s) **secondary** (standby, watching
the primary's heartbeats). If the primary dies, a secondary **takes over
automatically** — no human, no gap. That automatic takeover is called **failover**.

The `replica.*` config block already models this (`role: primary|secondary`,
`monitor_chain_id` for the chain the secondary watches), but it is **typed-only, not
wired** — the YAML parses cleanly, but no failover logic runs yet. It's deferred to M3.

**Why it's not trivial on Cardano:** you can't naively run two instances — both would
try to spend the **same Receiver UTxO** and conflict (EUTxO again). True HA needs real
coordination (leader election, shared lock) so only one instance writes at a time.
That's exactly why it's a later milestone.

> **One-liner:** *"Today it's a single instance — if it dies, Docker restarts it but
> there's a gap. High availability means running a hot standby that takes over
> automatically; the config models it, but the failover logic is M3 because on Cardano
> two live instances would conflict over the same UTxO without coordination."*

---

## 15. Config `infrastructure.preview.yaml` — key blocks

| Block | Purpose |
| --- | --- |
| `database` | local sqlite (`state/preview/feeder.sqlite`); postgres supported for prod |
| `source` | the EVM chain it scans: `chain_id 10050`, RPC + WS, `start_block` |
| `block_scanner` | HTTP poller knobs (10s, 500 blocks, 6 confirmations, backfill 5000) |
| `event_processor` | `dedup_cache_ttl 1h`, `coalesce_window 2s`, `max_batch_size 10`, `max_intent_age 15m`, **`enable_parallel_mode: false`** |
| `worker_pool` | `inflight_timeout_ms 900000` (15min, Cardano-specific: releases the lane lock if a tx hangs) |
| `cardano` | `confirmation_depth: 1` (see §11) |
| `cron_service` | `tick_interval 30s` |
| `alerting` | canonical thresholds — **single source of truth**, shared by the feeder and the Prometheus alert rules |

### What comes from Spectra vs. what is Cardano-specific

- **From Spectra:** config layout, scanner→enricher→router pipeline, HTTP API,
  `dia_bridge_*` metrics, the worker-pool concept, cron service, backfill/gap recovery,
  health checks, the OR-gate policy, the 6 latency phases, the price cache.
- **Cardano-specific:** the **lane model** (per-receiver serialization), the
  **coalescer** (supersede), `inflight_timeout_ms`, `confirmation_depth` (Ouroboros
  finality), the `lib-bridge` write client, and the whole **fee flow** (receiver
  top-up → settle → payment-hook withdraw).

---

## 16. HTTP API

Server on `0.0.0.0:8080`. **No authentication**, rate-limited 60 req/min per IP, CORS
off by default. **No Swagger/OpenAPI or playground** — it's hand-written REST (a
possible future improvement).

| Endpoint | Returns |
| --- | --- |
| `GET /health`, `/health/ready` | liveness / readiness |
| `GET /metrics` | **Prometheus, ~50 metrics** (feeds Grafana) |
| `GET /api/v1/prices` | last confirmed prices per symbol |
| `GET /api/v1/status` | health snapshot (uptime, network, scanner, db) |
| `GET /api/v1/transactions` | Cardano tx history with status |
| `GET /api/v1/alerts?active=true` | active alerts |
| `GET /api/v1/events` | processed `IntentRegistered` events |
| `GET /api/v1/pools` | worker-pool stats |

---

## 17. State: implemented / M2 / deferred to M3

- **Implemented and active (this IS M2):** full scanner→tx pipeline, dedup, enricher,
  OR-gate router, coalescer + lanes, serial queue manager, cron service, alert
  evaluator, the 6 latency phases, both worker pools wired, inline backfill/gap
  recovery, full API, the 6 tables, state reconciliation at startup.
- **Implemented but OFF by default:** `enable_parallel_mode` (sequential is enough).
- **Deferred to M3 (typed, parses, but NOT wired):**
  - `replica.*` — **multi-instance HA / failover** (see §14).
  - `head_tracker_interval` / `gap_detection_interval` — dedicated loops; today they
    run **inline** in the scan tick.
  - `listen_addr` — host:port alias, loader-level only.

### M2 evidence pack

M2 is not just "the code runs" — there is a reproducible **evidence pack** that
captures a point-in-time deployment record proving the milestone works end-to-end.

Generate it with `make evidence` from `offchain/` (the feeder must be running, with
the monitoring stack up for the Grafana PNGs). It runs
`scripts/m2-evidence/package-m2-evidence.sh` plus two DB-stats scripts and writes a
self-contained dated directory to:

```text
docs/milestones/evidence/m2-<network>-<YYYYMMDD-HHMMSS>/
```

What the pack contains:

| Path | Content |
| --- | --- |
| `logs/` | raw `feeder.log`, `transactions.jsonl`, `lane.jsonl`, `intents/` |
| `db/` | `transaction_log`, `processed_events`, `chain_state` exported as CSV |
| `api/` | live `/api/v1/{prices,chains,symbols}` + Prometheus `/metrics` snapshots |
| `dashboards/` | full Grafana dashboard PNG + one PNG per panel |
| `stats/`, `stats.json` | DB-authoritative transaction/event statistics |
| `error-counts.tsv` | failed-tx counts bucketed by `error_code` |
| `SUMMARY.json` | machine-readable totals |
| `milestone-2-preview-evidence.md` | **the reviewer-facing report** — embeds the dashboards and explains each metric |

The script is read-only against the feeder (append-only logs + concurrent SQLite
reads), so it can run while the feeder keeps serving. See
[`offchain/feeder/scripts/README.md`](../../offchain/feeder/scripts/README.md) for
prerequisites, env vars, and the full output description.

---

## 18. Current limitations

1. **Single-instance, no HA.** If the process dies, Docker restarts it, but there's a
   gap until restart. Failover (`replica`) is M3 (§14).
2. **Per-lane throughput bounded by Cardano confirmation.** One tx in flight per
   receiver at a time (~30s–2min). Scale with more clients/receivers, not more workers
   per lane.
3. **Sequential processing** (parallel mode off). A ceiling, not a current problem (§12).
4. **Gap-detection/head-tracker run inline**, not as dedicated loops (M3).
5. **API has no auth** (rate-limited only). Don't expose it publicly as-is.
6. **`confirmation_depth: 1`** — practically final, but a Cardano rollback is
   theoretically possible (low risk; raise the depth to harden — §11).
7. **In-memory caches lost on restart** — re-seeded from the DB, but there's a brief
   "warm-up" window.

---

## 19. Questions for DIA

1. **Intent emission rate/volume** per symbol → validates that sequential mode, the
   `coalesce_window`, and `max_batch_size 10` are enough.
2. **Freshness/staleness SLA** per pair → drives `time_threshold` and the cron cadence.
   (Is 1h max acceptable, or do they need less?)
3. **Per-pair `price_deviation`** → today 0.1% for all; do they want it to differ per pair?
4. **Do they need HA / multi-instance (M3 replica)?** Is a single point of failure
   acceptable for now?
5. **Do they want `cron: true` active?** Today client-a doesn't have it → events only.
6. **Rollback tolerance** → is `confirmation_depth: 1` fine, or do they want more depth?

---

## 20. Metrics that exist but are NOT in Grafana

The feeder exposes ~50 `dia_bridge_*` metrics at `/metrics`. The current dashboard
(`monitoring/grafana/dashboards/feeder.json`) uses **13**. Below is what's missing —
split into **metrics with real data** (worth adding) and **metrics defined but with no
emitter yet** (do NOT add: they'd read 0/empty).

### Already in Grafana (reference)

`transactions_confirmed_total`, `transactions_failed_total`, `transactions_reorg_total`,
`intents_filtered_total`, `end_to_end_latency_seconds` (phase 6),
`price_deviation_percent`, `price_age_seconds`, `scanner_block_lag`,
`cardano_receiver_balance_lovelace`, `cardano_receiver_accrued_lovelace`,
`cardano_payment_hook_accrued_lovelace`, `cardano_admin_wallet_lovelace`,
`cardano_oracle_last_confirmed_timestamp_seconds`.

### A — Missing, with real data (candidates to add)

**Event/intent funnel** (how many enter vs. survive each stage):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_events_detected_total{scanner_type}` | Raw events detected by the scanner, **before** dedup. Inbound chain traffic, per path (http/ws). |
| `dia_bridge_events_duplicate_total` | Events dropped by the dedup cache (arrived on both HTTP and WS, or re-scan after reconnect). |
| `dia_bridge_events_invalid_total{reason}` | Events rejected at decode/enrich time (malformed, `getIntent` failed). |
| `dia_bridge_intents_scanned_total{symbol,scanner_type}` | Enriched intents **entering** the routing pipeline. |
| `dia_bridge_intents_routed_total{symbol,router_id}` | Intents **accepted** by a destination (passed trigger conditions). |
| `dia_bridge_transactions_submitted_total{symbol,client_id}` | Submission attempts **broadcast** to Cardano (the denominator for success rate, with confirmed/failed). |

**Latency breakdown (phases 1–5)** — today only phase 6 (end-to-end) is shown. These
show **WHERE** latency lives:

| Metric | What it measures |
| --- | --- |
| `dia_bridge_intent_to_registration_seconds{symbol}` | **Phase 1**: price created → registered on-chain (EVM). DIA/EVM side. |
| `dia_bridge_registration_to_scan_seconds{symbol}` | **Phase 2**: registered → scanner delivers it. Transport + polling. |
| `dia_bridge_scan_to_processing_seconds{symbol}` | **Phase 3**: delivered → processing starts. Internal backlog. |
| `dia_bridge_processing_to_submission_seconds{symbol,client_id}` | **Phase 4**: processing → submitted to Cardano. enrich + route + coalesce time. |
| `dia_bridge_submission_to_confirmation_seconds{symbol,client_id}` | **Phase 5**: submitted → confirmed. Pure Cardano-chain latency. |

**Scanner health** (today only `block_lag`):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_scanner_last_block{chain_id,scanner_type}` | Last block observed by each scanner. Progress cursor. |
| `dia_bridge_scanner_rpc_errors_total{chain_id,error_type}` | Scanner RPC errors. Health of the RPC/WS endpoint. |
| `dia_bridge_scanner_backfill_blocks_total{chain_id}` | Blocks backfilled after detecting a gap > `max_block_gap`. >0 = a gap was recovered. |
| `dia_bridge_scanner_backfill_chunks_total{chain_id}` | Number of backfill chunks executed (one per `eth_getLogs` in recovery). |

**Cost / fees** (today balances are shown, but not per-tx cost):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_transaction_fee_lovelace{symbol,client_id,customer}` | Histogram of lovelace paid **per oracle-update tx** (the Cardano equivalent of EVM gas). Key for cost tracking. |
| `dia_bridge_cardano_receiver_topup_warnings_total{client_id}` | How many times the receiver balance was below threshold after a confirmed tx. |
| `dia_bridge_cardano_pair_is_create{symbol,client_id}` | Whether the last submission **minted** the pair (1) or **updated** it (0). |

**Cron service** (today none shown):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_cron_resubmissions_total{router_id,symbol,client_id,outcome}` | Cron decisions by outcome: `submitted`, `skipped_already_fresh`, `skipped_no_intent`, `skipped_uninitialised`. Shows whether the cron is working and why it skips. |

**HTTP API** (today none shown):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_http_requests_total{method,endpoint,status}` | Requests served by the API, per endpoint and status code. |
| `dia_bridge_http_request_duration_seconds{method,endpoint}` | API latency per endpoint. |

**Worker pools** (emitted, but only meaningful with `enable_parallel_mode` ON):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_active_workers{pool_type}` | Workers currently executing a task, per pool type (event/update). |
| `dia_bridge_worker_pool_size{pool_type}` | Configured concurrency limit per pool. |
| `dia_bridge_worker_queue_size{pool_type}` | Tasks/events waiting in the pool queue. |
| `dia_bridge_worker_tasks_dropped_total{pool_type}` | Tasks dropped because the queue was full. **Backpressure signal.** |

**Spectra lifecycle aliases** — duplicate the funnel with Spectra's canonical naming
(`bridge_intents_*`) plus a `customer` label. Useful if DIA compares dashboards
between Spectra and this feeder:

`dia_bridge_intents_scanned_lifecycle_total`, `dia_bridge_intents_processed_lifecycle_total`,
`dia_bridge_intents_submitted_lifecycle_total`, `dia_bridge_intents_confirmed_lifecycle_total`,
`dia_bridge_intents_failed_lifecycle_total` — same funnel stages, for naming parity.

### B — Defined but with NO emitter in the current code (do NOT add yet)

These exist in `src/api/metrics.ts` but **no module increments them today** — on a
panel they'd read 0/empty. Don't add them until they're wired:

- `dia_bridge_worker_tasks_completed_total` — *intent:* tasks completed successfully in the pools.
- `dia_bridge_worker_tasks_failed_total` — *intent:* tasks that failed or timed out.
- `dia_bridge_worker_task_retries_total` — *intent:* task-level retries.
- `dia_bridge_db_operations_total{table,operation}` — *intent:* DB operations by table and type.
- `dia_bridge_db_operation_duration_seconds{table,operation}` — *intent:* DB operation latency.
- `dia_bridge_component_health{component}` — *intent:* per-component health (1/0).
- `dia_bridge_recovery_attempts_total{component,reason}` — *intent:* recovery attempts after transient errors.

> Note: `/metrics` also includes `prom-client` default metrics (`process_*`,
> `nodejs_*`: CPU, heap, event-loop lag). These are Node runtime metrics, not feeder
> domain, and are also not dashboarded.

### Suggested panels to add (by value)

1. **Funnel** (detected → scanned → routed → submitted → confirmed/failed/filtered):
   shows at a glance where intents drop off.
2. **Per-phase latency breakdown** (1–5): isolates whether latency is DIA, transport,
   internal, or Cardano.
3. **Cost per tx** (`transaction_fee_lovelace`): tracks ADA spend.
4. **Scanner health** (`last_block`, `rpc_errors`, `backfill`).
5. **Cron** (`cron_resubmissions_total` by outcome).
