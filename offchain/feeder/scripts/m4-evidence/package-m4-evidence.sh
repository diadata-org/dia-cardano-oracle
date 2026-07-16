#!/usr/bin/env bash
#
# package-m4-evidence.sh — assemble the COMPLETE Milestone 4 evidence pack. Two
# halves, one directory:
#
#   (A) Reliability — the sustained-run uptime/accuracy evidence: confirmed /
#       failed / condemned / reorg tallies, per-pair confirmed counts + sample
#       Cardano tx hashes, the per-feed sanity (accuracy) check, the test suites
#       (Aiken + feeder + CLI + indexer), all summarised in SUMMARY.json. This is the
#       same reliability machinery the M2/M3 packs use, read from the run's
#       logs + SQLite + live feeder metrics.
#
#   (B) Consumer — the net-new M4 surface: the indexer's live HTTP responses,
#       the example consumer contract reading a feed through it (emulator +
#       on-chain), the published Pair policy ids + addresses, and live renders
#       of the five Grafana dashboards.
#
# This is what `make evidence4` runs; it also runs standalone. Read-only: it
# never writes a transaction. The feeder/indexer may keep running.
#
# Env vars (all optional; `make evidence4` sets EVIDENCE_NETWORK + EVIDENCE_STAMP):
#   EVIDENCE_NETWORK      Cardano network (preview | mainnet). Default: preview.
#   EVIDENCE_STAMP        Shared dir stamp. Default: the resolved run-dir id, else
#                         a UTC timestamp.
#   EVIDENCE_DASH_FROM    Grafana render-window start. Default: now-3d (spans the
#                         sustained multi-day run). Use now-3h for a short bring-up.
#   INDEXER_URL           Indexer base URL. Default: http://localhost:<INDEXER_HOST_PORT>
#                         read from feeder/.env (fallback :3001).
#   GRAFANA_URL           Grafana base URL for the dashboard renders. Default:
#                         http://localhost:<GRAFANA_HOST_PORT> from feeder/.env
#                         (fallback :3000; GRAFANA_ADMIN_PASSWORD for auth).
#   FEEDER_API_URL        Feeder API for the reorg metric. Default:
#                         http://localhost:<FEEDER_HOST_PORT> from feeder/.env (fallback :8080).
#   PROM_URL              Prometheus base URL. Default:
#                         http://localhost:<PROMETHEUS_HOST_PORT> from feeder/.env (fallback :9090).
#   DEMO_SYMBOL           Sample pair for the per-pair captures. Default: first pair
#                         the indexer reports (else the first confirmed on-chain).
#   EVIDENCE_ONCHAIN_LOG  Path to a saved run of run-consumer-demo-onchain.sh
#                         (e.g. produced with `… | tee onchain.txt`). Embedded when set.
#   EVIDENCE_SKIP_TESTS   Set to 1 to skip the test-suite step (quick re-renders).
#   RUN_ID                Per-run state dir selector (newest when empty).
#
# Output: docs/milestones/evidence/m4-<network>-<stamp>/  (a -01, -02 … suffix is
#         appended when a pack for that stamp already exists)
#
# Dependencies: bash, jq, curl, sqlite3, awk, python3. (aiken + node for the demos + tests.)

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths — network + stamp from env; output dir name follows the network.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/m4-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
NETWORK="$(echo "${EVIDENCE_NETWORK:-preview}" | tr '[:upper:]' '[:lower:]')"
NETWORK_DISPLAY="$(tr '[:lower:]' '[:upper:]' <<<"${NETWORK:0:1}")${NETWORK:1}"
# Display name + paired DIA source + explorer so the markdown matches the network.
if [[ "$NETWORK" == "mainnet" ]]; then
  DIA_NETWORK="Mainnet"; EXPLORER_NAME="Cardanoscan"; EXPLORER_URL="https://cardanoscan.io/"
else
  DIA_NETWORK="Testnet"; EXPLORER_NAME="Cardanoscan Preview"; EXPLORER_URL="https://preview.cardanoscan.io/"
fi

# The pack runs on the HOST, so it reaches each service on its PUBLISHED host
# port — configured in ONE place, feeder/.env (see .env.example "Docker host
# ports"). Read them here so remapping a port there is all it takes; fall back to
# the container-internal default when a var is unset. An explicit *_URL env still
# wins over both.
ENV_FILE="$REPO_ROOT/offchain/feeder/.env"
env_port() { # $1=var name in feeder/.env, $2=fallback port
  local value=""
  [[ -f "$ENV_FILE" ]] && value="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '[:space:]')"
  printf '%s' "${value:-$2}"
}
FEEDER_HOST_PORT="$(env_port FEEDER_HOST_PORT 8080)"
INDEXER_HOST_PORT="$(env_port INDEXER_HOST_PORT 3001)"
GRAFANA_HOST_PORT="$(env_port GRAFANA_HOST_PORT 3000)"
PROMETHEUS_HOST_PORT="$(env_port PROMETHEUS_HOST_PORT 9090)"

INDEXER_URL="${INDEXER_URL:-http://localhost:${INDEXER_HOST_PORT}}"
INDEXER_URL="${INDEXER_URL%/}"

# Grafana (for the dashboard PNG snapshots). The renderer sidecar comes up with
# `make up MONITORING=1`.
GRAFANA_URL="${GRAFANA_URL:-http://localhost:${GRAFANA_HOST_PORT}}"
GRAFANA_USER="${GRAFANA_USER:-admin}"
GRAFANA_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
# Render window: default now-3d so a full multi-day sustained run is visible.
DASH_FROM="${EVIDENCE_DASH_FROM:-now-3d}"

