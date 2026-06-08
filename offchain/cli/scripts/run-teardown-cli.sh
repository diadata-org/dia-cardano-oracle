#!/usr/bin/env bash
set -euo pipefail

# run-teardown-cli.sh — CHAIN-AS-TRUTH decommission of a deployment.
#
# Tears a deployment down and recovers as much locked ADA as possible. The CHAIN
# is the source of truth — the committed state JSONs are not trusted as the list
# of what to act on:
#
#   1. It QUERIES the LIVE on-chain UTxOs (scripts/teardown-helpers/query-live.ts)
#      per category before acting.
#   2. It ACTS ONLY on what is actually on-chain right now — never against
#      something the chain says is gone.
#   3. On each confirmed burn/reclaim/settle/withdraw it stamps that entity's
#      JSON via scripts/teardown-helpers/record-teardown.ts (the CLI verb already
#      appends the tx to `transactions`; the helper adds the `teardown` status).
#   4. After a category's live list is exhausted, every JSON with NO live match
#      is marked ORPHANED via record-teardown.ts --orphan (already burned/
#      reclaimed elsewhere, or never minted) — NO tx is attempted for it.
#
# Ordered sequence — wrong order strands ADA:
#   2. deposit:merge per client      (sweep side-deposits into balance FIRST)
#   3. settle per client             (where LIVE receiver accrued_to_hook > 0)
#   4. receiver:withdraw per client  (where LIVE receiver balance > 0)
#   5. payment-hook:withdraw         (drain the hook's aggregated accrued)
#   6. pair:burn per LIVE pair NFT
#   7. receiver:burn + payment-hook:burn  (Burn-redeemer deployments; --skip-singleton-burns)
#   8. reclaim ALL LIVE reference scripts: client (×each) → payment-hook → config
#   9. config:burn LAST              (Burn-redeemer deployments; --skip-singleton-burns)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"

FROM_STEP=1
EXPLICIT_RUN_ID="${RUN_ID:-}"
SKIP_SINGLETON_BURNS=false
BUILD_ONLY=false

usage() {
  cat <<'EOF'
usage: run-teardown-cli.sh [--run-id ID] [--from-step N] [--skip-singleton-burns]
                           [--build-only]

CHAIN-AS-TRUTH decommission of a deployment. Loads an existing
state/<network>_run_<id> directory (never creates/cleans state), QUERIES the
live on-chain UTxOs, acts only on what is live, records each outcome into the
entity JSON, and marks the rest orphaned.

options:
  --run-id ID              tear down state/<network>_run_<ID> (default: NEWEST).
  --from-step N            resume at step N (1..9). N>1 requires --run-id.
  --skip-singleton-burns   SKIP steps 7 and 9 (receiver:burn / payment-hook:burn
                           / config:burn). REQUIRED for deployments whose
                           contracts lack the Burn redeemers.
  --build-only             pass --build-only to every CLI verb (inspect only).
EOF
}

normalize_bool() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    true|1|yes) printf 'true\n' ;;
    false|0|no) printf 'false\n' ;;
    *) echo "invalid boolean value: $1" >&2; exit 1 ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      [[ $# -ge 2 ]] || { echo "missing value for --run-id" >&2; exit 1; }
      EXPLICIT_RUN_ID="$2"; shift 2 ;;
    --run-id=*) EXPLICIT_RUN_ID="${1#*=}"; shift ;;
    --from-step)
      [[ $# -ge 2 ]] || { echo "missing value for --from-step" >&2; exit 1; }
      FROM_STEP="$2"; shift 2 ;;
    --from-step=*) FROM_STEP="${1#*=}"; shift ;;
    --skip-singleton-burns) SKIP_SINGLETON_BURNS=true; shift ;;
    --skip-singleton-burns=*) SKIP_SINGLETON_BURNS="$(normalize_bool "${1#*=}")"; shift ;;
    --build-only) BUILD_ONLY=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if ! [[ "$FROM_STEP" =~ ^[0-9]+$ ]] || (( FROM_STEP < 1 || FROM_STEP > 9 )); then
  echo "--from-step must be an integer between 1 and 9" >&2
  exit 1
fi

# Load .env early so CARDANO_NETWORK drives every network-scoped path.
if [[ -f "$CLI_DIR/.env" ]]; then
  set -a
  source "$CLI_DIR/.env"
  set +a
fi

CARDANO_NETWORK="${CARDANO_NETWORK:-Preview}"
NETWORK_TAG="$(printf '%s' "$CARDANO_NETWORK" | tr '[:upper:]' '[:lower:]')"
if [[ "$NETWORK_TAG" != "preview" && "$NETWORK_TAG" != "mainnet" ]]; then
  echo "[teardown] unsupported CARDANO_NETWORK=$CARDANO_NETWORK (expected Preview or Mainnet)" >&2
  exit 1
