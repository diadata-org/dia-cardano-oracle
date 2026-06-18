# Mini-plan — Grafana dashboards: living guide + complete the panels

Captured so we don't forget. Two things, in priority order.

## Contents

- [1. MUST: complete the missing-metric panels](#1-must-complete-the-missing-metric-panels)
- [2. Living dashboards guide (docs/architecture)](#2-living-dashboards-guide-docsarchitecture)

## 1. MUST: complete the missing-metric panels — ✅ DONE (2026-06-18)

> Done: feed-sanity panel added to Overview Row 4; "Pipeline funnel & HTTP" row (event +
> intent funnel + `http_requests_total`) added to Internals; `feeder.md §19C` false claim
> corrected; `threshold-drift.test.ts` guards the feed-sanity panel ↔ `FeedAccuracyFail`
> boundary. Remaining unshown metrics are the low-value ones, deliberately skipped.
> The notes below are kept as the record of what was audited.

M3-D built the **Internals** dashboard (`feeder-internals.json`, 11 panels) and wired the
4 stub metrics. Coverage audit (declared in `metrics.ts` vs referenced in the 3 dashboard
JSON `expr` fields, verified 2026-06-18): **62 declared, 16 with no panel.** Classified:

**Add (worth a panel):**
- **`dia_bridge_feed_sanity_status{symbol}`** (M3-A) — emitted + watched by `FeedAccuracyFail`,
  on NO dashboard. Add a per-symbol panel (0 = ok / 1 = suspect / 2 = broken) to Overview
  Row 4 (Price Quality & Anomaly Detection). **Also: `feeder.md §19C` falsely claims this is
  "shown on feeder-internals.json" — correct that line.**
- **Event/intent funnel** — `events_detected_total`, `events_duplicate_total`,
  `events_invalid_total`, `intents_scanned_total`, `intents_routed_total`,
  `transactions_submitted_total`. `feeder.md §19A` lists these as "Missing, with real data
  (candidates to add)" and §19's "Suggested panels #1 (by value): Funnel" — never built.
  Add a funnel row (detected → scanned → routed → submitted → confirmed/failed/filtered).
- `http_requests_total{method,endpoint,status}` — Internals shows HTTP latency but not request
  counts. (nice-to-have)

**Skip (record the decision, do not add):**
- 5 Spectra lifecycle aliases (`intents_*_lifecycle_total`) — duplicate the funnel, naming
  parity only.
- `scanner_last_block`, `cardano_receiver_topup_warnings_total`, `cardano_pair_is_create` — niche.

After adding panels, extend `threshold-drift.test.ts` template-var/threshold assertions if a
new panel carries a thresholded value (the feed_sanity panel does: 0/1/2 colour steps).

## 1b. Multi-entity correctness (same symbol on >1 client) — ✅ DONE (2026-06-18)

Found with the real multi-customer config (2 customers, 2 clients, 3 routers;
**BTC/USD served by BOTH client-test-01 and client-test-02**). Panels grouped by `symbol`
ALONE collapsed or duplicated the two independent on-chain feeds in the default (Client=All)
view. Fixed by grouping/labelling by `(symbol, client_id)` (or `router_id` where the metric
has no `client_id`):

- **Confirmed updates — all-time (per pair)** — `sum by (symbol, client_id)`, legend `{{symbol}} · {{client_id}}`. ✓
- **Feed sanity verdict (per pair)** — `max by (symbol, client_id)`. ✓
- **Symbol updates confirmed (5m)** — `sum by (symbol, client_id)` (drift test count-group updated to match). ✓
- **Pair staleness (per symbol)** — legend now `{{symbol}} · {{client_id}}`. ✓
- **Price deviation p95 / heatmap** — `price_deviation_percent` has no `client_id`, so grouped by
  `(le, symbol, router_id)` (each BTC feed is on a distinct router). ✓ Price *age* left symbol-only
  (a source property). ✓
- **Tx touching pair (feeder-tx.json)** — `sum by (symbol, client_id, outcome)`. ✓

Already multi-entity-correct (no change): Receiver balance/Deposit pending (by client),
Receiver accrued (total + by client), Tx by client, Tx fee p50 (by customer_id), Tx involving
router (by router_id), and the global singletons (provider/scanner/admin/paymenthook).

## 2. Living dashboards guide (docs/architecture)

Turn the stale, dated audit into a maintained reference.

- **Source:** `docs/audit/20260611-grafana-dashboards-audit.md` — excellent structure
  (at-a-glance, how to open, filters, panel-by-panel what/how/when-to-worry, cheat sheet),
  but **pre-M3 and stale**.
- **New home:** `docs/architecture/grafana-dashboards.md` (living). Archive the dated audit
  to `docs/audit/_archived/` (or banner it "superseded by …") — keep it as the snapshot.
- **Update vs the audit:**
  - "two dashboards" → **three** (add the whole **Internals** section: 11 panels).
  - Filter cascade is now **Customer → Client → Router → Symbol** (audit omits `Router`).
  - New panels "Tx involving router (by router & outcome)" (Overview + Transactions).
  - M3 additions: `feed_sanity_status` panel + `FeedAccuracyFail`.
  - Remove meta-language ("no longer counted here"); de-hardcode "10 pairs" / "two".
  - Re-render the PNG images (fresh window, incl. Internals).
  - Note how the alert-trigger Pushgateway shows up in panels/filters (the `trigger` entity).
- **What else to add:** alert → which-panel map; "reading the threshold colours"; how alerts
  surface (panel colours · Prometheus `/alerts` · Alertmanager).
- **Decide before building (avoids a doc that drifts):** how much per-panel detail is manual
  vs leaning on the dashboard JSON `description` fields (which already carry per-panel text
  and are re-rendered into the evidence pack). Reconcile with `feeder.md §19` ("Metrics not
  in Grafana") — once panels are complete, §19 shrinks to "metrics with no panel yet".
