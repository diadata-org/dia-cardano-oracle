#!/usr/bin/env bash
#
# package-m4-evidence.sh — assemble the Milestone 4 evidence pack: the
# consumer-facing INDEXER and the example consumer CONTRACT that reads a feed
# through it. This is what `make evidence4` runs; it also runs standalone.
#
# It captures, into a self-contained directory under docs/milestones/evidence/:
#   - the indexer's live HTTP responses (health, the published pairs, a sample
#     pair with its reference-input UTxO, the Prometheus metrics, the OpenAPI
#     schema) — read over HTTP from a running indexer;
#   - the end-to-end consumer demo on the emulator (run here, output captured);
#   - the on-chain consumer demo output (embedded when you point it at a log);
#   - the published Pair policy ids + addresses for the live feeds.
#
# Read-only: it never writes a transaction. The feeder/indexer may keep running.
#
# Env vars (all optional; `make evidence4` sets the first two):
#   EVIDENCE_NETWORK  Cardano network (preview | mainnet). Default: preview.
#   EVIDENCE_STAMP    Shared dir stamp. Default: the resolved run-dir id, else a
#                     UTC timestamp.
#   INDEXER_URL       Indexer base URL. Default: http://localhost:3001.
#   DEMO_SYMBOL       Sample pair for the per-pair captures. Default: first pair
#                     the indexer reports (else BTC/USD).
#   EVIDENCE_ONCHAIN_LOG  Path to a saved run of run-consumer-demo-onchain.sh
#                     (e.g. produced with `… | tee onchain.txt`). Embedded when set.
#   RUN_ID            Per-run state dir selector (newest when empty).
#
# Output: docs/milestones/evidence/m4-<network>-<stamp>/  (a -01, -02 … suffix is
#         appended when a pack for that stamp already exists)
#
# Dependencies: bash, jq, curl. (aiken + node, only for the emulator demo step.)

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths — network + stamp from env; output dir name follows the network.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts/m4-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
NETWORK="$(echo "${EVIDENCE_NETWORK:-preview}" | tr '[:upper:]' '[:lower:]')"
NETWORK_DISPLAY="$(tr '[:lower:]' '[:upper:]' <<<"${NETWORK:0:1}")${NETWORK:1}"
INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"
INDEXER_URL="${INDEXER_URL%/}"

STATE_ROOT="$REPO_ROOT/offchain/state"
if [[ -n "${RUN_ID:-}" ]]; then
  STATE_DIR="$STATE_ROOT/${NETWORK}_run_${RUN_ID}"
else
  newest="$(ls -d "$STATE_ROOT/${NETWORK}_run_"*/ 2>/dev/null | sort | tail -1 || true)"
  STATE_DIR="${newest%/}"
fi
RUN_LABEL="$(basename "${STATE_DIR:-${NETWORK}}")"
STAMP="${EVIDENCE_STAMP:-}"
if [[ -z "$STAMP" ]]; then
  if [[ "$RUN_LABEL" == ${NETWORK}_run_* ]]; then STAMP="${RUN_LABEL#${NETWORK}_run_}"; else STAMP="$(date -u +%Y%m%d-%H%M%S)"; fi
fi

OUT_BASE="$REPO_ROOT/docs/milestones/evidence/m4-${NETWORK}-${STAMP}"
OUT_DIR="$OUT_BASE"
suffix=1
while [[ -e "$OUT_DIR" ]]; do OUT_DIR="$(printf '%s-%02d' "$OUT_BASE" "$suffix")"; suffix=$((suffix + 1)); done
mkdir -p "$OUT_DIR/indexer" "$OUT_DIR/consumer-demo"
MD_FILE="milestone-4-${NETWORK}-evidence.md"

echo "[package-m4] network=$NETWORK_DISPLAY stamp=$STAMP indexer=$INDEXER_URL"
echo "[package-m4] output: $OUT_DIR"

# ---------------------------------------------------------------------------
# 1. Indexer live HTTP responses (read-only).
# ---------------------------------------------------------------------------
INDEXER_UP=0
if curl -fsS --max-time 10 "$INDEXER_URL/v1/health" -o "$OUT_DIR/indexer/health.json" 2>/dev/null; then
  INDEXER_UP=1
  echo "[package-m4] indexer reachable — capturing endpoints"
  curl -fsS --max-time 30 "$INDEXER_URL/v1/pairs"        -o "$OUT_DIR/indexer/pairs.json"   2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/v1/openapi.json" -o "$OUT_DIR/indexer/openapi.json" 2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/metrics"         -o "$OUT_DIR/indexer/metrics.txt"  2>/dev/null || true

  # Pick the sample pair: DEMO_SYMBOL, else the first the indexer reported.
  SAMPLE_SYMBOL="${DEMO_SYMBOL:-}"
  if [[ -z "$SAMPLE_SYMBOL" && -s "$OUT_DIR/indexer/pairs.json" ]]; then
    SAMPLE_SYMBOL="$(jq -r '.pairs[0].symbol // empty' "$OUT_DIR/indexer/pairs.json" 2>/dev/null || true)"
  fi
  SAMPLE_SYMBOL="${SAMPLE_SYMBOL:-BTC/USD}"
  enc="$(jq -rn --arg s "$SAMPLE_SYMBOL" '$s|@uri')"
  curl -fsS --max-time 15 "$INDEXER_URL/v1/pairs/$enc"      -o "$OUT_DIR/indexer/sample-pair.json" 2>/dev/null || true
  curl -fsS --max-time 15 "$INDEXER_URL/v1/pairs/$enc/utxo" -o "$OUT_DIR/indexer/sample-utxo.json" 2>/dev/null || true
