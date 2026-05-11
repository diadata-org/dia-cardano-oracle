#!/usr/bin/env bash
# Run Aiken contract tests/build and optionally save output to an evidence directory.
#
# Usage:
#   run-contracts-tests.sh
#   run-contracts-tests.sh --evidence-dir /path/to/evidence
#
# When --evidence-dir is given the output is tee'd to:
#   <evidence-dir>/aiken-check.log
#   <evidence-dir>/aiken-build.log
# and the script exits non-zero if either command fails.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AIKEN_DIR="$REPO/contracts/aiken"
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

run_aiken_check() {
  echo "[contracts-tests] running: aiken check"
  cd "$AIKEN_DIR"
  aiken check
}

run_aiken_build() {
  echo "[contracts-tests] running: aiken build"
  cd "$AIKEN_DIR"
  aiken build
}

if [[ -n "$EVIDENCE_DIR" ]]; then
  mkdir -p "$EVIDENCE_DIR"
  LOG="$EVIDENCE_DIR/aiken-check.log"
  echo "[contracts-tests] output → $LOG"
  run_aiken_check 2>&1 | tee "$LOG"
  EXIT_CODE="${PIPESTATUS[0]}"
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    echo "[contracts-tests] FAILED (exit $EXIT_CODE)" | tee -a "$LOG"
    exit "$EXIT_CODE"
  fi
  echo "[contracts-tests] PASSED" | tee -a "$LOG"
  BUILD_LOG="$EVIDENCE_DIR/aiken-build.log"
  echo "[contracts-tests] output → $BUILD_LOG"
  run_aiken_build 2>&1 | tee "$BUILD_LOG"
  EXIT_CODE="${PIPESTATUS[0]}"
  if [[ "$EXIT_CODE" -ne 0 ]]; then
    echo "[contracts-tests] BUILD FAILED (exit $EXIT_CODE)" | tee -a "$BUILD_LOG"
    exit "$EXIT_CODE"
  fi
  echo "[contracts-tests] BUILD PASSED" | tee -a "$BUILD_LOG"
else
  run_aiken_check
  run_aiken_build
fi
