Generated Preview/Mainnet state artifacts live here while running the CLI.

Do not commit generated protocol, client, pair, intent, batch, or build-only
JSON files. They are environment-specific outputs created by the operator CLI.

## Layout

```
state/
  <network>/                   e.g. preview/
    config-bootstrap.json      Protocol artifact: Config + PaymentHook + scripts
    clients/<client-id>/       Per-client artifacts:
      client.json              Client artifact (Receiver scripts, draft data)
      pairs/<pair-slug>.json   Per-pair artifacts (Pair NFT, latest datum)
    intents/                   Generated unsigned/signed DIA intent JSON
    batches/                   Generated batch update manifests
```

## Receiver state fields

The per-client `client.json` stores the off-chain mirror of the on-chain
`ReceiverDatum` under `receiver.receiverState`:

| Field | Type | Meaning (mirrors the on-chain datum) |
| --- | --- | --- |
| `balanceLovelace` | string (lovelace) | Client-prepaid pool, top-up adds here, `Withdraw` removes from here |
| `accruedToHookLovelace` | string (lovelace) | Per-update protocol fees that have been moved out of `balanceLovelace` and are waiting to be batched into the global PaymentHook by a `Settle` transaction |
| `minUtxoLovelace` | string (lovelace) | Locked min-UTxO floor; never moves |

Invariant (must match the on-chain check `exact_locked_lovelace`):

```
ReceiverUTxO.lovelace == minUtxoLovelace + balanceLovelace + accruedToHookLovelace
```

`accruedToHookLovelace` is increased by every `AccrueFee` redeemer (one
per oracle update, or `N × protocol_fee_lovelace` for a batch update)
and is drained back to `0` by every `Settle` redeemer. The `Withdraw`
redeemer cannot touch this field — it only moves lovelace out of
`balanceLovelace`.
