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
  - [Automatic fee-loop maintenance thresholds](#automatic-fee-loop-maintenance-thresholds)
  - [Cardano provider health thresholds](#cardano-provider-health-thresholds)
  - [Per-feed sanity check (`feed_sanity`)](#per-feed-sanity-check-feed_sanity)
  - [Notification channels (`notifications`)](#notification-channels-notifications)

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
| **Customer** | The business/operator label used in metrics, dashboards, and logs. In YAML this is `customer_id`. |
| **Client deployment** | The Cardano-side deployment: one Receiver UTxO, one deposit address, one Receiver NFT, and one pair namespace. It is represented by `client_state_path`. |
| **Router** | An off-chain YAML config group: symbols, trigger conditions, destination, and policy thresholds. It does not exist on-chain. |
| **Destination** | The router entry that points to a Cardano client deployment through `cardano.client_state_path` and `cardano.protocol_state_path`. |
| **Lane** | The feeder submission key `client_state_path :: protocol_state_path`. One lane means one serial queue protecting one Receiver UTxO. |

**Sharing** means one on-chain client deployment with many off-chain routers. It does
not mean many on-chain clients. Use this when one customer needs different
`time_threshold` / `price_deviation` policies for different, non-overlapping symbol
sets, while keeping one Receiver and one deposit address.

## Routers

Routers are **network-scoped**: each router gets one file under
`routers/<network>/` (e.g. `routers/preview/client-a-router-default.yaml`,
`routers/mainnet/client-a-router-majors.yaml`). The feeder loads **only** the folder matching
the active `CARDANO_NETWORK`, so a Preview router never loads on Mainnet; each
router's `cardano.network` field is a second guard (a mismatch is skipped with a
warning).

**Add a router:** drop a file in the right network folder. The pair set lives in that
router's `triggers.conditions`. See [`../README.md`](../README.md) for how routers,
lanes, and the policy gate work.

**Add a new on-chain client deployment:** run the CLI receiver/bootstrap flow to create
a new `clients/<id>.json` only when the customer needs a separate Receiver balance,
separate deposit address, separate pair namespace, or separate lane throughput.

A router is an **off-chain config grouping**, not an on-chain identity. Multiple
router files may point at the **same** `cardano.client_state_path` +
`cardano.protocol_state_path`, which means they share one on-chain client
deployment: the same Receiver UTxO, deposit address, and per-client pair
scripts/policy. This is the intended way to give one customer different
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

## Automatic fee-loop maintenance thresholds

The daemon also keeps the fee loop healthy on its own — `settle` (Receiver
accrued → PaymentHook), `payment-hook:withdraw` (PaymentHook → admin wallet),
and `wallet:consolidate` (defragment the admin wallet into a dedicated collateral
UTxO). These `alerting.*` keys decide **when** each automatic step acts:

| Key | Role |
| --- | --- |
| `auto_settle_lovelace` | Daemon auto-runs `settle` once a Receiver's accrued reaches this. Must be **>** `settle_overdue_lovelace` (the alert fires first). |
| `auto_withdraw_lovelace` | Daemon auto-runs `payment-hook:withdraw` once the PaymentHook accrued reaches this. Must be **>** `payment_hook_withdraw_ready_lovelace`. |
| `admin_wallet_min_collateral_lovelace` | Largest pure-ADA wallet UTxO below this → `AdminWalletFragmented` alert (the wallet can't back collateral). |
| `auto_consolidate_below_lovelace` | Daemon auto-runs `wallet:consolidate` once the largest wallet UTxO falls below this. Must be **<** `admin_wallet_min_collateral_lovelace` (the alert fires first). |

Each `auto_*` key is **optional**: unset disables that automatic step (never
defaulted). The **ordering invariant** (each `auto_*` beyond its paired alert, so
the alert fires first and the automatic step only follows) is enforced by the
`threshold-drift` test. Full rationale:
[Architecture → Fee loop & automatic maintenance](../../../docs/architecture/feeder.md#fee-loop--automatic-maintenance-settle--withdraw--consolidate).

## Cardano provider health thresholds

The feeder reaches Cardano through two API providers, with roles set by the
`CARDANO_PROVIDER` env var: a **primary** (the build/submit provider lucid uses
for everything) and a **secondary** (confirmation/reorg redundancy). These
`alerting.*` keys say how long a provider may go without a successful
call/probe before its alert fires:

| Key | Role |
| --- | --- |
| `provider_primary_unhealthy_seconds` | Seconds without a successful primary call → `PrimaryProviderDown` (critical). A primary outage (e.g. a Blockfrost `402` quota wall) freezes every build. Measured passively from the balance-refresh calls. |
| `provider_secondary_unhealthy_seconds` | Seconds without a successful secondary liveness probe → `SecondaryProviderDown` (warning). Losing it drops confirmation/reorg redundancy only. Measured by an active probe. |
| `provider_request_quota_per_day_blockfrost` | Blockfrost plan daily request limit. `ProviderRequestQuotaHighBlockfrost` (warning) fires when 24 h requests cross this × `provider_request_quota_warn_ratio` — the proactive headroom signal **before** the `402` wall. Set to your plan's quota. |
| `provider_request_quota_per_day_koios` | Same, for Koios → `ProviderRequestQuotaHighKoios`. |
| `provider_request_quota_warn_ratio` | Fraction of the daily quota at which the headroom warnings fire (e.g. `0.8` = 80 %). Shared by both providers. |
| `provider_error_rate_warn_ratio` | Fraction of requests failing/throttled (error + `429`) over 10 min → `ProviderErrorRateHigh` (warning). e.g. `0.2` = 20 %. |

The four request-quota / error-rate keys are backed by
`dia_bridge_provider_requests_total{provider,method,outcome}` (every request,
including retries). Backed (provider health) by
`dia_bridge_provider_last_ok_timestamp_seconds{provider,role}` and
`dia_bridge_component_health{component,role}`. The alerts key off **role**, so the
critical one always tracks whichever provider `CARDANO_PROVIDER` selects to build.
Full rationale:
[Architecture → Cardano API provider health](../../../docs/architecture/feeder.md#cardano-api-provider-health-primary-vs-secondary).

## Per-feed sanity check (`feed_sanity`)

The feeder periodically compares each feed's live on-chain value against the latest
DIA source value and publishes `dia_bridge_feed_sanity_status{symbol}` (0 = ok,
1 = suspect, 2 = broken), which the `FeedAccuracyFail` alert watches. It runs on its
OWN clock, separate from `cron_service` and the balance refresh. The same check is
available on demand: `npm run sanity:feeds`.

| Key | Role | Default |
| --- | --- | --- |
| `feed_sanity.enabled` | Run the in-feeder periodic check. | `true` |
| `feed_sanity.interval` | How often it runs (duration string). | `5m` |
| `feed_sanity.freshness_grace_seconds` | Grace added to a feed's freshness ceiling (confirmation + clock skew) so a value read just before its heartbeat reads as fresh. | `120` |

The price tolerance and freshness ceiling per feed come from that router's own
`price_deviation` / `time_threshold` / `max_staleness` (the push-policy knobs), so the
check judges a feed against the same bounds the feeder guarantees.

## Notification channels (`notifications`)

Where Alertmanager delivery is turned on and addressed. Off by default → alerts reach
the logs + database (via the feeder webhook) only. The SECRETS live in `feeder/.env`,
never in this file; the generator writes these channels into the generated
`monitoring/<network>/alertmanager.yml`.

| Key | Role |
| --- | --- |
| `notifications.telegram.enabled` | Deliver firing/resolved alerts to Telegram. |
| `notifications.telegram.chat_id` | Target chat/group id (bot token → `.env` `ALERTMANAGER_TELEGRAM_BOT_TOKEN`). |
| `notifications.email.enabled` | Deliver alerts by email. |
| `notifications.email.to` / `from` / `smarthost` | Recipients, sender, and SMTP `host:port` (password → `.env` `ALERTMANAGER_SMTP_PASSWORD`). |

`monitoring/<network>/alerts.yml` and `monitoring/<network>/alertmanager.yml` are
generated per network from this YAML by `make generate-monitoring` (automatic on
`make up`) — edit the YAML, not the generated files.
