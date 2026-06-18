#!/usr/bin/env bash
# Drive the alert pipeline end-to-end and capture the evidence.
#
# For each alert: push its synthetic metric (via trigger-alert.sh) → poll until
# Prometheus reports it `firing` → snapshot the Prometheus alert state AND the
# feeder alert_log row written through the webhook → optionally render the
# dashboard → clear → poll until it resolves. Each transition is appended to a
# timeline markdown with timestamps, so the run is both the on-screen demo and
# the "alert-trigger logs" evidence the QA pack folds in.
#
# Requires the monitoring stack up:  cd offchain && make up MONITORING=1
#
# Usage (from offchain/feeder/):
#   scripts/monitoring/trigger-alert-demo.sh                 # default mix (~40 min)
#   scripts/monitoring/trigger-alert-demo.sh fast            # short-for: only (~10-15 min)
#   scripts/monitoring/trigger-alert-demo.sh all             # every alert (~55 min)
#   scripts/monitoring/trigger-alert-demo.sh OraclePairStale ReceiverBalanceLow
#
# Env (all optional):
#   MAX_FIRE_WAIT   seconds to wait for an alert to reach `firing` (default 900 —
#                   a 10m `for:` rule fires at ~600s + scrape/eval alignment, so
#                   this leaves a comfortable margin).
#   MAX_RESOLVE_WAIT seconds to wait for it to resolve after clear (default 180).
#   POLL_INTERVAL   seconds between polls (default 5).
#   OUT_DIR         where to write the bundle (default
#                   docs/milestones/evidence/alert-trigger-<network>-<stamp>/).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIGGER="$SCRIPT_DIR/trigger-alert.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

PROM_URL="${PROM_URL:-http://localhost:9090}"
FEEDER_URL="${FEEDER_URL:-http://localhost:8080}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"
GRAFANA_USER="admin"
GRAFANA_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
GRAFANA_DASHBOARD_UID="dia-cardano-feeder"

NETWORK="${CARDANO_NETWORK:-Preview}"
networkTag="$(echo "$NETWORK" | tr '[:upper:]' '[:lower:]')"

MAX_FIRE_WAIT="${MAX_FIRE_WAIT:-900}"
MAX_RESOLVE_WAIT="${MAX_RESOLVE_WAIT:-180}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

# Alert sets, by how long they take (each alert fires after its own `for:` window,
# and the run is sequential — one alert at a time, for clean per-alert screenshots):
#   fast    — short `for:` only (1m + 5m rules), single-push      → ~10–15 min
#   default — a representative mix across categories               → ~40 min
#   all     — every rule, incl. the slower rate/histogram ones     → ~55 min
FAST_ALERTS=(PrimaryProviderDown SecondaryProviderDown OraclePairStale ReceiverBalanceLow)
DEFAULT_ALERTS=(OraclePairStale ReceiverBalanceLow FeedAccuracyFail SettleOverdue ReceiverDepositsPending)
ALL_ALERTS=(OraclePairStale ReceiverBalanceLow SettleOverdue PaymentHookWithdrawReady \
  AdminWalletLow AdminWalletFragmented ReceiverDepositsPending FeedAccuracyFail \
  PrimaryProviderDown SecondaryProviderDown ReorgRateHigh PriceDeviationHigh PriceAgeHigh)

if [ "$#" -eq 0 ]; then
  ALERTS=("${DEFAULT_ALERTS[@]}")
elif [ "$1" = "fast" ]; then
  ALERTS=("${FAST_ALERTS[@]}")
elif [ "$1" = "all" ]; then
  ALERTS=("${ALL_ALERTS[@]}")
else
  ALERTS=("$@")
fi

for tool in jq curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "fatal: '$tool' not found on PATH" >&2; exit 1; }
done
curl -fsS --max-time 5 "$PROM_URL/api/v1/status/buildinfo" >/dev/null 2>&1 || {
  echo "fatal: Prometheus not reachable at $PROM_URL — is the monitoring stack up? (make up MONITORING=1)" >&2
  exit 1
}

STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/docs/milestones/evidence/alert-trigger-$networkTag-$STAMP}"
mkdir -p "$OUT_DIR"
TIMELINE="$OUT_DIR/timeline.md"

# State of one alertname in Prometheus: "firing" | "pending" | "inactive".
alert_state() {
  curl -fsS --max-time 5 "$PROM_URL/api/v1/alerts" 2>/dev/null \
    | jq -r --arg n "$1" '
        [.data.alerts[]? | select(.labels.alertname == $n) | .state] as $s
        | if ($s | index("firing")) then "firing"
          elif ($s | index("pending")) then "pending"
          else "inactive" end' 2>/dev/null || echo "inactive"
}

