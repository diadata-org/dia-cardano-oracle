# Off-Chain CLI

This package contains the TypeScript CLI used to bootstrap and operate the DIA Cardano Oracle contracts.

## Scope

The current CLI target is the Cardano `Preview` network using Blockfrost as the provider.

The current implementation supports:

- blueprint inspection for the compiled Aiken validators
- Preview provider verification
- Preview wallet creation and inspection
- Config bootstrap transactions
- PaymentHook bootstrap transactions
- pair bootstrap transactions
- oracle update transactions

Price authority comes from official DIA `OracleIntent` payloads and their `EIP-712` secp256k1 signatures. The Cardano wallet only submits Cardano transactions and authorizes admin actions when it is one of the configured `valid_config_signers`.

## Commands

```sh
npm install
npm run cli -- help
npm run cli -- blueprint:list
npm run cli -- preview:protocol
npm run cli -- preview:wallet:create
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json --out ./state/preview/config-bootstrap.json
npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/pairs/usdc-usd.json
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/pairs/usdc-usd.json --out ./state/preview/pairs/usdc-usd.json
```

Each transaction command also supports `--build-only`.

## Recommended Order

1. Inspect the compiled blueprint:

```sh
npm run cli -- blueprint:list
```

2. Verify Preview provider access:

```sh
npm run cli -- preview:protocol
```

3. Create a Preview wallet:

```sh
npm run cli -- preview:wallet:create
```

4. Fund the generated address with the official Preview faucet:

- Guide: <https://docs.cardano.org/cardano-testnets/tools/faucet>
- Environment: `Preview Testnet`

5. Store the generated seed phrase in `.env` as `CARDANO_WALLET_SEED`.

6. Verify the configured wallet:

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

7. Bootstrap the unique Config state:

```sh
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json --out ./state/preview/config-bootstrap.json
```

8. Bootstrap the unique PaymentHook state, register the coordinator staking credential, and update the Config artifact with the active hook reference:

