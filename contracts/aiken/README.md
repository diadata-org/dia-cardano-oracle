# Aiken Contracts

This package contains the Aiken on-chain implementation for the DIA Cardano Oracle project.

## Architecture

The current contract set follows the final Receiver-based architecture:

- `config_state` mints and guards the global Config NFT. Config stores DIA admin keys, authorized DIA secp256k1 public keys, the EIP-712 domain, the protocol fee, the active PaymentHook reference, and the coordinator credential.
- `update_coordinator` is the global withdrawal validator used once per update transaction. It is the authority for DIA intent validation, fee movement, pair creation, pair updates, and batch consistency.
- `payment_hook` mints and guards the global PaymentHook NFT and accumulates protocol fees.
- `receiver` is compiled once per client and guards that client's prepaid fee balance.
- `pair_state` is compiled once per client with that client's `receiver_hash`; each pair is a separate Pair NFT and Pair UTxO under the client-specific pair script. Pair NFTs are minted only inside real update transactions coordinated by `update_coordinator`.
- `reference_holder` is the script address used for reference-script UTxOs. It rejects spend attempts so reference-script UTxOs are not spendable by the deploy wallet.

There is no global pair allow-list. Pair identity is represented by the Pair NFT asset name, derived as `blake2b_256(pair_id)`, and client isolation comes from the Receiver-specific `pair_state` script hash.

There is also no placeholder Pair bootstrap state. The first transaction for a pair is an oracle update: it mints the Pair NFT and creates the Pair UTxO with the signed intent's real `price`, `timestamp`, `nonce`, `intent_hash`, and `signer`. Later updates consume the existing Pair UTxO and require strictly fresher `timestamp` and `nonce`.

## Fee flow (decoupled settlement)

Protocol fees are paid by clients and routed through the Receiver and
PaymentHook in two separate transactions:

1. **Per update — `AccrueFee` on the Receiver.** Every single or batch
   oracle update spends the client's Receiver UTxO with the
   `AccrueFee` redeemer. The Receiver datum moves the protocol fee
   (or `N × protocol_fee_lovelace` in batch updates) from
   `balance_lovelace` into `accrued_to_hook_lovelace`. The total ADA
   on the Receiver UTxO does not change — fees are reclassified, not
   spent. The PaymentHook is **not** touched during oracle updates.
2. **Periodically — `Settle`.** An admin-initiated Settle transaction
   spends one or more Receiver UTxOs with the `Settle` redeemer
   (which drains `accrued_to_hook_lovelace` to zero on each), spends
   the global PaymentHook UTxO with `ApplySettle` (which credits the
   matching ADA to `accrued_fees_lovelace`), and is authorised by the
   coordinator's `ApplySettle` redeemer plus an admin signature. The
   coordinator enforces that the sum of the receiver drains equals
   the increase in the hook's accrued fees.

This decoupling exists so that high-frequency price updates do not
contend on the single global PaymentHook UTxO. The `Withdraw` redeemer
on the Receiver explicitly cannot drain `accrued_to_hook_lovelace` —
the only path from a Receiver to the PaymentHook is through Settle.

## Structure

- `validators/` contains spending, minting, and withdrawal validators.
- `lib/` contains shared types, validation helpers, and unit tests.

## Prerequisites

- Aiken `v1.1.21` (Plutus V3), as pinned in `aiken.toml`. Install via the
  [official instructions](https://aiken-lang.org/installation-instructions).

You only need Aiken installed if you intend to modify the contracts, run the
unit tests, or rebuild the blueprint. The compiled output `plutus.json` is
committed in this directory, so the off-chain CLI can run without rebuilding.

## Commands

```sh
aiken check    # run the unit test suite
aiken build    # regenerate ./plutus.json (the compiled blueprint)
```

## Compiled output

`plutus.json` in this directory is the canonical compiled blueprint and is
consumed by the off-chain CLI in [`offchain/cli/`](../../offchain/cli/) to
derive script hashes, addresses, and policy ids. Whenever the contracts
change, rebuild this file with `aiken build` and commit the result.