# Wait until alertname reaches a target state (or timeout). Echoes elapsed secs.
wait_for_state() {
  local name="$1" target="$2" max="$3" waited=0
  while [ "$waited" -lt "$max" ]; do
    [ "$(alert_state "$name")" = "$target" ] && { echo "$waited"; return 0; }
    sleep "$POLL_INTERVAL"; waited=$((waited + POLL_INTERVAL))
  done
  echo "$waited"; return 1
}

iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

cat > "$TIMELINE" <<EOF
# Alert-trigger logs — ${NETWORK}

Each alert below was fired by pushing a synthetic value for its metric to the
Pushgateway (\`trigger-alert.sh\`). The value crosses the real threshold from
\`monitoring/alerts.yml\`, so the genuine rule fires and flows through the live
pipeline (Prometheus → Alertmanager → feeder webhook → \`alert_log\`). Only the
input metric is synthetic; the rules, routing, and recording are production.

Run stamp: **${STAMP}** · Prometheus: ${PROM_URL} · feeder: ${FEEDER_URL}

| Alert | Pushed at | Reached \`firing\` | Cleared at | Resolved | Prometheus | alert_log |
| --- | --- | --- | --- | --- | --- | --- |
EOF

echo "[demo] firing ${#ALERTS[@]} alert(s) into $OUT_DIR"

for alert in "${ALERTS[@]}"; do
  echo "[demo] === $alert ==="
  pushed_at="$(iso)"
  "$TRIGGER" "$alert" >/dev/null 2>&1 || { echo "[demo]   trigger failed for $alert — skipping" >&2; continue; }

  if fire_waited="$(wait_for_state "$alert" firing "$MAX_FIRE_WAIT")"; then
    fired_at="$(iso)"; fire_note="${fire_waited}s"
    echo "[demo]   $alert FIRING after ${fire_waited}s"
  else
    fired_at="—"; fire_note="not within ${MAX_FIRE_WAIT}s"
    echo "[demo]   $alert did NOT reach firing within ${MAX_FIRE_WAIT}s" >&2
  fi

  # Snapshot the firing state from BOTH sources of truth.
  prom_file="$alert-prometheus.json"
  curl -fsS --max-time 5 "$PROM_URL/api/v1/alerts" 2>/dev/null \
    | jq --arg n "$alert" '{data:{alerts:[.data.alerts[]? | select(.labels.alertname==$n)]}}' \
    > "$OUT_DIR/$prom_file" 2>/dev/null || echo '{"data":{"alerts":[]}}' > "$OUT_DIR/$prom_file"

  log_file="$alert-alertlog.json"
  if curl -fsS --max-time 5 "$FEEDER_URL/api/v1/alerts" -o "$OUT_DIR/$log_file" 2>/dev/null; then
    log_note="[\`$log_file\`]($log_file)"
  else
    echo '{"alerts":[],"note":"feeder API not reachable"}' > "$OUT_DIR/$log_file"
    log_note="_feeder API n/a_"
  fi

  # Best-effort dashboard PNG so the spike is visible on screen.
  if curl -fsS --max-time 5 "$GRAFANA_URL/api/health" >/dev/null 2>&1; then
    curl -fsS --max-time 30 -u "$GRAFANA_USER:$GRAFANA_PASS" \
      -o "$OUT_DIR/$alert.png" \
      "$GRAFANA_URL/render/d/$GRAFANA_DASHBOARD_UID/dia-cardano-oracle-feeder?orgId=1&from=now-30m&to=now&width=1600&height=900&kiosk=tv&tz=UTC" \
      2>/dev/null || true
  fi

  cleared_at="$(iso)"
  "$TRIGGER" clear >/dev/null 2>&1 || true
  if resolve_waited="$(wait_for_state "$alert" inactive "$MAX_RESOLVE_WAIT")"; then
    resolved_note="yes (${resolve_waited}s)"
  else
    resolved_note="still active after ${MAX_RESOLVE_WAIT}s"
  fi

  printf '| %s | %s | %s | %s | %s | [`%s`](%s) | %s |\n' \
    "$alert" "$pushed_at" "$fire_note" "$cleared_at" "$resolved_note" \
    "$prom_file" "$prom_file" "$log_note" >> "$TIMELINE"
done

echo "[demo] done — timeline: ${TIMELINE#"$REPO_ROOT"/}"
