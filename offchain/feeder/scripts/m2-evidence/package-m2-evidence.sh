#!/usr/bin/env bash
#
# package-m2-evidence.sh — assemble the COMPLETE Milestone 2 evidence pack
# from a running (or stopped) feeder deployment. This is what `make evidence`
# runs; it can also be run standalone.
#
# Reads logs + sqlite + live API + Grafana renderer and writes a
# self-contained directory under docs/milestones/evidence/. Inputs:
#
#   logs + sqlite : offchain/state/<network>_run_<id>/ (or flat
#                   state/<network>/ when no run dir exists; honors RUN_ID)
#   feeder API    : http://localhost:8080
#   Grafana       : http://localhost:3000 (renderer profile must be up)
#
# Env vars (set by `make evidence`; both optional when run standalone):
#   EVIDENCE_NETWORK  Cardano network (e.g. preview, mainnet). Default: preview.
#   EVIDENCE_STAMP    Shared dir stamp so all evidence scripts write into one
#                     dir. Default: the run dir id of the resolved STATE_DIR
#                     (matches the m1-* packs); a flat state/<network> with no
#                     run dir falls back to a UTC `date -u +%Y%m%d-%H%M%S`.
#
# Run AFTER the feeder has accumulated material to show. The feeder may
# continue running while this script executes (append-only logs + SQLite
# concurrent reads).
#
# Output: docs/milestones/evidence/m2-<network>-<run-id>/  (a two-digit suffix
#         -01, -02, … is appended when a pack for that run already exists)
#
# Dependencies (all on standard Linux): bash, jq, sqlite3, curl, awk.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths — network and dir stamp from env (see header). State dir and output
# dir name follow the network so the pack is not preview-only.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/m2-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
NETWORK="$(echo "${EVIDENCE_NETWORK:-preview}" | tr '[:upper:]' '[:lower:]')"
# Display name + paired DIA source + explorer, so the evidence markdown matches
# the network — a Mainnet pack must never claim "Preview".
NETWORK_DISPLAY="$(tr '[:lower:]' '[:upper:]' <<<"${NETWORK:0:1}")${NETWORK:1}"
if [[ "$NETWORK" == "mainnet" ]]; then
  DIA_NETWORK="Mainnet"; EXPLORER_NAME="Cardanoscan"; EXPLORER_URL="https://cardanoscan.io/"
else
  DIA_NETWORK="Testnet"; EXPLORER_NAME="Cardanoscan Preview"; EXPLORER_URL="https://preview.cardanoscan.io/"
fi
MD_FILE="milestone-2-${NETWORK}-evidence.md"

# Resolve the per-run state dir — mirror cmd/feeder/run-state.ts resolveRunStateDir
# so the pack reads the SAME deployment the daemon writes:
#   RUN_ID set   -> state/<network>_run_<RUN_ID>
#   RUN_ID empty -> newest state/<network>_run_*
#   no run dirs  -> flat state/<network>  (pre-per-run layout / live preview)
STATE_ROOT="$REPO_ROOT/offchain/state"
if [[ -n "${RUN_ID:-}" ]]; then
  STATE_DIR="$STATE_ROOT/${NETWORK}_run_${RUN_ID}"
else
  newest="$(ls -d "$STATE_ROOT/${NETWORK}_run_"*/ 2>/dev/null | sort | tail -1)"
  STATE_DIR="${newest:+${newest%/}}"
  STATE_DIR="${STATE_DIR:-$STATE_ROOT/$NETWORK}"
fi
LOGS_DIR="$STATE_DIR/logs"
SQLITE_FILE="$STATE_DIR/feeder.sqlite"
API_URL="http://localhost:8080"
GRAFANA_URL="http://localhost:3000"
GRAFANA_USER="admin"
GRAFANA_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
GRAFANA_DASHBOARD_UID="dia-cardano-feeder"

# Pack stamp mirrors the run dir id (so the evidence dir maps to the deployment
# it was captured from, like the m1-* packs) rather than wall-clock time.
# EVIDENCE_STAMP still overrides for shared multi-script runs; a flat
# state/<network> with no run dir falls back to a UTC stamp.
run_suffix="${STATE_DIR##*_run_}"
if [[ "$run_suffix" == "$STATE_DIR" ]]; then
  run_suffix="$(date -u +%Y%m%d-%H%M%S)"
fi
STAMP="${EVIDENCE_STAMP:-$run_suffix}"
OUT_DIR="$REPO_ROOT/docs/milestones/evidence/m2-$NETWORK-$STAMP"
# Standalone only: if a pack already exists for this run, append a two-digit
# suffix (-01, -02, …) instead of overwriting. When EVIDENCE_STAMP is set (e.g.
# `make evidence`), the caller already resolved the dir and shares it across the
# sibling scripts, so we must use it verbatim — bumping here would desync them.
if [[ -z "${EVIDENCE_STAMP:-}" && -e "$OUT_DIR" ]]; then
  suffix_n=1
  while [[ -e "$(printf '%s-%02d' "$OUT_DIR" "$suffix_n")" ]]; do
    suffix_n=$((suffix_n + 1))
  done
  STAMP="$(printf '%s-%02d' "$STAMP" "$suffix_n")"
  OUT_DIR="$(printf '%s-%02d' "$OUT_DIR" "$suffix_n")"
fi

# ---------------------------------------------------------------------------
# Pre-flight: required tools + state must exist.
# ---------------------------------------------------------------------------
for tool in jq sqlite3 curl awk; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "fatal: required tool '$tool' not found on PATH" >&2
    exit 1
  }
done

[[ -d "$LOGS_DIR" ]] || {
  echo "fatal: feeder logs dir not found: $LOGS_DIR" >&2
  echo "Did you run the feeder against Cardano ${NETWORK_DISPLAY}? See offchain/feeder/README.md" >&2
  exit 1
}
[[ -f "$SQLITE_FILE" ]] || {
  echo "fatal: sqlite db not found: $SQLITE_FILE" >&2
  exit 1
}