# Feeder API (reorg metric) + Prometheus.
FEEDER_API_URL="${FEEDER_API_URL:-http://localhost:${FEEDER_HOST_PORT}}"
PROM_URL="${PROM_URL:-http://localhost:${PROMETHEUS_HOST_PORT}}"

STATE_ROOT="$REPO_ROOT/offchain/state"
if [[ -n "${RUN_ID:-}" ]]; then
  STATE_DIR="$STATE_ROOT/${NETWORK}_run_${RUN_ID}"
else
  newest="$(ls -d "$STATE_ROOT/${NETWORK}_run_"*/ 2>/dev/null | sort | tail -1 || true)"
  STATE_DIR="${newest%/}"
fi
STATE_DIR="${STATE_DIR:-$STATE_ROOT/$NETWORK}"
RUN_LABEL="$(basename "${STATE_DIR:-${NETWORK}}")"
LOGS_DIR="$STATE_DIR/logs"
SQLITE_FILE="$STATE_DIR/feeder.sqlite"

STAMP="${EVIDENCE_STAMP:-}"
if [[ -z "$STAMP" ]]; then
  if [[ "$RUN_LABEL" == ${NETWORK}_run_* ]]; then STAMP="${RUN_LABEL#${NETWORK}_run_}"; else STAMP="$(date -u +%Y%m%d-%H%M%S)"; fi
fi

OUT_BASE="$REPO_ROOT/docs/milestones/evidence/m4-${NETWORK}-${STAMP}"
OUT_DIR="$OUT_BASE"
suffix=1
while [[ -e "$OUT_DIR" ]]; do OUT_DIR="$(printf '%s-%02d' "$OUT_BASE" "$suffix")"; suffix=$((suffix + 1)); done
mkdir -p "$OUT_DIR/indexer" "$OUT_DIR/consumer-demo" "$OUT_DIR/dashboards" \
         "$OUT_DIR/logs" "$OUT_DIR/db" "$OUT_DIR/stats" "$OUT_DIR/sanity" "$OUT_DIR/tests"
MD_FILE="milestone-4-${NETWORK}-evidence.md"

# Required tools (reliability half needs sqlite3/awk/python3 too).
for tool in jq curl sqlite3 awk python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "fatal: required tool '$tool' not found on PATH" >&2; exit 1; }
done

echo "[package-m4] network=$NETWORK_DISPLAY stamp=$STAMP run=$RUN_LABEL"
echo "[package-m4] indexer=$INDEXER_URL grafana-window=$DASH_FROM"
echo "[package-m4] output: $OUT_DIR"

# ===========================================================================
# PART A — RELIABILITY (uptime / accuracy): logs + DB + stats + sanity + tests.
# ===========================================================================

# ---------------------------------------------------------------------------
# A1. Copy raw logs verbatim + dump the SQLite tables as CSV.
# ---------------------------------------------------------------------------
echo "[package-m4] A1 — copying logs + dumping DB"
if [[ -d "$LOGS_DIR" ]]; then
  for f in feeder.log transactions.jsonl lane.jsonl; do
    [[ -f "$LOGS_DIR/$f" ]] && cp "$LOGS_DIR/$f" "$OUT_DIR/logs/$f"
  done
  if [[ -d "$LOGS_DIR/intents" ]]; then
    mkdir -p "$OUT_DIR/logs/intents"
    cp -r "$LOGS_DIR/intents/." "$OUT_DIR/logs/intents/" 2>/dev/null || true
  fi
else
  echo "[package-m4]   WARNING: logs dir not found: $LOGS_DIR"
fi

DB_LOG="$OUT_DIR/db/transaction_log.csv"
DB_PRESENT=0
if [[ -f "$SQLITE_FILE" ]]; then
  DB_PRESENT=1
  for table in transaction_log processed_events chain_state contract_symbol_updates; do
    if sqlite3 "$SQLITE_FILE" ".tables" | grep -qw "$table"; then
      sqlite3 -header -csv "$SQLITE_FILE" "SELECT * FROM $table" > "$OUT_DIR/db/$table.csv"
    fi
  done
else
  echo "[package-m4]   WARNING: sqlite db not found: $SQLITE_FILE — reliability tallies will be empty"
fi

# ---------------------------------------------------------------------------
# A2. Snapshot the feeder API /metrics (for the reorg counter) — best-effort.
# ---------------------------------------------------------------------------
echo "[package-m4] A2 — snapshotting feeder metrics"
FEEDER_METRICS="$OUT_DIR/stats/feeder-metrics.txt"
if curl -fsS --max-time 5 "$FEEDER_API_URL/health/live" >/dev/null 2>&1; then
  curl -fsS "$FEEDER_API_URL/metrics" > "$FEEDER_METRICS" 2>/dev/null || true
else
  echo "[package-m4]   feeder API not reachable at $FEEDER_API_URL — reorgs read as 0"
fi

# ---------------------------------------------------------------------------
# A3. Compute reliability tallies from the DB (source of truth). Same
# definitions as the M2/M3 packs:
#   confirmed — a Cardano tx that landed on-chain.
#   failed    — a broadcast tx that failed on-chain (excludes NonMonotonicNonce
#               and IntentAgedOut = both dropped before any tx was ever built or
#               broadcast, and CrashRecovery = force-failed on a restart: none of
#               the three is a broadcast that failed).
#   condemned — NonMonotonicNonce (superseded on-chain) or IntentAgedOut (aged out
#               of the submission buffer before the lane flushed) — no tx, no fee.
#   reorgs    — already-confirmed txs dropped by a chain reorg (from the metric).
# ---------------------------------------------------------------------------
echo "[package-m4] A3 — computing reliability tallies"
stat_total_confirmed=0
stat_total_failed=0
stat_total_condemned=0
stat_total_reorgs=0
stat_first_iso=""
stat_last_iso=""
SYMBOL_COUNTS="$OUT_DIR/stats/symbol-counts.tsv"
SYMBOL_HASHES="$OUT_DIR/stats/symbol-tx-hashes.tsv"
ERROR_COUNTS="$OUT_DIR/stats/error-counts.tsv"
: > "$SYMBOL_COUNTS"; : > "$SYMBOL_HASHES"; : > "$ERROR_COUNTS"

