# Off-Chain CLI

This package contains the TypeScript CLI used for the DIA Cardano Oracle project.

## Scope

The current CLI target is the Cardano `Preview` network using Blockfrost as the provider.

The current implementation supports:

- blueprint inspection for the compiled Aiken validators
- Preview provider verification
- Preview wallet creation and inspection
- Config bootstrap transactions
- pair bootstrap transactions
- oracle update transactions

For price data, the CLI now consumes the official DIA `OracleIntent` shape and treats the Cardano wallet only as the transaction submitter on Cardano.

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
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json --out ./state/preview/config-bootstrap.json
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/pairs/usdc-usd.json
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/pairs/usdc-usd.json --out ./state/preview/pairs/usdc-usd.json
```

Planned command:

```sh
npm run cli -- preview:config:update --input ./examples/preview/config-update.example.json
```

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

7. Bootstrap the Config state:

```sh
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json --out ./state/preview/config-bootstrap.json
```

8. Register the first pair and create its initial oracle state from an official DIA `OracleIntent`:

```sh
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/pairs/usdc-usd.json
```

9. Update an existing pair from a newer DIA `OracleIntent`:

```sh
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/pairs/usdc-usd.json --out ./state/preview/pairs/usdc-usd.json
```

## Command Model

The CLI is non-interactive.

- `.env` stores provider configuration and Cardano submitter credentials.
- JSON files store repeatable execution inputs.
- `state/preview/` stores generated deployment state.
- `examples/preview/` stores input templates and fixtures.

The Cardano wallet is used for:

- bootstrap and admin transactions
- pair bootstrap transactions
- oracle update transaction submission
- fee payment on Cardano

The Cardano wallet is not used as the oracle price authority.

Price authority comes from the DIA `OracleIntent` signature. The CLI:

- reads the official DIA intent fields
- reconstructs the EIP-712 digest
- recovers the secp256k1 public key from the DIA signature
- verifies that the recovered signer address matches `intent.signer`
- forwards the intent and recovered public key to Cardano for on-chain verification

## Configuration Model

`preview:config:bootstrap` creates the initial Config NFT and Config UTxO.

The Config datum stores:

- `validConfigSigners`: Cardano key hashes authorized for configuration changes
- `authorizedOraclePublicKeys`: DIA secp256k1 public keys authorized for oracle intent verification
- `feeAddresses`
- `feeAmount`
- the EIP-712 domain configuration required to reconstruct the DIA intent hash
- `allowedPairs`

If `validConfigSigners` is omitted, the CLI defaults it to the payment key hash of the configured Cardano wallet.

If `feeAddresses` is omitted, the CLI defaults it to the configured Cardano wallet address.

`authorizedOraclePublicKeys` must be provided explicitly.

## Pair and Update Inputs

`preview:pair:bootstrap` and `preview:update` both consume an official DIA-style `OracleIntent`.

The current fixture format is:

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
  }
}
```

`preview:pair:bootstrap` derives `pairId` from `intent.symbol`. If `pairTokenName` is omitted, the CLI derives it from the symbol by replacing `/` with `_`.

`preview:update` requires a newer intent for the same pair. The incoming DIA intent must have:

- the same symbol as the pair state file
- a strictly greater `timestamp`
- a strictly greater `nonce`

## State Files

Generated state belongs under `state/preview/`.

- `state/preview/config-bootstrap.json` stores the resolved Config deployment state
- `state/preview/pairs/*.json` stores pair-specific deployment state and the latest confirmed oracle state

These files are generated artifacts and should be produced from the current scripts after running the commands above.

## Environment

Copy `.env.example` to `.env` and set:

- a valid Blockfrost project id for `Preview`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`

`preview:wallet:create` generates a new Preview wallet locally and prints the seed phrase and derived addresses. Store the result outside the repository before using it.

## Example Files

The files under `examples/preview/` do not all have the same status.

- `config-bootstrap.example.json`
  Current template for `preview:config:bootstrap`.
  This file is expected to be edited by operators.
- `pair-bootstrap.example.json`
  Current runnable fixture for `preview:pair:bootstrap`.
  It contains a real DIA `OracleIntent` captured from the DIA testnet explorer for `USDC/USD`.
- `update.example.json`
  Current runnable fixture for `preview:update`.
  It contains a newer real DIA `OracleIntent` for the same `USDC/USD` pair.
- `config-update.example.json`
  Placeholder template for a planned command.
  It is not part of the completed flow yet.

The generated files under `state/preview/` are different.

- `examples/preview/` contains human-edited input files.
- `state/preview/` contains generated artifacts produced by the CLI after a successful transaction.

## Field Origins

### `config-bootstrap.example.json`

```json
{
  "configAssetName": "4449415f434f4e464947",
  "authorizedOraclePublicKeys": [
    "03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"
  ],
  "feeAmount": "2000000",
  "domain": {
    "name": "DIA Oracle",
    "version": "1.0",
    "sourceChainId": "100640",
    "verifyingContract": "0xF8c614A483A0427A13512F52ac72A576678bE317"
  },
  "lovelace": "5000000"
}
```

- `configAssetName`
  Project-defined Cardano asset name for the Config NFT.
  This is a hex-encoded UTF-8 string.
- `authorizedOraclePublicKeys`
  DIA secp256k1 public keys allowed to authorize oracle intents on Cardano.
  These are compressed public keys in hex format.
- `feeAmount`
  Lovelace paid to each configured fee address during oracle updates.
- `domain.name`
  Comes from the DIA `OracleIntentRegistry` EIP-712 domain.
- `domain.version`
  Comes from the DIA `OracleIntentRegistry` EIP-712 domain.
- `domain.sourceChainId`
  Source chain id used by DIA when signing the intent.
- `domain.verifyingContract`
  The DIA `OracleIntentRegistry` contract address used in the EIP-712 domain.
- `lovelace`
  ADA amount locked into the initial Config UTxO.

### `pair-bootstrap.example.json` and `update.example.json`

Both files wrap an official DIA `OracleIntent`:

```json
{
  "intent": {
    "intentType": "OracleUpdate",
    "version": "1.0",
    "chainId": "100640",
    "nonce": "...",
    "expiry": "...",
    "symbol": "USDC/USD",
    "price": "...",
    "timestamp": "...",
    "source": "DIA Oracle",
    "signature": "0x...",
    "signer": "0x..."
  }
}
```

These fields come from DIA itself, not from Cardano:

- `intentType`
- `version`
- `chainId`
- `nonce`
- `expiry`
- `symbol`
- `price`
- `timestamp`
- `source`
- `signature`
- `signer`

The CLI reads these values, rebuilds the EIP-712 digest, recovers the signer public key, and verifies that the recovered signer is authorized by the current Config state.

## Hex-Encoded Names

Some Cardano fields are stored as byte arrays on-chain, so the CLI inputs use hex strings instead of plain text.

Examples:

- `configAssetName: "4449415f434f4e464947"`
  Plain text: `DIA_CONFIG`
- Pair token name `555344435f555344`
  Plain text: `USDC_USD`
- Pair id `555344432f555344`
  Plain text: `USDC/USD`

Rules used by the CLI:

- `configAssetName`
  Must be provided as UTF-8 text encoded to hex.
- `pairId`
  Derived from `intent.symbol` as UTF-8 hex.
- `pairTokenName`
  Derived from `intent.symbol.replace("/", "_")` as UTF-8 hex, unless explicitly provided.

This means:

- symbol `USDC/USD`
- pair id `555344432f555344`
- token name `555344435f555344`

## Editing Guidance

To create or edit inputs safely:

1. For `config-bootstrap.example.json`, edit only the project-controlled fields:
   - `configAssetName`
   - `authorizedOraclePublicKeys`
   - `feeAmount`
   - `domain`
   - `lovelace`
2. For `pair-bootstrap.example.json`, replace the `intent` with a real DIA intent for the symbol you want to register.
3. For `update.example.json`, replace the `intent` with a newer DIA intent for the same symbol already registered on Cardano.
4. Do not manually edit files under `state/preview/` unless you are repairing a broken local artifact.

## How To Source New DIA Intents

New `OracleIntent` fixtures should be copied from DIA infrastructure, not invented manually.

Recommended sources:

- DIA testnet explorer transaction pages
- DIA testnet explorer API responses
- the decoded `registerIntent(...)` call data from `OracleIntentRegistry`

When replacing a fixture:

1. Keep the full official DIA field set unchanged.
2. Keep `signature` and `signer` exactly as emitted by DIA.
3. For `update`, ensure the new intent has the same `symbol` and a greater `timestamp` and `nonce` than the current pair state.