echo "[package-m2] state dir: $STATE_DIR"
echo "[package-m2] out dir:   $OUT_DIR"

mkdir -p "$OUT_DIR"/{logs,logs/intents,db,api,dashboards,stats}

# ---------------------------------------------------------------------------
# Step 1 — copy raw logs verbatim.
# Logs are immutable artifacts; copy them as-is so the reviewer can grep
# anything we did not explicitly extract.
# ---------------------------------------------------------------------------
echo "[package-m2] step 1/6 — copying raw logs"
for f in feeder.log transactions.jsonl lane.jsonl; do
  [[ -f "$LOGS_DIR/$f" ]] && cp "$LOGS_DIR/$f" "$OUT_DIR/logs/$f"
done
if [[ -d "$LOGS_DIR/intents" ]]; then
  cp -r "$LOGS_DIR/intents/." "$OUT_DIR/logs/intents/" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Step 2 — dump sqlite tables as CSV.
# CSV is the reviewer-friendly format and survives schema changes — every
# column header is in the first row of each file.
# ---------------------------------------------------------------------------
echo "[package-m2] step 2/6 — dumping sqlite tables"
for table in transaction_log processed_events chain_state; do
  if sqlite3 "$SQLITE_FILE" ".tables" | grep -qw "$table"; then
    sqlite3 -header -csv "$SQLITE_FILE" "SELECT * FROM $table" \
      > "$OUT_DIR/db/$table.csv"
  fi
done

# ---------------------------------------------------------------------------
# Step 3 — snapshot the live HTTP API. Best-effort: if the feeder is
# already stopped, the curls fail and we move on with a note.
# ---------------------------------------------------------------------------
echo "[package-m2] step 3/6 — snapshotting feeder API"
if curl -fsS --max-time 5 "$API_URL/health/live" >/dev/null 2>&1; then
  curl -fsS "$API_URL/api/v1/prices"  > "$OUT_DIR/api/prices.json"  || true
  curl -fsS "$API_URL/api/v1/chains"  > "$OUT_DIR/api/chains.json"  || true
  curl -fsS "$API_URL/api/v1/symbols" > "$OUT_DIR/api/symbols.json" || true
  curl -fsS "$API_URL/metrics"        > "$OUT_DIR/api/metrics.txt"  || true
  echo "[package-m2]   API reachable — snapshots captured"
else
  echo "[package-m2]   API NOT reachable at $API_URL — skipping snapshots"
  echo "Feeder API was not reachable at $API_URL when this pack was assembled." \
    > "$OUT_DIR/api/UNAVAILABLE.txt"
fi

# ---------------------------------------------------------------------------
# Step 4 — render Grafana dashboard PNGs.
# Requires the `monitoring` docker-compose profile to be up (grafana +
# renderer). Falls back to placeholder + note if the renderer is down.
# ---------------------------------------------------------------------------
echo "[package-m2] step 4/6 — rendering Grafana dashboard"

