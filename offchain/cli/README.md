# DIA Cardano Oracle CLI

TypeScript CLI for deploying and operating the DIA Cardano Oracle contracts on Cardano `Preview` and `Mainnet`.

The active network is selected by the `CARDANO_NETWORK` env var (`Preview` or
`Mainnet`). Every CLI command, state directory, evidence directory, and step ID
written into state JSONs is derived from that single variable — no code changes
or alternate command set are needed to target a different network. Set
`CARDANO_NETWORK` and the matching Blockfrost project id in `.env`, generate or
fund the right wallet, and re-run.

This page documents running the CLI on the host (npm). The same commands also
run in the self-contained Docker image — see
[`offchain/feeder/README.md`](../feeder/README.md#running-with-docker)
(`make wallet`, `make run-all`, `make cli CMD="…"`).

## Contents

- [Overview](#overview)
  - [Folder structure](#folder-structure)
- [Prerequisites](#prerequisites)
- [Environment](#environment)
- [Install](#install)
- [Wallet Setup](#wallet-setup)
  - [1. Inspect contracts](#1-inspect-contracts)
  - [2. Inspect network](#2-inspect-network)
  - [3. Create a Cardano wallet](#3-create-a-cardano-wallet)
  - [4. Create an Ethereum wallet](#4-create-an-ethereum-wallet)
  - [5. Fund and inspect the Cardano wallet](#5-fund-and-inspect-the-cardano-wallet)
- [Protocol Deployment](#protocol-deployment)
  - [6. Initialize the protocol artifact](#6-initialize-the-protocol-artifact)
  - [7. Parameterize Config scripts](#7-parameterize-config-scripts)
  - [8. Bootstrap Config](#8-bootstrap-config)
  - [9. Publish Config reference scripts](#9-publish-config-reference-scripts)
  - [10. Parameterize PaymentHook scripts](#10-parameterize-paymenthook-scripts)
  - [11. Bootstrap PaymentHook](#11-bootstrap-paymenthook)
  - [12. Publish PaymentHook reference script](#12-publish-paymenthook-reference-script)
- [Client Deployment](#client-deployment)
  - [13. Initialize the client artifact](#13-initialize-the-client-artifact)
  - [14. Parameterize Receiver and Pair scripts](#14-parameterize-receiver-and-pair-scripts)
  - [15. Bootstrap the Receiver](#15-bootstrap-the-receiver)
  - [16. Publish client reference scripts](#16-publish-client-reference-scripts)
  - [17. Top up the Receiver](#17-top-up-the-receiver)
- [Oracle Intent Flow](#oracle-intent-flow)
  - [18. Create an unsigned intent](#18-create-an-unsigned-intent)
  - [19. Sign the intent](#19-sign-the-intent)
  - [20. Create and sign in one step](#20-create-and-sign-in-one-step)
- [Live Updates](#live-updates)
  - [21. Submit one update](#21-submit-one-update)
  - [22. Create a Config update draft](#22-create-a-config-update-draft)
  - [23. Submit a Config update](#23-submit-a-config-update)
  - [24. Create a batch manifest](#24-create-a-batch-manifest)
  - [25. Submit a batch update](#25-submit-a-batch-update)
  - [25b. Settle accrued fees](#25b-settle-accrued-fees)
  - [25c. Side-deposit funding](#25c-side-deposit-funding)
- [Maintenance Transactions](#maintenance-transactions)
  - [26. Withdraw from the Receiver](#26-withdraw-from-the-receiver)
  - [27. Withdraw protocol fees from PaymentHook](#27-withdraw-protocol-fees-from-paymenthook)
  - [28. Update min UTxO for Receiver (admin only)](#28-update-min-utxo-for-receiver-admin-only)
  - [29. Update min UTxO for Pair (admin only)](#29-update-min-utxo-for-pair-admin-only)
  - [29b. Burn a Pair (admin only)](#29b-burn-a-pair-admin-only)
  - [29c. Deduplicate Pair UTxOs (admin only)](#29c-deduplicate-pair-utxos-admin-only)
  - [29d. Burn the Receiver (admin only)](#29d-burn-the-receiver-admin-only)
  - [29e. Burn the PaymentHook (admin only)](#29e-burn-the-paymenthook-admin-only)
  - [29f. Burn the Config (admin only)](#29f-burn-the-config-admin-only)
  - [30. Update min UTxO for Config (admin only)](#30-update-min-utxo-for-config-admin-only)
  - [31. Update min UTxO for PaymentHook (admin only)](#31-update-min-utxo-for-paymenthook-admin-only)
  - [32. Reclaim reference-script UTxOs](#32-reclaim-reference-script-utxos)
- [Build Only](#build-only)
- [Artifact rules](#artifact-rules)

## Overview

The CLI takes three kinds of inputs: **state artifacts** (the persistent
protocol/client/pair JSON files — one source of truth per artifact),
**generated payloads** (ephemeral intents, config-update drafts, and batch
manifests that you generate with a command and then feed to a transaction
command), and **direct CLI flags** (simple values such as `--amount-lovelace`).
All files live under `../state/<network>/`, where `<network>` is the lowercase
value of `CARDANO_NETWORK` (`preview` or `mainnet`).

### Folder structure

```text
offchain/cli/
├── src/
│   ├── index.ts            # CLI entrypoint and command dispatcher
│   ├── init/               # protocol/client init, config-update + batch generators
│   ├── deploys/            # parameterize + bootstrap + reference-script publish
│   ├── oracle/             # EIP-712 intent create/sign, EVM wallet helper
│   ├── transactions/       # update, batch, settle, top-up, withdraw, burn, reclaim, min-utxo
│   ├── preflight/          # invariant checks shared by tx builders
│   ├── core/               # config (env), state I/O, primitives, Lucid wiring
│   ├── wallet/             # Cardano wallet creation
│   └── emulator/           # in-process emulator flow + benchmark
├── scripts/
│   ├── run-all-cli.sh          # full end-to-end runbook (Preview or Mainnet)
│   ├── run-teardown-cli.sh     # decommission runbook (chain-as-truth teardown)
│   ├── fee-benchmark.sh        # batch-size capacity benchmark
│   ├── emulator-benchmark.ts   # in-process emulator throughput benchmark
│   ├── run-contracts-tests.sh  # Aiken contract test runner
│   └── run-node-tests.sh       # Node.js integration test runner
└── .env                    # CARDANO_NETWORK, Blockfrost, wallet seeds
```

State lives in the **shared** `offchain/state/` tree — a sibling of `cli/` and
`feeder/`. The CLI writes the deployment record; the feeder reads it and adds its
runtime (DB, logs, pair state) to the same run dir:

```text
offchain/state/<network>_run_<id>/                  # shared per-run state
├── config-bootstrap.json                       # protocol artifact (Config + PaymentHook + global ref-scripts)
├── clients/
│   ├── <client>.json                           # client artifact (Receiver + client ref-scripts)
│   └── <client>/pairs/<pair>.json              # pair artifacts (one per live pair)
├── intents/<pair>.{unsigned,signed}.json       # EIP-712 oracle intents
├── config-updates/config-update.json           # generated Config-update drafts
├── update-batches/update-batch.manifest.json   # generated batch manifests
└── logs/ + feeder.sqlite                        # feeder runtime (gitignored)
```

Sub-folder docs: [`scripts/README.md`](./scripts/README.md) (developer / CI tooling) and
[`state/README.md`](./state/README.md) (the generated state-artifact field reference).

The normal flow is:

1. create wallets
2. initialize protocol state
3. parameterize and bootstrap protocol contracts
4. initialize client state
5. parameterize and bootstrap receiver contracts
6. create and sign intents
7. submit single or batch oracle updates
8. run maintenance transactions

**Common flags (used across commands):** `--protocol-state <path>` points at the
protocol artifact (`config-bootstrap.json`); `--client-state <path>` at the
client artifact; `--pair-state <path>` at a pair file; `--out <path>` chooses
where output is written; `--build-only` builds and inspects the transaction
without submitting (see [Build Only](#build-only)). The examples below show them
inline; the per-command tables list only the flags specific to that command.

## Prerequisites

- **Node.js 20+** with `npm`.
- **Compiled on-chain contracts.** This CLI reads
  [`contracts/aiken/plutus.json`](../../contracts/aiken/plutus.json) to derive
  script hashes, addresses, and policy ids. The file is committed, so a
  fresh clone works out of the box. If you have modified the contracts,
  rebuild it with `aiken build` first — see
  [`contracts/aiken/README.md`](../../contracts/aiken/README.md).
- **A Blockfrost project id** for the network you target (Preview *or* Mainnet),
  or a Koios endpoint.
- **A funded wallet seed for that network.** The CLI can create one for you in
  step 3 below; fund it from the Preview faucet (Preview) or send real ADA
  (Mainnet) before continuing past step 5.

## Environment

Create `.env` from `.env.example`. **Every per-network variable is suffixed
`_TESTNET` (used when `CARDANO_NETWORK=Preview`) or `_MAINNET` (used when
`CARDANO_NETWORK=Mainnet`).** A single `.env` carries both environments' creds
side by side; switching networks is one line.

Unsuffixed variables (selector / network-agnostic):

- `CARDANO_NETWORK` — `Preview` or `Mainnet`. Drives state/evidence dirs, step
  IDs, and which `*_TESTNET` / `*_MAINNET` block the CLI reads.
- `CARDANO_PROVIDER` — `Blockfrost` (default) or `Koios`.
- `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION` — EIP-712 domain (network-independent).

Per-network variables (set BOTH the `_TESTNET` and `_MAINNET` variant of each;
`.env.example` ships with the canonical confirmed values pre-filled):

| Base name | Purpose |
|---|---|
| `BLOCKFROST_PROJECT_ID_*` | Blockfrost project id matching the network |
| `BLOCKFROST_API_URL_*` | Blockfrost REST endpoint |
| `KOIOS_API_URL_*` | Koios endpoint (used only when `CARDANO_PROVIDER=Koios`) |
| `CARDANO_WALLET_SEED_*` | Mnemonic of the funder wallet |
| `CARDANO_PRIVATE_KEY_*` | Alt. to seed; one of the two must be set |
| `DIA_SOURCE_CHAIN_ID_*` | DIA chain id (Testnet=`10050`, Mainnet=`1050`) |
| `DIA_RPC_URL_*` | DIA EVM JSON-RPC endpoint |
| `DIA_WS_URL_*` | DIA WebSocket endpoint base |
| `DIA_REGISTRY_ADDRESS_*` | `OracleIntentRegistry` address |
| `DIA_EXPLORER_URL_*` | DIA explorer base URL |
| `DIA_AUTHORIZED_PRIVATE_KEY_*` | **Local** self-sign key (ours, one): signs demo EIP-712 OracleIntents from the CLI / run-all. Its derived public key is authorized automatically. |
| `DIA_AUTHORIZED_PUBLIC_KEYS_*` | **DIA's** real signer public keys (comma-separated list, verify-only — we hold no private half): authorized at `protocol:init` / `config:update` so the feeder's real DIA intents are accepted. On Mainnet, set ONLY these (never the local private key). |
| `DIA_WS_CREDENTIAL_*` | Conduit path-style credential for the WS endpoint |

So a fresh setup looks like: `cp .env.example .env`, fill the two
`BLOCKFROST_PROJECT_ID_*` values + the two `CARDANO_WALLET_SEED_*` values +
the two `DIA_AUTHORIZED_PRIVATE_KEY_*` and `DIA_WS_CREDENTIAL_*` values, leave the
rest as-is. Set `CARDANO_NETWORK=Preview` (or `Mainnet`) to choose which side
the CLI uses today.

## Install

```sh
cd offchain/cli
npm install
```

## Wallet Setup

### 1. Inspect contracts

Lists the compiled blueprints and prints the reference-holder address for a
parameterized protocol artifact.

```sh
npm run cli -- blueprint:list
npm run cli -- reference-holder --protocol-state ../state/<network>/config-bootstrap.json
```

`reference-holder` requires a parameterized state artifact (run after `config:parameterize`).

### 2. Inspect network

Prints the resolved network, provider, and protocol parameters for the current
`.env`.

```sh
npm run cli -- protocol
```

### 3. Create a Cardano wallet

Generates a new Cardano wallet mnemonic and prints its address and
`paymentKeyHash`.

```sh
npm run cli -- wallet:create
```

Set `CARDANO_WALLET_SEED_TESTNET` (or `_MAINNET`, depending on `CARDANO_NETWORK`) in `.env` with the generated mnemonic. The printed `paymentKeyHash` is the default config-admin signer used later by `protocol:init`.

### 4. Create an Ethereum wallet

Generates an Ethereum private key and prints its compressed public key.

```sh
npm run cli -- ethereum-wallet:create
```

Set `DIA_AUTHORIZED_PRIVATE_KEY_TESTNET` (or `_MAINNET`, depending on `CARDANO_NETWORK`) in `.env` with the generated private key. The printed compressed `publicKey` is the default authorized DIA signer used later by `protocol:init`.

### 5. Fund and inspect the Cardano wallet

Prints the configured wallet's address, balance, UTxOs, and derived defaults so
you can confirm where to send funds.

```sh
npm run cli -- wallet
npm run cli -- wallet:utxos
npm run cli -- wallet:defaults
```

Fund the configured address:

- On `CARDANO_NETWORK=Preview`, use the Cardano Preview faucet:
  <https://docs.cardano.org/cardano-testnets/tools/faucet>
- On `CARDANO_NETWORK=Mainnet`, send real ADA from an exchange or another
  wallet. Confirm the destination address matches `wallet:defaults` for the
  same `.env` you will run the CLI with.

The deployment wallet needs enough pure ADA UTxOs for:

- Config bootstrap
- Config reference scripts
- PaymentHook bootstrap
- PaymentHook reference script
- Receiver bootstrap
- Client reference scripts
- first pair update/create and later updates

## Protocol Deployment

### 6. Initialize the protocol artifact

Creates the protocol artifact `../state/<network>/config-bootstrap.json` with
Config and PaymentHook defaults, asset labels, deposit tx-build params, and
empty script/transaction blocks. No transaction is submitted.

```sh
npm run cli -- protocol:init
```

Key flags (all optional). Each falls back to the single-source CLI default in
[`src/core/constants.ts`](./src/core/constants.ts) when omitted:

| Flag | What |
| --- | --- |
| `--deposit-min-lovelace` | Dust floor a side deposit must hold to be accepted/swept (§25c) |
| `--deposit-max-per-merge` | Max deposit UTxOs folded into one `deposit:merge` (§25c) |
| `--deposit-max-per-update-fold` | Max deposits an oracle update folds in (top-up riding on an update) (§25c) |

These are stored in `configState` next to the fee params (`baseFeeLovelace`,
`perPairFeeLovelace`, `minUtxoLovelace`) and read by both the CLI and the feeder.

### 7. Parameterize Config scripts

Selects a pure ADA wallet UTxO and derives the Config, Coordinator, and
ReferenceHolder scripts offline, saving them to the artifact. No transaction is
submitted.

```sh
npm run cli -- config:parameterize \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 8. Bootstrap Config

Consumes the selected wallet UTxO, mints the Config NFT, and creates the Config
UTxO on-chain.

```sh
npm run cli -- config:bootstrap \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 9. Publish Config reference scripts

Publishes the Config and Coordinator reference scripts at the reference-holder
address.

```sh
npm run cli -- config:reference-scripts \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 10. Parameterize PaymentHook scripts

Selects a pure ADA wallet UTxO and derives the PaymentHook scripts offline. No
transaction is submitted.

```sh
npm run cli -- payment-hook:parameterize \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 11. Bootstrap PaymentHook

Consumes the selected wallet UTxO, mints the PaymentHook NFT, and creates the
PaymentHook UTxO on-chain.

```sh
npm run cli -- payment-hook:bootstrap \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 12. Publish PaymentHook reference script

Publishes the PaymentHook reference script at the reference-holder address.

```sh
npm run cli -- payment-hook:reference-script \
  --protocol-state ../state/<network>/config-bootstrap.json
```

## Client Deployment

### 13. Initialize the client artifact

Creates the client artifact `../state/<network>/clients/client-a.json` with the
`clientId`, the receiver asset label/name, and the receiver min UTxO.

```sh
npm run cli -- client:init
```

### 14. Parameterize Receiver and Pair scripts

Selects a pure ADA wallet UTxO and derives the Receiver and Pair scripts
offline. No transaction is submitted.

```sh
npm run cli -- receiver:parameterize \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

### 15. Bootstrap the Receiver

Creates the on-chain Receiver UTxO with `balanceLovelace = 0`. Fund it before
the first price update with `receiver:top-up` (§17) or via side deposits (§25c).

```sh
npm run cli -- receiver:bootstrap \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

### 16. Publish client reference scripts

Publishes the Receiver and Pair validators, the Pair minting policy, and the
deposit validator (four reference scripts) at the reference-holder address in a
single transaction.

```sh
npm run cli -- reference-scripts:publish-client \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

### 17. Top up the Receiver

Adds ADA to a Receiver's balance so it can pay oracle update fees. The
configured wallet credits the supplied `--amount-lovelace` to the Receiver. In
production, clients fund via side deposits instead (§25c); `receiver:top-up` is
the direct path used in the single-wallet runbook.

```sh
npm run cli -- receiver:top-up \
  --amount-lovelace 100000000 \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--amount-lovelace` | Lovelace to add to the Receiver balance | required |

## Oracle Intent Flow

Every Pair UTxO is created from a real signed oracle intent. There is no
separate Pair bootstrap transaction and no placeholder datum. There are three
intent commands: `intent:create` (generate an unsigned intent file),
`intent:sign` (sign an existing unsigned intent), and `intent:create-and-sign`
(prompt and immediately sign).

### 18. Create an unsigned intent

Generates an unsigned EIP-712 oracle intent file.

```sh
npm run cli -- intent:create \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --out ../state/<network>/intents/usdc-usd.unsigned.json
```

### 19. Sign the intent

Signs an existing unsigned intent with the configured local signer private key (`DIA_AUTHORIZED_PRIVATE_KEY_*`).

```sh
npm run cli -- intent:sign \
  --input ../state/<network>/intents/usdc-usd.unsigned.json \
  --out ../state/<network>/intents/usdc-usd.signed.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--input` | Unsigned intent file to sign | required |

### 20. Create and sign in one step

Prompts for the intent fields and writes a signed intent directly.

```sh
npm run cli -- intent:create-and-sign \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --out ../state/<network>/intents/usdt-usd.signed.json
```

For every later update, generate a fresh signed intent with a new nonce, timestamp, expiry, and price.

## Live Updates

### 21. Submit one update

Submits a single oracle update for one pair. If the pair artifact does not exist
yet, it mints the Pair NFT and creates the first Pair UTxO (this is admin-gated —
the configured wallet must be a `config_admins` signer); if it already exists,
it writes the next datum (not admin-gated). New Pair UTxOs inherit the current
`configState.minUtxoLovelace`. With `--fold-deposits` the update opportunistically
folds up to `configState.depositMaxPerUpdateFold` clean pending side deposits into
the Receiver balance in the same tx (§25c,
[architecture §5.14](../../docs/architecture/cardano-oracle-architecture.md#514-side-deposit-funding--merge-per-client)).

```sh
npm run cli -- update \
  --intent ../state/<network>/intents/usdc-usd.signed.json \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --pair-state ../state/<network>/clients/client-a/pairs/usdc-usd.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--intent` | Signed intent driving the update | required |
| `--fold-deposits` | Fold pending side deposits into the Receiver balance in this tx (§25c) | off |

### 22. Create a Config update draft

Generates a structured Config-update draft instead of asking you to hand-write
JSON.

```sh
npm run cli -- config:update:create \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --out ../state/<network>/config-updates/config-update.json
```

### 23. Submit a Config update

Applies a Config-update draft on-chain. Requires a Config signer.

```sh
npm run cli -- config:update \
  --input ../state/<network>/config-updates/config-update.json \
  --protocol-state ../state/<network>/config-bootstrap.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--input` | Config-update draft to apply | required |

### 24. Create a batch manifest

Generates a batch manifest interactively — the CLI asks which pair state paths
and signed intent files to include. A pair state path may point to an existing
pair artifact or to the path the batch should create.

```sh
npm run cli -- update:batch:create \
  --pairs-dir ../state/<network>/clients/client-a/pairs \
  --intents-dir ../state/<network>/intents \
  --out ../state/<network>/update-batches/update-batch.manifest.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--pairs-dir` | Directory of pair artifacts to choose from | required |
| `--intents-dir` | Directory of signed intents to choose from | required |

### 25. Submit a batch update

Updates existing pairs and creates missing pairs in one transaction. New pairs
inherit `configState.minUtxoLovelace` automatically. If any pair in the manifest
is being created, the configured wallet must be a `config_admins` signer;
pure-update batches do not need admin authorisation.

```sh
npm run cli -- update:batch \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --manifest ../state/<network>/update-batches/update-batch.manifest.json \
  --out ../state/<network>/update-batches/update-batch.result.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--manifest` | Batch manifest produced by §24 | required |

### 25b. Settle accrued fees

Drains accrued fees from one or more Receivers and credits them to the
PaymentHook in a single transaction, clearing each Receiver's accrual. This is
an admin-initiated operation. `--client-state` is repeatable — pass it once per
client to settle N receivers in one transaction. See architecture
[§5.11 Settle accrued fees](../../docs/architecture/cardano-oracle-architecture.md#511-settle-accrued-fees)
for how it is validated on-chain.

```sh
# Single client:
npm run cli -- settle \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json

# Multiple clients in one tx (repeat --client-state):
npm run cli -- settle \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --client-state ../state/<network>/clients/client-b.json
```

### 25c. Side-deposit funding

How a client funds their Receiver balance without running the CLI: each client
has a per-client deposit address, the client sends an ordinary ADA payment to
it, and DIA later folds the accumulated deposits into the Receiver balance.
Besides the standalone `deposit:merge` (a bulk sweep), an ordinary `update`
automatically folds a bounded number of pending deposits into the Receiver it is
already touching. The deposit floor, per-merge cap, and per-update fold cap come
from `protocol:init` (§6, `depositMinLovelace` / `depositMaxPerMerge` /
`depositMaxPerUpdateFold`). See architecture
[§5.14 Side-deposit funding & merge](../../docs/architecture/cardano-oracle-architecture.md#514-side-deposit-funding--merge-per-client)
for how it works on-chain.

Three commands:

- `deposit:address` — print the address a client funds (give this to the client).
- `deposit:fund` — send an ADA payment to that address (what a client does from
  any wallet; provided here for the runbook / tests).
- `deposit:merge` — fold accumulated deposits into the Receiver balance
  (DIA-side; the feeder daemon also runs this automatically).

```sh
# Print the address a client funds:
npm run cli -- deposit:address \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json

# Fund it with a plain ADA payment:
npm run cli -- deposit:fund --amount-lovelace 5000000 \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json

# Sweep accumulated deposits into the Receiver balance:
npm run cli -- deposit:merge \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

The three deposit caps are set at `protocol:init` (§6) and default from
[`src/core/constants.ts`](./src/core/constants.ts):

| Flag / config knob | What |
| --- | --- |
| `--amount-lovelace` (`deposit:fund`) | Lovelace to send to the deposit address (required) |
| `depositMinLovelace` (`protocol:init` `--deposit-min-lovelace`) | Min lovelace a deposit must hold to be accepted / swept |
| `depositMaxPerMerge` (`protocol:init` `--deposit-max-per-merge`) | Max deposit UTxOs folded into one `deposit:merge` |
| `depositMaxPerUpdateFold` (`protocol:init` `--deposit-max-per-update-fold`) | Max deposits an ordinary `update` folds in automatically |

## Maintenance Transactions

### 26. Withdraw from the Receiver

Moves lovelace out of a Receiver's balance to a recipient address. If
`--recipient-address` is omitted, the configured wallet address is used.

```sh
npm run cli -- receiver:withdraw \
  --amount-lovelace 2000000 \
  --recipient-address <addr_test...> \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--amount-lovelace` | Lovelace to withdraw from the Receiver balance | required |
| `--recipient-address` | Destination address | configured wallet |

### 27. Withdraw protocol fees from PaymentHook

Moves settled protocol fees out of the PaymentHook to the admin wallet.

```sh
npm run cli -- payment-hook:withdraw \
  --amount-lovelace 2000000 \
  --protocol-state ../state/<network>/config-bootstrap.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--amount-lovelace` | Lovelace to withdraw from the PaymentHook | required |

### 28. Update min UTxO for Receiver (admin only)

Sets a new `min_utxo_lovelace` floor on a Receiver UTxO. The Receiver UTxO is
adjusted to hold the new minimum ADA; `balance` and `accrued` fields are
unchanged. Requires a Config signer.

```sh
npm run cli -- receiver:update-min-utxo \
  --new-min-utxo-lovelace 3000000 \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--new-min-utxo-lovelace` | New min-UTxO floor for the Receiver | required |

### 29. Update min UTxO for Pair (admin only)

Sets a new `min_utxo_lovelace` floor on a Pair UTxO. All other Pair datum fields
are unchanged. Requires a Config signer.

```sh
npm run cli -- pair:update-min-utxo \
  --new-min-utxo-lovelace 3000000 \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --pair-state ../state/<network>/clients/client-a/pairs/usdc-usd.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--new-min-utxo-lovelace` | New min-UTxO floor for the Pair | required |

### 29b. Burn a Pair (admin only)

Burns the Pair NFT of an existing pair and returns the locked min-ADA to the
admin wallet. A later `update` for the same symbol mints a fresh Pair NFT and
rebuilds pair state. Requires a `config_admins` signer. See architecture
[§5.13 Pair burn](../../docs/architecture/cardano-oracle-architecture.md#513-pair-burn-admin-only)
for the on-chain validation.

```sh
npm run cli -- pair:burn \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --pair-state ../state/<network>/clients/client-a/pairs/usdc-usd.json
```

### 29c. Deduplicate Pair UTxOs (admin only)

Scans the pair validator address for duplicate Pair NFT UTxOs (multiple UTxOs
carrying the same pair unit), keeps the one with the highest datum nonce, and
burns the rest. Idempotent — exits cleanly when no duplicates are found.
Requires a `config_admins` signer.

```sh
npm run cli -- pair:dedup \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

Duplicates can arise if the feeder submits a valid update but crashes before
writing local state, then re-creates the pair on restart. The feeder logs a
`WARN [duplicate-pairs]` entry with the exact command to run when it detects
this at startup.

### 29d. Burn the Receiver (admin only)

Burns the Receiver NFT and recovers the locked min-UTxO ADA to the admin wallet,
used when decommissioning a client. Requires a `config_admins` signer. Run
`receiver:withdraw` (§26) to drain `balance` and `settle` (§25b) to drain accrued
fees first — the burn rejects a Receiver whose `balance` or `accrued` is non-zero.

```sh
npm run cli -- receiver:burn \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

### 29e. Burn the PaymentHook (admin only)

Burns the PaymentHook NFT and recovers the locked min-UTxO ADA to the admin
wallet, used when decommissioning a deployment. Requires a `config_admins` signer.
Run `payment-hook:withdraw` (§27) to drain the hook's `accrued_fees` first — the
burn rejects a hook with non-zero accrued fees.

```sh
npm run cli -- payment-hook:burn \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 29f. Burn the Config (admin only)

Burns the Config NFT and recovers the locked min-UTxO ADA to the admin wallet, the
final step of decommissioning a deployment. Requires a `config_admins` signer. Run
it last: `reclaim-reference-script` (§32) reads the live Config UTxO to authorize
each reclaim, so the Config UTxO must outlive every reference script.

```sh
npm run cli -- config:burn \
  --protocol-state ../state/<network>/config-bootstrap.json
```

### 30. Update min UTxO for Config (admin only)

Sets a new `min_utxo_lovelace` on the Config UTxO via a Config-update draft (see
§22). Requires a Config signer. See architecture
[§5.12 Update min UTxO](../../docs/architecture/cardano-oracle-architecture.md#512-update-min-utxo-admin-only).

```sh
npm run cli -- config:update \
  --input ../state/<network>/config-updates/min-utxo-update.json \
  --protocol-state ../state/<network>/config-bootstrap.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--input` | Config-update draft setting the new min UTxO | required |

### 31. Update min UTxO for PaymentHook (admin only)

Sets a new `min_utxo_lovelace` on the PaymentHook UTxO. The PaymentHook output
must hold `new_min_utxo + accrued_fees_lovelace` total lovelace. Requires a
Config signer. See architecture
[§5.12 Update min UTxO](../../docs/architecture/cardano-oracle-architecture.md#512-update-min-utxo-admin-only).

```sh
npm run cli -- payment-hook:update \
  --input ../state/<network>/hook-updates/min-utxo-update.json \
  --protocol-state ../state/<network>/config-bootstrap.json
```

| Flag | What | Default |
| --- | --- | --- |
| `--input` | Update draft setting the new min UTxO | required |

### 32. Reclaim reference-script UTxOs

Spends reference-script UTxO(s) at the reference-holder address and returns the
locked ADA to the admin wallet. Used when upgrading contracts: reclaim, then
re-publish the new version. Requires a Config signer.

`--script` maps 1:1 to publish commands — if a publish command put N UTxOs
on-chain, its reclaim name spends exactly those same N UTxOs in one transaction.
Cleared entries are reset to `{ txHash: "", outputIndex: 0, scriptHash: "" }` in
the artifact.

There are 7 reference-script UTxOs in total (3 global + 4 per client):

| UTxO | What's stored there | Published by | Output index |
| --- | --- | --- | --- |
| `global.config` | `config_state` spend validator | `config:reference-scripts` | 0 |
| `global.coordinator` | `update_coordinator` withdrawal validator | `config:reference-scripts` | 1 |
| `global.paymentHook` | `payment_hook` spend validator | `payment-hook:reference-script` | 0 |
| `client.receiver` | `receiver` spend validator (per client) | `reference-scripts:publish-client` | 0 |
| `client.pair` | `pair_state` spend validator (per client) | `reference-scripts:publish-client` | 1 |
| `client.pairMint` | `pair_state` minting policy (per client) | `reference-scripts:publish-client` | 2 |
| `client.deposit` | `deposit` spend validator (per client) | `reference-scripts:publish-client` | 3 |

Minting policies (`config_state` mint, `payment_hook` mint, `receiver` mint) are one-shot bootstrap scripts — they are NOT stored at the reference-holder address.

Reclaim `--script` values and what each reclaims in one transaction:

| `--script` | UTxOs reclaimed |
| --- | --- |
| `config` | global.config + global.coordinator (2 UTxOs — same as publish) |
| `payment-hook` | global.paymentHook (1 UTxO) |
| `client` | client.receiver + client.pair + client.pairMint + client.deposit (4 UTxOs — same as publish) |

**Global scripts:**

```sh
# Reclaims config + coordinator together (they were published in the same tx):
npm run cli -- reclaim-reference-script \
  --script config \
  --protocol-state ../state/<network>/config-bootstrap.json

# Reclaims payment-hook alone:
npm run cli -- reclaim-reference-script \
  --script payment-hook \
  --protocol-state ../state/<network>/config-bootstrap.json
```

**Client scripts:**

```sh
# Reclaims receiver + pair + pairMint + deposit together (they were published in the same tx):
npm run cli -- reclaim-reference-script \
  --script client \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

After reclaiming, re-publish with the standard publish command:

```sh
# After reclaiming config (republishes config + coordinator in one tx):
npm run cli -- config:reference-scripts \
  --protocol-state ../state/<network>/config-bootstrap.json

# After reclaiming payment-hook:
npm run cli -- payment-hook:reference-script \
  --protocol-state ../state/<network>/config-bootstrap.json

# After reclaiming client (republishes receiver + pair + pairMint + deposit in one tx):
npm run cli -- reference-scripts:publish-client \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json
```

## Build Only

Every transaction-submitting command supports `--build-only`. In this mode the
CLI builds the transaction, runs all validators locally, and prints the result,
but **does not submit it to the network**, and the state file is **not**
overwritten. Use it for inspection, offline auditing, or signing flows where the
build, the signing, and the submission happen on different machines. Redirect
stdout to capture the build output:

```sh
npm run cli -- update \
  --intent ../state/<network>/intents/usdc-usd.signed.json \
  --protocol-state ../state/<network>/config-bootstrap.json \
  --client-state ../state/<network>/clients/client-a.json \
  --pair-state ../state/<network>/clients/client-a/pairs/usdc-usd.json \
  --build-only \
  > ../state/<network>/builds/update.build-only.json
```

Parameterization commands are offline by design and never submit transactions,
so they do not take `--build-only`.

## Artifact rules

The folder tree at the top of this README lists every directory and file the
CLI reads or writes. The operational rules that govern how those files compose:

- **Protocol-level commands** read and update `config-bootstrap.json` (Config,
  Coordinator, PaymentHook, global reference scripts, global tx history).
- **Client-level commands** read and update `clients/<client>.json` (Receiver
  scripts/state/UTxO, client reference scripts, client tx history) and receive
  `--protocol-state` explicitly when they need protocol context.
- **Pair-level commands** read and update `clients/<client>/pairs/<pair>.json`
  (Pair scripts/state/UTxO, pair datum, pair tx history) and receive
  `--client-state`/`--protocol-state` explicitly when they need parent context.
- **Intents, config-update drafts, and batch manifests** are generated before
  they are consumed; they live under `state/<network>/` next to the artifacts
  that produce or consume them.

Child artifacts never embed parent paths; the parent path is always a CLI flag.

For the exact field-by-field shape of each artifact (`scripts`,
`compiledScripts`, `referenceScripts`, `datum`, `transactions`, and the Receiver
state fields), see [`state/README.md`](./state/README.md).
</content>
</invoke>
