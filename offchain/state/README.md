Generated Preview/Mainnet state artifacts live here while running the CLI.

Do not commit generated protocol, client, pair, intent, batch, or build-only
JSON files. They are environment-specific outputs created by the operator CLI.

## Contents

- [Layout](#layout)
- [Protocol artifact (`config-bootstrap.json`) — `scripts` block](#protocol-artifact-config-bootstrapjson--scripts-block)
- [Protocol artifact — `configState` deposit fields](#protocol-artifact--configstate-deposit-fields)
- [Protocol artifact — `referenceScripts` block](#protocol-artifact--referencescripts-block)
- [Receiver state fields](#receiver-state-fields)

## Layout

```
state/
  <network>/                   e.g. preview/
    config-bootstrap.json      Protocol artifact: Config, Coordinator, PaymentHook, ReferenceHolder scripts + state
    clients/<client-id>/       Per-client artifacts:
      client.json              Client artifact (Receiver/Pair scripts, draft data)
      pairs/<pair-slug>.json   Per-pair artifacts (Pair NFT, latest datum)
    intents/                   Generated unsigned/signed DIA intent JSON
    batches/                   Generated batch update manifests
```

## Protocol artifact (`config-bootstrap.json`) — `scripts` block

The `scripts` field in the protocol artifact stores all derived script
identifiers. Fields follow the same grouping order as the setup sequence
(Config → Coordinator → ReferenceHolder → PaymentHook):

| Field | Set by | Notes |
| --- | --- | --- |
| `configPolicyId` | `preview:config:parameterize` | Config NFT minting policy id |
| `configUnit` | `preview:config:parameterize` | `policyId + assetName` unit |
| `configValidatorHash` | `preview:config:parameterize` | Config spend validator hash |
| `configValidatorAddress` | `preview:config:parameterize` | Config spend validator address |
| `coordinatorHash` | `preview:config:parameterize` | Coordinator stake validator hash |
| `coordinatorRewardAddress` | `preview:config:parameterize` | Coordinator withdrawal/reward address |
| `referenceHolderValidatorHash` | `preview:config:parameterize` | ReferenceHolder spend validator hash |
| `referenceHolderAddress` | `preview:config:parameterize` | Address where reference-script UTxOs are parked |
| `paymentHookPolicyId` | `preview:payment-hook:parameterize` | PaymentHook NFT minting policy id |
| `paymentHookUnit` | `preview:payment-hook:parameterize` | `policyId + assetName` unit |
| `paymentHookValidatorHash` | `preview:payment-hook:parameterize` | PaymentHook spend validator hash |
| `paymentHookValidatorAddress` | `preview:payment-hook:parameterize` | PaymentHook spend validator address |

All fields are `string`, empty (`""`) until the corresponding parameterize
step runs. Config/Coordinator/ReferenceHolder fields are set together by
`preview:config:parameterize`; PaymentHook fields by
`preview:payment-hook:parameterize`.

The artifact also holds a `compiledScripts` block (and `client.json` an
equivalent one): hex-encoded compiled script binaries written by the
parameterize commands and read by deploy/transaction commands. These are
generated binaries — you never edit them by hand.

## Protocol artifact — `configState` deposit fields

The protocol artifact's `configState` block stores the fee params and the
side-deposit tunables set at `protocol:init`. The deposit-related fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `depositMinLovelace` | string (lovelace) | Floor a side deposit must hold to be accepted / swept |
| `depositMaxPerMerge` | string (count) | Max deposit UTxOs folded into one standalone `deposit:merge` |
| `depositMaxPerUpdateFold` | string (count) | Max deposits an ordinary `update` folds into the Receiver automatically |

See the CLI README [§25c Side-deposit funding](../README.md#25c-side-deposit-funding)
for how clients fund and how these caps apply.

## Protocol artifact — `referenceScripts` block

Tracks the on-chain outRef (`txHash`, `outputIndex`) and `scriptHash` of each
published reference-script UTxO at the `reference_holder` address. These
outRefs are cited in transaction commands so validators do not need to be
embedded inline.

| `--script` value | What's at that UTxO | Published by | Output index |
| --- | --- | --- | --- |
| `config` | `config_state` spend validator | `preview:config:reference-scripts` | 0 |
| `coordinator` | `update_coordinator` withdrawal validator | `preview:config:reference-scripts` | 1 |
| `payment-hook` | `payment_hook` spend validator | `preview:payment-hook:reference-script` | 0 |
| `receiver` *(per client)* | `receiver` spend validator | `preview:reference-scripts:publish-client` | 0 |
| `pair` *(per client)* | `pair_state` spend validator | `preview:reference-scripts:publish-client` | 1 |
| `pairMint` *(per client)* | `pair_state` minting policy | `preview:reference-scripts:publish-client` | 2 |
| `deposit` *(per client)* | `deposit` spend validator | `preview:reference-scripts:publish-client` | 3 |

Note: **config and coordinator are published in the same transaction** by
`preview:config:reference-scripts` (output 0 and output 1 respectively).
**receiver, pair, pairMint, and deposit are published in the same transaction**
by `preview:reference-scripts:publish-client` (outputs 0, 1, 2, and 3 respectively).

Reclaim names match publish commands exactly — if a publish command puts N UTxOs,
its reclaim name spends those same N UTxOs in one transaction:

| `--script` value | UTxOs reclaimed | Clears entries |
| --- | --- | --- |
| `config` | global.config + global.coordinator (2 UTxOs) | `referenceScripts.global.config`, `.coordinator` |
| `payment-hook` | global.paymentHook (1 UTxO) | `referenceScripts.global.paymentHook` |
| `client` | client.receiver + client.pair + client.pairMint + client.deposit (4 UTxOs) | `referenceScripts.client.*` |

After `preview:reclaim-reference-script --script <name>`, the corresponding
entries are cleared to `{ txHash: "", outputIndex: 0, scriptHash: "" }` in the
artifact. If an update or settle transaction is submitted while a reference
UTxO is absent, the validator falls back to inline attachment automatically.

## Receiver state fields

The per-client `client.json` stores the off-chain mirror of the on-chain
`ReceiverDatum` under `receiver.receiverState`:

| Field | Type | Meaning (mirrors the on-chain datum) |
| --- | --- | --- |
| `balanceLovelace` | string (lovelace) | Client-prepaid pool. `receiver:top-up`, a `deposit:merge`, and an `update` folding pending side deposits all add here; `Withdraw` removes from here |
| `accruedToHookLovelace` | string (lovelace) | Per-update protocol fees that have been moved out of `balanceLovelace` and are waiting to be batched into the global PaymentHook by a `Settle` transaction |
| `minUtxoLovelace` | string (lovelace) | Locked min-UTxO floor; never moves |

These mirror the on-chain `ReceiverDatum`; the balance invariant, the
per-update fee formula, and how `Settle`/`Withdraw` move each field are
covered in
[architecture §4.3](../../../docs/architecture/cardano-oracle-architecture.md#43-receiver-datum-per-client).