# Panels to snapshot, in dashboard reading order: "id|title|description".
# IDs, titles and PromQL come from monitoring/<network>/dashboards/feeder.json —
# keep in sync with it. The description is rendered under each PNG in the
# report and explains the metric (NOT the data). Single-quoted so the literal
# backticks survive into the markdown unevaluated.
PANELS=(
  '11|Confirmed oracle updates — all-time total (per pair)|Metric `sum by (symbol) (dia_bridge_transactions_confirmed_total)`. Running all-time count of oracle-update transactions that reached on-chain confirmation, split per price pair (the `symbol` label). This is the liveness proof — every active pair should show a non-zero, growing count.'
  '12|Price data age p95 — 1 h window (per routed pair)|Metric `histogram_quantile(0.95, rate(dia_bridge_price_age_seconds_bucket[1h]))` per `symbol`, in seconds. 95th percentile of how old the DIA source price was at the moment the feeder consumed it — i.e. data freshness, not transaction speed. Recorded ONLY for the pairs this feeder routes (not the hundreds of other symbols the source feed carries). Lower is better; high values feed the `PriceAgeHigh` alert.'
  '1|Pair staleness (per symbol)|Metric `time() - dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds`, in seconds. Wall-clock age of the most recent confirmed on-chain update for each pair — how stale the value currently living on Cardano is. Drives the `OraclePairStale` alert.'
  '2|Receiver balance — ADA (per client)|Metric `dia_bridge_cardano_receiver_balance_lovelace / 1000000`, in ADA. Current spendable balance of each Receiver address, converted from lovelace. The metric labels include both `receiver_address` and the client `deposit_address` operators should fund when `ReceiverBalanceLow` fires.'
  '3|Admin wallet • PaymentHook • Receiver accrued — ADA|Three ADA series (lovelace ÷ 1e6): `dia_bridge_cardano_admin_wallet_lovelace` (operator admin wallet), `dia_bridge_cardano_payment_hook_accrued_lovelace` (fees accrued inside the PaymentHook awaiting withdraw), and `sum(dia_bridge_cardano_receiver_accrued_lovelace)` (amounts accrued at receivers awaiting settle). Together they track the fee / settlement money flow.'
  '201|Admin wallet — largest UTxO — ADA (collateral floor)|Metric `dia_bridge_cardano_admin_wallet_max_utxo_lovelace / 1000000`, in ADA. The LARGEST single pure-ADA UTxO in the admin/signer wallet. A Cardano script tx needs a collateral UTxO distinct from its fee inputs, so THIS — not the total balance — decides whether the wallet can still build. Below `admin_wallet_min_collateral_lovelace` the wallet is fragmented (`AdminWalletFragmented`, critical) even if the total looks healthy; the daemon auto-consolidates below `auto_consolidate_below_lovelace`.'
  '15|Deposit pending — ADA (per client)|Metric `dia_bridge_cardano_deposit_pending_lovelace / 1000000`, in ADA. Side-deposits a client has sent to its per-client deposit address that the feeder has not yet folded into the Receiver balance. The daemon merges these automatically once the Receiver balance falls below `receiver_balance_low_lovelace` or the pending pile reaches `deposit_pending_merge_lovelace`; a steadily growing value with no merges is worth a look.'
  '4|Symbol-update latency (p50/p95/p99)|Metric `histogram_quantile(0.50 / 0.95 / 0.99, rate(dia_bridge_end_to_end_latency_seconds_bucket[5m]))`, in seconds, aggregated across all pairs. Per-symbol pipeline latency from feeder processing start to Cardano confirmation, at the median, 95th and 99th percentiles. For per-TRANSACTION stage latency see the Transactions dashboard below.'
  '5|Symbol updates confirmed (5m)|Metric `sum by (symbol) (increase(dia_bridge_transactions_confirmed_total[5m]))` — a 5-minute count (not a rate), per pair. A batch transaction of N pairs adds 1 to each of its N symbols, so this is symbol-update throughput; for pure per-transaction counts see "Tx confirmed vs failed" below.'
  '6|Symbol-update failures (5m, by error code)|Metric `sum by (error_code) (increase(dia_bridge_transactions_failed_total[5m]))` — a 5-minute count grouped by `error_code`, REAL submission failures only. Superseded intents the feeder declined to submit (`NonMonotonicNonce`, no tx, no fee) are NOT counted here — they go to `dia_bridge_intents_superseded_total{reason}`. Codes are documented in `offchain/feeder/src/errors/codes.ts`.'
  '16|Tx confirmed vs failed (5m)|Metric `sum by (outcome) (increase(dia_bridge_transactions_total[5m]))` — Cardano TRANSACTIONS per 5-minute window, counted once per tx (a batch of N pairs is ONE tx), by `outcome`. Condemned no-ops are excluded. This is pure transaction throughput, distinct from the per-symbol counts above.'
  '17|Pairs per tx (p50/p95)|Metric `histogram_quantile(0.50 / 0.95, rate(dia_bridge_transaction_pairs_bucket[5m]))` — batch size: how many pairs travel in each transaction, at the median and 95th percentile.'
  '7|Reorg counter|Metric `sum(increase(dia_bridge_transactions_reorg_total[1h]))`. Count of already-confirmed transactions dropped by a chain reorganisation in the last hour. Should sit at 0; a sustained non-zero value triggers `ReorgRateHigh` and points at provider lag.'
  '8|Scanner block lag|Metric `dia_bridge_scanner_block_lag`, in blocks. How many blocks behind the chain tip the DIA-side scanner currently is. A steadily rising lag means the scanner is falling behind the source chain and updates will be delayed.'
  '9|Intents filtered (5m, by reason)|Metric `sum by (reason) (increase(dia_bridge_intents_filtered_total[5m]))` — a 5-minute count grouped by `reason`. Intents the feeder deliberately suppressed before submitting. High counts are normal: the deviation/time-threshold policy suppresses most intents by design.'
  '13|Price deviation p95 — 1 h window (per pair)|Metric `histogram_quantile(0.95, rate(dia_bridge_price_deviation_percent_bucket[1h]))` per `symbol`, in percent. 95th percentile of the percentage gap between the price the feeder published and the reference price, per pair. A high value suggests a possible misreport and feeds the `PriceDeviationHigh` alert.'
  '10|Price deviation distribution (heatmap)|Metric `sum by (le, symbol) (rate(dia_bridge_price_deviation_percent_bucket[5m]))`, percent buckets. Heatmap of the price-deviation distribution over time (histogram `le` buckets, colour = frequency), measured at policy-gating time for every evaluated intent — submitted and gate-suppressed alike. Healthy feeds cluster near 0%; a vertical spread means deviations are growing.'
  '14|Tx fee p50 — lovelace (per customer)|Metric `histogram_quantile(0.50, sum by (le, customer_id) (rate(dia_bridge_transaction_fee_lovelace_bucket[5m])))`, in lovelace (1 ADA = 1,000,000 lovelace). Median Cardano network fee paid per oracle-update transaction, grouped by `customer_id` — the basis for per-customer cost attribution / billing. A batch of N pairs is one tx and one fee observation.'
  '203|Cardano provider health — primary vs secondary (1 = up)|Metric `dia_bridge_component_health{component,role}` (1 = up, 0 = down). Health of the two Cardano API providers by role: PRIMARY is the build/submit provider lucid uses (selected by `CARDANO_PROVIDER`) — if it is down nothing can be built and every pair freezes together (e.g. a Blockfrost 402 quota wall) → `PrimaryProviderDown` (critical); SECONDARY backs confirmation/reorg redundancy → `SecondaryProviderDown` (warning). The down-alerts watch `dia_bridge_provider_last_ok_timestamp_seconds{provider,role}`.'
)