if [[ "$DB_PRESENT" == 1 ]]; then
  stat_total_confirmed=$(sqlite3 "$SQLITE_FILE" "SELECT COUNT(*) FROM transaction_log WHERE status='confirmed';" 2>/dev/null || echo 0)
  stat_total_failed=$(sqlite3 "$SQLITE_FILE" "SELECT COUNT(*) FROM transaction_log WHERE status='failed' AND COALESCE(error_code,'') NOT IN ('NonMonotonicNonce','IntentAgedOut','CrashRecovery','');" 2>/dev/null || echo 0)
  stat_total_condemned=$(sqlite3 "$SQLITE_FILE" "SELECT COUNT(*) FROM transaction_log WHERE status='failed' AND error_code IN ('NonMonotonicNonce','IntentAgedOut');" 2>/dev/null || echo 0)

  # Window from confirmed txs (falls back to created_at_ms if no confirmed_at).
  first_ms=$(sqlite3 "$SQLITE_FILE" "SELECT MIN(COALESCE(confirmed_at_ms,created_at_ms)) FROM transaction_log WHERE status='confirmed';" 2>/dev/null || echo "")
  last_ms=$(sqlite3 "$SQLITE_FILE" "SELECT MAX(COALESCE(confirmed_at_ms,created_at_ms)) FROM transaction_log WHERE status='confirmed';" 2>/dev/null || echo "")
  [[ -n "$first_ms" && "$first_ms" != "" ]] && stat_first_iso=$(python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])/1000).isoformat()+'Z')" "$first_ms" 2>/dev/null || echo "")
  [[ -n "$last_ms"  && "$last_ms"  != "" ]] && stat_last_iso=$(python3 -c "import datetime,sys;print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])/1000).isoformat()+'Z')" "$last_ms" 2>/dev/null || echo "")

  # Confirmed count per symbol.
  sqlite3 -separator $'\t' "$SQLITE_FILE" \
    "SELECT symbol, COUNT(*) FROM transaction_log WHERE status='confirmed' AND symbol!='' GROUP BY symbol ORDER BY COUNT(*) DESC;" \
    > "$SYMBOL_COUNTS" 2>/dev/null || true

  # First confirmed tx hash per symbol (reviewer spot-check / verifiable hashes).
  sqlite3 -separator $'\t' "$SQLITE_FILE" \
    "SELECT symbol, MIN(cardano_tx_hash) FROM transaction_log WHERE status='confirmed' AND symbol!='' AND cardano_tx_hash!='' GROUP BY symbol;" \
    > "$SYMBOL_HASHES" 2>/dev/null || true

  # Real failures grouped by error_code.
  sqlite3 -separator $'\t' "$SQLITE_FILE" \
    "SELECT error_code, COUNT(*) FROM transaction_log WHERE status='failed' AND COALESCE(error_code,'') NOT IN ('NonMonotonicNonce','IntentAgedOut','CrashRecovery','') GROUP BY error_code ORDER BY COUNT(*) DESC;" \
    > "$ERROR_COUNTS" 2>/dev/null || true
fi

# Reorgs from the feeder metric (if snapshot succeeded).
if [[ -f "$FEEDER_METRICS" ]]; then
  stat_total_reorgs=$(awk '/^dia_bridge_transactions_reorg_total\{/ { sum += $NF } END { printf "%d", sum + 0 }' "$FEEDER_METRICS")
fi
: "${stat_total_confirmed:=0}" "${stat_total_failed:=0}" "${stat_total_condemned:=0}" "${stat_total_reorgs:=0}"

echo "[package-m4]   confirmed=$stat_total_confirmed failed=$stat_total_failed condemned=$stat_total_condemned reorgs=$stat_total_reorgs"

# ---------------------------------------------------------------------------
# A4. Per-feed sanity (accuracy) — on-chain value vs latest DIA source.
# Best-effort: needs the Cardano chain + DIA registry reachable.
# ---------------------------------------------------------------------------
echo "[package-m4] A4 — per-feed sanity (accuracy)"
if SANITY_OUT_DIR="$OUT_DIR/sanity" CARDANO_NETWORK="$NETWORK_DISPLAY" \
     bash -c "cd '$REPO_ROOT/offchain/feeder' && npm run --silent sanity:feeds" \
     > "$OUT_DIR/sanity/sanity-run.log" 2>&1 && [ -f "$OUT_DIR/sanity/feed-sanity.md" ]; then
  echo "[package-m4]   feed sanity captured"
  SANITY_MD="$(cat "$OUT_DIR/sanity/feed-sanity.md")"
else
  echo "[package-m4]   feed sanity unavailable (chain/registry not reachable) — noting in report" >&2
  SANITY_MD=$'_The per-feed sanity check did not run when this pack was assembled (the Cardano chain or DIA registry was not reachable). Run it against a live deployment with:_\n\n```sh\ncd offchain/feeder && npm run sanity:feeds\n```\n\n_It compares each live on-chain Pair value (price, timestamp) against the latest DIA `IntentRegistered` for the symbol and judges accuracy + freshness against that feed'\''s own push-policy thresholds._'
fi

