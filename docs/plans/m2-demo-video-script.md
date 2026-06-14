# Milestone 2 — Demo Video Script (QA review logs / lightweight preview)

This is the shooting script for the M2 acceptance demo. Per the Catalyst text, the
demo is a **lightweight preview** of the system feeding the **10 asset price feeds**,
showing the **real-time dashboards used by DIA for quality assurance and anomaly
detection**, plus **automated alerts** for anomalies (stale data / misreported prices).

- **Network:** Cardano **Preview** (the demo is explicitly a preview, not production).
- **Formal tx evidence** (confirmed Mainnet tx logs) is a **separate** deliverable — it is
  NOT part of this video. This video is the "QA review logs" demo only.
- **Target length:** 8–12 minutes.
- **Do NOT force `AdminWalletLow`** (or any Mainnet alert) — it stalls every update. All
  alert demonstrations here run on Preview only.

## Contents

- [What the reviewer must see](#what-the-reviewer-must-see)
- [Pre-flight (before hitting record)](#pre-flight-before-hitting-record)
- [Alert arming (timing matters)](#alert-arming-timing-matters)
- [Scene-by-scene script](#scene-by-scene-script)
  - [Scene 1 — Intro](#scene-1--intro)
  - [Scene 2 — The 10 feeds are live](#scene-2--the-10-feeds-are-live)
  - [Scene 3 — Real-time QA dashboards](#scene-3--real-time-qa-dashboards)
  - [Scene 4 — Anomaly detection & automated alerts](#scene-4--anomaly-detection--automated-alerts)
  - [Scene 5 — On-chain verification](#scene-5--on-chain-verification)
  - [Scene 6 — Wrap-up](#scene-6--wrap-up)
- [Cleanup after recording](#cleanup-after-recording)
- [Endpoints & URLs cheat-sheet](#endpoints--urls-cheat-sheet)

## What the reviewer must see

Mapping each on-screen moment to the M2 acceptance language:

| M2 acceptance phrase | Shown in |
|---|---|
| "lightweight preview … feeding data for the 10 asset price feeds" | Scene 2 |
| "real-time dashboards used by DIA for quality assurance" | Scene 3 |
| "anomaly detection of any stale data or misreported prices" | Scene 4 (PriceAge / PriceDeviation / OraclePairStale) |
| "automated alerts for any anomalies" | Scene 4 (alerts firing in Prometheus + Grafana) |
| "confirmed oracle transactions recorded on the chain" | Scene 5 (Cardanoscan) |

## Pre-flight (before hitting record)

1. **Preview has been running ~3–4 h** so dashboards have depth and latency p50/p95 have
   samples. Same run used for the fresh evidence pack (`preview_run_20260608-040304`).
2. **Monitoring stack up:** `cd offchain && make up MONITORING=1` (feeder + Prometheus +
   Grafana + renderer). Confirm all four containers are `Up (healthy)`.
3. **Sanity-check the surfaces** (don't record yet):
   - `curl -s localhost:8080/api/v1/symbols` → 10 symbols.
   - `curl -s localhost:8080/api/v1/prices | jq '.count'` → 10.
   - Grafana `http://localhost:3000` → both dashboards load (overview + Transactions).
   - Prometheus `http://localhost:9090/alerts` → 9 rules listed, all green/inactive.
4. **Pick the symbol** you'll spotlight in Scenes 2/5 (e.g. BTC/USD) and have a recent
   confirmed tx hash ready (`curl -s 'localhost:8080/api/v1/transactions?limit=1&status=confirmed' | jq`).
5. **Browser tabs open in order:** API (`/docs`), Grafana overview, Grafana Transactions,
   Prometheus `/alerts`, Cardanoscan Preview.

## Alert arming (timing matters)

Alerts have real thresholds and a `for:` dwell — you can't make them fire instantly without
faking them, and we don't fake them. Instead **arm the conditions before recording** so they
transition **Pending → Firing** *during* the video. Exact remediation/trigger commands for
each alert live in its own `description` block in
[`offchain/feeder/monitoring/alerts.yml`](../../offchain/feeder/monitoring/alerts.yml) — use those
as the single source (do not hand-improvise flags).

Recommended set (all safe on Preview):

| Alert | Threshold / `for:` | Arm at (relative to record start) | How to arm |
|---|---|---|---|
| **ReceiverBalanceLow** (warning) | balance < 2 ADA, `for: 5m` | T−6 min | Drain the client Receiver below 2 ADA (settle/withdraw per its remediation block). |
| **SettleOverdue** (warning) | accrued > 10 ADA, `for: 10m` | T−11 min | Let updates accrue past 10 ADA (don't settle), or run a burst of updates. |
| **ReceiverDepositsPending** (info) | pending > 5 ADA, `for: 10m` | T−11 min | `deposit:fund` the deposit address but do NOT run `deposit:merge`. |

`OraclePairStale` (1 h threshold) is **too slow to fire live** — instead show the **rule and
its remediation text** in Prometheus/`alerts.yml` and explain it (Scene 4), rather than
waiting an hour. If a natural `PriceAgeHigh`/`PriceDeviationHigh` happens to be firing during
the shoot, point it out — but don't bank on it.

> Write down the wall-clock time you armed each one; you'll narrate "this was triggered N
> minutes ago by draining the Receiver" when it appears firing.

## Scene-by-scene script

### Scene 1 — Intro
*(00:00–00:45)*

**On screen:** title slide or terminal with the repo.
**Narration:**
> "This is the Milestone 2 demo for the DIA oracle on Cardano. It's a lightweight preview
> on the Preview network, showing the feeder delivering the 10 Catalyst price feeds, the
> real-time QA dashboards, and the automated anomaly alerts. The formal confirmed-transaction
> evidence is on Mainnet and ships separately; this video is the QA-and-monitoring demo."

### Scene 2 — The 10 feeds are live
*(00:45–02:30)*

**On screen:** the `/docs` API reference, then the terminal.
- Open **`http://localhost:8080/docs`** → the interactive API reference (Swagger UI),
  generated from the OpenAPI 3.0 schema at `http://localhost:8080/api/v1/openapi.json`.
  Narrate: "the API is self-documented — every endpoint, schema, and example is here,
  generated from the code so it can't drift." Optionally expand an endpoint and hit
  **Try it out → Execute** to fire a live request from the page (e.g. `GET /api/v1/prices`).
- `curl -s localhost:8080/api/v1/symbols | jq` → narrate the 10 symbols.
- `curl -s localhost:8080/api/v1/prices | jq '.prices[] | {symbol, price, timestamp, cardanoTxHash}'`
  → show each feed has a fresh price, timestamp, and an on-chain tx hash.
- Show the feeder log tail: `docker logs dia-feeder-preview-feeder-sqlite-1 --tail 20`
  → point out the scanner + cron heartbeat keeping all 10 fresh.
**Narration:** emphasize "10 feeds, each backed by a confirmed Cardano tx, refreshed on
deviation or heartbeat."

### Scene 3 — Real-time QA dashboards
*(02:30–05:30)*

**On screen:** Grafana `http://localhost:3000`.
- **Overview dashboard** (`dia-cardano-feeder`): walk the template-variable cascade
  **network → customer → client → router → symbol**. Select customer `customer-test-01` →
  client `client-test-01` → router `client_test_01_router_default`. Show the filters narrow
  every panel.
- Point out the QA-relevant panels: confirmed symbol updates, last-confirmed freshness,
  per-symbol latency, balances (Receiver / Admin / accrued) in ADA, Billing row
  (`transaction_fee_lovelace` by client/customer).
- **Transactions dashboard** (`dia-cardano-feeder-tx`): per-**transaction** view — tx-stage
  latency p50/p95/p99, confirmed-vs-failed throughput, success ratio, batch-size histogram.
  Explain batching: one tx can carry N pairs, so per-tx metrics differ from per-symbol.
**Narration:** "These are the dashboards DIA uses for quality assurance — freshness,
latency, success ratio, and cost, sliced by customer/client/router/symbol."

### Scene 4 — Anomaly detection & automated alerts
*(05:30–09:30)*

**On screen:** Prometheus `http://localhost:9090/alerts`, then Grafana alert state.
- Show the **9 alert rules** and group them by anomaly type:
  - *Stale data:* `OraclePairStale`, `PriceAgeHigh`.
  - *Misreported prices:* `PriceDeviationHigh`.
  - *Operational / funding:* `ReceiverBalanceLow`, `AdminWalletLow`, `SettleOverdue`,
    `PaymentHookWithdrawReady`, `ReceiverDepositsPending`, `ReorgRateHigh`.
- Open `OraclePairStale` and `PriceDeviationHigh`, read the `expr` and the embedded
  **remediation** (the description carries exact Docker + npm fix commands).
- Now show the alerts you **armed** transitioning **Pending → Firing** (e.g.
  `ReceiverBalanceLow`). Narrate the arming: "~6 minutes ago I drained this client's Receiver
  below 2 ADA; the alert is now firing." Switch to Grafana to show the same alert surfaced on
  the dashboard.
- Read that alert's remediation and (optionally) run the fix on screen, then show it clear.
**Narration:** "Anomalies — stale data, price deviation, low balances — are detected
automatically and raise alerts with built-in remediation. `AdminWalletLow` is shown as a rule
but never force-triggered, since on Mainnet it would halt every update."

### Scene 5 — On-chain verification
*(09:30–10:30)*

**On screen:** terminal → Cardanoscan Preview.
- Take the spotlight symbol's tx hash from Scene 2 and open
  `https://preview.cardanoscan.io/transaction/<txHash>`.
- Show the confirmed tx on the explorer — the oracle update is real and independently
  verifiable.
**Narration:** "Every price you saw is anchored to a confirmed Cardano transaction, verifiable
by anyone on a public explorer."

### Scene 6 — Wrap-up
*(10:30–11:00)*

**Narration:**
> "That's the M2 QA-and-monitoring demo: 10 live feeds, real-time QA dashboards, and automated
> anomaly alerts on Preview. The confirmed Mainnet transaction logs accompany this submission as
> the formal feeder evidence, and the in-repo developer documentation completes the milestone."

## Cleanup after recording

- Reverse every armed condition: top up the Receiver, run `settle` / `payment-hook:withdraw`,
  run `deposit:merge`, restart the feeder if you stopped it. Confirm all alerts return to
  green in Prometheus.
- Generate the fresh evidence pack from the same run: `cd offchain && make evidence`.

## Endpoints & URLs cheat-sheet

| What | URL |
|---|---|
| API docs (Swagger UI — Try it out) | `http://localhost:8080/docs` |
| OpenAPI 3.0 schema | `http://localhost:8080/api/v1/openapi.json` |
| Symbols | `http://localhost:8080/api/v1/symbols` |
| Prices | `http://localhost:8080/api/v1/prices` |
| Transactions | `http://localhost:8080/api/v1/transactions?limit=10&status=confirmed` |
| Metrics | `http://localhost:8080/metrics` |
| Grafana | `http://localhost:3000` |
| Prometheus alerts | `http://localhost:9090/alerts` |
| Cardanoscan (Preview) | `https://preview.cardanoscan.io/transaction/<txHash>` |
| Alert rules + remediation (source) | [`offchain/feeder/monitoring/alerts.yml`](../../offchain/feeder/monitoring/alerts.yml) |