```sh
npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

9. Register a pair and create its initial Pair UTxO from an official DIA `OracleIntent`:

```sh
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/pairs/usdc-usd.json
```

10. Apply a newer DIA `OracleIntent` to the existing pair:

```sh
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/pairs/usdc-usd.json --out ./state/preview/pairs/usdc-usd.json
```

## Command Model

The CLI is non-interactive.

- `.env` stores provider configuration and Cardano submitter credentials.
- `examples/preview/` stores human-edited input files.
- `state/preview/` stores generated state artifacts produced by successful commands.

The Cardano wallet is used for:

- bootstrap and admin transactions
- pair registration transactions
- oracle update submission
- payment of Cardano transaction fees

The Cardano wallet is not the oracle price authority.

## Architecture Model Reflected by the CLI

The CLI follows the current Milestone 1 architecture:

- `config_state`
  unique Config UTxO and Config NFT
- `payment_hook`
  unique PaymentHook UTxO and PaymentHook NFT
- `pair_state`
  one Pair UTxO and one Pair NFT per pair
- `update_coordinator`
  staking validator executed once per update transaction through a withdrawal witness

The `Config` artifact stores:

- `validConfigSigners`
- `authorizedDiaPublicKeys`
- the DIA EIP-712 `domain`
- the registered `allowedPairs`
- the active `paymentHookRef`
- the active `updateCoordinatorCredential`
- `minUtxoLovelace`

The `PaymentHook` artifact stores:

- `withdrawAddress`
- `protocolFeePerTxLovelace`
- `minUtxoLovelace`
- `accruedFeesLovelace`
- `lifetimeFeesCollectedLovelace`
- `lifetimeFeesWithdrawnLovelace`
- `feeChargeCount`

The PaymentHook locked lovelace is expected to satisfy:

```text
locked_lovelace = min_utxo_lovelace + accrued_fees_lovelace
```

The `preview:payment-hook:bootstrap` command also registers the coordinator staking credential so that later update transactions can execute the coordinator through a `withdraw` witness.

## Input Files

### `config-bootstrap.example.json`

Used by `preview:config:bootstrap`.

```json
{
  "configAssetName": "4449415f434f4e464947",
  "authorizedDiaPublicKeys": [
    "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"
  ],
  "domain": {
    "name": "DIA Oracle",
    "version": "1.0",
    "sourceChainId": "100640",
    "verifyingContract": "0xF8c614A483A0427A13512F52ac72A576678bE317"
  },
  "minUtxoLovelace": "5000000"
}
```

Field origins:

- `configAssetName`
  Project-defined Cardano asset name for the Config NFT.
- `authorizedDiaPublicKeys`
  Compressed secp256k1 public keys allowed to authorize DIA intents on Cardano.
- `domain.*`
  Official DIA EIP-712 domain values.
- `minUtxoLovelace`
  Exact lovelace locked in the Config UTxO.

If `validConfigSigners` is omitted, the CLI defaults it to the payment key hash of the configured Cardano wallet.

### `payment-hook-bootstrap.example.json`

Used by `preview:payment-hook:bootstrap`.

```json
{
  "paymentHookAssetName": "4449415f5041594d454e545f484f4f4b",
  "protocolFeePerTxLovelace": "2000000",
  "minUtxoLovelace": "3000000"
}
```

Field origins:

- `paymentHookAssetName`
  Project-defined Cardano asset name for the PaymentHook NFT.
- `protocolFeePerTxLovelace`
  Fixed protocol fee charged per update transaction.
- `minUtxoLovelace`
  Exact lovelace reserved in the PaymentHook UTxO.
- `withdrawAddress`
  Optional. If omitted, the CLI defaults it to the configured Cardano wallet address.

### `pair-bootstrap.example.json`

Used by `preview:pair:bootstrap`.

```json
{
  "intent": {
    "intentType": "OracleUpdate",
    "version": "1.0",
    "chainId": "100640",
    "nonce": "1760960522308165264",
    "expiry": "1760964122",
    "symbol": "USDC/USD",
    "price": "99992561",
    "timestamp": "1760960522",
    "source": "DIA Oracle",
    "signature": "0x...",
    "signer": "0x..."
  },
  "minUtxoLovelace": "5000000"
}
```

Field origins:

- `intent`
  Official DIA `OracleIntent` payload.
- `pairTokenName`
  Optional. If omitted, the CLI derives it from `symbol` by replacing `/` with `_` and hex-encoding the result.
- `minUtxoLovelace`
  Exact lovelace locked in the Pair UTxO.

### `update.example.json`

Used by `preview:update`.

```json
{
  "intent": {
    "intentType": "OracleUpdate",
    "version": "1.0",
    "chainId": "100640",
    "nonce": "1776186346664217707",
    "expiry": "1776203290",
    "symbol": "USDC/USD",
    "price": "99983970",
    "timestamp": "1776199690",
    "source": "DIA Oracle",
    "signature": "0x...",
    "signer": "0x..."
  }
}
```

The update intent must match the pair and be fresher than the currently stored state:

- same `symbol`
- greater `timestamp`
- greater `nonce`

### Hex-Encoded Fields

Some Cardano fields are stored as hex-encoded UTF-8 strings.

- `4449415f434f4e464947` = `DIA_CONFIG`
- `4449415f5041594d454e545f484f4f4b` = `DIA_PAYMENT_HOOK`
- `555344432f555344` = `USDC/USD`
- `555344435f555344` = `USDC_USD`

This is normal for Cardano asset names and datum fields that store bytes instead of plain text.

## State Files

Generated state belongs under `state/preview/`.

- `state/preview/config-bootstrap.json`
  current Config and PaymentHook deployment state
- `state/preview/pairs/*.json`
  pair-specific state, including the latest confirmed oracle value

These are generated artifacts, not templates. Recreate them from the commands above when the contracts or CLI change.

## Environment

Copy `.env.example` to `.env` and set:

- a valid Blockfrost project id for `Preview`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`

`preview:wallet:create` generates a new Preview wallet locally and prints the seed phrase and derived addresses. Store the result outside the repository before using it.