fi

CARDANO_PROVIDER="${CARDANO_PROVIDER:-Blockfrost}"
POST_TX_DELAY_SECONDS="${POST_TX_DELAY_SECONDS:-15}"

# Resolve the target run state — ALWAYS an EXISTING run; never create/rm/mkdir it.
if [[ -n "$EXPLICIT_RUN_ID" ]]; then
  RUN_ID="$EXPLICIT_RUN_ID"
else
  shopt -s nullglob
  newest_dir=""
  newest_mtime=0
  for dir_path in "$REPO"/offchain/state/"${NETWORK_TAG}"_run_*; do
    [[ -d "$dir_path" ]] || continue
    mtime="$(stat -c %Y "$dir_path" 2>/dev/null || stat -f %m "$dir_path")"
    if (( mtime >= newest_mtime )); then
      newest_mtime="$mtime"
      newest_dir="$dir_path"
    fi
  done
  shopt -u nullglob
  if [[ -z "$newest_dir" ]]; then
    echo "[teardown] no state/${NETWORK_TAG}_run_* directory found; nothing to tear down" >&2
    exit 1
  fi
  RUN_ID="$(basename "$newest_dir" | sed "s/^${NETWORK_TAG}_run_//")"
  echo "[teardown] no --run-id given; picked NEWEST run: $(basename "$newest_dir")"
fi

if (( FROM_STEP > 1 )) && [[ -z "$EXPLICIT_RUN_ID" ]]; then
  echo "[teardown] --from-step requires --run-id" >&2
  exit 1
fi

STATE_NAME="${NETWORK_TAG}_run_${RUN_ID}"
STATE_REL="../state/${STATE_NAME}"
STATE_ROOT="$REPO/offchain/state/${STATE_NAME}"
PROTOCOL_STATE_REL="$STATE_REL/config-bootstrap.json"

[[ -d "$STATE_ROOT" ]] || { echo "[teardown] state root not found: $STATE_ROOT" >&2; exit 1; }
[[ -f "$STATE_ROOT/config-bootstrap.json" ]] || {
  echo "[teardown] config-bootstrap.json not found under $STATE_ROOT" >&2
  exit 1
}

EVIDENCE_NAME="teardown-${NETWORK_TAG}-${RUN_ID}"
EVIDENCE_ROOT="$REPO/docs/milestones/evidence/${EVIDENCE_NAME}"
mkdir -p "$EVIDENCE_ROOT"

exec > >(tee -a "$EVIDENCE_ROOT/00-master.log") 2>&1

cd "$CLI_DIR"

export CARDANO_NETWORK
export CARDANO_PROVIDER

BUILD_ONLY_FLAG=""
if [[ "$BUILD_ONLY" == "true" ]]; then
  BUILD_ONLY_FLAG="--build-only"
fi

should_run_step() {
  local step="$1"
  (( step >= FROM_STEP ))
}

pty_exec() {
  local cli_cmd="$*"
  if [[ "$(uname)" == "Darwin" ]]; then
    npm run cli -- $cli_cmd
  else
    script -q -e -c "npm run cli -- $cli_cmd" /dev/null
  fi
}

run_cli_logged() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[teardown] $cli_cmd"
  pty_exec $cli_cmd | tee "$EVIDENCE_ROOT/$log_name"
}

