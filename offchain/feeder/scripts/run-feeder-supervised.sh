#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-feeder-supervised.sh — restart supervisor for the npm/local feeder run.
#
# WHY
#   The Docker deployment uses `restart: unless-stopped`, so the daemon's
#   self-exit on persistent lucid WASM corruption (exit code 17) auto-restarts
#   with a fresh WASM module. The bare `npm run feeder:dev -- daemon` (tsx) run
#   has NO supervisor: a self-exit just leaves the process dead. This script is
#   that supervisor for local/npm runs — it runs the daemon in a restart loop
#   so the same fresh-process recovery works outside Docker.
#
# WHAT
#   Runs `npm run feeder:dev -- daemon "$@"` in a loop, passing through all
#   args and the inherited environment (RUN_ID, CARDANO_NETWORK, DRY_RUN, …).
#   Between restarts it sleeps with an ESCALATING backoff so a permanent error
#   (bad config, missing env) does NOT tight-crash-loop and burn CPU; a clean
#   run that survives past RESET_AFTER_SECONDS resets the backoff to its floor.
#
#   A clean exit (code 0) — e.g. an operator Ctrl+C that the daemon turns into
#   a graceful exit, or `--validate-only`-style early returns — STOPS the loop.
#   Any non-zero exit (including the WASM self-exit code 17) triggers a
#   backoff + restart.
#
# ENV OVERRIDES
#   FEEDER_BACKOFF_MIN_SECONDS   floor backoff between restarts   (default 2)
#   FEEDER_BACKOFF_MAX_SECONDS   ceiling backoff between restarts (default 60)
#   FEEDER_BACKOFF_RESET_SECONDS uptime past which backoff resets (default 300)
#
# USAGE
#   ./scripts/run-feeder-supervised.sh                 # daemon, default args
#   ./scripts/run-feeder-supervised.sh --dry-run       # pass-through flags
#   RUN_ID=20260517-063917 ./scripts/run-feeder-supervised.sh
#   npm run feeder:supervised -- --dry-run             # via the npm script
# ---------------------------------------------------------------------------
set -uo pipefail

# Run from the feeder package root regardless of the caller's cwd, so the
# relative `npm run` and config/state paths resolve correctly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEEDER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${FEEDER_DIR}"

BACKOFF_MIN="${FEEDER_BACKOFF_MIN_SECONDS:-2}"
BACKOFF_MAX="${FEEDER_BACKOFF_MAX_SECONDS:-60}"
BACKOFF_RESET="${FEEDER_BACKOFF_RESET_SECONDS:-300}"

backoff="${BACKOFF_MIN}"

echo "[supervisor] starting feeder daemon under restart supervision (args: $*)"

while true; do
  started_at="$(date +%s)"
  # `--` forwards the remaining args to the daemon (npm strips the first `--`).
  npm run feeder:dev -- daemon "$@"
  exit_code=$?
  ended_at="$(date +%s)"
  uptime=$(( ended_at - started_at ))

  if [ "${exit_code}" -eq 0 ]; then
    echo "[supervisor] daemon exited cleanly (code 0) — not restarting."
    break
  fi

  # A run that stayed up long enough is treated as healthy: reset the backoff
  # so an unrelated late failure does not inherit a long delay.
  if [ "${uptime}" -ge "${BACKOFF_RESET}" ]; then
    backoff="${BACKOFF_MIN}"
  fi

  echo "[supervisor] daemon exited with code ${exit_code} after ${uptime}s — restarting in ${backoff}s."
  sleep "${backoff}"

  # Escalate the backoff (double, capped) so a permanent error does not
  # tight-loop. Reset above clears it after a healthy run.
  backoff=$(( backoff * 2 ))
  if [ "${backoff}" -gt "${BACKOFF_MAX}" ]; then
    backoff="${BACKOFF_MAX}"
  fi
done
