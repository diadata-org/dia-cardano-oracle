# DIA Cardano Oracle Feeder — Architecture Guide

> This document explains the Cardano oracle feeder: what it is, how it relates to the
> Spectra bridge it is ported from, how it works end to end, and where to find the rest
> of the repository's documentation. Read it top to bottom — the concepts build on each
> other. It is the plain-language companion to the formal architecture spec
> ([`cardano-oracle-architecture.md`](./cardano-oracle-architecture.md)) and to the
> operator manuals (the READMEs, mapped in the final section).

## Contents

- [Overview: what it is, and how it maps to Spectra](#overview-what-it-is-and-how-it-maps-to-spectra)
- [Concept glossary: customer, client, router, lane](#concept-glossary-customer-client-router-lane)
- [Client funding: side-deposit address + merge](#client-funding-side-deposit-address--merge)
- [1. What the feeder is (high level)](#1-what-the-feeder-is-high-level)
- [2. End-to-end flow (from an intent to a Cardano tx)](#2-end-to-end-flow-from-an-intent-to-a-cardano-tx)
- [3. Ingestion: HTTP and WebSocket in parallel](#3-ingestion-http-and-websocket-in-parallel)
- [4. The update decision: two filter stages](#4-the-update-decision-two-filter-stages)
- [5. Batching & submission: Coalescer vs Queue Manager](#5-batching--submission-coalescer-vs-queue-manager)
- [6. Latency: the 6 phases](#6-latency-the-6-phases)
- [7. Caches & the price cache](#7-caches--the-price-cache)
- [8. The database](#8-the-database)
- [9. Loops & cadences](#9-loops--cadences)
- [10. Cron service](#10-cron-service)
- [11. Confirmation depth (Cardano finality)](#11-confirmation-depth-cardano-finality)
- [12. Sequential vs parallel processing](#12-sequential-vs-parallel-processing)
- [13. Worker pools](#13-worker-pools)
- [14. Single-instance vs multi-instance (HA / failover)](#14-single-instance-vs-multi-instance-ha--failover)
- [15. Config `infrastructure.preview.yaml` — key blocks](#15-config-infrastructurepreviewyaml--key-blocks)
- [16. HTTP API](#16-http-api)
- [17. State: implemented / M2 / deferred to M3](#17-state-implemented--m2--deferred-to-m3)
- [18. Current limitations](#18-current-limitations)
- [19. Metrics that exist but are NOT in Grafana](#19-metrics-that-exist-but-are-not-in-grafana)
- [20. lucid WASM build resilience (submission/finality hardening)](#20-lucid-wasm-build-resilience-submissionfinality-hardening)
- [Fee loop & automatic maintenance (settle / withdraw / consolidate)](#fee-loop--automatic-maintenance-settle--withdraw--consolidate)
- [Alerts & automatic remediation — at a glance](#alerts--automatic-remediation--at-a-glance)
  - [Cardano API provider health (primary vs secondary)](#cardano-api-provider-health-primary-vs-secondary)
- [Where to find everything (documentation map)](#where-to-find-everything-documentation-map)
- [Open questions & constraints to verify](#open-questions--constraints-to-verify)

---

## Overview: what it is, and how it maps to Spectra

**What it is.** A production-style *feeder*: a long-running service that watches DIA
oracle intents on the EVM side (Lasernet) and turns them into confirmed price-update
transactions on **Cardano**, for one or more client receivers — with full monitoring
(Grafana/Prometheus), an HTTP API, alerting, and an operator CLI.

**It is a port of DIA's Spectra bridge.** Rather than invent a new design, it mirrors
[`diadata-org/Spectra-interoperability/services/bridge`](https://github.com/diadata-org/Spectra-interoperability/tree/main/services/bridge)
so it stays familiar to anyone who knows Spectra and behaves the same wherever Cardano
allows it. The four buckets below summarise the relationship; the full disposition table
is in §15.

| Relationship | Spectra (DIA's EVM bridge) | This feeder (Cardano) |
| --- | --- | --- |
| **Taken 1:1** | modular YAML config; the `scanner → enricher → router → write-client` pipeline; the HTTP API surface; the `dia_bridge_*` metric names; the OR-gate policy (`time_threshold` / `price_deviation`); the cron liveness service; the 6 latency phases; gap-recovery/backfill | same names, same shapes, same metrics — a Spectra dashboard reads largely the same |
| **Adapted for Cardano** | one worker pool per router submitting concurrently | a **lane model**: one serial queue per (client, receiver UTxO), because Cardano's EUTxO model forbids two txs spending the same UTxO at once. We added a **coalescer** (keep the newest price per symbol; batch a client's symbols) and an **in-flight lock timeout** |
| **Cardano-only (no Spectra equivalent)** | — | `confirmation_depth` (Ouroboros finality), the `lib-bridge` Cardano tx builder, and the whole **fee flow** (receiver top-up → settle → payment-hook withdraw) |
| **Deliberately left out (for now)** | HA failover monitor (`replica.*`), dedicated head-tracker/gap loops, EVM-destination subsystems | typed in config so a Spectra-shaped YAML still loads, but **not wired** — reserved for M3 (see §17) |

The rest of this document walks the pipeline in order. §15 holds the
full Spectra-parity table; §17 lists exactly what is implemented vs. deferred.

---

## Concept glossary: customer, client, router, lane

Read this section before the pipeline. Most confusion in the feeder comes from using
"client" to mean two different things. In this repo the terms below are deliberately
separate.

| Term | What it means | Where it lives | Does it exist on-chain? |
| --- | --- | --- | --- |
| **Customer** | The external party DIA is serving. It is an operational/reporting label: `customer_id` in YAML/metrics, `customerId` in TypeScript/API. | Router metadata, logs, metrics, dashboards. | No. |
| **Client deployment** | One Cardano oracle namespace for a customer: one Receiver UTxO, one deposit address, one Receiver NFT, one per-client pair policy/script set. | `state/<network>_run_<id>/clients/<client>.json` plus the live UTxOs on Cardano. | Yes. |
| **Router** | An off-chain feeder config group: which intents are relevant, which destination they go to, and which `time_threshold` / `price_deviation` policy applies. | `offchain/feeder/config/routers/<network>/*.yaml`. | No. |
| **Destination** | One output target inside a router. For this Cardano feeder, a destination points to `client_state_path` + `protocol_state_path`. | Router YAML. | No, but it references on-chain state files. |
| **Lane** | The submission/concurrency key: `client_state_path :: protocol_state_path`. One lane means one serial writer for one Receiver. | Feeder runtime (`src/submitter/lane-key.ts`). | No, but it protects one on-chain Receiver UTxO. |
| **Receiver** | The per-client UTxO that holds prepaid balance, accrued fees, and the Receiver NFT. Every update spends and recreates it. | Cardano, described by the client state JSON. | Yes. |
| **Deposit address** | The per-client funding address tied to the Receiver NFT. A customer can send ordinary ADA there; the feeder/CLI later merges it into the Receiver. | Cardano script address derived from the client deployment. | Yes. |
| **Pair** | One DIA symbol under one client deployment, e.g. `BTC/USD`. It has a Pair UTxO and Pair NFT under that client's pair policy. | Cardano + `<run>/clients/<client>/pairs/*.json`. | Yes. |

**The rule:** sharing means **one on-chain client deployment, many off-chain routers**.
It does **not** mean many on-chain clients. A router is not a client deployment; it is
just feeder configuration.

This is the supported shape for one customer that wants different policies across
different pair groups:

```text
customer: ACME
  on-chain client deployment: acme.json
    Receiver UTxO: one
    deposit address: one
    pair policy/script namespace: one
  router: acme-router-majors.yaml    symbols BTC/USD, ETH/USD   policy 0.5% OR 10m
  router: acme-router-stables.yaml   symbols USDC/USD, USDT/USD policy 0.1% OR 30m
  both routers point to the same client_state_path + protocol_state_path
```

That setup reuses the same Receiver, deposit address, and pair namespace. The routers
still keep independent policy/cache state because feeder policy is keyed by
`(routerId, destinationIndex, symbol)`.

The hard boundary is symbol overlap on a shared lane. If two routers point to the same
`client_state_path :: protocol_state_path`, their symbol sets must be **disjoint**.
The lane coalescer buffers by `symbol` inside that shared lane, so two routers both
claiming `BTC/USD` are not two independent customers. The config validator rejects that
dangerous shape at startup.

Create a second on-chain client deployment only when DIA needs a separate Receiver,
separate deposit address, separate pair namespace, or independent lane throughput.

**Artifact ownership at a glance:**

| Scope | Artifacts | When to create another one |
| --- | --- | --- |
| **Per protocol/run** | Config UTxO/NFT, PaymentHook UTxO/NFT, global reference scripts, protocol state JSON. | New network/run/protocol deployment. |
| **Per on-chain client deployment** | Receiver UTxO/NFT, deposit address, per-client reference scripts, pair policy/script namespace, client state JSON. | Separate balance/deposit/pair namespace or separate lane throughput. |
| **Per pair** | Pair UTxO/NFT and local pair-state JSON for one symbol under one client deployment. | New DIA symbol for that client deployment. |
| **Per router** | YAML file, trigger conditions, policy thresholds, router id, destination index, policy cache rows. | New off-chain routing/policy group; no new on-chain artifacts by itself. |

---

## Client funding: side-deposit address + merge

> This is the feeder-operational view of side-deposit funding (who triggers the merge,
> with what params and thresholds, and how it serialises against oracle updates). The
> on-chain view — the deposit validator, the anti-skim rule, and the merge transaction
> shape — is in
> [`cardano-oracle-architecture.md` §5.14](./cardano-oracle-architecture.md#514-side-deposit-funding--merge-per-client).

A client's prepaid balance lives in their **Receiver** UTxO. To add balance you must
**spend and recreate that Receiver** (the `TopUp` operation) — which requires the script,
the datum, and protocol-aware tooling (the CLI). **A client cannot do that from an
ordinary wallet.** So `receiver:top-up` is, in practice, an **internal DIA / operator**
operation — not something a client runs. (A client *could* run their own top-up with the
full tooling, but they won't.)

To let a client fund with nothing but an ordinary wallet payment, each client has a
**per-client deposit address** — a separate script
(`contracts/aiken/validators/deposit.ak`). The flow:

1. **Client deposits.** The client sends ADA to their deposit address with a normal wallet
   payment — no CLI, no datum. In Plutus V3 a datum-less script UTxO is spendable, so the
   payment lands as a usable deposit (unlike sending to the Receiver address, whose
   validator does `expect Some(datum)` and would strand the funds).
2. **DIA/feeder credits the balance.** Later, the feeder/CLI folds the accumulated
   deposits into the Receiver's `balance_lovelace`, in either of two forms (both run the
   deposit's anti-skim rule — see
   [`cardano-oracle-architecture.md` §5.14](./cardano-oracle-architecture.md#514-side-deposit-funding--merge-per-client)):
   - **Standalone merge** — spends the Receiver under the `TopUp` redeemer together with
     the selected clean deposit UTxOs in one tx, recreating the Receiver with the higher
     balance. Used for bulk sweeps.
   - **Fold into an update** — the feeder absorbs up to `depositMaxPerUpdateFold` confirmed
     clean deposits into an oracle-update tx it is already submitting, so one tx updates
     the price AND tops up the balance.

**Security (the deposit validator).** The deposit validator is parametrised per client by
the Receiver NFT `(policy_id, asset_name)`, so the deposit address is unique per client. A
deposit may only be spent in a tx that **consumes that client's canonical Receiver and
raises its `balance_lovelace` by at least the total swept** from the address (the
"anti-skim" rule — see `lib/dia_cardano_oracle/deposit_logic.ak`). Consequences: a deposit
can only ever credit *its own* client's balance (it can't be stolen, and a sweep of N
deposits must credit all N); and `Settle`/`Withdraw` can never spend a deposit because
they lower the Receiver's lovelace. The credit runs either as a standalone `TopUp` merge
or as an `AccrueFee` update that absorbs the deposit — both raise `balance_lovelace`.

**Who does what:** the **client** only deposits (plain payment); **DIA/the feeder** credits
the balance (and the daemon does it automatically when a Receiver runs low — see §10). The
CLI verbs are `deposit:address` (print the address to hand to a client), `deposit:fund` (a
plain payment, for testing/operator use), and `deposit:merge` (the standalone sweep).

**Folding deposits into an update (best-effort).** Beyond the standalone merge, the feeder
opportunistically folds up to `depositMaxPerUpdateFold` confirmed clean deposits into the
oracle-update tx it is already submitting, so a single tx both updates the price and tops
up `balance_lovelace`. It is **best-effort**: the feeder tries the combined tx first, and
if that build/sign/submit fails it retries a pure update (at most one fallback), so a
bad or contended deposit never blocks a price update (`runWithFoldFallback` in
`src/lib-bridge/index.ts`). The standalone `deposit:merge` remains for bulk sweeps that
should not wait for an update to ride along.

**Params vs triggers — HOW vs WHEN.** Both forms select clean ADA-only deposits at or
above a dust floor (`depositMinLovelace`). The standalone merge is capped per tx
(`depositMaxPerMerge`); the update-fold uses the smaller `depositMaxPerUpdateFold` so the
absorbed deposits fit within the tx budget alongside a price update. Those three are
**tx-build params**: they are set at the CLI's `protocol:init` and stored in
`config-bootstrap.json::configState`, siblings of `minUtxoLovelace`. Both the CLI and the
daemon read them from that SAME protocol state — the daemon via `readDepositMinLovelace`,
passing the floor to the bridge so the deposit-pending probe counts exactly what the sweep
would. They are **not** feeder-YAML keys. Separately, **when** the daemon auto-merges is
governed by the feeder `infrastructure.<network>.yaml::alerting.*` thresholds
(`receiver_balance_low_lovelace`, `deposit_pending_merge_lovelace`) — timing only, never
tx shape.

**Concurrency — hard exclusion.** The auto-merge is enqueued as a first-class task on the
SAME per-lane submission queue as oracle updates (`enqueueLaneTask`, keyed by `laneKey`).
The lane queue runs one entry at a time, so an update and a merge on the same Receiver are
mutually exclusive **by construction** — they can never spend the Receiver UTxO at once. A
per-lane dedup guard stops the daemon stacking a fresh merge each refresh tick while one is
already queued/running; it is a dedup, not a safety lock (the lane queue is the lock).

---

## 1. What the feeder is (high level)

The feeder is a **single Node.js process** that:

1. Watches DIA's EVM chain (Lasernet) for `IntentRegistered` events.
2. Enriches each event into a full intent (symbol, price, timestamp, nonce).
3. Decides whether that intent is worth an on-chain update.
4. Groups intents per lane/client deployment and writes an oracle-update transaction to Cardano.
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
Result Handler ── writes DB + pair-state files + priceCache + metrics
```

---

## 3. Ingestion: HTTP and WebSocket in parallel

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
relevant to this router?"* — it runs **before** the OR-gate. (Conditions can match any
enriched field, not just symbol; all listed conditions must pass.)

**This is per router, evaluated independently.** Every intent is checked against every
router separately — there is no single global pass/fail. So the same intent can be
**accepted by one router and filtered by another at the same time** (e.g. BTC/USD is in
`client-a-router-majors.yaml` but not `client-a-router-stables.yaml`). Those two routers may point to
different on-chain client deployments, or to the same one. That is why
`intents_filtered_total{reason="condition"}` is counted per `(router_id, symbol)`.

### Stage 2 — the OR-gate (freshness filter) — `reason: "time_threshold" | "price_deviation" | "timestamp_*"`

For a symbol that *is* relevant, two thresholds are evaluated (`src/router/policy.ts`):

- `time_threshold` — minimum time since the last on-chain confirm.
- `price_deviation` — minimum relative price change vs. the last recorded price.

| Configured | Passes if… |
| --- | --- |
| Neither | always |
| Time only | `time_threshold` elapsed |
| Price only | deviation ≥ `price_deviation` |
| **Both** (client-a: `10m` + `0.5%`) | **time OR price** (whichever happens first) |
| No prior cached price | always (first update) |

Before the OR-gate there is a **timestamp monotonicity** check: a smaller timestamp →
suppress (`timestamp_regression`); an equal timestamp → suppress
(`timestamp_duplicate`).

> **One-liner:** *"We push an update when the price moves more than 0.5%, OR when 10
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
  symbols in two situations: a short `coalesce_window` (30s) **only when the lane was
  empty/idle**, and — more importantly — **for free while the previous tx is still
  confirming** (the lane is busy, so intents pile up at no extra latency cost). See the
  state machine below for the exact rule.
- **Queue Manager = the single cashier per Receiver.** It takes the assembled package
  and sends it to Cardano **one at a time**: grabs the Receiver UTxO, builds the tx,
  signs it, submits it, **waits for confirmation**, and only then handles the next
  package for that same Receiver. While a tx is in flight, **nobody else touches that
  UTxO**.

### Why both exist

| | Coalescer | Queue Manager |
| --- | --- | --- |
| **Question it answers** | Which intents are worth it, and how do I group them? | How do I write this on-chain without conflicts? |
| **Problem it solves** | Avoid sending stale prices; send 1 tx instead of 10 | EUTxO: two txs spending the same Receiver UTxO **conflict** → must serialize |
| **Works with** | symbols in memory (a `Map`) | the real on-chain UTxO + signing + confirmation |
| **Output** | a ready batch | a confirmed on-chain tx |

### The core reason: the UTxO lock

In Cardano a transaction **spends** a specific UTxO (the client deployment's Receiver). If you
send two txs at once both trying to spend the **same** UTxO, one fails. So the Queue
Manager keeps **one serial queue per lane** (= per on-chain client deployment/Receiver):
submit → wait for
confirmation → release the lock → submit the next.

A **lane = `client_state_path :: protocol_state_path`**. In on-chain terms, that is one
client deployment and one Receiver UTxO. Parallelism across client deployments comes
from having **multiple lanes** (multiple Receivers), NOT multiple workers within one
lane.

> **One-liner:** *"The coalescer gathers one lane's intents and keeps the freshest
> price per symbol in a single transaction; the queue manager takes that transaction
> and writes it to Cardano one at a time per Receiver, waiting for confirmation before
> the next, because EUTxO does not allow two simultaneous writes against the same
> UTxO."*

### Always build a valid tx (validate against the live on-chain datum)

Before building, the bridge decodes the **live on-chain pair datum** of each Pair UTxO
it is about to spend and validates the intent's `(timestamp, nonce)` against it — the
ground truth, not the local pair-state file (which can drift behind chain). The
`pair_state` validator requires a strictly greater `(timestamp, nonce)`; DIA advances
the per-pair nonce slowly, so a fresh-hash intent can still carry a nonce that does not
beat the on-chain one.

- **Single update:** the builder refuses to assemble a tx that would not beat the chain
  (classified as a benign `NonMonotonicNonce` — a newer update is already on chain — with
  **no tx and no fee**).
- **Batch:** a pair whose intent does not beat its on-chain datum is **dropped from the
  batch** (reported benignly as superseded), so one stale pair never poisons the atomic
  tx and reverts the whole batch. The remaining valid pairs still go out together —
  batching stays the main path. The builder re-asserts the same check as a final guard.

### Where does the client come in? (both stages are per lane)

A common confusion: *which* stage knows the client deployment? **Both do**, and they use
the **exact same key** to partition their work (`src/submitter/lane-key.ts`):

```text
lane = client_state_path :: protocol_state_path   →  one on-chain client deployment (its Receiver UTxO)
```

The destination is attached **upstream**: the router emits each `SubmitRequest` already
carrying the Cardano destination, which points at one client deployment's state files.
So by the time anything reaches the coalescer, every request already knows its lane.
Nothing has to "sort by client" afterward — work is **partitioned by lane**, not
ordered:

- **Coalescer** keeps **one buffer per lane (= per Receiver)**. Inside each buffer it's
  `Map<symbol, newest>`. When a lane flushes, it flushes **that one Receiver's symbols**
  → that's the batch. It **never mixes two lanes in a batch**.
- **Queue Manager** keeps **one serial queue per lane (= per Receiver)**, routing each
  request to its queue by the same key. `submitBatch` even **rejects** a batch whose
  requests don't all share one lane.

So two different on-chain client deployments run on **separate queues → concurrently**;
within one deployment/Receiver, **serial**. Neither stage is "the client-aware one" —
both partition by the same lane. The real difference between them is the *job*
(group/filter vs. write safely), not the client.

One subtle but important consequence, defined up front in the glossary: **router !=
client deployment**. Multiple routers may target the same lane and therefore share one
Receiver/deposit/pair deployment, while still keeping different policy state. The safe
operating shape is: **shared lane, disjoint symbol sets**.

### Batch vs simple update — decided automatically, per lane

There is **no manual "batch mode"**. At flush time the write client looks at **how many
symbols that one lane accumulated during the window**
(`src/submitter/cardano-write-client.ts`):

| Symbols buffered for the lane | What is sent |
| --- | --- |
| **1** | a **simple update** (1 tx, 1 pair) |
| **2–10** | **one batch tx** updating several pairs of the **same Receiver** |
| **>10** (`max_batch_size`) | split into multiple txs |

Calm market → mostly simple updates. A burst across several of a lane's pairs — or
several pairs arriving **while the previous tx was still confirming** — flushes as a
batch. Either way it's always **one Receiver per tx** (one lane, one signer).

### The coalescer state machine

The lane buffer is **not FIFO** — it's a `Map<symbol, newest-intent>`. Three states:
`idle → accumulating → in-flight`.

- **`idle` → first intent arrives → `accumulating`**: starts the `coalesce_window` (30s)
  timer. This wait happens **only here** — when the lane was empty. Whatever lands
  in those 30s flushes together (a wider window gathers more pairs into the first batch).
- **`in-flight` (a tx is confirming) → intents arrive**: they just accumulate
  (supersede per symbol), **no timer**. The lane is already "waiting" on the chain, so
  this costs zero extra latency.
- **tx confirms with a non-empty buffer**: flush **immediately** — no second window.
  This is where most multi-symbol batches come from: everything that piled up while the
  previous tx was confirming goes out in one batch.
- `max_intent_age: 15m` — drops buffered intents that are too old at flush time.

> **One-liner:** *"We only pause for the `coalesce_window` when the lane is idle. Once a
> transaction is in flight, new prices accumulate for free — keeping the newest per
> symbol — and the moment the chain confirms, the whole accumulated batch goes out with
> no extra wait."*

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

> The main dashboard shows **phase 6** (end-to-end, per symbol). Phases 1–5 (the
> per-symbol/intent axis) **are emitted but not dashboarded** — they're in the "metrics
> to add" list (§19).

### Two axes: per symbol vs per transaction

The 6 phases above are the **per-symbol/intent** axis: each price (each symbol) has its
own DIA timestamp and travels its own path. But a Cardano transaction is **atomic and
can batch many pairs** — so "how many pairs landed" (per-symbol) and "how many
transactions we sent" (per-tx) are different questions. The feeder emits a second,
**per-transaction** family so a batch of 5 pairs counts as *one* tx, not five:

| Metric | Axis | Meaning |
| --- | --- | --- |
| `dia_bridge_transactions_total{client_id,customer_id,outcome}` | per tx | Transactions, counted once per tx, by outcome (`confirmed`/`failed`). |
| `dia_bridge_transaction_pairs{client_id,customer_id,outcome}` | per tx | Histogram of pairs-per-tx (batch size). |
| `dia_bridge_transaction_router_membership_total{client_id,customer_id,router_id,outcome}` | per (tx, router) | Which routers contributed at least one member to a tx. This is how mixed-router batches are represented without adding a scalar `router_id` to tx-level counters. |
| `dia_bridge_tx_pair_membership_total{client_id,customer_id,router_id,destination_index,symbol,outcome}` | per (tx, router destination, pair) | Which router/destination/symbol members each tx touched — filter by symbol or router to find the txs that included that member without inflating pure tx counts. |
| `dia_bridge_tx_processing_to_submission_seconds` | per tx | Tx-level stage latency (the per-symbol counterpart is phase 4). |
| `dia_bridge_tx_submission_to_confirmation_seconds` | per tx | Tx-level stage latency (per-symbol counterpart: phase 5). |
| `dia_bridge_tx_end_to_end_seconds` | per tx | Tx-level end-to-end (per-symbol counterpart: phase 6). |

**Counted once per tx.** The result handler fires once per intent, so a batch of N pairs
fires N times with the same tx hash. The first batch member is the stateless
**representative** (`isTransactionRepresentative`) that emits the tx-scoped metrics
exactly once; the membership counter fires for every member.

**No-tx failures excluded.** A condemned/superseded intent the feeder declined to submit
(the build-time monotonicity assertion refuses, or the coalescer pre-filter drops it)
surfaces as a `NonMonotonicNonce` failure with **no tx broadcast and no fee**. These are
correct no-ops, not failed transactions, so `isNoTransactionFailure` excludes them from
the tx-level counts.

The dedicated **`monitoring/grafana/dashboards/feeder-tx.json`** dashboard ("DIA Cardano
Oracle Feeder — Transactions") renders this axis: tx-stage latency (p50/p95/p99),
confirmed-vs-failed throughput, success ratio, and batch-size distribution. The main
dashboard's "Row 2b — Transactions (per tx)" carries a condensed view.

---

## 7. Caches & the price cache

**Principle: persisted state is the source of truth for anything that must
survive a restart.** The in-memory caches are just the fast path. DB tables keep
scanner/tx history; Cardano pair-state files keep the confirmed on-chain pair
snapshot used to warm the hot cache.

| Cache | Holds | Used by | On restart |
| --- | --- | --- | --- |
| **dedup cache** | seen intent hashes (LRU, TTL 1h) | the hot-path dedup check | empty; the checkpoint skips already-scanned blocks |
| **priceCache** | the **last confirmed price** (and `nonce`) per (router, dest, symbol) | the policy gate (OR-gate) + the cron (the `nonce` lets the cron skip resubmits that cannot beat on-chain) | empty; **re-seeded after startup reconcile from `<run>/clients/*/pairs/*.json`** |
| **latestIntentCache** | the **last intent seen** (confirmed or not) | the cron (to know *what* to resubmit) | empty; refills within seconds from live events |

### The price cache, specifically

It's an in-memory (RAM) table of **the last on-chain-confirmed price of each pair**.
Key `(router, dest, symbol)` → last price + timestamp + when it was updated.

Two consumers:

1. **The policy gate.** When a new BTC/USD intent arrives, the gate compares against
   the last confirmed price/time to decide *"did it move >0.5%? has 10m passed?"*. That
   "last" comes from the price cache.
2. **The cron service.** To know whether a pair is stale (last confirmed older than
   `time_threshold`), it reads the age from the price cache.

**Why RAM and not disk every time:** it's the hot path — queried on every intent,
thousands of times. RAM is instant. On restart the daemon first reconciles local
pair-state files with live Cardano UTxOs, then hydrates `priceCache` from those
confirmed pair-state files before cron/alerting can read it.

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
| `transaction_log` | In-flight and confirmed Cardano txs (pending→submitted→confirmed/failed); each row carries the `router_id` / `client_id` / `customer_id` identity of the update |
| `contract_symbol_updates` | Latest confirmed value per `(chain, contract, symbol)`, upserted on confirm. Cardano keying: `chain` = network magic, `contract` = the client's pair validator address, `symbol` = the pair. Stores `last_price`/`last_timestamp`/`last_nonce`/intent hash/tx hash/`update_count`/fee; `last_nonce` rehydrates the cron's nonce baseline on restart |
| `performance_metrics` | Time-series of metrics (feeds `/api/v1/performance`) |
| `alert_log` | Alerts fired / resolved |

### Restart / crash recovery

1. Migrate/validate the 6 tables.
2. **Crash recovery**: txs left `pending`/`submitted` are marked `failed` (we don't
   know if they hit the chain). No double-apply: the contract rejects with
   `NonMonotonicNonce` if it was already on-chain.
3. Read the **checkpoint** from `chain_state` and resume scanning from there (old
   blocks are not re-processed).
4. Reconcile Cardano pair-state files against live UTxOs.
5. Hydrate `priceCache`, last-confirmed metrics, and readiness state from the
   reconciled `<run>/clients/*/pairs/*.json` files.
6. Start cron/alerting only after that warm-up, so a restart does not emit false
   `skipped_uninitialised` decisions.

**Operator lifecycle (Docker).** The steps above are the daemon's *warm* restart
(same persisted state). Operators drive the lifecycle via the Makefile, and the
**image bakes the compiled binary** — so a source change needs a rebuild:

- `make restart` — warm restart, no data change.
- `make reset-restart` — wipe runtime state (DB/logs/pairs) + reseed checkpoint + start. For **config-only** (YAML) changes; no rebuild.
- `make fresh` — **rebuild the image** (so source changes take effect), then wipe the Prometheus/Grafana volumes + DB/logs/pairs, reseed, start. The command to use after **code** changes.
- `make down VOLUMES=1` — stop and also delete the Prometheus + Grafana named volumes (fresh metrics).

The on-chain deploy (`<run>/config-bootstrap.json`, `<run>/clients/<id>.json`) is a
bind-mounted artifact and is **never** touched by any of these — only the feeder's
own runtime state and the monitoring volumes are. See
[`offchain/feeder/README.md`](../../offchain/feeder/README.md) for the full command reference.

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
   the same coalescer path** as the event-driven flow.
4. If the last intent equals what's already on-chain → skip (`skipped_already_fresh`);
   the contract would reject it with `NonMonotonicNonce`.
5. If the last intent's `nonce` does **not** exceed the last confirmed nonce → skip
   (`skipped_superseded`): the `pair_state` validator requires a strictly greater
   `(timestamp, nonce)`, so the resubmission would be rejected on chain. DIA advances the
   per-pair nonce slowly, so this is common — skipping it here avoids a wasted pipeline
   pass and fee (the build-time on-chain datum check is the final guard).

**Heartbeat timing — per-pair vs aligned (`cron_service.aligned_heartbeat`).** Step 2's
"fresher than `time_threshold`" check runs in one of two modes:

- **per-pair (default):** a pair is due once *its own* last confirm is older than
  `time_threshold`. Each pair's timer drifts independently, so any single 30s tick finds
  only the handful of pairs that just crossed — they go out as small, staggered txs
  (≈ 1 pair/tx in practice).
- **aligned (`aligned_heartbeat: true`):** a pair is due once the shared wall-clock
  boundary `floor(now / time_threshold) * time_threshold` is newer than its last confirm.
  All pairs cross the boundary in the **same** tick, so they reach the coalescer together
  and flush as **one batch every `time_threshold`** — far fewer, fuller txs and a lower
  fee per pair. Max staleness is unchanged (≈ `time_threshold`); the deviation arm still
  pushes a volatile pair immediately between boundaries, and that pair rejoins the batch
  at the next boundary. Only applies when `time_threshold > 0`; in deviation-only mode
  the `max_staleness` backstop stays per-pair.

For the full knob matrix and the per-pair-vs-aligned timeline, see
[push-policy config](../audit/20260609-feeder-push-policy-config.md#heartbeat-timing-per-pair-vs-aligned).

> The cron service is globally enabled (`cron_service.enabled`) and **opt-in per
> destination** via `cron: true` in the router YAML. `client-a` sets `cron: true`, so its
> pairs get the liveness heartbeat; a destination without it updates only on events.

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

The **build** step that precedes submission (lucid's `.complete()`) has its own
resilience story — it intermittently throws a transient WASM error that the feeder
recovers from across three layers without ever risking a double-submit. See §20.

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
| `database` | local sqlite (run-scoped `<run>/feeder.sqlite`); postgres supported for prod |
| `source` | the EVM chain it scans: `chain_id 10050`, RPC + WS, `start_block` |
| `block_scanner` | HTTP poller knobs (10s, 500 blocks, 6 confirmations, backfill 5000) |
| `event_processor` | `dedup_cache_ttl 1h`, `coalesce_window 30s`, `max_batch_size 10`, `max_intent_age 15m`, **`enable_parallel_mode: false`** |
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

### Spectra parity and Cardano divergences (full table)

This is the canonical disposition register — which Spectra config keys, metrics, and
behaviours are matched 1:1 versus adapted or extended for Cardano. The feeder is
intentionally close to
[`diadata-org/Spectra-interoperability/services/bridge`](https://github.com/diadata-org/Spectra-interoperability/tree/main/services/bridge):
same modular YAML config layout, same scanner → enricher → router → write-client
pipeline, same HTTP API surface, same `dia_bridge_*` metric prefix. Most code-path
behaviours map 1:1; the Cardano-destination side diverges where the EUTxO model forces
it and where Spectra config fields are dead (declared but never read in Spectra itself).

| Concept | Spectra | This feeder | Why |
| --- | --- | --- | --- |
| Worker pool (`worker_pool.max_workers`, `task_queue_size`, `task_timeout`) | Per-router pool with N concurrent submission workers. | **Wired** via `UpdateWorkerPoolManager`: each router gets its own pool with `max_workers` workers and a `task_queue_size`-deep queue. The workers do **not** submit to Cardano directly — they drain into the shared coalescer, which serialises submissions per lane = `(client_state_path, protocol_state_path)`. So the pool raises ingest throughput from the daemon's event loop without ever breaking lane safety, and a saturated router cannot starve the others. Cross-lane parallelism still comes from multiple clients (different Receivers). | Cardano's EUTxO model serialises spends of the same Receiver UTxO, so on-chain writes stay serial per lane even though the pool itself is concurrent. |
| In-flight lock timeout (`worker_pool.inflight_timeout_ms`) | Not present. | **Required**. Cardano-specific because the lane lock is held while a tx is in-flight. Default 15 min. | Reflects the wall-clock ceiling on Cardano submit+confirm. |
| Parallel event processor (`event_processor.enable_parallel_mode`, `parallel_*`) | Active — parallel enrichment + gas-est pipeline. | **Active** — wired in parallel mode when `enable_parallel_mode: true`. Sequential (default) when the key is absent or false. | Sequential mode is sufficient for current throughput; parallel mode is available for high-volume deployments. |
| Block scanner gap recovery (`block_scanner.backward_sync`, `max_block_gap`, `head_tracker_interval`, `gap_detection_interval`) | Active — backfill in 5000-block chunks when the gap exceeds `max_block_gap`. | **Active**: when `backward_sync: true`, the scanner switches to 5000-block chunks (vs `block_range` default 500) and skips `scan_interval` between chunks until caught up. Emits `dia_bridge_scanner_backfill_*` counters. | Chain-agnostic; reuses Spectra's design. |
| Cron service (`cron_service.*` + per-destination `cron: true`) | Active — per-router cron timer re-pushes the latest cached intent when `time_threshold` elapsed. | **Active**: ticks every `cron_service.tick_interval`, re-submits via the same coalescer path as the event-driven flow. Outcome partitioned in `dia_bridge_cron_resubmissions_total{outcome}`. | Ensures uptime and accuracy guarantees when the deviation filter suppresses every incoming event during low-volatility windows. |
| `health_check.max_processing_lag` | Declared but never read in Spectra. | **Active** — drives the `registry` check in `/health/ready`. | Cardano-feeder extension. |
| `health_check.timeout`, `max_queue_size`, `recovery.*`, `event_processor.batch_size`, `validation_timeout` | Declared but never read in Spectra. | **Removed** from our types + YAMLs (cruft in both repos). | Reduces operator confusion. |
| `replica.*` | Active — HA failover monitor. | **Typed, not yet wired** — fields parse cleanly from YAML; failover logic is reserved for a future implementation. | Operational HA requires multi-instance coordination not yet implemented. |
| `cardano.confirmation_depth` | N/A. | **Active** — feeder waits `(depth - 1) × 20 s` past inclusion and re-verifies the tx is still on chain. Reflected in `/api/v1/prices` `confirmedAtDepth`. | Cardano-specific (Ouroboros Praos finality model). |
| `alerting.*` block | N/A. | **Active** — canonical thresholds for both feeder warnings and Prometheus alert rules. | Centralises operational thresholds. |

Porting a deployment FROM Spectra to this feeder:

- Drop `event_processor.{batch_size, validation_timeout}`,
  `health_check.{timeout, max_queue_size}`, and the `recovery` block — silently ignored.
- Keep `worker_pool.{max_workers, task_queue_size, task_timeout}` — read and wired here
  (per-router update pools draining into the serial per-lane coalescer).
- Add `cardano.confirmation_depth`, the `alerting:` block, and
  `worker_pool.inflight_timeout_ms` — all required by our validator.
- Per Cardano destination, optionally add `cron: true` + `time_threshold: 5m` to opt
  into cron-driven liveness.

---

## 16. HTTP API

Server on `0.0.0.0:8080`. **No authentication**, rate-limited 60 req/min per IP, CORS
off by default. The route table is described by an auto-generated OpenAPI 3.0 document
(`GET /api/v1/openapi.json`, rendered at `GET /docs`) built from the TypeBox schemas in
`src/api/routes.ts`.

| Endpoint | Returns |
| --- | --- |
| `GET /health`, `/health/ready` | liveness / readiness |
| `GET /metrics` | **Prometheus, ~50 metrics** (feeds Grafana) |
| `GET /api/v1/prices` | last confirmed prices per symbol; each entry carries `routerId` + the resolved `customerId` / `clientId` / `network` |
| `GET /api/v1/status` | health snapshot (uptime, network, scanner, db) |
| `GET /api/v1/transactions` | Cardano tx history with status |
| `GET /api/v1/transactions/{txHash}` | one tx's members; tx-level `network` / `clientId` / `customerId` + `routerIds` (a batch can mix routers on the shared lane), and per-member `routerId` / `clientId` / `customerId` |
| `GET /api/v1/alerts?active=true` | active alerts |
| `GET /api/v1/events` | processed `IntentRegistered` events |
| `GET /api/v1/pools` | worker-pool stats |
| `GET /api/v1/openapi.json`, `/docs` | generated OpenAPI document |

Every routed update resolves once to a **runtime identity** (`network`, `customerId`,
`clientId`, `routerId`, `destinationIndex`, `laneKey` — `src/runtime/identity.ts`) that
is carried through cron, queue, submission, result handling, metrics, logs, the
`transaction_log` rows, and these API responses, so no stage re-derives the client from a
path or the customer from a side map.

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
   receiver at a time (~30s–2min). Scale with more client deployments/receivers, not
   more workers per lane.
3. **Sequential processing** (parallel mode off). A ceiling, not a current problem (§12).
4. **Gap-detection/head-tracker run inline**, not as dedicated loops (M3).
5. **API has no auth** (rate-limited only). Don't expose it publicly as-is.
6. **`confirmation_depth: 1`** — practically final, but a Cardano rollback is
   theoretically possible (low risk; raise the depth to harden — §11).
7. **In-memory caches lost on restart** — rebuilt from reconciled pair-state files
   before cron starts, but the latest-intent cache still refills from live DIA events.

---

## 19. Metrics that exist but are NOT in Grafana

The feeder exposes ~55 `dia_bridge_*` metrics at `/metrics`, across **two** dashboards:
`monitoring/grafana/dashboards/feeder.json` (operational overview) and
`feeder-tx.json` (the per-transaction axis — see §6). Below is what neither shows yet —
split into **metrics with real data** (worth adding) and **metrics defined but with no
emitter yet** (do NOT add: they'd read 0/empty).

### Already in Grafana (reference)

`transactions_confirmed_total`, `transactions_failed_total`, `transactions_reorg_total`,
`intents_filtered_total`, `end_to_end_latency_seconds` (phase 6),
`price_deviation_percent`, `price_age_seconds`, `scanner_block_lag`,
`cardano_receiver_balance_lovelace`, `cardano_receiver_accrued_lovelace`,
`cardano_payment_hook_accrued_lovelace`, `cardano_admin_wallet_lovelace`,
`cardano_oracle_last_confirmed_timestamp_seconds`, `transaction_fee_lovelace`.
Per-transaction axis (`feeder-tx.json`): `transactions_total`, `transaction_pairs`,
`tx_pair_membership_total`, `tx_processing_to_submission_seconds`,
`tx_submission_to_confirmation_seconds`, `tx_end_to_end_seconds`.

### A — Missing, with real data (candidates to add)

**Event/intent funnel** (how many enter vs. survive each stage):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_events_detected_total{scanner_type}` | Raw events detected by the scanner, **before** dedup. Inbound chain traffic, per path (http/ws). |
| `dia_bridge_events_duplicate_total` | Events dropped by the dedup cache (arrived on both HTTP and WS, or re-scan after reconnect). |
| `dia_bridge_events_invalid_total{reason}` | Events rejected at decode/enrich time (malformed, `getIntent` failed). |
| `dia_bridge_intents_scanned_total{symbol,scanner_type}` | Enriched intents **entering** the routing pipeline. |
| `dia_bridge_intents_routed_total{symbol,router_id}` | Intents **accepted** by a destination (passed trigger conditions). |
| `dia_bridge_transactions_submitted_total{symbol,client_id,customer_id}` | Submission attempts **broadcast** to Cardano (the denominator for success rate, with confirmed/failed). |

**Latency breakdown (phases 1–5)** — today only phase 6 (end-to-end) is shown. These
show **WHERE** latency lives:

| Metric | What it measures |
| --- | --- |
| `dia_bridge_intent_to_registration_seconds{symbol}` | **Phase 1**: price created → registered on-chain (EVM). DIA/EVM side. |
| `dia_bridge_registration_to_scan_seconds{symbol}` | **Phase 2**: registered → scanner delivers it. Transport + polling. |
| `dia_bridge_scan_to_processing_seconds{symbol}` | **Phase 3**: delivered → processing starts. Internal backlog. |
| `dia_bridge_processing_to_submission_seconds{symbol,client_id,customer_id}` | **Phase 4**: processing → submitted to Cardano. enrich + route + coalesce time. |
| `dia_bridge_submission_to_confirmation_seconds{symbol,client_id,customer_id}` | **Phase 5**: submitted → confirmed. Pure Cardano-chain latency. |

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
| `dia_bridge_transaction_fee_lovelace{symbol,client_id,customer_id}` | Histogram of lovelace paid **per oracle-update tx** (the Cardano equivalent of EVM gas). Key for cost tracking. |
| `dia_bridge_cardano_receiver_topup_warnings_total{client_id}` | How many times the receiver balance was below threshold after a confirmed tx. |
| `dia_bridge_cardano_pair_is_create{symbol,client_id,customer_id}` | Whether the last submission **minted** the pair (1) or **updated** it (0). |

**Cron service** (today none shown):

| Metric | What it measures |
| --- | --- |
| `dia_bridge_cron_resubmissions_total{router_id,symbol,client_id,outcome}` | Cron decisions by outcome: `submitted`, `skipped_already_fresh`, `skipped_superseded`, `skipped_no_intent`, `skipped_uninitialised`. Shows whether the cron is working and why it skips. |

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
(`bridge_intents_*`) plus a `customer_id` label. Useful if DIA compares dashboards
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

---

## 20. lucid WASM build resilience (submission/finality hardening)

Every Cardano tx the feeder (and the CLI) submits is assembled by
`@lucid-evolution/lucid` and finalised by `.complete()`, which runs inside a CML
WASM module. That `.complete()` step is the one place in the submission path with a
known transient failure mode, and the feeder hardens it in three layers — none of
which can cause a double-submit.

### Root cause

`@lucid-evolution/lucid ^0.4.29` (with CML WASM 6.0.2-3) intermittently throws, from
inside `.complete()`:

```text
TypeError: Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer
```

This is the classic WASM `memory.grow` → detached-ArrayBuffer pattern: lucid holds a
JS `TypedArray` view onto the WASM linear memory; when the build grows that linear
memory mid-`.complete()`, the old `ArrayBuffer` is detached and the held view is
invalidated, so the next `.set(...)` throws. **The build inputs are valid** — the
identical build, retried, succeeds. It is non-deterministic: a full Preview run hit it
at `payment-hook:withdraw` immediately after the byte-identical `receiver:withdraw`
builder had completed cleanly.

There is a second, harder failure form — a **WASM trap**:

```text
{ Complete: RuntimeError: unreachable }
```

Unlike the detached-ArrayBuffer blip, a trap can **poison the WASM module for the rest
of the process**: every subsequent `.complete()` in that process keeps failing while a
**fresh process** builds the identical tx fine. A live Preview run proved both halves of
that: the long-running daemon kept trapping for ~13 h while the CLI (a fresh process)
built the same tx on the first try. The daemon only recovered on restart. Both
signatures — `detached`/`%TypedArray%` and `unreachable` — are therefore treated as
"only a fresh process clears this" by the self-exit guard (Layer 3).

### Why we did NOT upgrade lucid

We investigated the obvious "just bump the dependency" route and rejected it:

- **0.4.30–0.4.34** keep the **same** CML WASM (6.0.2-3) → no fix.
- **0.5.2** bumps CML to 6.2.0-1, but **0.5.0 is a breaking release** (pluggable
  evaluator), and the detach fix in that line is undocumented/unconfirmed.

Migrating across a breaking major for an *uncertain* fix is not worth it, so we
mitigate **without changing lucid or the WASM** — the mitigation is entirely on our
side of the boundary.

### The three mitigation layers

Each layer targets a different process lifetime. The key safety rule throughout: a
retry only ever re-runs the **build**, never a submit, so a transient build failure
can never produce two on-chain txs.

**Layer 1 — `completeWithRetry` (in-process build rebuild).**
`offchain/cli/src/core/tx-build.ts`. Wraps `.complete()`. On the WASM signature **only**
(`detached ArrayBuffer` / `%TypedArray%` / `detached`) it REBUILDS a **fresh** tx from
the supplied build factory and re-`.complete()`s it; any non-WASM error (validation,
fee, balancing, "amount exceeds…") rethrows immediately so real failures are never
masked. It rebuilds — it does **not** re-`.complete()` the stale builder — because
lucid's `TxBuilder` is stateful and `.complete()` is not idempotent: re-completing the
same builder DUPLICATES the outputs and produces a corrupt tx (a live Preview run hit
exactly this — a tx with both outputs twice, rejected by the node with a deserialise
size mismatch). The retry happens entirely **before** submit, so there is no
double-submit. This wrapper is in the shared CLI library used by all tx builders,
**including the feeder** via the `lib-bridge` builders, so the feeder's update/merge
builds inherit it for free. Env: `TX_BUILD_ATTEMPTS` (default 3),
`TX_BUILD_RETRY_DELAY_MS` (default 300 ms).

**Layer 2 — CLI runbook fresh-process retry (`run-all-cli.sh`).**
A long CLI sequence runs each step as its own process. If a step fails **before
submitting** — detected by the absence of `Submitted transaction hash` in that step's
log — it is re-run in a **fresh process** (hence a fresh WASM module) up to
`TX_STEP_BUILD_RETRIES` (default 2). A step whose log shows it **already submitted** is
**never** blindly retried — that is the double-submit guard at the runbook layer.

**Layer 3 — feeder daemon self-exit + supervisor (`WASM_FATAL_CONSECUTIVE_FAILURES`).**
The daemon is long-running, so it holds **one** WASM module for its entire life.
Re-creating a `Lucid` object inside the process does **not** re-initialise the WASM
(the module is a per-process singleton) — only a **fresh process** gets a fresh WASM
module. So the daemon layers on top of Layer 1:

1. Layer 1 rebuilds in-process.
2. The submission worker pool retries the lane task (`worker_pool.max_retries`).
3. If a WASM-signature build failure still persists *after* the pool retries are
   exhausted, the daemon counts it as a **consecutive** WASM failure (the counter
   resets to 0 on any successful submission — see `src/submitter/wasm-failure-guard.ts`,
   kept pure for unit testing). The classifier (`isProcessRecoverableWasmError`) matches
   **both** signatures — the detached-ArrayBuffer family **and** the `unreachable` trap —
   precisely because both only clear on a fresh process. (This is the fix for the ~13 h
   outage: the classifier previously matched only `detached`, so an `unreachable` trap
   storm never incremented the counter and the self-exit never fired.) A *non*-WASM
   failure — e.g. `NonMonotonicNonce`, or a collateral-exhaustion build error that
   auto-consolidate resolves — leaves the streak unchanged, so the daemon never restarts
   for a condition a restart cannot fix. Once the count reaches
   `WASM_FATAL_CONSECUTIVE_FAILURES` (default **5**), the daemon logs FATAL and calls
   `process.exit(WASM_FATAL_EXIT_CODE)` — exit code **17**, distinct so a supervisor can
   recognise it.

A **supervisor** then restarts the process with a fresh WASM module, and state resumes
from persisted DB + pair-state files (§7–§8): Docker Compose uses
`restart: unless-stopped`; bare-metal/npm uses `feeder:supervised`
(`scripts/run-feeder-supervised.sh`, a restart-loop with backoff). The defaults live in
`src/config/constants.ts` (`DEFAULT_WASM_FATAL_CONSECUTIVE_FAILURES`,
`WASM_FATAL_EXIT_CODE`); `WASM_FATAL_CONSECUTIVE_FAILURES` is the env override.

> **One-liner:** *"lucid's WASM occasionally throws a transient detached-ArrayBuffer
> error while building a tx. We retry the build in-process (rebuilding, never
> re-completing); the CLI re-runs a pre-submit step in a fresh process; and the
> long-running feeder self-exits after 5 consecutive WASM build failures so a
> supervisor hands it a fresh WASM module — all without ever re-submitting an
> already-submitted tx."*

---

## Fee loop & automatic maintenance (settle / withdraw / consolidate)

The admin/signer wallet signs **every** Cardano tx the feeder submits and pays its
network fee + collateral, so it drains over time. It is refilled by collecting the
protocol's own revenue — there is no faucet in the loop:

```
client prepays ─→ [Receiver UTxO]  (balance)
   each UPDATE deducts a service fee → accumulates as `accrued` inside the Receiver
   + the admin wallet pays the Cardano network fee and provides collateral
        │
  settle ────────┘ drains Receiver.accrued ─→ [PaymentHook]  (revenue contract)
                                                   │
  payment-hook:withdraw ───────────────────────────┘ pays withdraw_address
                                                   = the ADMIN WALLET
```

Run by hand, this loop is forgettable, and two failure shapes stall the feeder:

- **Wallet empties** — never settled/withdrawn, so network fees bleed it dry.
- **Wallet fragments** — change accrues into many sub-collateral UTxOs. A script tx
  needs a collateral UTxO **distinct from its fee inputs**; once every UTxO is below
  the collateral need the builder traps (`RuntimeError: unreachable`) even though the
  **total** balance still looks healthy. (This caused a ~13 h Preview outage.)

The daemon therefore runs the loop **itself**, on the balance-refresh tick (the cron
cadence, `cron_service.tick_interval`), off the same `snapshotBalances` probe that feeds
the gauges. Each step is a pure decision (`src/submitter/auto-remediation.ts`,
unit-tested) + a dedup guard + a fire-and-forget **lane task** dispatched on the SAME
serial per-lane queue the oracle updates use — so an automatic step and an update on the
same Receiver are **mutually exclusive by construction**, never racing.

| Automatic step | Fires when | Action | Threshold key |
|---|---|---|---|
| **auto-merge** | pending side-deposits ≥ floor, or Receiver balance low | fold deposits into the Receiver (`deposit:merge`) | `deposit_pending_merge_lovelace` (+ `receiver_balance_low_lovelace`) |
| **auto-settle** | Receiver `accrued` ≥ threshold | drain accrued → PaymentHook (`settle`) | `auto_settle_lovelace` |
| **auto-withdraw** | PaymentHook `accrued` ≥ threshold | PaymentHook → admin wallet (`payment-hook:withdraw`), refilling the wallet | `auto_withdraw_lovelace` |
| **auto-consolidate** | largest pure-ADA wallet UTxO < threshold | fold dust into a dedicated collateral UTxO + working balance (`wallet:consolidate`) | `auto_consolidate_below_lovelace` |

**Ordering invariant — alert first, automatic after.** Every `auto_*` threshold sits
**beyond** its paired alert so the operator-facing alert fires *first* and the automatic
step only follows if the condition keeps developing. For accruals (settle/withdraw) that
means the auto value is **greater** than the alert; for the shrinking collateral floor it
is **smaller**. The `threshold-drift` test fails the build if any pairing is violated, so
an automatic step can never silently pre-empt its alert. Each `auto_*` key is **optional**:
left unset, that automatic step is disabled (never defaulted).

**Self-heal vs. prevention.** Auto-consolidate is *prevention* — it keeps a
collateral-capable UTxO so the wallet never collapses. The WASM self-exit (§20) is
*recovery* — if a hard trap poisons the in-process WASM module anyway, the daemon exits
17 and the supervisor hands it a fresh process. Together they mean a wedged feeder neither
happens (prevention) nor needs a human restart (recovery).

## Alerts & automatic remediation — at a glance

Every operational threshold lives in **one** place —
`infrastructure.<network>.yaml::alerting.*` — mirrored into `monitoring/alerts.yml`
(Prometheus) and the Grafana panels, with the `threshold-drift` test failing the build on
any divergence. Preview and Mainnet carry **identical values** (the alerts/dashboard are
network-agnostic). Current values:

| Key | Value | Drives | Severity / effect |
|---|---|---|---|
| `receiver_balance_low_lovelace` | 2 ADA | **ReceiverBalanceLow** alert (+ auto-merge arm) | warning — top up the Receiver |
| `settle_overdue_lovelace` | 10 ADA | **SettleOverdue** alert | warning — settle is due |
| `auto_settle_lovelace` | 30 ADA | **auto-settle** (daemon) | acts: drain accrued → PaymentHook |
| `payment_hook_withdraw_ready_lovelace` | 50 ADA | **PaymentHookWithdrawReady** alert | info — withdraw is available |
| `auto_withdraw_lovelace` | 100 ADA | **auto-withdraw** (daemon) | acts: PaymentHook → admin wallet |
| `admin_wallet_low_lovelace` | 5 ADA | **AdminWalletLow** alert (total balance) | critical — wallet near empty |
| `admin_wallet_min_collateral_lovelace` | 10 ADA | **AdminWalletFragmented** alert (largest UTxO) | critical — no collateral-capable UTxO |
| `auto_consolidate_below_lovelace` | 7 ADA | **auto-consolidate** (daemon) | acts: defragment + rebuild collateral UTxO |
| `deposit_pending_merge_lovelace` | 5 ADA | **ReceiverDepositsPending** alert + auto-merge | info — deposits awaiting merge |
| `oracle_pair_stale_seconds` | 3600 s | **OraclePairStale** alert | warning — no confirm in 1 h |
| `price_deviation_high_percent` | 5 % | **PriceDeviationHigh** alert | critical — possible misreport |
| `price_age_high_seconds` | 600 s | **PriceAgeHigh** alert | warning — DIA source stale |
| `reorg_rate_high_per_hour` | 3 | **ReorgRateHigh** alert | warning — chain provider lagging |
| `provider_primary_unhealthy_seconds` | 600 s | **PrimaryProviderDown** alert | critical — build/submit provider down → everything freezes |
| `provider_secondary_unhealthy_seconds` | 900 s | **SecondaryProviderDown** alert | warning — confirmation/reorg redundancy lost |

Read each automatic step against the alert directly above/below it: the **alert fires
first**, the **automatic step follows** only if the condition keeps developing
(accruals grow past the higher `auto_*`; the largest UTxO shrinks past the lower
`auto_consolidate_below`). Backing gauges: `dia_bridge_cardano_receiver_balance_lovelace`,
`..._receiver_accrued_lovelace`, `..._payment_hook_accrued_lovelace`,
`..._admin_wallet_lovelace` (total) and `..._admin_wallet_max_utxo_lovelace` (largest
pure-ADA UTxO — the fragmentation signal), `..._deposit_pending_lovelace`.

### Cardano API provider health (primary vs secondary)

The feeder reaches Cardano through **two** API providers with different roles, selected by
`CARDANO_PROVIDER`:

- **Primary** — the provider lucid uses to fetch protocol parameters, read UTxOs, build,
  sign, and submit. If it is down, **nothing can be built** and every pair freezes
  together — this is the single point of failure behind the classic Blockfrost
  `402 Payment Required` (quota) outage. Measured **passively** from the calls the
  balance-refresh tick already makes (no extra provider load) → **PrimaryProviderDown**
  (critical) once it goes `provider_primary_unhealthy_seconds` without a success.
- **Secondary** — the redundancy provider used for tx confirmation and reorg checks.
  Losing it degrades redundancy but not core operation. It is only called on demand, so
  passive tracking cannot tell "idle" from "down"; it is **probed actively** with one
  cheap read per tick → **SecondaryProviderDown** (warning).

Both roles emit `dia_bridge_component_health{component,role}` (1/0) and
`dia_bridge_provider_last_ok_timestamp_seconds{provider,role}` (the alert signal:
`time() - last_ok > threshold`). Because the **role** is derived from `CARDANO_PROVIDER`,
the critical alert always tracks whichever provider actually builds — swap the env and the
roles, alerts, and the "Cardano provider health" Grafana panel follow. The primary's health
also gates `/health/ready` (component `cardano_provider`).

> **Not a transaction failure.** A `NonMonotonicNonce` result means a newer intent already
> won on chain, so the feeder declines to submit — **no tx, no fee**. These are counted in
> `dia_bridge_intents_superseded_total{reason}` and logged at info level as `intent
> superseded (no tx)`; they are kept out of `transactions_failed_total` and the
> `TRANSACTION FAILED` log so the failure counters reflect only real failures.

## Where to find everything (documentation map)

The feeder is one part of a larger repository. Every document worth reading, grouped by
purpose, so it is clear where to look.

### Start here — understand the system

- [`README.md`](../../README.md) (repo root) — repository entry point: scope,
  prerequisites, quick start, and pointers to every component.
- [`docs/architecture/cardano-oracle-architecture.md`](./cardano-oracle-architecture.md)
  — the formal, canonical architecture spec: the on-chain contracts, compile-time
  parameters, UTxO model, datums, every transaction shape (with diagrams), the fee flow,
  and the feeder's DB/API/metrics. **This `feeder.md` is the plain-language companion to
  it** — read this first, that one for the rigorous detail.
- **This document** — the narrative feeder walkthrough.

### Operator manuals — how to run it

- [`offchain/feeder/README.md`](../../offchain/feeder/README.md) — the feeder operator
  manual: Docker & npm workflows, all `make` targets and flags, log streams,
  env/secrets, the 6-table DB schema, config knobs, the full HTTP API reference, the
  finality/reorg model, and the alert map — it points back to this guide for the
  architecture and the Spectra-parity table (§15).
- [`offchain/cli/README.md`](../../offchain/cli/README.md) — the CLI runbook: the full
  numbered sequence to deploy the protocol, onboard a client, publish reference scripts,
  run updates, settle fees, and reclaim — for Preview and Mainnet.
- [`offchain/feeder/scripts/README.md`](../../offchain/feeder/scripts/README.md) — the
  evidence-pack tooling (`make evidence`) and the on-chain pair-scan helper.

### Developer reference

- [`contracts/aiken/README.md`](../../contracts/aiken/README.md) — map of the on-chain
  Aiken validators (the contracts, design highlights, build/bench commands).
- [`offchain/state/README.md`](../../offchain/state/README.md) — the generated
  state-artifact tree (what each field in the bootstrap/client JSON files means).

### Requirements & scope (the contract)

- [`docs/requirements/cardano-integration-requirement-pf.md`](../requirements/cardano-integration-requirement-pf.md)
  — the DIA PRD: the EVM reference contracts and required behaviour the feeder was built
  against.
- [`docs/milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)
  — the Catalyst milestone definitions (M1–M4): outputs, acceptance criteria, evidence.

### Evidence — proof it works

- [`docs/milestones/evidence/m2-preview-20260609-132545/milestone-2-preview-evidence.md`](../milestones/evidence/m2-preview-20260609-132545/milestone-2-preview-evidence.md)
  — the **auto-generated M2 evidence report**: per-pair confirmed-tx counts, sample tx
  hashes, end-to-end latency, failures by error code, embedded Grafana dashboard/panel
  PNGs, and the alerts active at capture time. Regenerate any time with `make evidence`
  (see §17).
- Earlier M1 packs live under
  [`docs/milestones/evidence/`](../milestones/evidence/) — dated, per network.

### Security & audits

- [`docs/security/security-notes.md`](../security/security-notes.md) — the trust
  model and in-scope security properties.
- [`docs/audit/`](../audit/) — the security and fee/efficiency audit reports.

### Planning (internal)

- [`docs/plans/milestone-feeder-plan.md`](../plans/milestone-feeder-plan.md) and
  [`docs/plans/work-plan.md`](../plans/work-plan.md) — the live delivery plans.

---

## Open questions & constraints to verify

Not blockers — items to confirm with the data owner or measure during real use.

- **Throughput headroom under load.** DIA emits intents frequently; the bottleneck is
  **Cardano confirmation** (one tx per receiver at a time, ~30 s–2 min), not the feeder's
  enrichment. The open item is whether the per-lane submission rate keeps every pair
  within its freshness target at peak emission — and, if not, whether to scale out with
  more client deployments/receivers/lanes rather than rely on parallel enrichment. Best
  measured once live volumes are known.
- **Rollback tolerance.** The feeder runs at `confirmation_depth: 1` — a tx is treated as
  final as soon as it lands in a block (practically final for an oracle, lowest latency).
  To verify: is depth 1 acceptable, or should it wait extra Cardano blocks to ride out
  short rollbacks, at some latency cost? (See §11.)
