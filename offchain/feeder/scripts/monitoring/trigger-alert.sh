#!/usr/bin/env bash
# Fire a feeder alert ON DEMAND by pushing synthetic metric values to the
# Pushgateway. Prometheus scrapes them, the REAL alert rules fire, and the rest
# of the pipeline takes it from there (Alertmanager → the feeder webhook →
# alert_log → notifications). Nothing else is faked — only the input metric.
#
# Requires the monitoring stack up:  cd offchain && make up MONITORING=1
#
# Usage (from offchain/feeder/):
#   scripts/monitoring/trigger-alert.sh list                 # supported alerts
#   scripts/monitoring/trigger-alert.sh <AlertName>          # fire one
#   scripts/monitoring/trigger-alert.sh clear                # remove pushed metrics (reset)
#
# After firing, watch it land:
#   curl -s localhost:9090/api/v1/alerts        # Prometheus rule state (pending → firing)
#   curl -s localhost:8080/api/v1/alerts        # the feeder's alert_log (recorded via the webhook)
#   open http://localhost:9093                  # Alertmanager UI
set -euo pipefail

PUSHGW="${PUSHGW_URL:-http://localhost:9091}"
JOB="alert-trigger"
# Tag every pushed series with the active network (a Pushgateway grouping label,
# kept by Prometheus via honor_labels) so it also shows on the network-filtered
# Grafana dashboards, not only in the alert rules.
NETWORK="${CARDANO_NETWORK:-Preview}"
ENDPOINT="$PUSHGW/metrics/job/$JOB/network/$NETWORK"

# Replace the job's pushed metrics with the given exposition text.
push() { printf '%s\n' "$1" | curl -sf --data-binary @- "$ENDPOINT" >/dev/null; }
clear_all() { curl -sf -X DELETE "$ENDPOINT" >/dev/null 2>&1 || true; }

# Rate/counter alerts need a rising series across ≥2 scrapes. Push an increasing
# value a few times so increase()/rate() goes positive.
push_rising() {
  local template="$1" # contains %VAL%
  for v in 0 50 100 150; do
    push "${template//%VAL%/$v}"
    sleep 8
  done
}

# Register the synthetic "trigger" entity in the metrics that feed the dashboard's
# cascading filters (network → customer → client → router → symbol), at value 0.
# These are the only metrics carrying the full label spine, so pushing them is what
# makes `trigger` / `TRG/USD` selectable in the Customer/Client/Router/Symbol
# dropdowns. Value 0 (counters) adds no transaction and no throughput — it only
# makes the entity exist as a filter option. POST keeps it alongside the alert
# series; `clear` removes it with everything else.
register_trigger_entity() {
  push 'dia_bridge_transactions_total{customer_id="trigger",client_id="trigger",outcome="confirmed"} 0
dia_bridge_transaction_router_membership_total{customer_id="trigger",client_id="trigger",router_id="trigger"} 0
dia_bridge_tx_pair_membership_total{customer_id="trigger",client_id="trigger",router_id="trigger",symbol="TRG/USD"} 0'
}

now=$(date +%s)
stale_ts=$((now - 4000))   # > 3600 s old  → OraclePairStale
primary_ts=$((now - 700))  # > 600 s       → PrimaryProviderDown
secondary_ts=$((now - 1000)) # > 900 s     → SecondaryProviderDown

case "${1:-}" in
  ReceiverBalanceLow)
    push 'dia_bridge_cardano_receiver_balance_lovelace{client_id="trigger"} 1000000' ;;       # 1 ADA (< 2)
  SettleOverdue)
    push 'dia_bridge_cardano_receiver_accrued_lovelace{client_id="trigger"} 11000000' ;;      # 11 ADA (> 10)
  PaymentHookWithdrawReady)
    push 'dia_bridge_cardano_payment_hook_accrued_lovelace 51000000' ;;                       # 51 ADA (> 50)
  AdminWalletLow)
    push 'dia_bridge_cardano_admin_wallet_lovelace 4000000' ;;                                # 4 ADA (< 5)
  AdminWalletFragmented)
    push 'dia_bridge_cardano_admin_wallet_max_utxo_lovelace 9000000' ;;                       # 9 ADA (< 10)
  ReceiverDepositsPending)
    push 'dia_bridge_cardano_deposit_pending_lovelace{client_id="trigger"} 6000000' ;;        # 6 ADA (> 5)
  FeedAccuracyFail)
    push 'dia_bridge_feed_sanity_status{symbol="TRG/USD",client_id="trigger",customer_id="trigger"} 2' ;;
  OraclePairStale)
    push "dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds{symbol=\"TRG/USD\",client_id=\"trigger\"} $stale_ts" ;;
  PrimaryProviderDown)
    push "dia_bridge_provider_last_ok_timestamp_seconds{provider=\"trigger\",role=\"primary\"} $primary_ts" ;;
  SecondaryProviderDown)
    push "dia_bridge_provider_last_ok_timestamp_seconds{provider=\"trigger\",role=\"secondary\"} $secondary_ts" ;;
  ReorgRateHigh)
    echo "pushing a rising reorg counter over ~32s (rate alert)..."
    push_rising 'dia_bridge_transactions_reorg_total{symbol="TRG/USD",client_id="trigger"} %VAL%' ;;
  PriceDeviationHigh)
    echo "pushing rising price-deviation buckets over ~32s (histogram alert)..."
    push_rising 'dia_bridge_price_deviation_percent_bucket{symbol="TRG/USD",le="5"} 0
dia_bridge_price_deviation_percent_bucket{symbol="TRG/USD",le="10"} %VAL%
dia_bridge_price_deviation_percent_bucket{symbol="TRG/USD",le="+Inf"} %VAL%' ;;
  PriceAgeHigh)
    echo "pushing rising price-age buckets over ~32s (histogram alert)..."
    push_rising 'dia_bridge_price_age_seconds_bucket{symbol="TRG/USD",le="600"} 0
dia_bridge_price_age_seconds_bucket{symbol="TRG/USD",le="1200"} %VAL%
dia_bridge_price_age_seconds_bucket{symbol="TRG/USD",le="+Inf"} %VAL%' ;;
  clear)
    clear_all; echo "cleared pushed trigger metrics (alerts resolve on the next eval)"; exit 0 ;;
  list|"")
    cat <<'EOF'
Supported alerts (pass one as the argument):
  Instant (single push):
    ReceiverBalanceLow  SettleOverdue  PaymentHookWithdrawReady  AdminWalletLow
    AdminWalletFragmented  ReceiverDepositsPending  FeedAccuracyFail
    OraclePairStale  PrimaryProviderDown  SecondaryProviderDown
  Rate-based (~32s rising push):
    ReorgRateHigh  PriceDeviationHigh  PriceAgeHigh
  clear   — remove pushed metrics (alerts resolve)
EOF
    exit 0 ;;
  *)
    echo "unknown alert: $1 — run '$0 list'" >&2; exit 1 ;;
esac

# Make the synthetic entity selectable in the dashboard's cascading filters.
register_trigger_entity

echo "pushed synthetic metric for $1."
echo "It crosses the real threshold → Prometheus fires after the rule's 'for:' window."
echo "Watch it:  curl -s localhost:9090/api/v1/alerts   (pending → firing)"
echo "           curl -s localhost:8080/api/v1/alerts   (feeder alert_log, via the webhook)"
echo "Reset:     $0 clear"