# Transactions dashboard (feeder-tx.json, uid dia-cardano-feeder-tx) — the
# per-TRANSACTION axis: a batch of N pairs is ONE tx. Same "id|title|description"
# shape; keep in sync with monitoring/<network>/dashboards/feeder-tx.json.
GRAFANA_TX_DASHBOARD_UID="dia-cardano-feeder-tx"
PANELS_TX=(
  '301|Stage 1 — processing → submission|Metric `histogram_quantile(0.50 / 0.95 / 0.99, rate(dia_bridge_tx_processing_to_submission_seconds_bucket[5m]))`, in seconds, one observation per confirmed tx. Time to build, queue and sign a transaction before broadcast.'
  '302|Stage 2 — submission → confirmation|Metric `histogram_quantile(0.50 / 0.95 / 0.99, rate(dia_bridge_tx_submission_to_confirmation_seconds_bucket[5m]))`, in seconds. Pure Cardano settlement time from broadcast to on-chain confirmation, per tx.'
  '303|End-to-end — processing → confirmation|Metric `histogram_quantile(0.50 / 0.95 / 0.99, rate(dia_bridge_tx_end_to_end_seconds_bucket[5m]))`, in seconds. Total per-transaction latency from feeder processing start to confirmation.'
  '311|Tx confirmed vs failed (5m)|Metric `sum by (outcome) (increase(dia_bridge_transactions_total[5m]))` — transactions per 5-minute window counted once per tx, by outcome. Condemned no-ops excluded.'
  '312|Tx success ratio (5m)|Confirmed transactions as a percentage of all transactions in the last 5 minutes. Shows "No data" when no transactions were sent in that window (rather than 0%).'
  '313|Tx by client (5m)|Metric `sum by (client_id) (increase(dia_bridge_transactions_total[5m]))` — transactions per 5-minute window grouped by client (receiver identity), counted once per tx.'
  '321|Pairs per tx (p50/p95/p99)|Metric `histogram_quantile(0.50 / 0.95 / 0.99, rate(dia_bridge_transaction_pairs_bucket[5m]))` — batch size distribution: pairs per transaction at the median, 95th and 99th percentiles.'
  '322|Batch size distribution (heatmap)|Metric `sum by (le) (rate(dia_bridge_transaction_pairs_bucket[5m]))`, batch-size buckets. Heatmap of pairs-per-transaction over time; bright bands show the typical batch size.'
  '323|Tx touching pair (5m, by symbol & outcome)|Metric `sum by (symbol, outcome) (increase(dia_bridge_tx_pair_membership_total[5m]))` — one increment per (tx, pair). Filter by `$symbol` to find the transactions that included a given pair (their size is in "Pairs per tx"); carries confirmed vs failed and the customer dimension.'
  '331|Tx counts — confirmed vs failed (selected range)|The number of real Cardano oracle transactions over the window — how many confirmed on-chain and how many failed, counted once per transaction (one transaction can carry several price pairs).'
)

render_dashboard() {
  local uid="$1"
  local slug="$2"
  local out_png="$3"
  local from="now-3h"
  local to="now"
  curl -fsS --max-time 30 \
    -u "$GRAFANA_USER:$GRAFANA_PASS" \
    -o "$out_png" \
    "$GRAFANA_URL/render/d/$uid/$slug?orgId=1&from=$from&to=$to&width=1600&height=2400&kiosk=tv&tz=UTC"
}

render_panel() {
  local uid="$1"
  local panel_id="$2"
  local out_png="$3"
  local from="now-3h"
  local to="now"
  curl -fsS --max-time 30 \
    -u "$GRAFANA_USER:$GRAFANA_PASS" \
    -o "$out_png" \
    "$GRAFANA_URL/render/d-solo/$uid/panel?orgId=1&panelId=$panel_id&from=$from&to=$to&width=1200&height=400&tz=UTC"
}

# Markdown for the report's "## Dashboards" section, built as PNGs land so the
# report embeds exactly what was captured (with each panel's real title).
DASHBOARDS_MD=""

if curl -fsS --max-time 5 "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
  if render_dashboard "$GRAFANA_DASHBOARD_UID" "dia-cardano-oracle-feeder" "$OUT_DIR/dashboards/dashboard-full.png" 2>/dev/null; then
    echo "[package-m2]   full dashboard PNG captured"
    DASHBOARDS_MD=$'### Overview dashboard\n\n![DIA Cardano Oracle Feeder — full dashboard](dashboards/dashboard-full.png)\n\n_Each panel is also captured individually below. Every caption names the underlying Prometheus metric and explains what it measures. A batch transaction of N pairs counts as N symbol updates in the per-symbol panels and as ONE transaction in the per-tx panels._\n\n### Overview panels\n'
    # Per-panel snapshots — embed each one under its title, then explain the metric.
    for entry in "${PANELS[@]}"; do
      panel_id="${entry%%|*}"
      rest="${entry#*|}"
      panel_title="${rest%%|*}"
      panel_desc="${rest#*|}"
      if render_panel "$GRAFANA_DASHBOARD_UID" "$panel_id" "$OUT_DIR/dashboards/panel-$panel_id.png" 2>/dev/null; then
        echo "[package-m2]   panel $panel_id PNG captured"
        DASHBOARDS_MD+=$'\n'"**${panel_title}**"$'\n\n'"![${panel_title}](dashboards/panel-${panel_id}.png)"$'\n\n'"${panel_desc}"$'\n'
      else
        echo "[package-m2]   panel $panel_id PNG FAILED — skipping in report" >&2
      fi
    done

    # Transactions dashboard (per-tx axis) — full render + per-panel snapshots.
    if render_dashboard "$GRAFANA_TX_DASHBOARD_UID" "dia-cardano-oracle-feeder-transactions" "$OUT_DIR/dashboards/tx-dashboard-full.png" 2>/dev/null; then
      echo "[package-m2]   tx dashboard PNG captured"
      DASHBOARDS_MD+=$'\n### Transactions dashboard\n\n![DIA Cardano Oracle Feeder — Transactions — full dashboard](dashboards/tx-dashboard-full.png)\n\n_The per-transaction view: a batch of N pairs is ONE transaction here. Stage latency, confirmed-vs-failed throughput, success ratio and batch size._\n\n### Transactions panels\n'
      for entry in "${PANELS_TX[@]}"; do
        panel_id="${entry%%|*}"
        rest="${entry#*|}"
        panel_title="${rest%%|*}"
        panel_desc="${rest#*|}"
        if render_panel "$GRAFANA_TX_DASHBOARD_UID" "$panel_id" "$OUT_DIR/dashboards/tx-panel-$panel_id.png" 2>/dev/null; then
          echo "[package-m2]   tx panel $panel_id PNG captured"
          DASHBOARDS_MD+=$'\n'"**${panel_title}**"$'\n\n'"![${panel_title}](dashboards/tx-panel-${panel_id}.png)"$'\n\n'"${panel_desc}"$'\n'
        else
          echo "[package-m2]   tx panel $panel_id PNG FAILED — skipping in report" >&2
        fi
      done
    else
      echo "[package-m2]   tx dashboard render FAILED — skipping in report" >&2
    fi
  else
    cat > "$OUT_DIR/dashboards/README.txt" <<EOF
