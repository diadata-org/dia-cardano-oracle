#!/usr/bin/env bash
# Run off-chain Node/TypeScript checks and optionally save output to an evidence directory.
#
# Usage:
#   run-node-tests.sh
#   run-node-tests.sh --evidence-dir /path/to/evidence
#
# When --evidence-dir is given the output is tee'd to:
#   <evidence-dir>/npm-test.log
#   <evidence-dir>/npm-typecheck.log
#   <evidence-dir>/npm-build.log
# and the script exits non-zero on first failure.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI_DIR="$REPO/offchain/cli"
EVIDENCE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --evidence-dir)
      [[ $# -ge 2 ]] || { echo "missing value for --evidence-dir" >&2; exit 1; }
      EVIDENCE_DIR="$2"
      shift 2
      ;;
    --evidence-dir=*)
      EVIDENCE_DIR="${1#*=}"
      shift
      ;;
    --help|-h)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

run_logged() {
  local label="$1"
  local log="$2"
  shift 2
  echo "[node-tests] running: $*"
  if [[ -n "$log" ]]; then
    "$@" 2>&1 | tee "$log"
    EXIT_CODE="${PIPESTATUS[0]}"
    if [[ "$EXIT_CODE" -ne 0 ]]; then
      echo "[node-tests] $label FAILED (exit $EXIT_CODE)" | tee -a "$log"
      exit "$EXIT_CODE"
    fi
    echo "[node-tests] $label PASSED" | tee -a "$log"
  else
    "$@"
  fi
}

cd "$CLI_DIR"

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"
  run_logged "npm test"      "$EVIDENCE_DIR/npm-test.log"      npm test
  run_logged "npm typecheck" "$EVIDENCE_DIR/npm-typecheck.log" npm run typecheck
  run_logged "npm build"     "$EVIDENCE_DIR/npm-build.log"     npm run build
else
  npm test
  npm run typecheck
  npm run build
fi
