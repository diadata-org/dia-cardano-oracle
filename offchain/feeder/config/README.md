# Feeder config

Declarative configuration the feeder loads at startup. **Secrets never live here** —
wallet seeds and Blockfrost keys come from `.env`
(see [`../README.md` → Environment](../README.md#environment)). Every knob in the
infrastructure files is documented inline and summarised in
[`../README.md` → Config layout](../README.md#config-layout).

## Contents

- [Feeder config](#feeder-config)
  - [Contents](#contents)
  - [Files](#files)
  - [Terminology: router vs client](#terminology-router-vs-client)
  - [Routers](#routers)
  - [Side-deposit thresholds](#side-deposit-thresholds)

## Files

| File | Purpose |
| --- | --- |
| `infrastructure.preview.yaml` / `infrastructure.mainnet.yaml` | Main per-network infra config: database, source chain, block scanner, event processor, worker pool, health check, API, metrics, cardano confirmation, cron service, alerting. The active file is chosen by `CARDANO_NETWORK`. |
| `chains.yaml` | EVM source-chain definitions (chain id → RPC/WS endpoints, names). |
| `contracts.yaml` | Source contract addresses + ABIs the scanner watches. |
| `events.yaml` | Event signatures the extractor decodes (`IntentRegistered`). |
| `routers/<network>/*.yaml` | One file per router, per network — which symbols map to which Cardano destination, with trigger conditions and the per-destination policy (`time_threshold` / `price_deviation`). Several routers may point to the same on-chain client deployment. |

## Terminology: router vs client

In feeder config, **router** and **client** are not the same thing.

| Name | Meaning |
| --- | --- |
| **Consumer / customer** | The business/operator label used in metrics, dashboards, and logs. |
| **Client deployment** | The Cardano-side deployment: one Receiver UTxO, one deposit address, one Receiver NFT, and one pair namespace. It is represented by `client_state_path`. |
| **Router** | An off-chain YAML config group: symbols, trigger conditions, destination, and policy thresholds. It does not exist on-chain. |
| **Destination** | The router entry that points to a Cardano client deployment through `cardano.client_state_path` and `cardano.protocol_state_path`. |
| **Lane** | The feeder submission key `client_state_path :: protocol_state_path`. One lane means one serial queue protecting one Receiver UTxO. |

**Sharing** means one on-chain client deployment with many off-chain routers. It does
not mean many on-chain clients. Use this when one consumer needs different
`time_threshold` / `price_deviation` policies for different, non-overlapping symbol
sets, while keeping one Receiver and one deposit address.

## Routers

Routers are **network-scoped**: each router gets one file under
`routers/<network>/` (e.g. `routers/preview/client-a.yaml`,
`routers/mainnet/client-a.yaml`). The feeder loads **only** the folder matching
the active `CARDANO_NETWORK`, so a Preview router never loads on Mainnet; each
router's `cardano.network` field is a second guard (a mismatch is skipped with a
warning).

**Add a router:** drop a file in the right network folder. The pair set lives in that
router's `triggers.conditions`. See [`../README.md`](../README.md) for how routers,
lanes, and the policy gate work.

**Add a new on-chain client deployment:** run the CLI receiver/bootstrap flow to create
a new `clients/<id>.json` only when the consumer needs a separate Receiver balance,
separate deposit address, separate pair namespace, or separate lane throughput.

A router is an **off-chain config grouping**, not an on-chain identity. Multiple
router files may point at the **same** `cardano.client_state_path` +
`cardano.protocol_state_path`, which means they share one on-chain client
deployment: the same Receiver UTxO, deposit address, and per-client pair
scripts/policy. This is the intended way to give one consumer different
`time_threshold` / `price_deviation` policies across different pair sets.

When routers share one Cardano destination, keep their symbol sets
**disjoint**. Policy state is tracked per `(routerId, destinationIndex, symbol)`,
but the submission lane is shared per
`client_state_path :: protocol_state_path`, and the coalescer buffers by
`symbol` inside that lane. The validator rejects overlapping symbols across routers
that share the same lane, because they would overwrite each other in the per-symbol
lane buffer.

## Side-deposit thresholds

The only deposit-related knobs in these infrastructure YAMLs are the auto-merge
**trigger thresholds**, under `alerting.*`:

| Key | Role |
| --- | --- |
| `receiver_balance_low_lovelace` | Daemon auto-merges a client's pending deposits when its Receiver balance drops below this. |
| `deposit_pending_merge_lovelace` | Daemon auto-merges once the pile of pending deposits reaches this (optional; absent disables this arm). |

These decide **when** the daemon folds deposits in, not how the merge tx is
built. The tx-build params (`depositMinLovelace`, `depositMaxPerMerge`,
`depositMaxPerUpdateFold`) live in the CLI protocol state
`config-bootstrap.json::configState`, not in this YAML.
See [`../README.md` → Client funding (side-deposits)](../README.md#client-funding-side-deposits).