Grafana reachable but renderer plugin is not responding. Either bring up
the monitoring profile (which includes the renderer sidecar):

    cd offchain && make up-monitoring

Then re-run this script, or drop manual PNG screenshots into this folder.
The dashboard JSON lives at offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json.
EOF
    DASHBOARDS_MD="_Grafana was reachable but the image renderer was not responding when this pack was assembled — no PNGs captured. See \`dashboards/README.txt\`._"
    echo "[package-m2]   Grafana up but render failed — wrote dashboards/README.txt"
  fi
else
  cat > "$OUT_DIR/dashboards/README.txt" <<EOF
Grafana was not reachable at $GRAFANA_URL when this pack was assembled.
Start the monitoring stack and re-run the script, or drop manual PNG
screenshots into this folder:

    cd offchain && make up-monitoring

The dashboard JSON lives at offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json.
EOF
  DASHBOARDS_MD="_Grafana was not reachable at $GRAFANA_URL when this pack was assembled — no PNGs captured. See \`dashboards/README.txt\`._"
  echo "[package-m2]   Grafana NOT reachable — wrote dashboards/README.txt"
fi

# ---------------------------------------------------------------------------
# Step 5 — compute stats from transactions.jsonl + DB.
# Everything is best-effort and degrades gracefully on missing inputs.
# ---------------------------------------------------------------------------
echo "[package-m2] step 5/6 — computing stats"
TX_LOG="$OUT_DIR/logs/transactions.jsonl"

stat_total_confirmed=0
stat_total_failed=0
stat_total_condemned=0
stat_total_reorgs=0
stat_first_event_iso=""
stat_last_event_iso=""

# Counts per symbol → /tmp file, then read back into the markdown.
SYMBOL_COUNTS="$OUT_DIR/stats/symbol-counts.tsv"
SYMBOL_HASHES="$OUT_DIR/stats/symbol-tx-hashes.tsv"
ERROR_COUNTS="$OUT_DIR/stats/error-counts.tsv"
LATENCY_FILE="$OUT_DIR/stats/symbol-latency.tsv"
DB_LOG="$OUT_DIR/db/transaction_log.csv"

if [[ -f "$TX_LOG" ]]; then
  stat_total_confirmed=$(jq -rs '[.[] | select(.event=="tx_confirmed")] | length' "$TX_LOG" 2>/dev/null || echo 0)
  stat_first_event_iso=$(jq -rs '[.[].ts] | min // ""' "$TX_LOG" 2>/dev/null || echo "")
  stat_last_event_iso=$(jq -rs '[.[].ts] | max // ""' "$TX_LOG" 2>/dev/null || echo "")

  # Confirmed tx count per symbol.
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol)]
    | group_by(.symbol)
    | map({symbol: .[0].symbol, count: length})
    | sort_by(-.count)
    | .[] | "\(.symbol)\t\(.count)"
  ' "$TX_LOG" > "$SYMBOL_COUNTS" 2>/dev/null || true

  # First tx hash per symbol (for the reviewer's spot-check table).
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol and .txHash)]
    | group_by(.symbol)
    | map({symbol: .[0].symbol, txHash: .[0].txHash})
    | .[] | "\(.symbol)\t\(.txHash)"
  ' "$TX_LOG" > "$SYMBOL_HASHES" 2>/dev/null || true

  # Real tx failures + condemned intents — sourced from the DB CSV (it carries
  # error_code; the JSONL tx_failed events do not). NonMonotonicNonce = intent
  # superseded on-chain before submission: no Cardano tx broadcast, no fee paid.
  # CrashRecovery = an intent that was in-flight (pending/submitted) when the
  # daemon last restarted, force-failed on startup — also NOT a broadcast tx that
  # failed on-chain. Both are excluded from the "real failures" total/table; all
  # other codes = a tx was submitted to the chain but failed.
  if [[ -f "$DB_LOG" ]]; then
    stat_total_failed=$(python3 - "$DB_LOG" <<'PYEOF'
import csv, sys
with open(sys.argv[1]) as f:
    rows = list(csv.DictReader(f))
real = [r for r in rows if r['status'] == 'failed' and r.get('error_code','') not in ('NonMonotonicNonce', 'CrashRecovery', '')]
print(len(real))
PYEOF
    )
    stat_total_condemned=$(python3 - "$DB_LOG" <<'PYEOF'
import csv, sys
with open(sys.argv[1]) as f:
    rows = list(csv.DictReader(f))
condemned = [r for r in rows if r['status'] == 'failed' and r.get('error_code','') == 'NonMonotonicNonce']
print(len(condemned))
PYEOF
    )
    # Real failures grouped by error_code (excludes NonMonotonicNonce + CrashRecovery).
    python3 - "$DB_LOG" "$ERROR_COUNTS" <<'PYEOF'
import csv, sys
from collections import Counter
with open(sys.argv[1]) as f:
    rows = list(csv.DictReader(f))
codes = Counter(
    r['error_code'] for r in rows
    if r['status'] == 'failed' and r.get('error_code','') not in ('NonMonotonicNonce', 'CrashRecovery', '')
)
with open(sys.argv[2], 'w') as out:
    for code, count in codes.most_common():
        out.write(f'{code}\t{count}\n')
