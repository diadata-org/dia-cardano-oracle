# CLI scripts

Tooling for the CLI (`offchain/cli/`): the two end-to-end runbooks plus test
runners, benchmarks, and diagnostic probes. The day-to-day operator commands
live in [`../README.md`](../README.md); this page documents the scripts that
wrap or exercise them.

## Contents

- [run-all-cli.sh — full deployment runbook](#run-all-clish--full-deployment-runbook)
- [run-teardown-cli.sh — decommission runbook](#run-teardown-clish--decommission-runbook)
- [Test & benchmark scripts](#test--benchmark-scripts)
- [tools/](#tools)

## run-all-cli.sh — full deployment runbook

Drives every network-scoped CLI command end to end — 37 steps, from protocol
init through client onboarding, a price-update batch, the fee lifecycle, and the
side-deposit fold. It loads `.env` first, so `CARDANO_NETWORK` (Preview or
Mainnet) keys every state dir, evidence dir, and explorer link. Each step tees
its output to a numbered log in the run's evidence directory.

What it exercises, in order:

- **Protocol (≈1–7):** `protocol:init` → config bootstrap + config reference
  scripts → payment-hook bootstrap + payment-hook reference script.
- **Client + pairs (≈10–24):** receiver bootstrap, client reference scripts
  (receiver / pair / pairMint / deposit, all four in one tx), receiver top-up,
  the first-pair `update` bootstrap, and ten more pair bootstraps
  (btc/eth/ada/usdt/dai/sol/bnb/xrp/matic/dot).
- **Fee lifecycle (≈25–30):** batch update → settle → `receiver:withdraw` →
  `payment-hook:withdraw` → reclaim + republish the payment-hook reference script.
- **Burn + deposits (≈31–37):** `pair:burn` → side-deposit `fund` ×2 → `merge`
  → fund once more → `update --fold-deposits` (absorbs the side-deposit into the
  Receiver balance inside the same update tx).

Flags:

| Flag | Meaning |
| --- | --- |
| `--run-id ID` | Reuse an existing run's state/evidence dir instead of starting a fresh one. |
| `--from-step N` | Resume at step N (`1..37`). Requires `--run-id`. |
| `--clean-previous=true\|false` | Whether to wipe prior non-preserved run dirs before starting. The original M1 Preview state/evidence dirs are always preserved. |

```sh
bash scripts/run-all-cli.sh                                          # fresh full run
bash scripts/run-all-cli.sh --from-step 28 --run-id 20260608-040304  # resume an existing run
```

Each step runs in a **fresh process**, so a transient lucid WASM build error is
retried at the step level (`TX_STEP_BUILD_RETRIES`, default 2) — but only before
the tx is submitted, never after. Full picture: the WASM-resilience section of
[`docs/architecture/feeder.md`](../../../docs/architecture/feeder.md).

## run-teardown-cli.sh — decommission runbook

Tears a deployment down and recovers as much locked ADA as possible. It is
**chain-as-truth**: before each action it queries the live on-chain UTxOs
(`teardown-helpers/query-live.ts`), acts only on what is actually present,
stamps each entity's JSON with the resulting tx and a `teardown` status
(`teardown-helpers/record-teardown.ts`), and marks every JSON with no live match
as orphaned — no tx is attempted for it. Like `run-all`, it loads `.env` so
`CARDANO_NETWORK` keys the paths and tees each step to a numbered log.

Ordered sequence — the order matters, a wrong one strands ADA:

1. `deposit:merge` per client — sweep side-deposits into the balance **first**.
2. `settle` per client where the live receiver has `accrued_to_hook > 0`.
3. `receiver:withdraw` per client where the live receiver `balance > 0`.
4. `payment-hook:withdraw` — drain the hook's aggregated accrued fees.
5. `pair:burn` — one per live Pair NFT.
6. `receiver:burn` + `payment-hook:burn` — only on deployments whose contracts
   carry the Burn redeemers (skip with `--skip-singleton-burns`).
7. reclaim all live reference scripts: client (each) → payment-hook → config.
8. `config:burn` last (same Burn-redeemer caveat as step 6).

Flags:

| Flag | Meaning |
| --- | --- |
| `--run-id ID` | Tear down `state/<network>_run_<ID>` (default: the newest run). |
| `--from-step N` | Resume at step N (`1..9`). N>1 requires `--run-id`. |
| `--skip-singleton-burns` | Skip the receiver / payment-hook / config burns for deployments whose contracts lack the Burn redeemers; their NFT min-UTxOs stay locked. |

```sh
bash scripts/run-teardown-cli.sh                          # full teardown, newest run
bash scripts/run-teardown-cli.sh --run-id <id> --from-step <n>
bash scripts/run-teardown-cli.sh --skip-singleton-burns   # leave the singletons live
```

## Test & benchmark scripts

**None of these are needed to operate the oracle.**

| Script | What it does | Run via |
| --- | --- | --- |
| `run-contracts-tests.sh` | Runs the Aiken contract tests/build; optionally saves output to an evidence directory. | `bash scripts/run-contracts-tests.sh` |
| `run-node-tests.sh` | Runs the off-chain Node/TypeScript checks; optionally saves output to an evidence directory. | `bash scripts/run-node-tests.sh` |
| `fee-benchmark.sh` | Measures on-chain network fees and exec-unit limits for the oracle transactions. | `bash scripts/fee-benchmark.sh` |
| `emulator-benchmark.ts` | Emulator protocol-flow benchmark (fees/latency without a live network). | `npm run benchmark:emulator` |

## tools/

- `probe-dia-ws.ts` — diagnostic probe for the DIA source WebSocket (connectivity / payload sanity).
