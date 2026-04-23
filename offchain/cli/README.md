# Off-Chain CLI

This package contains the TypeScript CLI used to bootstrap and operate the DIA Cardano Oracle contracts on the Cardano `Preview` network.

## Current Architecture

The CLI follows the final Receiver-based architecture:

- `config_state`: one global Config UTxO and Config NFT.
- `update_coordinator`: one global withdrawal validator.
- `payment_hook`: one global PaymentHook UTxO and PaymentHook NFT.
- `receiver`: one Receiver UTxO and Receiver NFT per client.
- `pair_state`: one client-specific Pair script, with one Pair UTxO and Pair NFT per subscribed pair.

`Config` stores the Cardano admin keys, authorized DIA secp256k1 public keys, the DIA EIP-712 domain, `protocolFeeLovelace`, the active PaymentHook reference, and the active coordinator credential. It does not store a global pair allow-list.

`PaymentHook` stores only the withdrawal target, accrued fees, lifetime collected/withdrawn counters, and min-UTxO value. The fee amount lives in Config.

`Receiver` stores the client prepaid balance. Each update moves `Config.protocolFeeLovelace` from the client's Receiver to the global PaymentHook.

Pair NFT asset names are `blake2b_256(pair_id)`, where `pair_id` is the UTF-8 DIA symbol such as `USDC/USD`.

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
npm run cli -- preview:receiver:bootstrap --input ./examples/preview/receiver-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/clients/client-a.json
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
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

3. Create and fund a Preview wallet:

```sh
npm run cli -- preview:wallet:create
```

Use the official faucet for the `Preview Testnet`: <https://docs.cardano.org/cardano-testnets/tools/faucet>

4. Store the generated seed phrase in `.env` as `CARDANO_WALLET_SEED`, then verify wallet access:

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:utxos
npm run cli -- preview:wallet:defaults
```

5. Bootstrap Config:

```sh
npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json --out ./state/preview/config-bootstrap.json
```

6. Bootstrap PaymentHook and register the coordinator staking credential:

```sh
npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/payment-hook-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/config-bootstrap.json
```

7. Bootstrap a client Receiver:

```sh
npm run cli -- preview:receiver:bootstrap --input ./examples/preview/receiver-bootstrap.example.json --state ./state/preview/config-bootstrap.json --out ./state/preview/clients/client-a.json
```

8. Bootstrap a pair for that client:

```sh
npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json --state ./state/preview/clients/client-a.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

9. Apply a newer DIA `OracleIntent`:

```sh
npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/clients/client-a/pairs/usdc-usd.json --out ./state/preview/clients/client-a/pairs/usdc-usd.json
```

## Input Files

`config-bootstrap.example.json` defines Config:

```json
{
  "configAssetName": "4449415f434f4e464947",
  "authorizedDiaPublicKeys": ["03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807"],
  "domain": {
    "name": "DIA Oracle",
    "version": "1.0",
    "sourceChainId": "100640",
    "verifyingContract": "0xF8c614A483A0427A13512F52ac72A576678bE317"
  },
  "protocolFeeLovelace": "2000000",
  "minUtxoLovelace": "5000000"
}
```

If `validConfigSigners` is omitted, the CLI defaults it to the payment key hash of the configured Cardano wallet.

`payment-hook-bootstrap.example.json` defines the global fee collector:

```json
{
  "paymentHookAssetName": "4449415f5041594d454e545f484f4f4b",
  "minUtxoLovelace": "3000000"
}
```

`withdrawAddress` is optional. If omitted, the CLI uses the configured wallet address.

`receiver-bootstrap.example.json` defines a client Receiver:

```json
{
  "clientId": "client-a",
  "receiverAssetName": "4449415f52454345495645525f434c49454e545f41",
  "initialBalanceLovelace": "10000000",
  "minUtxoLovelace": "3000000"
}
```

`pair-bootstrap.example.json` still accepts a DIA intent fixture to derive the pair id and verify the signer, but the on-chain initial Pair datum is zeroed (`price = 0`, `timestamp = 0`, `nonce = 0`). The first `preview:update` writes the live oracle value.

## State Files

Generated state belongs under `state/preview/`.

- `state/preview/config-bootstrap.json`: current global Config and PaymentHook deployment state.
- `state/preview/clients/<client>.json`: client Receiver state plus the client-specific Pair script hashes.
- `state/preview/clients/<client>/pairs/*.json`: pair-specific state, including latest confirmed oracle values and Receiver/PaymentHook state snapshots.

These are generated artifacts, not templates. Recreate them after contract or CLI ABI changes.

## Environment

Copy `.env.example` to `.env` and set:

- a valid Blockfrost project id for `Preview`
- either `CARDANO_WALLET_SEED` or `CARDANO_PRIVATE_KEY`

`preview:wallet:create` generates a new Preview wallet locally and prints the seed phrase and derived addresses. Store the result outside the repository before using it.