PYEOF
  fi

  # End-to-end latency per symbol — from the final summary line per tx
  # that carries `total_ms`. p50/p95 with awk.
  jq -rs '
    [.[] | select(.event=="tx_confirmed" and .symbol and .total_ms)]
    | .[] | "\(.symbol)\t\(.total_ms)"
  ' "$TX_LOG" 2>/dev/null \
    | awk -F'\t' '
        { a[$1] = a[$1] " " $2 }
        END {
          for (sym in a) {
            n = split(a[sym], arr, " ")
            # arr[1] is "" (leading space); shift
            for (i = 1; i < n; i++) arr[i] = arr[i+1]
            n -= 1
            # bubble sort (n ≤ ~thousands; fine for evidence packaging)
            for (i = 1; i <= n; i++) for (j = i+1; j <= n; j++)
              if (arr[i] > arr[j]) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
            p50_i = int(n * 0.5) + 1; if (p50_i > n) p50_i = n
            p95_i = int(n * 0.95) + 1; if (p95_i > n) p95_i = n
            printf "%s\t%d\t%d\t%d\n", sym, n, arr[p50_i], arr[p95_i]
          }
        }
      ' > "$LATENCY_FILE" 2>/dev/null || true

  # Reorgs from the metric (if API snapshot succeeded).
  if [[ -f "$OUT_DIR/api/metrics.txt" ]]; then
    stat_total_reorgs=$(awk '
      /^dia_bridge_transactions_reorg_total\{/ { sum += $NF }
      END { printf "%d", sum + 0 }
    ' "$OUT_DIR/api/metrics.txt")
  fi
fi

# ---------------------------------------------------------------------------
# Step 5b — capture alert evidence: the live Prometheus alert state at pack time
# plus the canonical catalog + remediation rendered from alerts.yml. Degrades
# gracefully — a missing Prometheus or toolchain falls back to a static catalog.
# ---------------------------------------------------------------------------
echo "[package-m2] step 5b — capturing alert state + remediation"
PROM_URL="${PROM_URL:-http://localhost:9090}"
ALERTS_ACTIVE_JSON="$OUT_DIR/alerts-active.json"
if curl -fsS --max-time 5 "$PROM_URL/api/v1/alerts" -o "$ALERTS_ACTIVE_JSON" 2>/dev/null; then
  echo "[package-m2]   captured live alert state from Prometheus"
else
  echo '{"status":"unavailable","data":{"alerts":[]}}' > "$ALERTS_ACTIVE_JSON"
  echo "[package-m2]   Prometheus not reachable — alerts-active.json marked unavailable" >&2
fi
ALERTS_MD="$(cd "$REPO_ROOT/offchain/feeder" \
  && EVIDENCE_NETWORK="$NETWORK" node --import tsx/esm scripts/m2-evidence/build-alerts.ts "$ALERTS_ACTIVE_JSON" 2>/dev/null)" || true
if [ -z "$ALERTS_MD" ]; then
  echo "[package-m2]   build-alerts.ts unavailable — falling back to static catalog" >&2
  ALERTS_MD="Source of truth: [per-network alert rules](../../../../offchain/feeder/monitoring/$NETWORK/alerts.yml)."
  ALERTS_MD+=$'\nCanonical thresholds: `infrastructure.<network>.yaml::alerting.*`.\n\nThe 12 alert rules (OraclePairStale, ReceiverBalanceLow, SettleOverdue, PaymentHookWithdrawReady, AdminWalletLow, AdminWalletFragmented, PriceDeviationHigh, PriceAgeHigh, ReorgRateHigh, ReceiverDepositsPending, PrimaryProviderDown, SecondaryProviderDown) and their exact remediation commands are defined in `alerts.yml`; the live snapshot is in `alerts-active.json`.'
fi

# ---------------------------------------------------------------------------
# Step 5c — capture the active push-policy config (which "when to push" mode
# each client used this run). The full matrix of modes lives in the audit doc.
# ---------------------------------------------------------------------------
echo "[package-m2] step 5c — capturing push-policy config"
PUSH_BLOCK="$( for f in "$REPO_ROOT"/offchain/feeder/config/routers/"$NETWORK"/*.yaml; do
    [ -f "$f" ] || continue
    echo "# $(basename "$f")"
    grep -E "^[[:space:]]*(price_deviation|time_threshold|max_staleness|cron):" "$f" | sed 's/^[[:space:]]*/  /'
  done 2>/dev/null )"
[ -n "$PUSH_BLOCK" ] || PUSH_BLOCK="(router config not found at config/routers/$NETWORK/)"
PUSH_MD="$(printf '%s\n' \
  "When the feeder pushes an oracle update is decided per pair by an OR-gate over a few knobs." \
  "**This run's config** (\`config/routers/$NETWORK/<client>.yaml\`, \`destinations[].*\`):" \
  "" \
  '```yaml' \
  "$PUSH_BLOCK" \
  '```' \
  "" \
  "With \`time_threshold > 0\` + \`cron: true\` + \`price_deviation\`, this is the **classic OR-gate + cron heartbeat**: a pair pushes when the price moves at least \`price_deviation\` **OR** every \`time_threshold\` (the cron heartbeat fires even if no new DIA intent arrives), so **max staleness ≈ \`time_threshold\`**. No \`max_staleness\` key is set — and it would be ignored here anyway, because it only applies when \`time_threshold\` is absent or \`0\`." \
  "" \
  "The other modes (and their effect on push frequency / max staleness / tx volume) are documented in full:" \
  "**[docs/audit/20260609-feeder-push-policy-config.md](../../../audit/20260609-feeder-push-policy-config.md)**. In short:" \
  "" \
  "- **OR-gate + heartbeat** (this run): move-based fast path + a \`time_threshold\` ceiling guaranteed by cron. Bounded staleness, medium tx." \
  "- **Deviation-only mode** (\`time_threshold: 0s\` + \`max_staleness\`): push only on a real price move, with \`max_staleness\` as the backstop. Fewest tx, ceiling = \`max_staleness\`." \
  "- **Periodic only** (\`time_threshold\` + \`cron\`, no \`price_deviation\`): a steady heartbeat every \`time_threshold\`, no fast path on a spike." \
  "- **Push-everything** (no knobs): every monotonic intent is submitted — highest tx volume." \
  "" \
  "In every mode, out-of-order (\`timestamp_regression\`) and duplicate (\`timestamp_duplicate\`) intents are dropped before anything is built." )"

# ---------------------------------------------------------------------------
# Step 5d — run the test suites and capture the REAL result (proof, not a
# claim). Feeder uses node:test (machine-readable "# tests/# pass/# fail"); the
# CLI uses a custom runner (pass/fail by exit code). Full output is saved as a
# pack artifact under tests/ and the counts are surfaced in the report.
# ---------------------------------------------------------------------------
echo "[package-m2] step 5d — running + capturing test suites"
mkdir -p "$OUT_DIR/tests"
FEEDER_TEST_LOG="$OUT_DIR/tests/feeder-tests.txt"
CLI_TEST_LOG="$OUT_DIR/tests/cli-tests.txt"

( cd "$REPO_ROOT/offchain/feeder" && npm test ) > "$FEEDER_TEST_LOG" 2>&1
feeder_test_exit=$?
CLI_HAS_TESTS=1
( cd "$REPO_ROOT/offchain/cli" && npm test ) > "$CLI_TEST_LOG" 2>&1
cli_test_exit=$?

stat_feeder_tests=$(grep -E '^# tests '  "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
stat_feeder_pass=$(grep  -E '^# pass '   "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
stat_feeder_fail=$(grep  -E '^# fail '   "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
stat_feeder_suites=$(grep -E '^# suites ' "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
: "${stat_feeder_tests:=0}" "${stat_feeder_pass:=0}" "${stat_feeder_fail:=0}" "${stat_feeder_suites:=0}"
feeder_result=$([ "$feeder_test_exit" = "0" ] && echo "PASS" || echo "FAIL")
cli_result=$([ "$cli_test_exit" = "0" ] && echo "PASS" || echo "FAIL")
echo "[package-m2]   feeder: $feeder_result ($stat_feeder_pass/$stat_feeder_tests, $stat_feeder_suites suites) — cli: $cli_result"

# ---------------------------------------------------------------------------
# Step 6 — write SUMMARY.json + milestone-2-preview-evidence.md.
# ---------------------------------------------------------------------------
echo "[package-m2] step 6/6 — generating SUMMARY.json + evidence markdown"

# SUMMARY.json — single machine-readable record of the pack.
jq -n \
  --arg stamp     "$STAMP" \
  --arg first     "$stat_first_event_iso" \
  --arg last      "$stat_last_event_iso" \
  --argjson confirmed  "$stat_total_confirmed" \
  --argjson failed     "$stat_total_failed" \
  --argjson condemned  "$stat_total_condemned" \
  --argjson reorgs     "$stat_total_reorgs" \
  --argjson feeder_tests "$stat_feeder_tests" \
  --argjson feeder_pass  "$stat_feeder_pass" \
  --argjson feeder_fail  "$stat_feeder_fail" \
  --arg     feeder_result "$feeder_result" \
  --arg     cli_result    "$cli_result" \
  '{
    pack_stamp: $stamp,
    window: { first_event_iso: $first, last_event_iso: $last },
    totals: {
      tx_confirmed:   $confirmed,
      tx_failed:      $failed,
      tx_condemned:   $condemned,
      reorgs:         $reorgs
    },
    tests: {
      feeder: { result: $feeder_result, total: $feeder_tests, pass: $feeder_pass, fail: $feeder_fail },
      cli:    { result: $cli_result }
    }
  }' > "$OUT_DIR/SUMMARY.json"

# Helper: render a TSV as a markdown table (col1 | col2 [| ...]).
tsv_to_md_table() {
  local file="$1"; shift
  local headers=("$@")
  [[ ! -s "$file" ]] && { echo "_(no data)_"; return; }
  local hdr="|"
  local sep="|"
  for h in "${headers[@]}"; do hdr+=" $h |"; sep+=" --- |"; done
  echo "$hdr"
  echo "$sep"
  awk -F'\t' '{
    printf "|"; for (i = 1; i <= NF; i++) printf " %s |", $i; printf "\n"
  }' "$file"
}

# Evidence markdown — structure mirrors the M1 preview evidence doc.
cat > "$OUT_DIR/$MD_FILE" <<EOF
# Milestone 2 ${NETWORK_DISPLAY} Evidence

Source of truth: [\`final-cardano-milestones.md\`](../../final-cardano-milestones.md).

Scope: Milestone 2 (Data Feeder and Documentation) validation on
Cardano ${NETWORK_DISPLAY} ↔ DIA ${DIA_NETWORK}.

Pack stamp: **$STAMP**

Window observed in \`transactions.jsonl\`:

- First tx event: \`$stat_first_event_iso\`
- Last tx event:  \`$stat_last_event_iso\`

Evidence pack location: this directory.

## Contents

- [Official Milestone 2 Outputs](#official-milestone-2-outputs)
- [Test results](#test-results)
- [Totals (this window)](#totals-this-window)
- [Confirmed Cardano tx count per pair](#confirmed-cardano-tx-count-per-pair)
- [Sample Cardano tx hashes (one per pair, first observed)](#sample-cardano-tx-hashes-one-per-pair-first-observed)
- [End-to-end latency per pair](#end-to-end-latency-per-pair)
- [Failures (grouped by error_code)](#failures-grouped-by-error_code)
- [Raw artefacts in this pack](#raw-artefacts-in-this-pack)
- [Push policy (this run)](#push-policy-this-run)
- [Dashboards](#dashboards)
  - [Overview dashboard](#overview-dashboard)
  - [Overview panels](#overview-panels)
  - [Transactions dashboard](#transactions-dashboard)
  - [Transactions panels](#transactions-panels)
- [Alerts active during the window](#alerts-active-during-the-window)

## Official Milestone 2 Outputs

| Official output | Repository status |
| --- | --- |
| Feeder scripts | Complete: \`offchain/feeder/\` (TypeScript, Node 22, ESM). |
| Test coverage | Feeder \`npm test\`: **$stat_feeder_pass / $stat_feeder_tests passing**, $stat_feeder_fail failed ($stat_feeder_suites suites) — **$feeder_result**. CLI \`npm test\`: **$cli_result**. Full output captured in [\`tests/\`](tests/). See [Test results](#test-results). |
| Uptime / accuracy reports | This pack: per-pair confirmed counts + latency + reorg stats. |
| QA review logs | This pack: \`logs/feeder.log\`, \`logs/transactions.jsonl\`, \`logs/lane.jsonl\`, \`logs/intents/\`. |
| Automated alerts | Complete: \`offchain/feeder/monitoring/$NETWORK/alerts.yml\` (12 alert rules; canonical thresholds in \`infrastructure.<network>.yaml::alerting.*\`). |
| Real-time dashboards | Complete: \`dashboards/\` (PNG snapshots taken at pack time). Source JSON: [\`offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json\`](../../../../offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json). |
| Developer documentation | Complete: [feeder README](../../../../offchain/feeder/README.md), [CLI README](../../../../offchain/cli/README.md), [architecture](../../../architecture/cardano-oracle-architecture.md). |

## Test results

Both test suites were run when this pack was assembled; the full console output is
saved alongside this report.

| Suite | Result | Tests | Suites | Output |
| --- | --- | ---: | ---: | --- |
| Feeder (\`offchain/feeder\`, \`npm test\`) | **$feeder_result** | $stat_feeder_pass / $stat_feeder_tests passing ($stat_feeder_fail failed) | $stat_feeder_suites | [\`tests/feeder-tests.txt\`](tests/feeder-tests.txt) |
| CLI (\`offchain/cli\`, \`npm test\`) | **$cli_result** | — (custom runner; pass/fail by exit code) | — | [\`tests/cli-tests.txt\`](tests/cli-tests.txt) |

## Totals (this window)

| Metric | Value |
| --- | ---: |
| Confirmed Cardano oracle update txs | $stat_total_confirmed |
| Failed Cardano tx attempts (real, tx broadcast) | $stat_total_failed |
| Condemned intents (NonMonotonicNonce — no tx, no fee) | $stat_total_condemned |
| Chain reorgs that dropped a tx | $stat_total_reorgs |

## Confirmed Cardano tx count per pair

$(tsv_to_md_table "$SYMBOL_COUNTS" "Pair" "Confirmed txs")

## Sample Cardano tx hashes (one per pair, first observed)

$(tsv_to_md_table "$SYMBOL_HASHES" "Pair" "Tx hash")

Verify on [${EXPLORER_NAME}](${EXPLORER_URL}) or any
public ${NETWORK_DISPLAY} explorer.

## End-to-end latency per pair

DIA \`IntentRegistered\` → Cardano \`tx_confirmed\`, milliseconds.

$(tsv_to_md_table "$LATENCY_FILE" "Pair" "Samples" "p50 (ms)" "p95 (ms)")

## Failures (grouped by error code)

Real Cardano transaction failures only — a transaction was broadcast and then
failed on-chain. Routine non-failures (an update made obsolete by a newer one
before it was sent, or an update interrupted by a restart) are not counted here.
An empty table means there were no real failures in this run.

$(tsv_to_md_table "$ERROR_COUNTS" "Error code" "Count")

## Raw artefacts in this pack

| Path | Contents |
| --- | --- |
| \`logs/feeder.log\`              | Daemon event stream (mirrors stderr). |
| \`logs/transactions.jsonl\`      | One JSON line per tx pipeline step. |
| \`logs/lane.jsonl\`              | Lane state events (intent_buffered, flush_triggered, …). |
| \`logs/intents/\`                | Per-intent lifecycle files (\`<ts>_<hash>.log\`). |
| \`db/transaction_log.csv\`       | Full \`transaction_log\` table dump from \`feeder.sqlite\`. |
| \`db/processed_events.csv\`      | Full \`processed_events\` table dump. |
| \`db/chain_state.csv\`           | Scanner checkpoint snapshot. |
| \`api/prices.json\`              | \`GET /api/v1/prices\` at pack time. |
| \`api/chains.json\`              | \`GET /api/v1/chains\` at pack time. |
| \`api/symbols.json\`             | \`GET /api/v1/symbols\` at pack time. |
| \`api/metrics.txt\`              | Prometheus \`/metrics\` exposition at pack time. |
| \`dashboards/dashboard-full.png\` | Full Grafana dashboard at pack time. |
| \`dashboards/panel-*.png\`       | Per-panel snapshots. |
| \`stats/\`                       | Intermediate TSV files this markdown was built from. |
| \`tests/feeder-tests.txt\`       | Full \`npm test\` console output for the feeder suite (node:test). |
| \`tests/cli-tests.txt\`          | Full \`npm test\` console output for the CLI suite. |
| \`alerts-active.json\`           | Prometheus \`/api/v1/alerts\` snapshot at pack time. |
| \`SUMMARY.json\`                 | Machine-readable totals (top of this document, as JSON). |

## Push policy (this run)

$PUSH_MD

## Dashboards

Grafana dashboard \`DIA Cardano Oracle Feeder\` (UID \`dia-cardano-feeder\`) —
PNG snapshots taken at pack time over a \`now-3h\` window. Source JSON:
[\`offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json\`](../../../../offchain/feeder/monitoring/$NETWORK/dashboards/feeder.json).

$DASHBOARDS_MD

To reproduce this dashboard live:

\`\`\`sh
cd offchain && make up-monitoring
# then open http://localhost:3000 (default admin/admin) — dashboard is auto-provisioned.
\`\`\`

See the [feeder README — Daemon + monitoring section](../../../../offchain/feeder/README.md#daemon--monitoring)
for the canonical operator instructions.

## Alerts active during the window

$ALERTS_MD
EOF

echo "[package-m2] done."
echo "[package-m2] open: $OUT_DIR/$MD_FILE"