# ---------------------------------------------------------------------------
# A5. Run the test suites and capture the real result.
# ---------------------------------------------------------------------------
AIKEN_TEST_LOG="$OUT_DIR/tests/aiken-tests.txt"
FEEDER_TEST_LOG="$OUT_DIR/tests/feeder-tests.txt"
CLI_TEST_LOG="$OUT_DIR/tests/cli-tests.txt"
INDEXER_TEST_LOG="$OUT_DIR/tests/indexer-tests.txt"
stat_aiken_tests=0; stat_aiken_pass=0; stat_aiken_fail=0
stat_feeder_tests=0; stat_feeder_pass=0; stat_feeder_fail=0; stat_feeder_suites=0
aiken_result="skipped"; feeder_result="skipped"; cli_result="skipped"; indexer_result="skipped"
if [[ "${EVIDENCE_SKIP_TESTS:-0}" == "1" ]]; then
  echo "[package-m4] A5 — tests SKIPPED (EVIDENCE_SKIP_TESTS=1)"
  echo "skipped (EVIDENCE_SKIP_TESTS=1)" | tee "$AIKEN_TEST_LOG" "$FEEDER_TEST_LOG" "$CLI_TEST_LOG" "$INDEXER_TEST_LOG" >/dev/null
else
  echo "[package-m4] A5 — running + capturing test suites (Aiken + feeder + CLI + indexer)"
  set +e
  ( cd "$REPO_ROOT/contracts/aiken"   && aiken check ) > "$AIKEN_TEST_LOG"  2>&1; aiken_exit=$?
  ( cd "$REPO_ROOT/offchain/feeder"  && npm test ) > "$FEEDER_TEST_LOG"  2>&1; feeder_exit=$?
  ( cd "$REPO_ROOT/offchain/cli"     && npm test ) > "$CLI_TEST_LOG"     2>&1; cli_exit=$?
  ( cd "$REPO_ROOT/offchain/indexer" && npm test ) > "$INDEXER_TEST_LOG" 2>&1; indexer_exit=$?
  set -e
  stat_aiken_tests=$(grep -m1 '"total"' "$AIKEN_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_aiken_pass=$(grep -m1 '"passed"' "$AIKEN_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_aiken_fail=$(grep -m1 '"failed"' "$AIKEN_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_feeder_tests=$(grep -E '^# tests '  "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_feeder_pass=$(grep  -E '^# pass '    "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_feeder_fail=$(grep  -E '^# fail '    "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  stat_feeder_suites=$(grep -E '^# suites ' "$FEEDER_TEST_LOG" | grep -oE '[0-9]+' | head -1)
  : "${stat_aiken_tests:=0}" "${stat_aiken_pass:=0}" "${stat_aiken_fail:=0}"
  : "${stat_feeder_tests:=0}" "${stat_feeder_pass:=0}" "${stat_feeder_fail:=0}" "${stat_feeder_suites:=0}"
  aiken_result=$([ "$aiken_exit" = "0" ] && echo "PASS" || echo "FAIL")
  feeder_result=$([ "$feeder_exit" = "0" ] && echo "PASS" || echo "FAIL")
  cli_result=$([ "$cli_exit" = "0" ] && echo "PASS" || echo "FAIL")
  indexer_result=$([ "$indexer_exit" = "0" ] && echo "PASS" || echo "FAIL")
  echo "[package-m4]   aiken: $aiken_result ($stat_aiken_pass/$stat_aiken_tests) — feeder: $feeder_result ($stat_feeder_pass/$stat_feeder_tests) — cli: $cli_result — indexer: $indexer_result"
fi

# ===========================================================================
# PART B — CONSUMER (net-new M4): indexer + consumer demo + addresses.
# ===========================================================================

# ---------------------------------------------------------------------------
# B1. Indexer live HTTP responses (read-only).
# ---------------------------------------------------------------------------
echo "[package-m4] B1 — capturing indexer endpoints"
INDEXER_UP=0
# The health probe queries the chain tip through the indexer, which occasionally
# takes several seconds under provider load. Retry a few times before giving up so
# a momentary slowdown does not blank out the whole indexer section of the pack.
INDEXER_HEALTH_ATTEMPTS="${INDEXER_HEALTH_ATTEMPTS:-3}"
for attempt in $(seq 1 "$INDEXER_HEALTH_ATTEMPTS"); do
  if curl -fsS --max-time 30 "$INDEXER_URL/v1/health" -o "$OUT_DIR/indexer/health.json" 2>/dev/null; then
    INDEXER_UP=1
    break
  fi
  echo "[package-m4]   indexer health attempt ${attempt}/${INDEXER_HEALTH_ATTEMPTS} failed — retrying"
  sleep 3
done
if [[ "$INDEXER_UP" == 1 ]]; then
  echo "[package-m4]   indexer reachable"
  curl -fsS --max-time 30 "$INDEXER_URL/v1/pairs"        -o "$OUT_DIR/indexer/pairs.json"   2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/v1/openapi.json" -o "$OUT_DIR/indexer/openapi.json" 2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/metrics"         -o "$OUT_DIR/indexer/metrics.txt"  2>/dev/null || true

  SAMPLE_SYMBOL="${DEMO_SYMBOL:-}"
  if [[ -z "$SAMPLE_SYMBOL" && -s "$OUT_DIR/indexer/pairs.json" ]]; then
    SAMPLE_SYMBOL="$(jq -r '.pairs[0].symbol // empty' "$OUT_DIR/indexer/pairs.json" 2>/dev/null || true)"
  fi
  # Fall back to the first confirmed on-chain symbol, else a generic label.
  if [[ -z "$SAMPLE_SYMBOL" && -s "$SYMBOL_COUNTS" ]]; then
    SAMPLE_SYMBOL="$(awk -F'\t' 'NR==1{print $1}' "$SYMBOL_COUNTS")"
  fi
  SAMPLE_SYMBOL="${SAMPLE_SYMBOL:-ARS/USDT}"
  enc="$(jq -rn --arg s "$SAMPLE_SYMBOL" '$s|@uri')"
  curl -fsS --max-time 15 "$INDEXER_URL/v1/pairs/$enc"      -o "$OUT_DIR/indexer/sample-pair.json" 2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/v1/pairs/$enc/utxo" -o "$OUT_DIR/indexer/sample-utxo.json" 2>/dev/null || true
else
  echo "[package-m4]   WARNING: indexer not reachable at $INDEXER_URL — start it (cd offchain && make up) and re-run."
fi

# ---------------------------------------------------------------------------
# B2. End-to-end consumer demo — emulator (offline, deterministic).
# ---------------------------------------------------------------------------
EMULATOR_OK=0
EMU_LOG="$OUT_DIR/consumer-demo/emulator.txt"
echo "[package-m4] B2 — running the emulator consumer demo…"
if bash "$REPO_ROOT/offchain/indexer/src/examples/run-consumer-demo-emulator.sh" >"$EMU_LOG" 2>&1; then
  EMULATOR_OK=1
  echo "[package-m4]   emulator demo passed"
else
  echo "[package-m4]   WARNING: emulator demo did not pass — see $EMU_LOG"
fi

# ---------------------------------------------------------------------------
# B3. On-chain consumer demo — embed a saved run if provided.
# ---------------------------------------------------------------------------
ONCHAIN_PRESENT=0
if [[ -n "${EVIDENCE_ONCHAIN_LOG:-}" && -f "${EVIDENCE_ONCHAIN_LOG}" ]]; then
  cp "${EVIDENCE_ONCHAIN_LOG}" "$OUT_DIR/consumer-demo/onchain.txt"
  ONCHAIN_PRESENT=1
  echo "[package-m4]   embedded on-chain demo log from $EVIDENCE_ONCHAIN_LOG"
fi

# ---------------------------------------------------------------------------
# B4. Dashboard snapshots — a full render of each of the five Grafana dashboards
#     over the run window (Overview, Transactions, Internals, Signer Wallets,
#     Operational Cost). Needs the monitoring profile up (make up MONITORING=1).
# ---------------------------------------------------------------------------
render_dashboard() {
  local uid="$1" slug="$2" out_png="$3"
  curl -fsS --max-time 30 -u "$GRAFANA_USER:$GRAFANA_PASS" -o "$out_png" \
    "$GRAFANA_URL/render/d/$uid/$slug?orgId=1&from=$DASH_FROM&to=now&width=1600&height=2400&kiosk=tv&tz=UTC"
}

echo "[package-m4] B4 — rendering dashboards (window $DASH_FROM → now)"
DASHBOARDS_MD=""
if curl -fsS --max-time 5 "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
  echo "[package-m4]   Grafana reachable — rendering dashboards"
  render_dashboard "dia-cardano-feeder" "dia-cardano-oracle-feeder" "$OUT_DIR/dashboards/overview-full.png" 2>/dev/null \
    && DASHBOARDS_MD+=$'### Overview dashboard\n\n![Overview — full dashboard](dashboards/overview-full.png)\n\n_Is each price feed alive, fresh, accurate and funded? A batch of N pairs counts as N symbol updates here._\n'
  render_dashboard "dia-cardano-feeder-tx" "dia-cardano-oracle-feeder-transactions" "$OUT_DIR/dashboards/tx-full.png" 2>/dev/null \
    && DASHBOARDS_MD+=$'\n### Transactions dashboard\n\n![Transactions — full dashboard](dashboards/tx-full.png)\n\n_The per-transaction view: a batch of N pairs is ONE transaction. Stage latency, confirmed-vs-failed throughput, success ratio, batch size._\n'
  render_dashboard "dia-cardano-feeder-internals" "dia-cardano-oracle-feeder-internals" "$OUT_DIR/dashboards/internals-full.png" 2>/dev/null \
    && DASHBOARDS_MD+=$'\n### Internals dashboard\n\n![Internals — full dashboard](dashboards/internals-full.png)\n\n_Feeder-internal observability: pipeline-phase latency, scanner, worker pools, DB, cron/recovery, provider health._\n'
  render_dashboard "feeder-wallets" "feeder-signer-wallets" "$OUT_DIR/dashboards/wallets-full.png" 2>/dev/null \
    && DASHBOARDS_MD+=$'\n### Signer Wallets dashboard\n\n![Signer Wallets — full dashboard](dashboards/wallets-full.png)\n\n_Per signer-wallet health for the multi-wallet pool: spendable balance, collateral floor (largest UTxO), usable-UTxO count, and active arbiter reservations. With no pool configured this shows the single `main` wallet._\n'
  render_dashboard "feeder-cost" "feeder-operational-cost" "$OUT_DIR/dashboards/cost-full.png" 2>/dev/null \
    && DASHBOARDS_MD+=$'\n### Operational Cost dashboard\n\n![Operational Cost — full dashboard](dashboards/cost-full.png)\n\n_What it costs to run the system: ADA fees of the management txs (settle, withdraw, main→pool funding, defrag, wallet shaping, standalone deposit merge) by kind and signer wallet. The top row is the cumulative snapshot; the time-series row below shows when each tx ran and how the cost grew._\n'
  if [[ -z "$DASHBOARDS_MD" ]]; then
    DASHBOARDS_MD="_Grafana was reachable but the image renderer was not responding — no PNGs captured. Bring up the monitoring profile (\`cd offchain && make up MONITORING=1\`) and re-run._"
  fi
else
  echo "[package-m4]   WARNING: Grafana not reachable at $GRAFANA_URL — skipping dashboard snapshots"
  DASHBOARDS_MD="_Grafana was not reachable at $GRAFANA_URL when this pack was assembled — no dashboard PNGs. Start the monitoring stack (\`cd offchain && make up MONITORING=1\`) and re-run._"
fi

# ===========================================================================
# ASSEMBLE — markdown helpers, SUMMARY.json, then the report.
# ===========================================================================

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
  awk -F'\t' '{ printf "|"; for (i = 1; i <= NF; i++) printf " %s |", $i; printf "\n" }' "$file"
}

pairs_table() {
  if [[ "$INDEXER_UP" == 1 && -s "$OUT_DIR/indexer/pairs.json" ]]; then
    echo "| Symbol | Price | Age (s) | Client | Pair UTxO (TxIn) |"
    echo "| --- | --- | --- | --- | --- |"
    jq -r '.pairs[] | "| \(.symbol) | \(.price) | \(.ageSeconds) | \(.clientId) | \(.utxoRef.txHash)#\(.utxoRef.outputIndex) |"' \
      "$OUT_DIR/indexer/pairs.json"
  else
    echo "_Indexer not reachable at pack time — start it and re-run to populate this table._"
  fi
}
addresses_table() {
  if [[ "$INDEXER_UP" == 1 && -s "$OUT_DIR/indexer/pairs.json" ]]; then
    echo "| Client | Pair policy id | Symbols |"
    echo "| --- | --- | --- |"
    jq -r '[.pairs[] | {clientId, pairPolicyId, symbol}] | group_by(.clientId)[] |
      "| \(.[0].clientId) | \(.[0].pairPolicyId) | \([.[].symbol] | join(", ")) |"' \
      "$OUT_DIR/indexer/pairs.json"
  else
    echo "_See offchain/indexer/README.md → Published contract addresses._"
  fi
}
sample_block() {
  if [[ -s "$OUT_DIR/indexer/sample-pair.json" ]]; then
    echo '```json'; jq '.' "$OUT_DIR/indexer/sample-pair.json"; echo '```'
  else
    echo "_No sample captured._"
  fi
}
file_block() { if [[ -s "$1" ]]; then echo '```'; cat "$1"; echo '```'; else echo "_$2_"; fi; }

HEALTH_SUMMARY="indexer not reachable at pack time"
PAIR_COUNT="—"
if [[ "$INDEXER_UP" == 1 && -s "$OUT_DIR/indexer/health.json" ]]; then
  PAIR_COUNT="$(jq -r '.pairCount' "$OUT_DIR/indexer/health.json" 2>/dev/null || echo '—')"
  TIP_H="$(jq -r '.tip.height' "$OUT_DIR/indexer/health.json" 2>/dev/null || echo '—')"
  HEALTH_SUMMARY="reachable; chain tip height ${TIP_H}; ${PAIR_COUNT} live pair(s)"
fi
OPENAPI_NOTE="not captured"
if [[ -s "$OUT_DIR/indexer/openapi.json" ]]; then
  OPENAPI_NOTE="captured ($(jq -r '.info.title' "$OUT_DIR/indexer/openapi.json" 2>/dev/null), $(jq -r '.paths | keys | length' "$OUT_DIR/indexer/openapi.json" 2>/dev/null) paths) — interactive UI at $INDEXER_URL/docs"
fi
EMU_STATUS=$([[ "$EMULATOR_OK" == 1 ]] && echo "PASSED" || echo "see log")
if [[ "$ONCHAIN_PRESENT" == 1 ]]; then
  ONCHAIN_DEMO_NOTE="embedded below"
  ONCHAIN_SECTION="$(file_block "$OUT_DIR/consumer-demo/onchain.txt" "no on-chain log")"
else
  ONCHAIN_DEMO_NOTE="run separately — see below"
  ONCHAIN_SECTION="_Run \`bash offchain/indexer/src/examples/run-consumer-demo-onchain.sh | tee onchain.txt\` against ${NETWORK_DISPLAY} (indexer up + funded wallet), then re-run with \`EVIDENCE_ONCHAIN_LOG=onchain.txt\` to embed it here._"
fi

# SUMMARY.json — single machine-readable record of the pack (mirrors M2/M3).
jq -n \
  --arg network   "$NETWORK_DISPLAY" \
  --arg stamp     "$STAMP" \
  --arg run       "$RUN_LABEL" \
  --arg first     "$stat_first_iso" \
  --arg last      "$stat_last_iso" \
  --argjson confirmed  "$stat_total_confirmed" \
  --argjson failed     "$stat_total_failed" \
  --argjson condemned  "$stat_total_condemned" \
  --argjson reorgs     "$stat_total_reorgs" \
  --argjson aiken_tests  "$stat_aiken_tests" \
  --argjson aiken_pass   "$stat_aiken_pass" \
  --argjson aiken_fail   "$stat_aiken_fail" \
  --argjson feeder_tests "$stat_feeder_tests" \
  --argjson feeder_pass  "$stat_feeder_pass" \
  --argjson feeder_fail  "$stat_feeder_fail" \
  --arg     feeder_result  "$feeder_result" \
  --arg     aiken_result   "$aiken_result" \
  --arg     cli_result     "$cli_result" \
  --arg     indexer_result "$indexer_result" \
  '{
    network: $network,
    pack_stamp: $stamp,
    run: $run,
    window: { first_confirmed_iso: $first, last_confirmed_iso: $last },
    totals: {
      tx_confirmed: $confirmed,
      tx_failed:    $failed,
      tx_condemned: $condemned,
      reorgs:       $reorgs
    },
    tests: {
      aiken:   { result: $aiken_result, total: $aiken_tests, pass: $aiken_pass, fail: $aiken_fail },
      feeder:  { result: $feeder_result, total: $feeder_tests, pass: $feeder_pass, fail: $feeder_fail },
      cli:     { result: $cli_result },
      indexer: { result: $indexer_result }
    }
  }' > "$OUT_DIR/SUMMARY.json"

# Precompute dynamic markdown blocks into $VARs so the heredoc uses ONLY $VAR
# expansions (never inline $()/backticks) — content in an expanded variable is
# not re-parsed, keeping the markdown's own backticks/parentheses safe.
PAIRS_TABLE="$(pairs_table)"
SAMPLE_BLOCK="$(sample_block)"
ADDRESSES_TABLE="$(addresses_table)"
EMU_BLOCK="$(file_block "$EMU_LOG" "the emulator demo did not run")"
SAMPLE_LABEL="${SAMPLE_SYMBOL:-sample}"
SYMBOL_COUNTS_MD="$(tsv_to_md_table "$SYMBOL_COUNTS" "Pair" "Confirmed txs")"
SYMBOL_HASHES_MD="$(tsv_to_md_table "$SYMBOL_HASHES" "Pair" "Tx hash (first confirmed)")"
ERROR_COUNTS_MD="$(tsv_to_md_table "$ERROR_COUNTS" "Error code" "Count")"

# ---------------------------------------------------------------------------
# Write the evidence markdown. Literal backticks are escaped (\`); every dynamic
# value is a precomputed $VAR.
# ---------------------------------------------------------------------------
cat >"$OUT_DIR/$MD_FILE" <<EOF
# Milestone 4 evidence — ${NETWORK_DISPLAY}

End-to-end integration on Cardano ${NETWORK_DISPLAY} ↔ DIA ${DIA_NETWORK}: the
sustained-run **reliability** evidence (uptime / accuracy) and the consumer-facing
**indexer** with the example **consumer contract** that reads a feed through it.
Captured from run \`${RUN_LABEL}\`. Everything here is read-only.

## Contents

- [What this shows](#what-this-shows)
- [Reliability — totals (this window)](#reliability--totals-this-window)
- [Confirmed Cardano tx count per pair](#confirmed-cardano-tx-count-per-pair)
- [Sample Cardano tx hashes (one per pair, first confirmed)](#sample-cardano-tx-hashes-one-per-pair-first-confirmed)
- [Failures (grouped by error code)](#failures-grouped-by-error-code)
- [Per-feed sanity (accuracy)](#per-feed-sanity-accuracy)
- [Test results](#test-results)
- [Indexer — live queries](#indexer--live-queries)
- [A pair in full](#a-pair-in-full)
- [Consuming a feed — end-to-end](#consuming-a-feed--end-to-end)
- [Published feeds — policy ids](#published-feeds--policy-ids)
- [Provider-usage monitoring](#provider-usage-monitoring)
- [Dashboards](#dashboards)
- [How to reproduce](#how-to-reproduce)
- [Files in this pack](#files-in-this-pack)

## What this shows

Two things together. First, that the oracle **runs reliably on ${NETWORK_DISPLAY}**:
confirmed on-chain updates over the observed window, real failures and reorgs, and
per-feed accuracy against the DIA source. Second, that a Cardano app can **consume**
a feed: the indexer answers live, and a real contract accepts a fresh price and
rejects one that does not meet its threshold.

- **Confirmed updates:** ${stat_total_confirmed} · **real failures:** ${stat_total_failed} · **reorgs:** ${stat_total_reorgs}.
- **Window (confirmed):** \`${stat_first_iso}\` → \`${stat_last_iso}\`.
- **Indexer:** ${HEALTH_SUMMARY}.
- **API reference:** ${OPENAPI_NOTE}.
- **Consumer demo (emulator):** ${EMU_STATUS}. **On-chain:** ${ONCHAIN_DEMO_NOTE}.

Machine-readable totals: [\`SUMMARY.json\`](SUMMARY.json).

## Reliability — totals (this window)

| Metric | Value |
| --- | ---: |
| Confirmed Cardano oracle update txs | ${stat_total_confirmed} |
| Failed Cardano tx attempts (real, tx broadcast) | ${stat_total_failed} |
| Condemned intents (superseded or aged out before submission — no tx, no fee) | ${stat_total_condemned} |
| Chain reorgs that dropped a tx | ${stat_total_reorgs} |

Operational publication reliability is measured from broadcast Cardano
transactions: ${stat_total_confirmed} confirmed, ${stat_total_failed} real
on-chain failure(s), and ${stat_total_reorgs} reorg(s). A strict confirmed-freshness
observation should be reported separately from this operational outcome measure,
because it includes normal scheduling and confirmation latency after a configured
freshness boundary.

## Confirmed Cardano tx count per pair

${SYMBOL_COUNTS_MD}

## Sample Cardano tx hashes (one per pair, first confirmed)

${SYMBOL_HASHES_MD}

Verify on [${EXPLORER_NAME}](${EXPLORER_URL}) or any public ${NETWORK_DISPLAY} explorer.

## Failures (grouped by error code)

Real Cardano transaction failures only — a transaction was broadcast and then failed
on-chain. Routine non-failures (an update made obsolete by a newer one before it was
sent, or an update interrupted by a restart) are not counted here. An empty table
means there were no real failures in this run.

${ERROR_COUNTS_MD}

## Per-feed sanity (accuracy)

Confirms oracle timestamp and price accuracy per price feed: each live on-chain Pair
value is compared against the latest DIA source value and judged against that feed's
own push-policy thresholds (price tolerance + freshness ceiling).

${SANITY_MD}

## Test results

All four suites are captured in this evidence pack; full console output is saved
under [\`tests/\`](tests/).

| Suite | Result | Tests | Output |
| --- | --- | ---: | --- |
| Aiken contracts (\`contracts/aiken\`, \`aiken check\`) | **${aiken_result}** | ${stat_aiken_pass} / ${stat_aiken_tests} passing (${stat_aiken_fail} failed) | [\`tests/aiken-tests.txt\`](tests/aiken-tests.txt) |
| Feeder (\`offchain/feeder\`, \`npm test\`) | **${feeder_result}** | ${stat_feeder_pass} / ${stat_feeder_tests} passing (${stat_feeder_fail} failed) | [\`tests/feeder-tests.txt\`](tests/feeder-tests.txt) |
| CLI (\`offchain/cli\`, \`npm test\`) | **${cli_result}** | — (custom runner; pass/fail by exit code) | [\`tests/cli-tests.txt\`](tests/cli-tests.txt) |
| Indexer (\`offchain/indexer\`, \`npm test\`) | **${indexer_result}** | — (custom runner; pass/fail by exit code) | [\`tests/indexer-tests.txt\`](tests/indexer-tests.txt) |

## Indexer — live queries

Every published pair the indexer reports, with the latest price and the output a
consumer references:

${PAIRS_TABLE}

Health response: [\`indexer/health.json\`](indexer/health.json) ·
all pairs: [\`indexer/pairs.json\`](indexer/pairs.json).

## A pair in full

One pair as the indexer returns it (\`${SAMPLE_LABEL}\`) — note the policy id a
consumer uses to verify the feed is genuine, and the output to reference:

${SAMPLE_BLOCK}

## Consuming a feed — end-to-end

The example consumer contract reads the referenced price and unlocks only when it
meets the configured minimum. Two runs prove both directions.

**Emulator (offline, deterministic):**

${EMU_BLOCK}

**On-chain (${NETWORK_DISPLAY}, real transactions):**

${ONCHAIN_SECTION}

## Published feeds — policy ids

The public identifiers a consumer needs, grouped by client:

${ADDRESSES_TABLE}

## Provider-usage monitoring

The feeder and the indexer share one chain-provider key. Their combined usage is
tracked on one metric and shown on the Internals dashboard panel **Requests in last
24h vs daily quota (per provider)**, with an alert that fires before the daily quota
is exhausted. The indexer's own usage is in
[\`indexer/metrics.txt\`](indexer/metrics.txt) (series \`dia_bridge_provider_requests_total\`).

## Dashboards

The five Grafana dashboards the feeder ships, rendered live over the run window
(\`${DASH_FROM}\` → now): **Overview**, **Transactions**, **Internals**, **Signer
Wallets** (the multi-wallet signer pool), and **Operational Cost** (the ADA cost of
the management txs). A full render of each shows every panel; the panel-by-panel
reference is the dashboards guide,
[\`docs/architecture/grafana-dashboards.md\`](../../../architecture/grafana-dashboards.md).

${DASHBOARDS_MD}

## How to reproduce

\`\`\`sh
cd offchain && make up MONITORING=1    # feeder + indexer + Grafana
curl -s localhost:3001/v1/pairs | jq   # the pairs table above
#  open http://localhost:3001/docs     # the API reference

# the consumption demo (offline):
bash offchain/indexer/src/examples/run-consumer-demo-emulator.sh
# and on ${NETWORK_DISPLAY} (indexer up + funded wallet in offchain/indexer/.env):
bash offchain/indexer/src/examples/run-consumer-demo-onchain.sh

# rebuild this pack (stack up with monitoring):
make evidence4                          # add EVIDENCE_ONCHAIN_LOG=… to embed the on-chain demo
\`\`\`

## Files in this pack

| Path | Contents |
| --- | --- |
| \`SUMMARY.json\`             | Machine-readable totals + test results (top of this document, as JSON). |
| \`logs/feeder.log\`          | Daemon event stream (mirrors stderr). |
| \`logs/transactions.jsonl\`  | One JSON line per tx pipeline step. |
| \`db/transaction_log.csv\`   | Full \`transaction_log\` table dump from \`feeder.sqlite\`. |
| \`db/*.csv\`                 | processed_events, chain_state, contract_symbol_updates dumps. |
| \`stats/\`                   | Intermediate TSV files + the feeder \`/metrics\` snapshot this report was built from. |
| \`sanity/feed-sanity.{md,json}\` | Per-feed accuracy: on-chain value vs latest DIA source, per symbol. |
| \`tests/*.txt\`              | Full \`aiken check\` and \`npm test\` console output for contracts, feeder, CLI and indexer. |
| \`indexer/health.json\`      | Indexer health: chain tip + live pair count. |
| \`indexer/pairs.json\`       | Every published pair (latest value + reference output). |
| \`indexer/sample-pair.json\` | One pair in full (price, policy id, reference output). |
| \`indexer/sample-utxo.json\` | Just the TxIn a consumer references. |
| \`indexer/openapi.json\`     | The API schema behind \`/docs\`. |
| \`indexer/metrics.txt\`      | The indexer's chain-provider request counts. |
| \`consumer-demo/emulator.txt\` | The offline end-to-end consumer demo run. |
| \`consumer-demo/onchain.txt\`  | The on-chain consumer demo run (when embedded). |
| \`dashboards/*.png\`           | The five Grafana dashboards rendered live over the run window. |
EOF

echo "[package-m4] done."
echo "[package-m4] open: $OUT_DIR/$MD_FILE"
