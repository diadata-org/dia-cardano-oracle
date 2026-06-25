#!/usr/bin/env bash
# End-to-end consumer demo against the REAL network, all in one script:
#   1. compile the example consumer validator (aiken build)
#   2. run the demo that reads the live pair FROM THE INDEXER over HTTP, then
#      builds a spend against the example validator that REFERENCES the pair's
#      UTxO — proving it REJECTS when min_price > the live price and ACCEPTS when
#      min_price < it. Real transactions, real confirmation.
#
# The on-chain counterpart of run-consumer-demo-emulator.sh (the offline proof).
#
# Prerequisites (everything comes from the environment, like the CLI/feeder):
#   - the indexer running and reachable at INDEXER_URL (default http://localhost:3001)
#   - a funded wallet + provider on the configured network, in offchain/indexer/.env
#     (CARDANO_NETWORK / CARDANO_PROVIDER / BLOCKFROST_* / CARDANO_WALLET_SEED_*)
# Optional: DEMO_SYMBOL (default BTC/USD), INDEXER_URL.
#
#   bash offchain/indexer/src/examples/run-consumer-demo-onchain.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEXER_DIR="$(cd "$HERE/../.." && pwd)"
CONTRACTS_DIR="$(cd "$INDEXER_DIR/../../contracts/aiken" && pwd)"

echo "==> [1/2] Compiling the example consumer validator (aiken build)…"
( cd "$CONTRACTS_DIR" && aiken build )

echo "==> [2/2] Running the on-chain consumer demo (real network + indexer)…"
( cd "$INDEXER_DIR" && node --env-file-if-exists=.env --import tsx/esm src/examples/consumer-demo-onchain.ts )