run_tx_logged() {
  run_cli_logged "$@"
  if [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$POST_TX_DELAY_SECONDS"
  fi
}

# Run a CLI verb (logged + post-tx delay) and return its exit code WITHOUT
# aborting the script. Every on-chain verb is guarded so a single failure is
# diagnosed, not fatal — and it is only ever called for items the chain query
# already confirmed are LIVE.
run_tx_checked() {
  local log_name="$1"
  shift
  local cli_cmd="$*"
  echo "[teardown] $cli_cmd"
  local rc=0
  set +e
  pty_exec $cli_cmd | tee "$EVIDENCE_ROOT/$log_name"
  rc=${PIPESTATUS[0]}
  set -e
  if [[ "$POST_TX_DELAY_SECONDS" -gt 0 ]]; then
    sleep "$POST_TX_DELAY_SECONDS"
  fi
  return "$rc"
}

capture_cli_json() {
  local log_name="$1"
  shift
  npm run --silent cli -- "$@" | tee "$EVIDENCE_ROOT/$log_name"
}

read_json_field() {
  local json_path="$1"
  local expression="$2"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const filePath = process.argv[1];
    const expression = process.argv[2];
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const value = expression.split(".").reduce((current, key) => current?.[key], data);
    if (value === undefined || value === null) {
      process.exit(1);
    }
    process.stdout.write(String(value));
  ' "$json_path" "$expression"
}

add_lovelace() {
  local a="$1" b="$2"
  node -e 'process.stdout.write(String((BigInt(process.argv[1]||"0"))+(BigInt(process.argv[2]||"0"))))' "$a" "$b"
}

lovelace_to_ada() {
  node -e '
    const l = BigInt(process.argv[1] || "0");
    const whole = l / 1000000n;
    const frac = (l % 1000000n).toString().padStart(6, "0");
    process.stdout.write(`${whole}.${frac}`);
  ' "$1"
}

# Pull the submitted tx hash from a CLI verb log. Every verb prints
# "Submitted: <hash>" or "Submitted transaction hash: <hash>" on stderr (which
# our PTY merges into the log). 64-hex match keeps it robust to either phrasing.
extract_tx_hash() {
  local log_path="$1"
  node -e '
    import("node:fs").then(({ readFileSync }) => {
      const text = readFileSync(process.argv[1], "utf8");
      const m = text.match(/Submitted[^0-9a-fA-F]*([0-9a-fA-F]{64})/);
      process.stdout.write(m ? m[1] : "");
    });
  ' "$log_path"
}

# Helper invocations — keep the helper paths in one place.
QUERY_LIVE="scripts/teardown-helpers/query-live.ts"
RECORD_TEARDOWN="scripts/teardown-helpers/record-teardown.ts"

record_status() {
  # record_status <file> <step> <txHash> <status>
  npx tsx "$RECORD_TEARDOWN" --file "$1" --step "$2" --tx-hash "$3" \
    --status "$4" --no-append --confirmed true
}

record_orphan() {
  # record_orphan <file> <reason>
  npx tsx "$RECORD_TEARDOWN" --file "$1" --orphan --reason "$2"
}

# Read a value out of the live-query JSON via node.
live_query_get() {
  # live_query_get <live_json_path> <node-expression-over-`d`>
  node -e '
    import("node:fs").then(({ readFileSync }) => {
      const d = JSON.parse(readFileSync(process.argv[1], "utf8"));
      const fn = new Function("d", `return (${process.argv[2]});`);
      const v = fn(d);
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    });
  ' "$1" "$2"
}

# ── Discover clients dynamically — NO hardcoded counts. ─────────────────────
shopt -s nullglob
CLIENT_FILES=("$STATE_ROOT"/clients/*.json)
shopt -u nullglob
if (( ${#CLIENT_FILES[@]} == 0 )); then
  echo "[teardown] no client states under $STATE_ROOT/clients/*.json" >&2
  exit 1
fi

PROTOCOL_STATE_ABS="$STATE_ROOT/config-bootstrap.json"

# ── Precondition banner (admin signer + feeder-stopped warning). ────────────
CONFIG_SIGNERS="$(read_json_field "$PROTOCOL_STATE_ABS" "configState.validConfigSigners" || true)"
HOOK_MIN="$(read_json_field "$PROTOCOL_STATE_ABS" "paymentHookState.minUtxoLovelace" || echo 0)"
CONFIG_MIN="$(read_json_field "$PROTOCOL_STATE_ABS" "configState.minUtxoLovelace" || echo 0)"

WALLET_DEFAULTS_JSON="$EVIDENCE_ROOT/00-wallet-defaults.json"
capture_cli_json "00-wallet-defaults.log" "wallet:defaults" > "$WALLET_DEFAULTS_JSON"
WALLET_PKH="$(read_json_field "$WALLET_DEFAULTS_JSON" "defaults.paymentKeyHash" || true)"
WALLET_ADDRESS="$(read_json_field "$WALLET_DEFAULTS_JSON" "address" || true)"

WALLET_IS_SIGNER="UNKNOWN"
if [[ -n "$WALLET_PKH" && -n "$CONFIG_SIGNERS" ]]; then
  if [[ " $CONFIG_SIGNERS " == *" $WALLET_PKH "* ]]; then
    WALLET_IS_SIGNER="YES"
  else
    WALLET_IS_SIGNER="NO"
  fi
fi

cat <<EOF

[teardown] ====================================================================
[teardown]  DESTRUCTIVE, IRREVERSIBLE, LIVE ON-CHAIN DECOMMISSION (chain-as-truth)
[teardown] ====================================================================
[teardown]  Network:        $CARDANO_NETWORK ($NETWORK_TAG)
[teardown]  Provider:       $CARDANO_PROVIDER
[teardown]  Run state:      $STATE_ROOT
[teardown]  Evidence:       $EVIDENCE_ROOT
[teardown]  From step:      $FROM_STEP
[teardown]  Build-only:     $BUILD_ONLY
[teardown]  Clients found:  ${#CLIENT_FILES[@]}
[teardown]
[teardown]  PRECONDITION 1 — The FEEDER MUST BE STOPPED for this network.
[teardown]    New oracle updates mint Pair NFTs / accrue fees, re-locking ADA
[teardown]    mid-teardown. This teardown queries the chain per category, so a still-running
[teardown]    feeder would also race the queries — STOP IT FIRST.
[teardown]  PRECONDITION 2 — The configured wallet MUST be a Config signer (admin).
[teardown]      wallet pkh:      ${WALLET_PKH:-<unknown>}
[teardown]      wallet address:  ${WALLET_ADDRESS:-<unknown>}
[teardown]      config signers:  ${CONFIG_SIGNERS:-<unknown>}
[teardown]      wallet is admin: $WALLET_IS_SIGNER
EOF

if [[ "$WALLET_IS_SIGNER" == "NO" ]]; then
  echo "[teardown] FATAL: configured wallet is NOT a Config signer; teardown verbs would fail on-chain. Aborting." >&2
  exit 1
fi

if [[ "$SKIP_SINGLETON_BURNS" == "true" ]]; then
  echo "[teardown]  MODE: --skip-singleton-burns ACTIVE (steps 7 & 9 skipped)."
else
  echo "[teardown]  MODE: FULL teardown (Burn-redeemer contracts; steps 7 & 9 run)."
fi
echo "[teardown] ===================================================================="
echo ""

# ── CHAIN QUERY: learn reality once up front. Every category decision below is
# made against this snapshot (and re-queried after burns where it matters). ──
LIVE_JSON="$EVIDENCE_ROOT/01-live-query.json"
build_live_query_args() {
  local -a a=(--protocol-state "$PROTOCOL_STATE_REL" --pair-glob-root "$STATE_REL")
  for cj in "${CLIENT_FILES[@]}"; do
    local cid
    cid="$(basename "$cj" .json)"
    a+=(--client-state "$STATE_REL/clients/${cid}.json")
  done
  printf '%s\n' "${a[@]}"
}

refresh_live_query() {
  echo "[teardown] querying LIVE on-chain UTxOs (chain-as-truth) ..."
  mapfile -t QL_ARGS < <(build_live_query_args)
  npx tsx "$QUERY_LIVE" "${QL_ARGS[@]}" > "$LIVE_JSON"
  echo "[teardown] live snapshot written to $LIVE_JSON"
}

refresh_live_query

# ── Recovery accumulators. ──────────────────────────────────────────────────
REC_BALANCE=0
REC_ACCRUED=0
REC_PAIR_MIN=0
PAIR_BURN_COUNT=0
PAIR_ORPHAN_COUNT=0
declare -a RECOVERY_LINES=()
declare -a ORPHAN_LINES=()

# ── STEP 2: deposit:merge per client (sweep side-deposits FIRST). ───────────
# deposit:merge is a no-op-or-throw verb; for a chain-as-truth pass we attempt
# it per client only when the deployment has side-deposit config, and tolerate
# the throw (nothing eligible). It does not consume an NFT, so there is no
# orphan concept here.
if should_run_step 2; then
  if [[ -z "$(read_json_field "$PROTOCOL_STATE_ABS" "configState.depositMinLovelace" || true)" ]]; then
    echo "[teardown] deposit:merge SKIPPED — no side-deposit config (pre-deposit deployment)."
  else
    for cj in "${CLIENT_FILES[@]}"; do
      CID="$(basename "$cj" .json)"
      if run_tx_checked "02-deposit-merge-${CID}.log" \
        "deposit:merge --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json $BUILD_ONLY_FLAG"; then
        echo "[teardown] deposit:merge ${CID}: swept pending deposits"
      else
        echo "[teardown] deposit:merge ${CID}: no eligible deposits (no-op)"
      fi
    done
  fi
fi

# ── STEP 3: settle per client where the LIVE receiver has accrued > 0. ──────
# Receiver liveness comes from the chain query; the accrued amount is read from
# the receiver state JSON (last-known on-chain value, valid once the feeder is
# stopped). settle rejects accrued == 0 on-chain, so skip those.
if should_run_step 3; then
  CLIENT_COUNT="$(live_query_get "$LIVE_JSON" "d.clients.length")"
  for (( i=0; i<CLIENT_COUNT; i++ )); do
    CID="$(live_query_get "$LIVE_JSON" "d.clients[$i].clientId")"
    RECV_PRESENT="$(live_query_get "$LIVE_JSON" "d.clients[$i].receiverPresent")"
    CJ="$STATE_ROOT/clients/${CID}.json"
    if [[ "$RECV_PRESENT" != "true" ]]; then
      echo "[teardown] settle ${CID}: receiver NFT not on-chain — skipped (handled as orphan in step 7)"
      continue
    fi
    ACCRUED="$(read_json_field "$CJ" "receiver.receiverState.accruedToHookLovelace" || echo 0)"
    if [[ "$ACCRUED" =~ ^[0-9]+$ ]] && (( ACCRUED > 0 )); then
      if run_tx_checked "03-settle-${CID}.log" \
        "settle --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json $BUILD_ONLY_FLAG"; then
        REC_ACCRUED="$(add_lovelace "$REC_ACCRUED" "$ACCRUED")"
        RECOVERY_LINES+=("settle (${CID} accrued → hook): $(lovelace_to_ada "$ACCRUED") ADA")
        if [[ "$BUILD_ONLY" != "true" ]]; then
          TXH="$(extract_tx_hash "$EVIDENCE_ROOT/03-settle-${CID}.log")"
          [[ -n "$TXH" ]] && record_status "$CJ" "teardown:settle" "$TXH" "settled"
        fi
      else
        echo "[teardown] settle ${CID}: FAILED — see 03-settle-${CID}.log" >&2
      fi
    else
      echo "[teardown] settle ${CID}: accrued_to_hook == 0 — skipped"
    fi
  done
fi

# ── STEP 4: receiver:withdraw per client where LIVE receiver balance > 0. ───
if should_run_step 4; then
  CLIENT_COUNT="$(live_query_get "$LIVE_JSON" "d.clients.length")"
  for (( i=0; i<CLIENT_COUNT; i++ )); do
    CID="$(live_query_get "$LIVE_JSON" "d.clients[$i].clientId")"
    RECV_PRESENT="$(live_query_get "$LIVE_JSON" "d.clients[$i].receiverPresent")"
    CJ="$STATE_ROOT/clients/${CID}.json"
    if [[ "$RECV_PRESENT" != "true" ]]; then
      echo "[teardown] receiver:withdraw ${CID}: receiver NFT not on-chain — skipped"
      continue
    fi
    BALANCE="$(read_json_field "$CJ" "receiver.receiverState.balanceLovelace" || echo 0)"
    if [[ "$BALANCE" =~ ^[0-9]+$ ]] && (( BALANCE > 0 )); then
      if run_tx_checked "04-receiver-withdraw-${CID}.log" \
        "receiver:withdraw --amount-lovelace $BALANCE --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json $BUILD_ONLY_FLAG"; then
        REC_BALANCE="$(add_lovelace "$REC_BALANCE" "$BALANCE")"
        RECOVERY_LINES+=("receiver:withdraw (${CID} balance): $(lovelace_to_ada "$BALANCE") ADA")
        if [[ "$BUILD_ONLY" != "true" ]]; then
          TXH="$(extract_tx_hash "$EVIDENCE_ROOT/04-receiver-withdraw-${CID}.log")"
          [[ -n "$TXH" ]] && record_status "$CJ" "teardown:receiver:withdraw" "$TXH" "withdrawn"
        fi
      else
        echo "[teardown] receiver:withdraw ${CID}: FAILED — see log" >&2
      fi
    else
      echo "[teardown] receiver:withdraw ${CID}: balance == 0 — skipped"
    fi
  done
fi

# ── STEP 5: payment-hook:withdraw (drain aggregated accrued) if hook is live. ─
if should_run_step 5; then
  HOOK_PRESENT="$(live_query_get "$LIVE_JSON" "d.hook.present")"
  HOOK_ACCRUED="$(read_json_field "$PROTOCOL_STATE_ABS" "paymentHookState.accruedFeesLovelace" || echo 0)"
  TOTAL_ACCRUED="$(add_lovelace "$REC_ACCRUED" "$HOOK_ACCRUED")"
  if [[ "$HOOK_PRESENT" != "true" ]]; then
    echo "[teardown] payment-hook:withdraw: hook NFT not on-chain — skipped"
  elif [[ "$TOTAL_ACCRUED" =~ ^[0-9]+$ ]] && (( TOTAL_ACCRUED > 0 )); then
    if run_tx_checked "05-payment-hook-withdraw.log" \
      "payment-hook:withdraw --amount-lovelace $TOTAL_ACCRUED --protocol-state $PROTOCOL_STATE_REL $BUILD_ONLY_FLAG"; then
      RECOVERY_LINES+=("payment-hook:withdraw (aggregated accrued): $(lovelace_to_ada "$TOTAL_ACCRUED") ADA")
      if [[ "$BUILD_ONLY" != "true" ]]; then
        TXH="$(extract_tx_hash "$EVIDENCE_ROOT/05-payment-hook-withdraw.log")"
        [[ -n "$TXH" ]] && record_status "$PROTOCOL_STATE_ABS" "teardown:payment-hook:withdraw" "$TXH" "hook-withdrawn"
      fi
    else
      echo "[teardown] payment-hook:withdraw: FAILED — see log" >&2
    fi
  else
    echo "[teardown] payment-hook:withdraw: aggregated accrued == 0 — skipped"
  fi
fi

# ── STEP 6: pair:burn — ONE per LIVE pair NFT. Orphan every non-live pair. ──
# This is the heart of chain-as-truth: we iterate the live-query pair list, burn
# only `present:true` pairs, and mark every `present:false` pair ORPHANED with
# no tx attempted.
if should_run_step 6; then
  CLIENT_COUNT="$(live_query_get "$LIVE_JSON" "d.clients.length")"
  for (( i=0; i<CLIENT_COUNT; i++ )); do
    CID="$(live_query_get "$LIVE_JSON" "d.clients[$i].clientId")"
    PAIR_COUNT="$(live_query_get "$LIVE_JSON" "d.clients[$i].pairs.length")"
    for (( j=0; j<PAIR_COUNT; j++ )); do
      PAIR_FILE="$(live_query_get "$LIVE_JSON" "d.clients[$i].pairs[$j].pairFile")"
      PAIR_PRESENT="$(live_query_get "$LIVE_JSON" "d.clients[$i].pairs[$j].present")"
      PJ="$STATE_ROOT/clients/${CID}/pairs/${PAIR_FILE}.json"
      if [[ "$PAIR_PRESENT" == "true" ]]; then
        PAIR_MIN="$(read_json_field "$PJ" "pairState.minUtxoLovelace" || echo 0)"
        if run_tx_checked "06-pair-burn-${CID}-${PAIR_FILE}.log" \
          "pair:burn --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json --pair-state $STATE_REL/clients/${CID}/pairs/${PAIR_FILE}.json $BUILD_ONLY_FLAG"; then
          echo "[teardown] pair:burn ${CID}/${PAIR_FILE}: burned (live NFT)"
          [[ "$PAIR_MIN" =~ ^[0-9]+$ ]] && REC_PAIR_MIN="$(add_lovelace "$REC_PAIR_MIN" "$PAIR_MIN")"
          PAIR_BURN_COUNT=$(( PAIR_BURN_COUNT + 1 ))
          if [[ "$BUILD_ONLY" != "true" ]]; then
            TXH="$(extract_tx_hash "$EVIDENCE_ROOT/06-pair-burn-${CID}-${PAIR_FILE}.log")"
            [[ -n "$TXH" ]] && record_status "$PJ" "teardown:pair:burn" "$TXH" "burned"
          fi
        else
          echo "[teardown] pair:burn ${CID}/${PAIR_FILE}: FAILED on a LIVE NFT — see log" >&2
        fi
      else
        echo "[teardown] pair:burn ${CID}/${PAIR_FILE}: NFT not on-chain — ORPHANED (no tx)"
        record_orphan "$PJ" "pair NFT not present at client pair address at teardown time"
        PAIR_ORPHAN_COUNT=$(( PAIR_ORPHAN_COUNT + 1 ))
        ORPHAN_LINES+=("pair ${CID}/${PAIR_FILE}: orphaned (already burned or never minted)")
      fi
    done
  done
  RECOVERY_LINES+=("pair:burn ($PAIR_BURN_COUNT live burned, $PAIR_ORPHAN_COUNT orphaned, Σ min-UTxO): $(lovelace_to_ada "$REC_PAIR_MIN") ADA")
fi

# ── STEP 7: receiver:burn per LIVE receiver + payment-hook:burn (Burn redeemer). ──
# Orphan any receiver whose NFT is already gone. Gated by --skip-singleton-burns.
if should_run_step 7; then
  if [[ "$SKIP_SINGLETON_BURNS" == "true" ]]; then
    echo "[teardown] step 7 SKIPPED (--skip-singleton-burns): receiver:burn + payment-hook:burn"
  else
    CLIENT_COUNT="$(live_query_get "$LIVE_JSON" "d.clients.length")"
    for (( i=0; i<CLIENT_COUNT; i++ )); do
      CID="$(live_query_get "$LIVE_JSON" "d.clients[$i].clientId")"
      RECV_PRESENT="$(live_query_get "$LIVE_JSON" "d.clients[$i].receiverPresent")"
      CJ="$STATE_ROOT/clients/${CID}.json"
      RMIN="$(read_json_field "$CJ" "receiver.receiverState.minUtxoLovelace" || echo 0)"
      if [[ "$RECV_PRESENT" == "true" ]]; then
        if run_tx_checked "07-receiver-burn-${CID}.log" \
          "receiver:burn --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json $BUILD_ONLY_FLAG"; then
          [[ "$RMIN" =~ ^[0-9]+$ ]] && RECOVERY_LINES+=("receiver:burn (${CID} min-UTxO): $(lovelace_to_ada "$RMIN") ADA")
          if [[ "$BUILD_ONLY" != "true" ]]; then
            TXH="$(extract_tx_hash "$EVIDENCE_ROOT/07-receiver-burn-${CID}.log")"
            [[ -n "$TXH" ]] && record_status "$CJ" "teardown:receiver:burn" "$TXH" "receiver-burned"
          fi
        else
          echo "[teardown] receiver:burn ${CID}: FAILED on a LIVE NFT — see log" >&2
        fi
      else
        echo "[teardown] receiver:burn ${CID}: NFT not on-chain — ORPHANED (no tx)"
        record_orphan "$CJ" "receiver NFT not present at receiver address at teardown time"
        ORPHAN_LINES+=("receiver ${CID}: orphaned (already burned or never minted)")
      fi
    done
    HOOK_PRESENT="$(live_query_get "$LIVE_JSON" "d.hook.present")"
    if [[ "$HOOK_PRESENT" == "true" ]]; then
      if run_tx_checked "07-payment-hook-burn.log" \
        "payment-hook:burn --protocol-state $PROTOCOL_STATE_REL $BUILD_ONLY_FLAG"; then
        RECOVERY_LINES+=("payment-hook:burn (min-UTxO): $(lovelace_to_ada "${HOOK_MIN:-0}") ADA")
        if [[ "$BUILD_ONLY" != "true" ]]; then
          TXH="$(extract_tx_hash "$EVIDENCE_ROOT/07-payment-hook-burn.log")"
          [[ -n "$TXH" ]] && record_status "$PROTOCOL_STATE_ABS" "teardown:payment-hook:burn" "$TXH" "hook-burned"
        fi
      else
        echo "[teardown] payment-hook:burn: FAILED on a LIVE NFT — see log" >&2
      fi
    else
      echo "[teardown] payment-hook:burn: hook NFT not on-chain — ORPHANED (no tx)"
      ORPHAN_LINES+=("payment-hook: orphaned (already burned or never minted)")
    fi
  fi
fi

# ── STEP 8: reclaim ALL LIVE reference scripts. Config stays alive until last.
# We re-query AFTER the burns (their inputs are unrelated, but a resumed run may
# have reclaimed some already), then reclaim only the ref-script kinds the chain
# still lists. Order per the audit: client (×each) → payment-hook → config.
if should_run_step 8; then
  refresh_live_query
  # Reclaim verbs operate on a SCRIPT KIND (client / payment-hook / config), not
  # one outRef. We treat a kind as live if ANY of its published outRefs is still
  # present. --script client reclaims receiver+pair+pairMint(+deposit) together.
  for cj in "${CLIENT_FILES[@]}"; do
    CID="$(basename "$cj" .json)"
    CLIENT_REF_LIVE="$(live_query_get "$LIVE_JSON" \
      "d.referenceScripts.some(r => r.kind.startsWith('client:${CID}:') && r.present)")"
    if [[ "$CLIENT_REF_LIVE" == "true" ]]; then
      if run_tx_checked "08-reclaim-client-${CID}.log" \
        "reclaim-reference-script --script client --protocol-state $PROTOCOL_STATE_REL --client-state $STATE_REL/clients/${CID}.json $BUILD_ONLY_FLAG"; then
        RECOVERY_LINES+=("reclaim client (${CID}): receiver+pair+pairMint(+deposit) — lovelace from chain")
        if [[ "$BUILD_ONLY" != "true" ]]; then
          TXH="$(extract_tx_hash "$EVIDENCE_ROOT/08-reclaim-client-${CID}.log")"
          [[ -n "$TXH" ]] && record_status "$STATE_ROOT/clients/${CID}.json" "teardown:reclaim:client" "$TXH" "client-refs-reclaimed"
        fi
      else
        echo "[teardown] reclaim client ${CID}: FAILED on LIVE ref scripts — see log" >&2
      fi
    else
      echo "[teardown] reclaim client ${CID}: no live ref scripts — ORPHANED (no tx)"
      record_orphan "$STATE_ROOT/clients/${CID}.json" "no live client reference scripts at teardown time"
      ORPHAN_LINES+=("client ref-scripts ${CID}: orphaned (already reclaimed or never published)")
    fi
  done

  HOOK_REF_LIVE="$(live_query_get "$LIVE_JSON" \
    "d.referenceScripts.some(r => r.kind === 'global:paymentHook' && r.present)")"
  if [[ "$HOOK_REF_LIVE" == "true" ]]; then
    if run_tx_checked "08-reclaim-payment-hook.log" \
      "reclaim-reference-script --script payment-hook --protocol-state $PROTOCOL_STATE_REL $BUILD_ONLY_FLAG"; then
      RECOVERY_LINES+=("reclaim payment-hook — lovelace from chain")
    else
      echo "[teardown] reclaim payment-hook: FAILED on LIVE ref script — see log" >&2
    fi
  else
    echo "[teardown] reclaim payment-hook: ref script not live — ORPHANED (no tx)"
    ORPHAN_LINES+=("payment-hook ref-script: orphaned (already reclaimed or never published)")
  fi

  CONFIG_REF_LIVE="$(live_query_get "$LIVE_JSON" \
    "d.referenceScripts.some(r => (r.kind === 'global:config' || r.kind === 'global:coordinator') && r.present)")"
  if [[ "$CONFIG_REF_LIVE" == "true" ]]; then
    if run_tx_checked "08-reclaim-config.log" \
      "reclaim-reference-script --script config --protocol-state $PROTOCOL_STATE_REL $BUILD_ONLY_FLAG"; then
      RECOVERY_LINES+=("reclaim config (config+coordinator) — lovelace from chain")
    else
      echo "[teardown] reclaim config: FAILED on LIVE ref script — see log" >&2
    fi
  else
    echo "[teardown] reclaim config: ref scripts not live — ORPHANED (no tx)"
    ORPHAN_LINES+=("config ref-scripts: orphaned (already reclaimed or never published)")
  fi
fi

# ── STEP 9: config:burn LAST (Burn redeemer ONLY). After EVERY reclaim. ─────
if should_run_step 9; then
  if [[ "$SKIP_SINGLETON_BURNS" == "true" ]]; then
    echo "[teardown] step 9 SKIPPED (--skip-singleton-burns): config:burn"
  else
    CONFIG_PRESENT="$(live_query_get "$LIVE_JSON" "d.config.present")"
    if [[ "$CONFIG_PRESENT" == "true" ]]; then
      if run_tx_checked "09-config-burn.log" \
        "config:burn --protocol-state $PROTOCOL_STATE_REL $BUILD_ONLY_FLAG"; then
        RECOVERY_LINES+=("config:burn (min-UTxO): $(lovelace_to_ada "${CONFIG_MIN:-0}") ADA")
        if [[ "$BUILD_ONLY" != "true" ]]; then
          TXH="$(extract_tx_hash "$EVIDENCE_ROOT/09-config-burn.log")"
          [[ -n "$TXH" ]] && record_status "$PROTOCOL_STATE_ABS" "teardown:config:burn" "$TXH" "config-burned"
        fi
      else
        echo "[teardown] config:burn: FAILED on a LIVE NFT — see log" >&2
      fi
    else
      echo "[teardown] config:burn: config NFT not on-chain — ORPHANED (no tx)"
      ORPHAN_LINES+=("config: orphaned (already burned or never minted)")
    fi
  fi
fi

# ── Recovery summary — derived from what was ACTUALLY acted on-chain. ───────
RECOVERED_SUMMABLE="$(add_lovelace "$(add_lovelace "$REC_BALANCE" "$REC_ACCRUED")" "$REC_PAIR_MIN")"

cat <<EOF

[teardown] ====================================================================
[teardown]  RECOVERY SUMMARY  (run: $STATE_NAME, mode: $([[ "$SKIP_SINGLETON_BURNS" == "true" ]] && echo "skip-singleton-burns" || echo "full"))
[teardown]  Chain-as-truth: every line below reflects a tx actually acted on-chain.
[teardown] ====================================================================
[teardown]  ACTED-ON line items:
EOF
if (( ${#RECOVERY_LINES[@]} == 0 )); then
  echo "[teardown]    (none — nothing was live, or --from-step skipped everything)"
else
  for line in "${RECOVERY_LINES[@]}"; do
    echo "[teardown]    - $line"
  done
fi
cat <<EOF
[teardown]
[teardown]  Σ recoverable from acted-on state (EXCLUDES reference-script lovelace,
[teardown]    which is read from chain): $(lovelace_to_ada "$RECOVERED_SUMMABLE") ADA
[teardown]
[teardown]  ORPHANED (no live UTxO; no tx attempted; JSON marked orphaned):
EOF
if (( ${#ORPHAN_LINES[@]} == 0 )); then
  echo "[teardown]    (none — every entity had a live on-chain match)"
else
  for line in "${ORPHAN_LINES[@]}"; do
    echo "[teardown]    - $line"
  done
fi
echo "[teardown] ===================================================================="

capture_cli_json "30a-wallet-final.json" wallet:utxos || true