else
  echo "[package-m4] WARNING: indexer not reachable at $INDEXER_URL — start it (cd offchain && make up) and re-run to capture live responses."
fi

# ---------------------------------------------------------------------------
# 2. End-to-end consumer demo — emulator (offline, deterministic). Run it here.
# ---------------------------------------------------------------------------
EMULATOR_OK=0
EMU_LOG="$OUT_DIR/consumer-demo/emulator.txt"
echo "[package-m4] running the emulator consumer demo…"
if bash "$REPO_ROOT/offchain/indexer/src/examples/run-consumer-demo-emulator.sh" >"$EMU_LOG" 2>&1; then
  EMULATOR_OK=1
  echo "[package-m4] emulator demo passed"
else
  echo "[package-m4] WARNING: emulator demo did not pass — see $EMU_LOG"
fi

# ---------------------------------------------------------------------------
# 3. On-chain consumer demo — embed a saved run if provided.
# ---------------------------------------------------------------------------
ONCHAIN_PRESENT=0
if [[ -n "${EVIDENCE_ONCHAIN_LOG:-}" && -f "${EVIDENCE_ONCHAIN_LOG}" ]]; then
  cp "${EVIDENCE_ONCHAIN_LOG}" "$OUT_DIR/consumer-demo/onchain.txt"
  ONCHAIN_PRESENT=1
  echo "[package-m4] embedded on-chain demo log from $EVIDENCE_ONCHAIN_LOG"
fi

# ---------------------------------------------------------------------------
# Markdown helpers — built from the captured JSON.
# ---------------------------------------------------------------------------
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
    echo '```json'
    jq '.' "$OUT_DIR/indexer/sample-pair.json"
    echo '```'
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

# Precompute every dynamic section into a variable, so the heredoc below uses
# ONLY \$VAR expansions (never inline \$()/backticks) — content inside an
# expanded variable is not re-parsed, which keeps the markdown's own backticks
# and parentheses safe.
PAIRS_TABLE="$(pairs_table)"
SAMPLE_BLOCK="$(sample_block)"
ADDRESSES_TABLE="$(addresses_table)"
EMU_BLOCK="$(file_block "$EMU_LOG" "the emulator demo did not run")"
SAMPLE_LABEL="${SAMPLE_SYMBOL:-sample}"

# ---------------------------------------------------------------------------
# Write the evidence markdown. Literal backticks are escaped (\`); every dynamic
# value is a precomputed \$VAR.
# ---------------------------------------------------------------------------
cat >"$OUT_DIR/$MD_FILE" <<EOF
# Milestone 4 evidence — ${NETWORK_DISPLAY}

The consumer-facing **indexer** and the example **consumer contract** that reads
a DIA feed through it. Captured on ${NETWORK_DISPLAY} from run \`${RUN_LABEL}\`.
Everything here is read-only: querying the chain and reading published values.

## Contents

- [What this shows](#what-this-shows)
- [Indexer — live queries](#indexer--live-queries)
- [A pair in full](#a-pair-in-full)
- [Consuming a feed — end-to-end](#consuming-a-feed--end-to-end)
- [Published feeds — policy ids](#published-feeds--policy-ids)
- [Provider-usage monitoring](#provider-usage-monitoring)
- [How to reproduce](#how-to-reproduce)
- [Files in this pack](#files-in-this-pack)

## What this shows

A Cardano app reads a DIA price in two steps: ask the indexer for a pair (it
returns the latest value and the exact on-chain output to reference), then build
a transaction that references that output and is allowed or denied based on the
price. This pack shows both: the indexer answering live, and a real contract
accepting a fresh price and rejecting one that does not meet its threshold.

- **Indexer:** ${HEALTH_SUMMARY}.
- **API reference:** ${OPENAPI_NOTE}.
- **Consumer demo (emulator):** ${EMU_STATUS}.
- **Consumer demo (on-chain):** ${ONCHAIN_DEMO_NOTE}.

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
tracked on one metric and shown on the Internals dashboard panel **Requests in
last 24h vs daily quota (per provider)**, with an alert that fires before the
daily quota is exhausted. The indexer's own usage is in
[\`indexer/metrics.txt\`](indexer/metrics.txt) (series \`dia_bridge_provider_requests_total\`).

## How to reproduce

\`\`\`sh
cd offchain && make up                 # feeder + indexer
curl -s localhost:3001/v1/pairs | jq   # the table above
#  open http://localhost:3001/docs     # the API reference

# the consumption demo (offline):
bash offchain/indexer/src/examples/run-consumer-demo-emulator.sh
# and on ${NETWORK_DISPLAY} (indexer up + funded wallet in offchain/indexer/.env):
bash offchain/indexer/src/examples/run-consumer-demo-onchain.sh
\`\`\`

## Files in this pack

| Path | Contents |
| --- | --- |
| \`indexer/health.json\`      | Indexer health: chain tip + live pair count. |
| \`indexer/pairs.json\`       | Every published pair (latest value + reference output). |
| \`indexer/sample-pair.json\` | One pair in full (price, policy id, reference output). |
| \`indexer/sample-utxo.json\` | Just the TxIn a consumer references. |
| \`indexer/openapi.json\`     | The API schema behind \`/docs\`. |
| \`indexer/metrics.txt\`      | The indexer's chain-provider request counts. |
| \`consumer-demo/emulator.txt\` | The offline end-to-end consumer demo run. |
| \`consumer-demo/onchain.txt\`  | The on-chain consumer demo run (when embedded). |
EOF

echo "[package-m4] done."
echo "[package-m4] open: $OUT_DIR/$MD_FILE"
