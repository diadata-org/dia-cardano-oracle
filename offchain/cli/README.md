# DIA Cardano Oracle CLI

TypeScript CLI for deploying and operating the DIA Cardano Oracle contracts on Cardano `Preview`.

## TOC

- [DIA Cardano Oracle CLI](#dia-cardano-oracle-cli)
  - [TOC](#toc)
  - [Architecture](#architecture)
  - [Environment](#environment)
  - [Step 1: Install](#step-1-install)
  - [Step 2: Inspect Contracts](#step-2-inspect-contracts)
  - [Step 3: Inspect Network](#step-3-inspect-network)
  - [Step 4: Create Cardano Wallet](#step-4-create-cardano-wallet)
  - [Step 5: Create Ethereum Wallet](#step-5-create-ethereum-wallet)
  - [Step 6: Inspect Wallet](#step-6-inspect-wallet)
  - [Step 7: Initialize Protocol Artifact](#step-7-initialize-protocol-artifact)
  - [Step 8: Parameterize Config Scripts](#step-8-parameterize-config-scripts)
  - [Step 9: Bootstrap Config](#step-9-bootstrap-config)
  - [Step 10: Publish Config Reference Scripts](#step-10-publish-config-reference-scripts)
  - [Step 11: Parameterize PaymentHook Scripts](#step-11-parameterize-paymenthook-scripts)
  - [Step 12: Bootstrap PaymentHook](#step-12-bootstrap-paymenthook)
  - [Step 13: Publish PaymentHook Reference Script](#step-13-publish-paymenthook-reference-script)
  - [Step 14: Initialize Client Artifact](#step-14-initialize-client-artifact)
  - [Step 15: Parameterize Client Receiver Scripts](#step-15-parameterize-client-receiver-scripts)
  - [Step 16: Bootstrap Client Receiver](#step-16-bootstrap-client-receiver)
  - [Step 17: Publish Client Reference Scripts](#step-17-publish-client-reference-scripts)
  - [Step 18: Bootstrap Pair](#step-18-bootstrap-pair)
  - [Step 19: Create Unsigned Intent](#step-19-create-unsigned-intent)
  - [Step 20: Sign Unsigned Intent](#step-20-sign-unsigned-intent)
  - [Step 21: Create And Sign Intent](#step-21-create-and-sign-intent)
  - [Step 22: Submit Single Update](#step-22-submit-single-update)
  - [Step 23: Update Config](#step-23-update-config)
  - [Step 24: Submit Batch Update](#step-24-submit-batch-update)
  - [Step 25: Top Up Receiver](#step-25-top-up-receiver)
  - [Step 26: Withdraw From Receiver](#step-26-withdraw-from-receiver)
  - [Step 27: Withdraw Protocol Fees](#step-27-withdraw-protocol-fees)
  - [Oracle Intent Signing](#oracle-intent-signing)
  - [State Artifacts](#state-artifacts)
  - [Script Parameterization](#script-parameterization)
  - [Reference Scripts](#reference-scripts)
  - [Build Only](#build-only)
  - [Preview Input Files](#preview-input-files)
  - [Source File Order](#source-file-order)
  - [State Files](#state-files)

## Architecture

The CLI operates the Receiver-based architecture described in [`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md):

- one global `config_state`
- one global `update_coordinator`
- one global `payment_hook`
- one `receiver` per client
- one `pair_state` per subscribed price pair

## Environment

Create `.env` from `.env.example` and set:

- `CARDANO_NETWORK=Preview`
- `BLOCKFROST_PROJECT_ID`
- optional `BLOCKFROST_API_URL`
- optional `KOIOS_API_URL`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`
- optional `DIA_EVM_PRIVATE_KEY` for signing Preview EIP-712 oracle intents

UTxOs, submission, and confirmation use Blockfrost. Protocol parameters are normalized from Koios for Conway / Plutus V3 transaction building.

## Step 1: Install

```sh
cd offchain/cli
npm install
```

## Step 2: Inspect Contracts

Input: compiled Aiken blueprint from `contracts/aiken/plutus.json`.

```sh
npm run cli -- blueprint:list
npm run cli -- preview:reference-holder
```

## Step 3: Inspect Network

Input: `.env`.

```sh
npm run cli -- preview:protocol
```

## Step 4: Create Cardano Wallet

Operation: create a new Cardano Preview wallet mnemonic for `.env`.

```sh
npm run cli -- preview:wallet:create
```

Set `CARDANO_WALLET_SEED` in `.env` with the generated mnemonic. The command also prints the derived `paymentKeyHash`, which is the default config-admin signer used later by `preview:protocol:init`.

## Step 5: Create Ethereum Wallet

Operation: create an Ethereum wallet for Preview EIP-712 signing.

```sh
npm run cli -- preview:ethereum-wallet:create
```

Set `DIA_EVM_PRIVATE_KEY` in `.env` with the generated private key if you want to create or sign Preview intents locally. The printed compressed `publicKey` becomes the default authorized DIA signer in `preview:protocol:init`.

## Step 6: Inspect Wallet

Input: `.env`.

After funding the Cardano wallet, inspect its address, UTxOs, and defaults:

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

Fund the configured address on `Preview Testnet`:

<https://docs.cardano.org/cardano-testnets/tools/faucet>

The deployment wallet must have enough pure ADA UTxOs for:

- global reference-script publication
- config bootstrap
- payment-hook bootstrap
- client reference-script publication
- receiver bootstrap
- pair bootstrap

## Step 7: Initialize Protocol Artifact

Operation: create the base protocol artifact with the configured wallet, the `reference_holder` address, and the initial Config values. The command proposes the same defaults used by `02-config-parameterize.example.json`, prefills the config-admin signer from the configured Cardano wallet, prefills the DIA signer public key from `DIA_EVM_PRIVATE_KEY` when available, lets you edit everything in the terminal, and writes the artifact immediately. Script hashes and datum CBOR remain empty until the later parameterization/bootstrap steps.

Writes: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:protocol:init
```

## Step 8: Parameterize Config Scripts

Operation: select an existing pure ADA wallet UTxO as `bootstrapRefs.config`, then derive the Config minting policy, Config validator, and Coordinator validator offline.

Input JSON: `./examples/preview/02-config-parameterize.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

This command does not submit a transaction. It stores the selected wallet UTxO in the protocol artifact so Step 9 can consume that same UTxO when minting the Config NFT.

```sh
npm run cli -- preview:config:parameterize --input ./examples/preview/02-config-parameterize.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 9: Bootstrap Config

Operation: mint the Config NFT and create the global Config UTxO.

Input JSON: `./examples/preview/04-config-bootstrap.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The command consumes the wallet UTxO selected in Step 8 as the Config bootstrap reference.

```sh
npm run cli -- preview:config:bootstrap --input ./examples/preview/04-config-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 10: Publish Config Reference Scripts

Operation: create two on-chain UTxOs at the protocol `reference_holder` address, with reference scripts attached: Config spend validator and Coordinator withdraw validator.

Input JSON: `./examples/preview/03-config-reference-scripts.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:config:reference-scripts --input ./examples/preview/03-config-reference-scripts.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 11: Parameterize PaymentHook Scripts

Operation: select an existing pure ADA wallet UTxO as `bootstrapRefs.paymentHook`, then derive the PaymentHook minting policy and PaymentHook validator offline.

Input JSON: `./examples/preview/05-payment-hook-parameterize.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

This command does not submit a transaction. It stores the selected wallet UTxO in the protocol artifact so Step 12 can consume that same UTxO when minting the PaymentHook NFT.

```sh
npm run cli -- preview:payment-hook:parameterize --input ./examples/preview/05-payment-hook-parameterize.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 12: Bootstrap PaymentHook

Operation: mint the PaymentHook NFT, create the PaymentHook UTxO, update Config with the PaymentHook reference, and register the Coordinator stake credential.

Input JSON: `./examples/preview/07-payment-hook-bootstrap.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The command consumes the wallet UTxO selected in Step 11 as the PaymentHook bootstrap reference.

```sh
npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/07-payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 13: Publish PaymentHook Reference Script

Operation: create one on-chain UTxO at the protocol `reference_holder` address, with the PaymentHook spend validator reference script attached.

Input JSON: `./examples/preview/06-payment-hook-reference-script.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:payment-hook:reference-script --input ./examples/preview/06-payment-hook-reference-script.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 14: Initialize Client Artifact

Operation: clone the live protocol artifact into a clean client artifact and prompt for the protocol state path, `client-id`, and output path defaults.

Writes: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:client:init
```

## Step 15: Parameterize Client Receiver Scripts

Operation: select an existing pure ADA wallet UTxO as `receiver.bootstrapRef`, then derive the Receiver minting policy, Receiver validator, Pair minting policy, and Pair validator for one client offline.

Input JSON: `./examples/preview/08-receiver-parameterize.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

This command does not submit a transaction. It stores the selected wallet UTxO in the client artifact so Step 16 can consume that same UTxO when minting the Receiver NFT.

```sh
npm run cli -- preview:receiver:parameterize --input ./examples/preview/08-receiver-parameterize.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 16: Bootstrap Client Receiver

Operation: mint the Receiver NFT and create the client Receiver UTxO.

Input JSON: `./examples/preview/10-receiver-bootstrap.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

The command consumes the wallet UTxO selected in Step 15 as the Receiver bootstrap reference.

```sh
npm run cli -- preview:receiver:bootstrap --input ./examples/preview/10-receiver-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 17: Publish Client Reference Scripts

Operation: create two on-chain UTxOs at the protocol `reference_holder` address, with reference scripts attached: Receiver spend validator and Pair spend validator for one client.

Input JSON: `./examples/preview/09-client-reference-scripts.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:reference-scripts:publish-client --input ./examples/preview/09-client-reference-scripts.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 18: Bootstrap Pair

Operation: mint the Pair NFT and create the initial Pair UTxO for a subscribed symbol.

Input JSON: `./examples/preview/11-pair-bootstrap.example.json`

State input: `./state/preview/clients/client-a.json`

Writes: `./state/preview/clients/client-a/pairs/usdc-usd.json`

The signed intent in the input identifies the pair symbol and the authorized EIP-712 signer. The initial on-chain Pair state starts with zero price, zero timestamp, and zero nonce.

```sh
mkdir -p ./state/preview/clients/client-a/pairs
npm run cli -- preview:pair:bootstrap --input ./examples/preview/11-pair-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

## Step 19: Create Unsigned Intent

Operation: interactively collect an unsigned EIP-712 `OracleIntent` with `@inquirer/prompts` and write it as JSON.

Optional state input: `./state/preview/config-bootstrap.json`

Writes: `./tmp/preview-intent.unsigned.json`

```sh
npm run cli -- preview:intent:create
```

## Step 20: Sign Unsigned Intent

Operation: sign an existing unsigned `OracleIntent`. If `--input` is omitted, the CLI prompts for the JSON path.

Input JSON: `./examples/preview/01-oracle-intent-sign.example.json` or any unsigned intent created in Step 19

Writes: `./tmp/usdc-usd.update.json`

```sh
npm run cli -- preview:intent:sign --input ./examples/preview/01-oracle-intent-sign.example.json --out ./tmp/usdc-usd.update.json
```

## Step 21: Create And Sign Intent

Operation: interactively collect an unsigned `OracleIntent` and immediately sign it with `DIA_EVM_PRIVATE_KEY`.

Optional state input: `./state/preview/config-bootstrap.json`

Writes: `./tmp/preview-intent.signed.json`

```sh
npm run cli -- preview:intent:create-and-sign
```

## Step 22: Submit Single Update

Operation: update one Pair UTxO with a signed DIA `OracleIntent`.

Input JSON: `./examples/preview/12-update.example.json` or a signed intent created in Step 20 or Step 21

State input: `./state/preview/clients/client-a/pairs/usdc-usd.json`

Updates: `./state/preview/clients/client-a/pairs/usdc-usd.json`

```sh
npm run cli -- preview:update --input ./examples/preview/12-update.example.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

## Step 23: Update Config

Operation: update Config parameters such as protocol fee, authorized DIA public keys, domain data, or config signers.

Input JSON: `./examples/preview/13-config-update.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

The Preview example authorizes an additional Ethereum/EIP-712 test signer. This enables later Preview updates with freshly signed payloads.

```sh
npm run cli -- preview:config:update --input ./examples/preview/13-config-update.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Step 24: Submit Batch Update

Operation: update one or more Pair UTxOs in one transaction.

Input JSON: `./examples/preview/14-update-batch.example.json`

Each batch entry contains a `statePath` and a signed DIA `OracleIntent`.

Updates: each `statePath` declared in the batch input.

The example batch intent is signed by the Ethereum/EIP-712 test signer authorized in Step 23.

```sh
npm run cli -- preview:update:batch --input ./examples/preview/14-update-batch.example.json
```

## Step 25: Top Up Receiver

Operation: add ADA to the client Receiver balance.

Input JSON: `./examples/preview/15-receiver-top-up.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:receiver:top-up --input ./examples/preview/15-receiver-top-up.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 26: Withdraw From Receiver

Operation: withdraw ADA from the client Receiver balance.

Input JSON: `./examples/preview/16-receiver-withdraw.example.json`

State input: `./state/preview/clients/client-a.json`

Updates: `./state/preview/clients/client-a.json`

```sh
npm run cli -- preview:receiver:withdraw --input ./examples/preview/16-receiver-withdraw.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a.json
```

## Step 27: Withdraw Protocol Fees

Operation: withdraw accrued protocol fees from PaymentHook.

Input JSON: `./examples/preview/17-payment-hook-withdraw.example.json`

State input: `./state/preview/config-bootstrap.json`

Updates: `./state/preview/config-bootstrap.json`

```sh
npm run cli -- preview:payment-hook:withdraw --input ./examples/preview/17-payment-hook-withdraw.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

## Oracle Intent Signing

Oracle updates require a signed DIA `OracleIntent`. The signature is an Ethereum/EIP-712 signature over the exact intent payload. If `symbol`, `price`, `timestamp`, `nonce`, `expiry`, `source`, or domain values change, a new signature is required.

Production updates should use DIA-provided signed intents. For Preview validation, the CLI can create and sign intents with interactive prompts or sign an existing unsigned file using an Ethereum private key configured as `DIA_EVM_PRIVATE_KEY`:

```sh
npm run cli -- preview:ethereum-wallet:create
```

Set `DIA_EVM_PRIVATE_KEY` in `.env` with the generated Ethereum private key. The generated `publicKey` is the value that must be present in `authorizedDiaPublicKeys` before updates signed by that key can be submitted.

```sh
npm run cli -- preview:intent:create --state ./state/preview/config-bootstrap.json --out ./tmp/preview-intent.unsigned.json
npm run cli -- preview:intent:sign --input ./tmp/preview-intent.unsigned.json --out ./tmp/usdc-usd.update.json
npm run cli -- preview:intent:create-and-sign --state ./state/preview/config-bootstrap.json --out ./tmp/preview-intent.signed.json
```

Output: a JSON object with:

- `intent`: update input compatible with `preview:update`
- `witness.signerPublicKey`: compressed EIP-712 signer public key to authorize in Config
- `witness.signerAddress`: Ethereum signer address recorded in the intent
- `witness.intentHash`: EIP-712 hash checked by the contracts

The recovered `witness.signerPublicKey` must be present in `authorizedDiaPublicKeys` before submitting an update. If the key is not already authorized, run the Config update step before submitting that signed intent.

## State Artifacts

The `init` commands create state artifacts directly. Most deployment and transaction commands then read an input JSON with `--input` and write the latest operational state with `--out`.

Use these state artifacts as the source for the next command:

- `./state/preview/config-bootstrap.json`: global protocol artifact.
- `./state/preview/clients/<client>.json`: client artifact.
- `./state/preview/clients/<client>/pairs/<pair>.json`: pair artifact.

The global artifact is created in Step 7 and updated by protocol-level operations:

- Step 7 initializes the base protocol artifact.
- Step 8 parameterizes the Config and Coordinator scripts offline, stores `bootstrapRefs.config`, and writes Config script metadata.
- Step 9 consumes `bootstrapRefs.config`, mints the Config NFT, and creates the Config UTxO.
- Step 10 publishes the Config and Coordinator reference scripts.
- Step 11 parameterizes the PaymentHook scripts offline, stores `bootstrapRefs.paymentHook`, and writes PaymentHook script metadata.
- Step 12 consumes `bootstrapRefs.paymentHook`, mints the PaymentHook NFT, updates Config with the PaymentHook reference, and registers the Coordinator stake credential.
- Step 13 publishes the PaymentHook reference script.
- Step 23 updates Config state and Config UTxO.
- Step 27 updates PaymentHook fee state and PaymentHook UTxO.

The client artifact is created in Step 14 and updated by client-level operations:

- Step 14 initializes the base client artifact from the live protocol artifact.
- Step 15 parameterizes the Receiver and Pair scripts offline, stores `receiver.bootstrapRef`, and writes client script metadata.
- Step 16 consumes `receiver.bootstrapRef`, mints the Receiver NFT, and creates the Receiver UTxO.
- Step 17 publishes the Receiver and Pair reference scripts.
- Step 25 updates the Receiver balance after a top-up.
- Step 26 updates the Receiver balance after a withdrawal.

The pair artifact is created in Step 18 and updated by price updates:

- Step 18 creates the Pair UTxO and initial Pair state.
- Step 22 updates one Pair state file.
- Step 24 updates each `statePath` listed in the batch input.

## Script Parameterization

Config, PaymentHook, and Receiver scripts are parameterized before they are bootstrapped or published as reference scripts. The CLI picks an existing pure ADA wallet UTxO as the bootstrap reference, derives the policy ids, validator hashes, addresses, initial datum CBOR, and script parameters offline, then writes those values into the state artifact.

Parameterization inputs:

- Config scripts use `bootstrapOutRef` and `configAssetName`.
- PaymentHook scripts use `bootstrapOutRef`, `paymentHookAssetName`, Config policy/id data, and Coordinator credential hash.
- Receiver scripts use `bootstrapOutRef`, `receiverAssetName`, and Config policy/id data.
- Pair scripts use Config policy/id data and Receiver validator hash.

The `bootstrapOutRef` parameters come from existing wallet UTxOs selected during the corresponding parameterization command. Those UTxOs are consumed later by the matching bootstrap command when the NFT is minted.

## Reference Scripts

Reference scripts published by this CLI are the reusable scripts used by protocol operations after deployment:

- Config spend validator.
- Coordinator withdraw validator.
- PaymentHook spend validator.
- Receiver spend validator for one client.
- Pair spend validator for one client.

One-shot minting policies are used only by their bootstrap transaction and are not published as reference scripts.

## Build Only

Every transaction-submitting command supports `--build-only`. The parameterization commands are offline and do not submit transactions.

Example:

```sh
npm run cli -- preview:config:reference-scripts --input ./examples/preview/03-config-reference-scripts.example.json --state ./state/preview/config-bootstrap.json --build-only --out ./tmp/config-reference-scripts.build-only.json
```

## Preview Input Files

The `init` commands and the interactive intent commands do not require JSON inputs. These files are the static JSON examples used by the non-interactive steps:

- `01-oracle-intent-sign.example.json`: unsigned EIP-712 intent payload for Preview signing
- `02-config-parameterize.example.json`: Config script parameterization input
- `03-config-reference-scripts.example.json`: Config and Coordinator reference-script input
- `04-config-bootstrap.example.json`: Config bootstrap input
- `05-payment-hook-parameterize.example.json`: PaymentHook script parameterization input
- `06-payment-hook-reference-script.example.json`: PaymentHook reference-script input
- `07-payment-hook-bootstrap.example.json`: PaymentHook bootstrap input
- `08-receiver-parameterize.example.json`: Receiver and Pair script parameterization input
- `09-client-reference-scripts.example.json`: Receiver and Pair reference-script input
- `10-receiver-bootstrap.example.json`: Receiver bootstrap input
- `11-pair-bootstrap.example.json`: Pair bootstrap input
- `12-update.example.json`: single DIA update input
- `13-config-update.example.json`: Config update input
- `14-update-batch.example.json`: batch DIA update input
- `15-receiver-top-up.example.json`: Receiver top-up input
- `16-receiver-withdraw.example.json`: Receiver withdraw input
- `17-payment-hook-withdraw.example.json`: PaymentHook fee withdrawal input

## Source File Order

Init modules in `src/init/`:

- `01-protocol-init.ts`
- `02-client-init.ts`

Deploy modules in `src/deploys/`:

- `01-config-parameterize.ts`
- `02-config-reference-scripts.ts`
- `03-config-bootstrap.ts`
- `04-payment-hook-parameterize.ts`
- `05-payment-hook-reference-script.ts`
- `06-payment-hook-bootstrap.ts`
- `07-receiver-parameterize.ts`
- `08-client-reference-scripts.ts`
- `09-receiver-bootstrap.ts`
- `10-pair-bootstrap.ts`

Transaction modules in `src/transactions/`:

- `11-update.ts`
- `12-config-update.ts`
- `13-update-batch.ts`
- `14-receiver-top-up.ts`
- `15-receiver-withdraw.ts`
- `16-payment-hook-withdraw.ts`

Oracle helper modules in `src/oracle/`:

- `01-ethereum-wallet-create.ts`
- `02-intent-sign.ts`
- `03-intent-create.ts`

## State Files

- `state/preview/config-bootstrap.json`: global protocol state
- `state/preview/clients/<client>.json`: client Receiver state and client reference scripts
- `state/preview/clients/<client>/pairs/*.json`: pair state, latest oracle value, Receiver snapshot, PaymentHook snapshot

Persist the output of each command to the state path shown in the step. Later commands read those state artifacts.
