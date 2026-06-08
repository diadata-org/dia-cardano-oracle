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
  - [Routers](#routers)
  - [Side-deposit thresholds](#side-deposit-thresholds)

## Files

| File | Purpose |
| --- | --- |
| `infrastructure.preview.yaml` / `infrastructure.mainnet.yaml` | Main per-network infra config: database, source chain, block scanner, event processor, worker pool, health check, API, metrics, cardano confirmation, cron service, alerting. The active file is chosen by `CARDANO_NETWORK`. |
| `chains.yaml` | EVM source-chain definitions (chain id → RPC/WS endpoints, names). |
| `contracts.yaml` | Source contract addresses + ABIs the scanner watches. |
| `events.yaml` | Event signatures the extractor decodes (`IntentRegistered`). |
| `routers/<network>/*.yaml` | One file per client, per network — which symbols map to which Cardano destination, with trigger conditions and the per-destination policy (`time_threshold` / `price_deviation`). |

## Routers

Routers are **network-scoped**: each client gets one file under
`routers/<network>/` (e.g. `routers/preview/client-a.yaml`,
`routers/mainnet/client-a.yaml`). The feeder loads **only** the folder matching
the active `CARDANO_NETWORK`, so a Preview router never loads on Mainnet; each
router's `cardano.network` field is a second guard (a mismatch is skipped with a
warning).

**Add a client:** drop a file in the right network folder; nothing else changes.
The pair set lives in that router's `triggers.conditions`. See
[`../README.md`](../README.md) for how routers, lanes, and the policy gate work.

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
