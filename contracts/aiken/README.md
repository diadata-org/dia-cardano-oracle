# Aiken Contracts

On-chain implementation of the DIA Cardano Oracle, written in
[Aiken](https://aiken-lang.org) and targeting Plutus V3.

This package compiles to `plutus.json` — a blueprint the off-chain CLI in
[`offchain/cli/`](../../offchain/cli/) consumes verbatim to derive script
hashes, addresses, and policy ids.

## Contents

- [Contracts](#contracts)
- [Design & security](#design--security)
- [Layout](#layout)
- [Prerequisites](#prerequisites)
- [Commands](#commands)
- [Benchmarks](#benchmarks)

## Contracts

Seven validators, each in its own file under [`validators/`](validators/).
Shared types and predicates live in [`lib/dia_cardano_oracle/`](lib/dia_cardano_oracle/).

| Validator | Kind | Role |
| --- | --- | --- |
| [`config_state`](validators/config_state.ak) | mint + spend | Mints, guards, and (on teardown) burns the global Config NFT (admin keys, DIA signer keys, EIP-712 domain, fee params, hook/coordinator pointers) |
| [`payment_hook`](validators/payment_hook.ak) | mint + spend | Mints, guards, and (on teardown) burns the global PaymentHook NFT; accumulates settled protocol fees |
| [`receiver`](validators/receiver.ak) | mint + spend | Per-client UTxO holding the client's prepaid fee balance and pending-to-hook accrual; the NFT is burnable on teardown |
| [`pair_state`](validators/pair_state.ak) | mint + spend | Per-client minting policy + spend validator for Pair NFTs (one Pair UTxO per subscribed symbol); NFTs are burnable |
| [`deposit`](validators/deposit.ak) | spend | Per-client side-deposit address: a client funds their balance with an ordinary wallet payment here; the feeder/CLI later folds the deposits into the Receiver balance |
| [`update_coordinator`](validators/update_coordinator.ak) | withdraw | Global authority for oracle updates (single + batch) and Settle; validates DIA intents, fee movement, and pair-state transitions |
| [`reference_holder`](validators/reference_holder.ak) | spend | Holds reference-script UTxOs; admin-gated reclaim for contract upgrades |

`config_state`, `payment_hook`, `update_coordinator`, and `reference_holder`
exist exactly once per deployment. `receiver`, `pair_state`, and `deposit` are
recompiled per client, so every client gets its own script address space.

## Design & security

The protocol design and security analysis live in
[`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md)
and [`docs/security/security-notes.md`](../../docs/security/security-notes.md).
Direct pointers:

- **Pair identity (unforgeable, per-client isolation):**
  [§2](../../docs/architecture/cardano-oracle-architecture.md#2-identity-tokens-state-tokens)
  and [§4.4](../../docs/architecture/cardano-oracle-architecture.md#44-pair-datum-per-client-per-pair).
- **DIA intents (EIP-712 + secp256k1 recovery):**
  [§5.7](../../docs/architecture/cardano-oracle-architecture.md#57-first-pair-updatecreate-per-client--pair).
- **Batch validation (single-pass, canonical order):**
  [§5.9](../../docs/architecture/cardano-oracle-architecture.md#59-price-update-batch).
- **Fee model (decoupled from updates, settle):**
  [§4.3](../../docs/architecture/cardano-oracle-architecture.md#43-receiver-datum-per-client)
  and [§5.11](../../docs/architecture/cardano-oracle-architecture.md#511-settle-accrued-fees).
- **Side-deposit funding & anti-skim:**
  [§5.14](../../docs/architecture/cardano-oracle-architecture.md#514-side-deposit-funding--merge-per-client).

## Layout

```text
contracts/aiken/
├── aiken.toml            # package manifest (pins stdlib + Aiken version)
├── plutus.json           # compiled blueprint (committed; consumed by the CLI)
├── validators/           # one file per validator (see table above)
├── lib/dia_cardano_oracle/
│   ├── config_logic.ak       # ConfigDatum + admin gate helpers
│   ├── coordinator_logic.ak  # coordinator redeemers + cross-script binding
│   ├── deposit_logic.ak      # side-deposit collect predicate (anti-skim)
│   ├── oracle_logic.ak       # PairDatum, UpdateWitness, EIP-712 hashing, signature recovery
│   ├── payment_hook_logic.ak # PaymentHookDatum + settle/withdraw transitions
│   └── receiver_logic.ak     # ReceiverDatum + balance/accrual transitions
└── build/                # aiken build cache (gitignored)
```

Each `*_logic.ak` file ends with inline `test` blocks; `aiken check` runs them
all. Validators in `validators/` also carry their own regression tests against
the deployed handlers (admin gating, cross-script redeemer-confusion, etc.).

## Prerequisites

- Aiken `v1.1.21` (Plutus V3), pinned in `aiken.toml`. Install via the
  [official instructions](https://aiken-lang.org/installation-instructions).

You only need Aiken installed if you intend to modify the contracts, run
the unit tests, or rebuild the blueprint. The committed `plutus.json` is
the canonical compiled artifact, so a fresh clone can run the off-chain CLI
without installing Aiken first.

## Commands

```sh
aiken check    # run the full unit-test suite
aiken build    # regenerate ./plutus.json
aiken bench    # run the benchmark suite (CPU/mem growth by size)
```

Always commit the rebuilt `plutus.json` alongside any validator change so
the off-chain CLI stays in sync.

## Benchmarks

`aiken bench` provides CPU/mem baselines for the hot paths:
`update_coordinator.valid_batch_update`, `update_coordinator.valid_settle`,
`receiver.spend AccrueFee`, `receiver.spend Settle`,
`payment_hook.spend ApplySettle`, and `pair_state.spend ApplyUpdate`.

```sh
# Full benchmark dataset as JSON
aiken bench --max-size 11 > benchmarks.json

# Only the coordinator benches (size 0..11 => modeled N = 1..12)
aiken bench --max-size 11 -m update_coordinator > update-coordinator-benches.json

# Focus on receiver / hook decode growth
aiken bench --max-size 11 -m receiver > receiver-benches.json
aiken bench --max-size 11 -m payment_hook > payment-hook-benches.json

# Control benchmark: pair_state fingerprint path
aiken bench --max-size 11 -m pair_state > pair-state-benches.json
```

These samplers model `N = size + 1`, so `--max-size 11` yields the range
`1..12`.
