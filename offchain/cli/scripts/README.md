# CLI scripts

Developer and CI tooling for the CLI (`offchain/cli/`): test runners, on-chain
benchmarks, and diagnostic probes. **None of these are needed to operate the oracle** —
the operator commands are documented in [`../README.md`](../README.md).

## Contents

- [Scripts](#scripts)
- [tools/](#tools)
- [Cleanup note](#cleanup-note)

## Scripts

| Script | What it does | Run via |
| --- | --- | --- |
| `run-all-cli.sh` | Drives every network-scoped CLI command end to end (loads `.env` so `CARDANO_NETWORK` sets the paths). Smoke-tests the full protocol → client → update flow. | `bash scripts/run-all-cli.sh` |
| `run-contracts-tests.sh` | Runs the Aiken contract tests/build; optionally saves output to an evidence directory. | `bash scripts/run-contracts-tests.sh` |
| `run-node-tests.sh` | Runs the off-chain Node/TypeScript checks; optionally saves output to an evidence directory. | `bash scripts/run-node-tests.sh` |
| `fee-benchmark.sh` | Measures on-chain network fees and exec-unit limits for the oracle transactions. | `bash scripts/fee-benchmark.sh` |
| `emulator-benchmark.ts` | Emulator protocol-flow benchmark (fees/latency without a live network). | `npm run benchmark:emulator` |

## tools/

- `probe-dia-ws.ts` — diagnostic probe for the DIA source WebSocket (connectivity / payload sanity).

## Cleanup note

`_OLD/` holds a superseded `reconcile-batch.ts`. It is dead code kept only as a
reference and can be deleted.
