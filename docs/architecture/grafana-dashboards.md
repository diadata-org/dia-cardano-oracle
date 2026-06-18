# DIA Cardano Oracle — Grafana dashboards guide

The maintained reference for the three Grafana dashboards the feeder ships. For
every chart it answers **what it shows · how to read it · when to worry**, explains
**how the filter bar works**, and gives a one-page **when-to-panic** cheat sheet.

This is the living companion to:

- the **operator manual** — [`offchain/feeder/README.md`](../../offchain/feeder/README.md)
  (§ Thresholds and alerts, § Service URLs, § HTTP API);
- the **feeder architecture** — [`feeder.md`](./feeder.md) (the metric catalog, § 19);
- the **dashboards themselves** —
  [`offchain/feeder/monitoring/grafana/dashboards/`](../../offchain/feeder/monitoring/grafana/dashboards/).

Every panel also carries its own inline `description` in the dashboard JSON (rendered
under the panel in Grafana and into the evidence pack). Thresholds quoted here are the
canonical values from `infrastructure.<network>.yaml::alerting`, enforced by the
`threshold-drift` test. Dashboard PNGs are produced by `make evidence3` (the Grafana
renderer); this guide describes meaning, not a frozen snapshot.

## Contents

- [1. The three dashboards at a glance](#1-the-three-dashboards-at-a-glance)
- [2. How to open them](#2-how-to-open-them)
- [3. How the filters work (read this first)](#3-how-the-filters-work-read-this-first)
  - [3.1 The filter cascade](#31-the-filter-cascade)
  - [3.2 The same symbol on more than one client](#32-the-same-symbol-on-more-than-one-client)
- [4. Dashboard 1 — Overview (`dia-cardano-feeder`)](#4-dashboard-1--overview-dia-cardano-feeder)
- [5. Dashboard 2 — Transactions (`dia-cardano-feeder-tx`)](#5-dashboard-2--transactions-dia-cardano-feeder-tx)
- [6. Dashboard 3 — Internals (`dia-cardano-feeder-internals`)](#6-dashboard-3--internals-dia-cardano-feeder-internals)
- [7. How alerts surface visually](#7-how-alerts-surface-visually)
- [8. When to panic — one-page cheat sheet](#8-when-to-panic--one-page-cheat-sheet)
- [9. Concepts the charts assume](#9-concepts-the-charts-assume)

## 1. The three dashboards at a glance

| Dashboard | UID | Counts in units of | Answers |
| --- | --- | --- | --- |
| **Overview** | `dia-cardano-feeder` | **symbol updates** (+ money / health) | "Is each price feed alive, fresh, accurate and funded?" |
| **Transactions** | `dia-cardano-feeder-tx` | **transactions** | "How are the Cardano transactions themselves performing?" |
| **Internals** | `dia-cardano-feeder-internals` | feeder internals | "Where is time/work going inside the feeder, and where do intents drop off?" |

**Why different units?** The feeder batches: one Cardano transaction can carry **N
price pairs**. So a tx that updates 5 pairs is **5 symbol updates** on Overview and
**1 transaction** on the Transactions dashboard. A count that looks bigger on one
dashboard than the other is the batch factor, not a bug.

## 2. How to open them

The monitoring stack runs under Docker (`make up MONITORING=1`).

| What | URL | Login |
| --- | --- | --- |
| Grafana | <http://localhost:3000> | `admin` / `${GRAFANA_ADMIN_PASSWORD:-admin}` |
| Overview | <http://localhost:3000/d/dia-cardano-feeder> | — |
| Transactions | <http://localhost:3000/d/dia-cardano-feeder-tx> | — |
| Internals | <http://localhost:3000/d/dia-cardano-feeder-internals> | — |

All auto-refresh every 30 s; the time picker (top-right) controls the window for every
panel at once. Dashboards are provisioned from the JSON files, so edit the JSON and
reload Grafana — there is no manual import.

## 3. How the filters work (read this first)

The Overview and Transactions dashboards carry a **filter bar** (Grafana *template
variables*) to zoom from "everything" down to one customer, client, router or symbol
without editing a query. The Internals dashboard is feeder-wide (filtered by `network`
only).

### 3.1 The filter cascade

| Filter | Means |
| --- | --- |
| **Customer** | The business/operator a router serves (`customer_id`). |
| **Client** | The on-chain deployment: one Receiver, one deposit address, one pair namespace (`client_id`). |
| **Router** | An off-chain config group of symbols + policy pointing at a client (`router_id`). |
| **Symbol** | The price pair. |
| **Error code** | *(Overview only)* a real transaction-failure code, to slice the failures chart. |

The filters chain **left to right**: `Customer → Client → Router → Symbol`. Picking a
customer narrows the Client dropdown to that customer's clients, which narrows Router,
which narrows Symbol. Each has an **`All`** default (do not narrow on this dimension).
The cascade is built from the transaction-flow metrics, so an entity appears once it
has produced (or is registered against) a transaction.

### 3.2 The same symbol on more than one client

The **same symbol can be served by more than one client** — e.g. `BTC/USD` published by
two independent on-chain deployments. Those are two separate feeds: each has its own
Receiver, its own on-chain value, its own staleness. The per-pair panels therefore key
by **`(symbol, client_id)`** (or `router_id` for the source-deviation panels, which carry
no `client_id`), so `BTC/USD · client-a` and `BTC/USD · client-b` show as distinct
series — never collapsed into one. When `Client = All`, expect a symbol that two clients
serve to appear once per client.

## 4. Dashboard 1 — Overview (`dia-cardano-feeder`)

The operational home base. Each panel: **what · how to read · when to worry.**

**Row — Oracle Feed Liveness**

- **Confirmed oracle updates — all-time total (per pair)** (`stat`, by `symbol, client_id`).
  All-time confirmed on-chain updates per feed. Every active feed should show a non-zero,
  growing number; one stuck at 0 (while others climb) never confirmed.
- **Price data age p95 — 1 h window** (`stat`, by `symbol`). 95th-percentile age of the
  **DIA source** price when consumed (source freshness, not tx speed). Climbing toward
  **600 s** fires `PriceAgeHigh` — upstream, not a Cardano problem.

**Row 1 — Balances & Staleness**

- **Pair staleness (per symbol)** (`stat`, legend `symbol · client_id`). Wall-clock age of
  the value currently on Cardano. Sawtooths between updates; past **3600 s** fires
  `OraclePairStale` (usual cause: a low Receiver/Admin balance).
- **Receiver balance — ADA (per client)** (`gauge`). Spendable ADA per Receiver; drains as
  it pays the per-update fee. Below **2 ADA** fires `ReceiverBalanceLow` → fund the deposit
  address.
- **Admin wallet · PaymentHook · Receiver accrued — ADA** (`stat`, global + per-client
  accrued). The fee money-flow: Admin wallet pays network fees (below **5 ADA** →
  `AdminWalletLow`); PaymentHook accrued (above **50 ADA** → `PaymentHookWithdrawReady`);
  Receiver accrued (above **10 ADA** → `SettleOverdue`).
- **Admin wallet — largest UTxO — ADA (collateral floor)** (`stat`). The largest single
  pure-ADA UTxO — what decides whether a script tx can still find collateral. Below
  **10 ADA** → `AdminWalletFragmented` (every build traps, even if the total looks fine).
- **Deposit pending — ADA (per client)** (`gauge`). Side-deposits not yet folded into the
  Receiver. Normally near 0 (auto-merged); a value that keeps growing with no merges →
  check the daemon logs.

**Row 2 — Symbol Throughput & Latency**

- **Symbol-update latency (p50/p95/p99)** (`timeseries`). End-to-end per-update latency,
  processing → confirmation. Watch a rising p95/p99 or a widening p50↔p99 gap.
- **Symbol updates confirmed (5m)** (`timeseries`, by `symbol, client_id`). Rolling 5-min
  count of confirmed updates per feed. Gaps are normal (the policy gate suppresses
  unchanged prices); a feed flatlining at 0 past its cadence is the signal.
- **Symbol-update failures (5m, by error code)** (`timeseries`). Real submission failures
  only (superseded no-ops are excluded). Any recurring code is a genuine problem.

**Row 2b — Transactions (preview)** — `Tx confirmed vs failed` and `Pairs per tx`, the
per-transaction view kept here for convenience (full detail on the Transactions dashboard).

**Row 3 — Chain & Scanner Health**

- **Reorg counter** (`stat`). Confirmed txs dropped by a Cardano reorg in the last hour;
  should sit at 0. Sustained **> 3/h** fires `ReorgRateHigh`.
- **Scanner block lag** (`timeseries`, global). Blocks behind the source-chain tip. A
  small stable lag is normal; a steadily rising lag means updates will be delayed.
- **Intents filtered (5m, by reason)** (`timeseries`). Intents deliberately suppressed
  (price barely moved, within the time window, not this client's pairs). **High is normal.**
  Read together with *Symbol updates confirmed*.

**Row 4 — Price Quality & Anomaly Detection**

- **Price deviation p95 — 1 h window** (`stat`, by `symbol, router_id`). 95th-percentile
  % move between consecutive prices at gate time. Above **5%** fires `PriceDeviationHigh`
  → investigate the source.
- **Price deviation distribution (heatmap)** (by `symbol, router_id`). The full deviation
  distribution over time; a healthy feed hugs the bottom (near 0%).
- **Feed sanity verdict (per pair)** (`stat`, by `symbol, client_id`). The periodic
  feed-sanity check: the live on-chain value vs the latest DIA source, **0 = ok / 1 =
  suspect / 2 = broken**. A sustained **2** fires `FeedAccuracyFail`. Inspect with
  `npm run sanity:feeds`.

**Row 5 — Billing**

- **Tx fee p50 — lovelace (per customer)** (`timeseries`, by `customer_id`). Median network
  fee per oracle-update tx — the basis for per-customer cost attribution. Batching lowers
  the per-pair cost.
- **Tx involving router (5m, by router & outcome)** (`timeseries`, by `router_id`). Which
  routers contributed to transactions, confirmed vs failed.

**Row 6 — Provider Health**

- **Cardano provider health — primary vs secondary** (`stat`). `1` = up, `0` = down, by
  role. **Primary down** → nothing can be built, every feed freezes together
  (`PrimaryProviderDown`, e.g. a Blockfrost `402`). **Secondary down** → redundancy lost
  only (`SecondaryProviderDown`).

## 5. Dashboard 2 — Transactions (`dia-cardano-feeder-tx`)

Everything here is **per transaction** (a batch of N pairs is ONE tx). Filtered by
Customer / Client (and Symbol on the membership panel).

**Row T1 — Latency by stage** — decomposes the end-to-end transaction time:

- **Stage 1 — processing → submission** — the feeder's own build/queue/sign work; should
  be short and stable.
- **Stage 2 — submission → confirmation** — pure Cardano settlement time; tracks the
  chain, not the feeder.
- **End-to-end — processing → confirmation** — the headline tx latency; compare to the two
  stages to attribute a rise.

**Row T2 — Throughput & outcome**

- **Tx confirmed vs failed (5m)** — transactions per 5 min by outcome; confirmed should
  dominate.
- **Tx success ratio (5m)** — confirmed ÷ all real attempts. Near **100%**; idle window
  reads **No data** (not 0%). Below ~95% sustained is a real problem.
- **Tx by client (5m)** — transaction load per client.

**Row T3 — Batch size & pair membership**

- **Pairs per tx (p50/p95/p99)** — batch size; higher amortizes the fixed fee over more
  pairs.
- **Batch size distribution (heatmap)** — the typical batch size over time.
- **Tx touching pair (5m, by symbol & outcome)** (by `symbol, client_id, outcome`) — which
  transactions carried a given pair, and whether they confirmed.
- **Tx involving router (5m, by router & outcome)** — which routers contributed to txs.

**Row T4 — Real transaction counts**

- **Tx counts — confirmed vs failed (selected range)** — raw confirmed/failed counts over
  the time-picker window; superseded no-ops and crash-recovery rows are not transactions
  and are not counted.

## 6. Dashboard 3 — Internals (`dia-cardano-feeder-internals`)

Feeder-internal observability (filtered by `network` only). For troubleshooting the feeder
itself rather than the feeds.

- **Per-phase latency (p95)** — the pipeline latency split into phases 1–5 (DIA/EVM →
  registration → scan → processing → submission → confirmation): isolates **where** latency
  lives (source, transport, internal, or Cardano).
- **Scanner RPC errors (5m, by type)** — health of the source-chain RPC/WS endpoint.
- **Scanner backfill (5m)** — blocks/chunks backfilled after a detected gap; > 0 means a
  gap was recovered.
- **Workers — active / capacity / queue** — the submission worker pool's occupancy; a queue
  that stays full is backpressure.
- **Worker tasks (5m)** — tasks completed by the pool.
- **HTTP request latency p95 (by endpoint)** — API responsiveness per endpoint.
- **DB operations (5m, by table)** / **DB operation latency p95 (by operation)** — database
  load and latency, from the `instrumentDb` wrapper that times every data op.
- **Cron resubmissions (5m, by outcome)** — cron decisions (`submitted`, `skipped_*`):
  shows whether the cron is working and why it skips.
- **Recovery attempts (5m, by reason)** — recovery events, e.g. crash recovery on startup.
- **Provider — time since last OK** — seconds since each provider last succeeded (the signal
  behind the provider-down alerts).

**Pipeline funnel & HTTP**

- **Event funnel (5m)** — inbound events: detected → dropped-as-duplicate → rejected-as-invalid.
- **Intent funnel (5m)** — where intents drop off: scanned → routed → submitted →
  confirmed / failed. The single best panel for "intents are arriving but nothing confirms."
- **HTTP requests (5m, by status)** — API request counts by HTTP status (pairs with the
  latency panel: how many, not just how long).

## 7. How alerts surface visually

An alert condition shows up in three places, all from one pipeline (feeder metrics →
Prometheus rules → Alertmanager → feeder webhook → `alert_log`):

- **Grafana panels** — the panel that owns the metric turns **yellow then red** at the
  configured threshold steps (e.g. Pair staleness red at 3600 s, Feed sanity red at 2).
  The colours are generated from the same `alerting.*` thresholds as the rules.
- **Prometheus** `/alerts` (<http://localhost:9090/alerts>) — the rule state: `pending`
  (matched, within its `for:` window) → `firing`.
- **Alertmanager** (<http://localhost:9093>) — active alerts, grouping and silences; it
  posts each firing/resolved alert to the feeder, which records it in `alert_log`
  (queryable at `/api/v1/alerts`).

To see an alert fire on demand without waiting for a real incident, the
`scripts/monitoring/trigger-alert.sh` harness pushes a synthetic value to a Pushgateway so
the **real** rule fires and flows through the whole pipeline (the pushed series is tagged
`client_id="trigger"`, so it is filterable and distinct from real feeds). See the feeder
README → *How alerts work*.

## 8. When to panic — one-page cheat sheet

Thresholds are the canonical values from `infrastructure.<network>.yaml::alerting` (mirrored
into the Prometheus rules and the Grafana panel colours; kept in sync by the threshold-drift
test).

| Panel | Alert | Fires when | Default | First action |
| --- | --- | --- | --- | --- |
| Pair staleness | `OraclePairStale` | on-chain value older than | **3600 s** | Check Receiver/Admin balance + `make logs` |
| Price age p95 | `PriceAgeHigh` | source price age p95 over | **600 s** | DIA source publishing stale prices (upstream) |
| Feed sanity verdict | `FeedAccuracyFail` | verdict sustained at | **2 (broken)** | On-chain value disagrees with the source — `npm run sanity:feeds` |
| Receiver balance | `ReceiverBalanceLow` | balance below | **2 ADA** | Send ADA to the deposit address |
| Admin wallet | `AdminWalletLow` | balance below | **5 ADA** | `settle` then `payment-hook:withdraw` to refill |
| Admin wallet largest UTxO | `AdminWalletFragmented` | largest pure-ADA UTxO below | **10 ADA** | `wallet:consolidate` |
| Receiver accrued | `SettleOverdue` | accrued above | **10 ADA** | Run `settle` |
| PaymentHook accrued | `PaymentHookWithdrawReady` | accrued above | **50 ADA** | DIA `payment-hook:withdraw` |
| Price deviation p95 | `PriceDeviationHigh` | p95 deviation over | **5 %** | Investigate the DIA source |
| Reorg counter | `ReorgRateHigh` | reorgs per hour over | **3 / h** | Check provider lag + scanner block lag |
| Provider health (primary) | `PrimaryProviderDown` | primary no success for | **600 s** | Rotate the key / switch `CARDANO_PROVIDER`, `make restart` |
| Provider health (secondary) | `SecondaryProviderDown` | secondary no probe for | **900 s** | Fix/rotate its endpoint in `feeder/.env`, `make restart` |
| Tx success ratio | _(watch manually)_ | confirmed/total drops | — | Failures panel + `make logs` |
| Scanner block lag | _(watch manually)_ | lag keeps climbing | — | Provider/connectivity check |

## 9. Concepts the charts assume

**Symbol updates vs transactions (the batch factor).** One transaction can carry many
pairs. Overview counts in **symbol updates**; the Transactions dashboard counts in
**transactions**. "5 updates / 1 tx" is a batch of 5, not a discrepancy.

**The same symbol on more than one client.** A symbol can run on multiple independent
clients; per-pair panels key by `(symbol, client_id)` so each on-chain feed is a distinct
series (see § 3.2).

**Confirmation depth.** A tx is *confirmed* once observed at `cardano.confirmation_depth`
blocks deep (default **1**) — probabilistically final, sufficient for a price feed. Detail:
README → *What "confirmed" means*.
