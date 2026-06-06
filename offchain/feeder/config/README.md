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
`routers/mainnet/client-a.yaml`). The feeder loads **only** the folder matching the
active `CARDANO_NETWORK` — so a Preview router (testnet wallet seed, `state/preview/…`
paths) never loads on Mainnet. The per-destination `cardano.network` field is a second
guard: a router whose destination network doesn't match the active network is skipped with
a warning. Add a new client by dropping a file in the right network folder; nothing else
changes. The active pair set lives in each router's `triggers.conditions`; see
[`../README.md`](../README.md) for how routers, lanes, and the policy gate work. The
pair-selection rationale is kept as a dated snapshot at
[`docs/milestones/evidence/pair-selection-20260605/pair-selection.md`](../../../docs/milestones/evidence/pair-selection-20260605/pair-selection.md).
