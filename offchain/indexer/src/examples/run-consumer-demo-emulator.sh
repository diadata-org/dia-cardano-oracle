#!/usr/bin/env bash
# End-to-end consumer demo, all in one script:
#   1. compile the example consumer validator (aiken build)
#   2. run the Lucid-emulator demo that uses the INDEXER to read the oracle feed
#      and proves a spend SUCCEEDS when the price meets the threshold and FAILS
#      when the price is below it — the validator consumes our oracle's datum.
#
# Runs on the Lucid in-memory emulator (offline, deterministic, no wallet/funds).
# The on-chain counterpart is run-consumer-demo-onchain.sh. Just:
#   bash offchain/indexer/src/examples/run-consumer-demo-emulator.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEXER_DIR="$(cd "$HERE/../.." && pwd)"
CONTRACTS_DIR="$(cd "$INDEXER_DIR/../../contracts/aiken" && pwd)"

echo "==> [1/2] Compiling the example consumer validator (aiken build)…"
( cd "$CONTRACTS_DIR" && aiken build )

echo "==> [2/2] Running the end-to-end consumer demo (Lucid emulator + indexer)…"
( cd "$INDEXER_DIR" && npx tsx src/examples/consumer-demo-emulator.ts )
