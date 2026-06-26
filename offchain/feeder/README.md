# DIA Cardano Oracle Feeder

Long-running daemon that consumes `IntentRegistered` events from the DIA
`OracleIntentRegistry` (DIA Lasernet testnet or mainnet) and submits
matching Cardano oracle update transactions through the contracts
deployed by `offchain/cli/`.

The pipeline is scanner → extractor → enricher → router → write-client, with
per-key transaction queues and an HTTP API for health / metrics / prices. This
README is the operator manual — how to run, configure, and observe the feeder.
For how it works internally and how it diverges from its EVM ancestor, see
[Architecture (see also)](#architecture-see-also).

## Contents

- [Directory guide](#directory-guide)
- [Core terms: customer, client, router, lane](#core-terms-customer-client-router-lane)
- [How to run — three forms](#how-to-run--three-forms)
- [Service URLs — where to look (once it's running)](#service-urls--where-to-look-once-its-running)
- [Per-run state (RUN_ID)](#per-run-state-run_id)
- [Running with Docker](#running-with-docker)
  - [Compose services & profiles](#compose-services--profiles)
  - [Network-scoped stacks](#network-scoped-stacks)
  - [Daemon only](#daemon-only)
  - [Daemon + monitoring](#daemon--monitoring)
  - [Capturing an operational snapshot](#capturing-an-operational-snapshot)
  - [Admin commands (CLI)](#admin-commands-cli)
  - [Operator setup — pick your scenario](#operator-setup--pick-your-scenario)
  - [Day-2 operations (Docker)](#day-2-operations-docker)
  - [Fault-drill intent injection](#fault-drill-intent-injection)
  - [Deploy, contracts & teardown (Docker)](#deploy-contracts--teardown-docker)
  - [Volume layout](#volume-layout)
- [Running locally (npm)](#running-locally-npm)
  - [Operator setup — pick your scenario](#operator-setup--pick-your-scenario-1)
  - [Day-2 operations (npm)](#day-2-operations-npm)
  - [All commands — copy-paste examples](#all-commands--copy-paste-examples)
- [Flags](#flags)
  - [`--log-level` — what each level shows](#--log-level--what-each-level-shows)
  - [`--clean` flag / `reset` sub-command — what gets deleted](#--clean-flag--reset-sub-command--what-gets-deleted)
- [Log streams](#log-streams)
- [Environment](#environment)
- [Database](#database)
  - [Schema — 6 tables](#schema--6-tables)
- [Config layout](#config-layout)
  - [Validation](#validation)
  - [`event_processor` knobs](#event_processor-knobs)
  - [`block_scanner` knobs](#block_scanner-knobs)
  - [`worker_pool` knobs](#worker_pool-knobs)
  - [`cron_service` knobs](#cron_service-knobs)
  - [`api` knobs](#api-knobs)
  - [Code-level defaults](#code-level-defaults)
- [HTTP API](#http-api)
  - [What "confirmed" means](#what-confirmed-means)
- [Thresholds and alerts](#thresholds-and-alerts)
  - [How alerts work — one pipeline](#how-alerts-work--one-pipeline)
  - [Alert thresholds — single source of truth](#alert-thresholds--single-source-of-truth)
  - [Client funding (side-deposits)](#client-funding-side-deposits)
  - [Full alert map](#full-alert-map)
  - [Operational wallets at a glance](#operational-wallets-at-a-glance)
  - [Automatic fee-loop maintenance (settle / withdraw / consolidate)](#automatic-fee-loop-maintenance-settle--withdraw--consolidate)
  - [Provider health (primary vs secondary)](#provider-health-primary-vs-secondary)
- [Architecture (see also)](#architecture-see-also)

## Directory guide

| Path | What's there |
| --- | --- |
| [`config/`](./config/README.md) | YAML configuration the feeder loads — infrastructure, chains, contracts, events, routers, pair selection. |
| [`scripts/`](./scripts/README.md) | Evidence-pack tooling (`make evidence`) and the on-chain pair-scan helper. |
| [`state/`](./state/README.md) | Per-run, per-network state (`state/<network>_run_<id>/`): imported CLI artifacts (committed) + runtime DB/logs (gitignored). |
| `src/`, `cmd/` | The feeder daemon source (TypeScript). |

## Core terms: customer, client, router, lane

The feeder uses these names precisely:

| Term | Meaning |
| --- | --- |
| **Customer** | The external party DIA serves; in YAML/metrics this is `customer_id`, and in TypeScript/API this is `customerId`. |
| **Client deployment** | The Cardano-side deployment for a customer: one Receiver UTxO, one deposit address, one Receiver NFT, and one pair namespace. |
| **Router** | An off-chain YAML config group that selects symbols and policy thresholds, then points to a destination. A router is not an on-chain object. |
| **Destination** | The `cardano:` block inside a router, pointing at `client_state_path` + `protocol_state_path`. |
| **Lane** | The runtime submission key `client_state_path :: protocol_state_path`; one lane means one serial queue protecting one Receiver UTxO. |

**Sharing** means **one on-chain client deployment, many off-chain routers**. Multiple
routers can point to the same `client_state_path` + `protocol_state_path` to reuse the
same Receiver, deposit address, and pair namespace while applying different policies to
different symbol sets. Those symbol sets must be disjoint; the config validator rejects
overlap on a shared lane.

## How to run — three forms

Pick one; full setup for each is in its section below.

| Form | Command | Restart on crash? | Grafana / Prometheus? | Use when |
| --- | --- | --- | --- | --- |
| **Docker** (recommended) | `make up` (`+ MONITORING=1`) | Yes — Compose `restart: unless-stopped` | Yes — with `MONITORING=1` | Any real deployment |
| **npm (local/dev)** | `npm run feeder:dev -- daemon` | No supervisor | No — `/metrics` only | Quick local dev / debugging |
| **npm supervised** | `npm run feeder:supervised -- daemon` | Yes — restart loop with backoff | No — `/metrics` only | Local runs that need resilience |

Two things to know before you read the rest of this manual:

> **`daemon` is the default command — typing it is optional.** Every
> `feeder:dev` / `feeder:supervised` invocation runs the daemon even without the
> word `daemon` (the examples further down omit it). What you **cannot** omit is
> the `--`: it is npm's argument separator, so any flag must come after it —
> `npm run feeder:dev -- --from-latest`. Drop the `--` and npm swallows the flag.
> Sub-commands (`init router`, `checkpoint …`, `reset`, `prune`) are likewise
> passed after the `--`.

> **Grafana and Prometheus are Docker-only.** The monitoring stack
> (Grafana + Prometheus + renderer) exists **only** through Docker
> (`make up MONITORING=1`) — there is no npm equivalent and no `npm run`
> script that starts it. The npm forms run the feeder alone: it still exposes
> `/metrics` (Prometheus format) and the full HTTP API on `:8080`, but no
> dashboard server comes up. To graph an npm run you must either use the Docker
> path or point your own Grafana/Prometheus at `localhost:8080/metrics`. Every
> Grafana/Prometheus URL and `MONITORING=1` instruction below therefore assumes
> the Docker path.

A note on lucid WASM: a transient lucid WASM build error (`detached ArrayBuffer`)
is auto-retried in-process and never reaches the operator. A rare *persistent*
one makes the daemon self-exit (code 17) so a supervisor restarts it with a
fresh WASM module; it then resumes from the DB. Docker and the supervised npm
form provide that supervisor; the bare `feeder:dev` form does not (a self-exit
leaves the process stopped). Deep detail →
[Architecture (see also)](#architecture-see-also).

## Service URLs — where to look (once it's running)

Start with `make up MONITORING=1` (feeder + indexer + Grafana + Prometheus +
Alertmanager + Pushgateway) or `make up` (feeder + indexer), then open these in a
browser. All are published on `localhost`.

| What | URL | Up with |
| --- | --- | --- |
| **Grafana** dashboards | <http://localhost:3000> — login `admin` / `${GRAFANA_ADMIN_PASSWORD:-admin}` | `make up MONITORING=1` |
| **Prometheus** (raw metrics, alert state) | <http://localhost:9090> — `/alerts` shows rule state (pending → firing) | `make up MONITORING=1` |
| **Alertmanager** (active alerts, silences) | <http://localhost:9093> — routes firing alerts to the feeder webhook (→ `alert_log`) and, when enabled, Telegram/email | `make up MONITORING=1` |
| **Pushgateway** (alert-trigger harness target) | <http://localhost:9091> — empty in normal operation; `scripts/monitoring/trigger-alert.sh` pushes here to fire an alert on demand | `make up MONITORING=1` |
| Feeder **API reference** (Swagger UI, interactive — Try it out) | <http://localhost:8080/docs> | `make up` |
| Feeder **OpenAPI schema** (3.0 JSON) | <http://localhost:8080/api/v1/openapi.json> | `make up` |
| Feeder **liveness** | <http://localhost:8080/health/live> | `make up` |
| Feeder **readiness** | <http://localhost:8080/health/ready> | `make up` |
| Feeder **metrics** (Prometheus scrape) | <http://localhost:8080/metrics> | `make up` |
| **Indexer** (consumer-facing on-chain queries) | <http://localhost:3001/v1/health>, `/v1/pairs` | `make up` |
| **Indexer** API reference (Swagger UI) + metrics | <http://localhost:3001/docs>, `/v1/openapi.json`, `/metrics` | `make up` |

Feeder HTTP API (all under `http://localhost:8080`):

| Endpoint | Shows |
| --- | --- |
| `/docs` | Interactive API reference (Swagger UI), rendered from the OpenAPI schema — fire requests with **Try it out** |
| `/api/v1/openapi.json` | The OpenAPI 3.0 schema itself, generated from the route table |
| `/api/v1/prices` | Latest confirmed price per symbol (each entry carries `routerId` + `customerId`/`clientId`/`network`) |
| `/api/v1/prices/:symbol` | One symbol across destinations |
| `/api/v1/symbols` | Symbols from the active router YAMLs |
| `/api/v1/transactions` | Recent Cardano submissions |
| `/api/v1/transactions/:txHash` | One tx + its member intents; tx-level `customerId`/`clientId`/`network` + `routerIds` (a batch can mix routers on the shared lane) |
| `/api/v1/chains` · `/api/v1/chains/:id/status` | Source-chain status |
| `/api/v1/alerts` · `/api/v1/alerts/:id` | Active + recent alerts |
| `/api/v1/performance` | DB-backed latency/throughput samples |
| `/api/v1/pools` · `/api/v1/pools/:router_id/tasks` | Worker-pool state |
| `/api/v1/status` · `/api/v1/status/components` | Daemon + component status |
| `/api/v1/events` · `/api/v1/events/:hash` | Processed `IntentRegistered` events |

Quick check from the terminal:

```sh
curl -s http://localhost:8080/health/live          # {"status":"alive"}
curl -s http://localhost:8080/api/v1/prices | jq   # latest prices
```

> If `localhost:8080` does not respond from your host while the container
> is "healthy", confirm `api.host: 0.0.0.0` in
> `config/infrastructure.<network>.yaml` (a process bound to `127.0.0.1`
> inside the container is unreachable through Docker's published port), then
> `make restart`.

The full API reference (query params, response shapes) is in
[§ HTTP API](#http-api) below.

## Per-run state (RUN_ID)

Each deployment's state lives in one **per-run dir**, `state/<network>_run_<id>/`,
in the shared `offchain/state/` tree (`../state/` from the feeder). It holds the
CLI's deployment record (config-bootstrap.json, clients) and the feeder's DB,
logs, and pair state together. That is why two deployments of one network (e.g.
two mainnet receivers) never clobber each other's database or scanner checkpoint.

`RUN_ID` is an **environment variable**, so everything here works identically
under Docker (`make … RUN_ID=…`) and npm (`RUN_ID=… npm run …`).

**The rule for picking a run: use `RUN_ID` if set, otherwise the newest run.**

- **Commands that operate on a run** (the daemon, `checkpoint`, `reset`, `prune`,
  the evidence pack): with `RUN_ID` set they use `state/<network>_run_<RUN_ID>/`;
  with it empty they use the **newest** `state/<network>_run_*/`.
- **`init router`**: scans `../state/` for the run (the **newest**
  `../state/<network>_run_*` by default; pass `--from <path>` to choose one) and
  generates the router YAML pointing the daemon at it. Pass that run id as
  `RUN_ID` to start the daemon.

```sh
# Docker — pass it on any target
make up RUN_ID=20260517-063917 MONITORING=1
make checkpoint-latest RUN_ID=20260517-063917

# npm — same env var, inline (or export it)
RUN_ID=20260517-063917 npm run feeder:dev -- daemon
RUN_ID=20260517-063917 npm run feeder:dev -- checkpoint set --from-latest
```

Or pin one deployment by setting `RUN_ID` in `.env` (read by both modes). The
lowercase `<network>` comes from `CARDANO_NETWORK`. You only need `RUN_ID` when
you keep **several** deployments of the same network and want to pin a specific
one; with a single deployment the newest-run default picks it automatically.

## Running with Docker

The feeder and all CLI admin commands ship in **one image**
(`dia-cardano-feeder:local`). Docker is the recommended deployment method
because the image is **self-contained**: the compiled feeder, the CLI, the Aiken
contracts (blueprint + compiler), and all native deps (better-sqlite3,
lucid-evolution) are baked in. Compiling contracts, deploying on-chain, running
the daemon, and tearing down all work in the container with no host-side setup.

All `make` targets below run from `offchain/` (where `Makefile` lives).
Run `make help` for a complete target list. The Makefile exports your current
host `UID`/`GID` so Docker can write to the bind-mounted `offchain/state/`
tree.

### Compose services & profiles

Everything runs from one image (`dia-cardano-feeder:local`) selected through Docker
Compose **profiles**. You normally drive these with `make` (below); this is the
underlying map.

| Service | Profile | What it is |
| --- | --- | --- |
| `feeder-sqlite` | `sqlite` | The feeder daemon with the **SQLite** backend (default). SQLite is an embedded file (`state/<network>_run_<id>/feeder.sqlite`) — there is no database server; the service *is* the feeder. |
| `feeder-postgres` | `postgres` | The **same** feeder daemon with the **PostgreSQL** backend. |
| `postgres` | `postgres` | A PostgreSQL 15 server, started only under this profile (data in the `postgres-data` volume). |
| `cli` | `cli` | Short-lived admin container for one-off CLI commands (`make cli CMD="…"`). |
| `prometheus`, `grafana`, `renderer` | `monitoring` | The observability stack (`MONITORING=1`). |

Things worth knowing:

- `feeder-sqlite` and `feeder-postgres` are the **same image** — the suffix only picks
  the DB backend. Run **exactly one** (both publish port 8080). SQLite is the default
  and is sufficient for single-instance deployments; Postgres is for higher-scale /
  external-DB setups.
- Pick the backend with the make target: `make up` (SQLite, default) or
  `make up-postgres`. That sets `DATABASE_DRIVER`; the path/DSN come from `.env`
  (`DATABASE_PATH_*` for SQLite, `DATABASE_DSN_*` for Postgres), and the `database` block
  in `config/infrastructure.<network>.yaml` documents the knobs (see
  [`config/`](./config/README.md)).
- Profiles **compose**: `MONITORING=1` adds the `monitoring` profile on top of the
  feeder profile. `make down` stops every profile **for the current network**
  (see [Network-scoped stacks](#network-scoped-stacks)).

### Network-scoped stacks

`make` scopes the Compose **project** per network — `dia-feeder-<network>`, taken
from `CARDANO_NETWORK` in `feeder/.env`. So Preview and Mainnet get separate
containers **and** separate named volumes, and switching networks never destroys
the other one's state:

| `feeder/.env` | Compose project | Containers | Named volumes |
| --- | --- | --- | --- |
| `CARDANO_NETWORK=Preview` | `dia-feeder-preview` | `dia-feeder-preview-feeder-sqlite-1`, … | `dia-feeder-preview_grafana-data`, … |
| `CARDANO_NETWORK=Mainnet` | `dia-feeder-mainnet` | `dia-feeder-mainnet-feeder-sqlite-1`, … | `dia-feeder-mainnet_grafana-data`, … |

Ports (8080 API, 3000 Grafana, 9090 Prometheus) are **shared**, so run **one
network at a time**. The feeder DB and logs live on the bind-mounted
`state/<network>_run_<id>/` (a host path, not a named volume), so they survive a
switch either way.

**Switching networks** — stop the current stack *before* changing the selector,
so `make down` targets the network that is actually up:

```sh
make down                  # stops the current network's stack (the other stays put)
# edit feeder/.env -> CARDANO_NETWORK=Mainnet
make up MONITORING=1       # starts the dia-feeder-mainnet stack
```

`make down-all` stops **both** `dia-feeder-preview` and `dia-feeder-mainnet` when
you're unsure what's running.

### Daemon only

```sh
cp offchain/feeder/.env.example offchain/feeder/.env
# Fill in Blockfrost keys, wallet seeds, etc.

cd offchain
make build          # builds the unified image once
make up             # starts feeder-sqlite in the background
make logs           # tail daemon logs
```

Open `http://localhost:8080/health/live` to verify the daemon is running.

> **The image bakes the compiled feeder + CLI.** Any time the source under
> `offchain/feeder/` or `offchain/cli/` changes (including after a `git pull`),
> re-run `make build` before `make up` / `make reset-restart` / any `make`
> sub-command, otherwise the container keeps running the old binary.
>
> **`make fresh` is the one-shot that can't forget the rebuild** — it runs
> `build` + wipes the Prometheus/Grafana volumes + the feeder DB/logs/pairs +
> reseeds the checkpoint + starts, all in order (the on-chain deploy in
> `../state` is kept). Use it after **code** changes. For **config-only** (YAML)
> changes no rebuild is needed — `make reset-restart` is enough.

### Daemon + monitoring

`MONITORING=1` is a toggle on any start target (`up`, `up-postgres`,
`restart-latest`, `reset-restart`). With it, Prometheus + Alertmanager + Grafana +
the renderer come up alongside the feeder; without it, only the feeder starts.
There is no separate `up-monitoring` target. Monitoring stays up until
`make down`.

```sh
cd offchain
make up MONITORING=1   # feeder-sqlite + Prometheus + Alertmanager + Grafana + renderer
make up                # feeder only (monitoring untouched)
make down              # stops everything (DB + volumes kept)
make down VOLUMES=1    # stops + DELETES the Prometheus + Grafana + Alertmanager volumes (fresh metrics; ../state/contracts untouched)
make fresh             # code changed? rebuild image + wipe volumes/DB/logs + reseed + start feeder + indexer (keeps on-chain deploy)
```

- Prometheus: `http://localhost:9090` — raw metrics and alert state
  (`/alerts` shows the configured alert rules).
- Alertmanager: `http://localhost:9093` — routes firing alerts to the feeder
  webhook (→ `alert_log`) and, when enabled, Telegram/email; its UI shows active
  alerts and lets you silence them.
- Grafana: `http://localhost:3000` — login `admin` / value of
  `GRAFANA_ADMIN_PASSWORD` in `.env` (defaults to `admin`). Three dashboards are
  pre-provisioned: **DIA Cardano Oracle Feeder** (operational overview, balances,
  per-symbol throughput), **DIA Cardano Oracle Feeder — Transactions**
  (per-transaction view: stage latency, confirmed-vs-failed, batch size), and
  **DIA Cardano Oracle Feeder — Internals** (pipeline-phase latency, scanner, worker
  pool, DB, cron/recovery — for troubleshooting the feeder itself). The first two
  filter by **network → customer → client → router → symbol** (cascading); Internals
  is feeder-wide (network only). A batch tx of N pairs counts as one transaction in
  the tx view and as N symbol updates in the overview.
- Renderer: a `grafana/grafana-image-renderer` sidecar that produces PNG
  snapshots of the dashboard for Grafana. No exposed port; intra-compose only.
- Pushgateway: `http://localhost:9091` — empty in normal operation; the
  `scripts/monitoring/trigger-alert.sh` harness pushes synthetic metric values here to
  fire an alert on demand (see *How alerts work* → *Fire an alert on demand*).

Alert rules, thresholds and the Alertmanager config are **generated** from
`infrastructure.<network>.yaml` (see *Alert thresholds — single source of truth*).
To change a threshold or a notification channel, edit that YAML and run
`make generate-monitoring` (automatic on `make up`) — do not hand-edit
`monitoring/alerts.yml` or `monitoring/alertmanager.yml`.

### Capturing an operational snapshot

`scripts/m2-evidence/` contains a script that packages a feeder's current logs,
DB tables, live API responses, and Grafana dashboard PNGs into a self-contained
dated directory — useful for sharing a point-in-time deployment record. The
script does not stop or restart the feeder. See
[`scripts/README.md`](./scripts/README.md) for the full description (inputs,
outputs, dependencies, dashboard rendering).

### Admin commands (CLI)

The `cli` compose service runs the same image as the feeder but invokes
`dia-cli` instead of the daemon. It is short-lived and removed after each
run (`--rm`).

```sh
cd offchain

# Inspect protocol state.
make cli CMD="protocol"

# Check wallet balances.
make cli CMD="wallet"
make cli CMD="wallet:utxos"

# Bootstrap a new client (after protocol:init + config:* commands).
make cli CMD="client:init"
make cli CMD="receiver:bootstrap"

# Top up the receiver wallet (amount in lovelace: 5000000 = 5 ADA).
make cli CMD="receiver:top-up --amount-lovelace 5000000"

# Publish reference scripts for a client.
make cli CMD="reference-scripts:publish-client"

# Trigger a manual settle.
make cli CMD="settle"

# Pair lifecycle.
make cli CMD="pair:burn --symbol BTC/USD"
make cli CMD="pair:dedup --symbol BTC/USD"

# Teardown burns (decommission) — recover each UTxO's min-ADA.
# Drain first: receiver:burn needs withdraw + settle; payment-hook:burn needs
# payment-hook:withdraw; config:burn runs last, after reference scripts are reclaimed.
make cli CMD="receiver:burn"
make cli CMD="payment-hook:burn"
make cli CMD="config:burn"

# Inspect the CLI state tree inside the container.
docker compose -f feeder/docker-compose.yml --project-directory feeder --profile cli run --rm --entrypoint sh cli -c "ls -R /app/offchain/state"
```

> **Always start/restart containers with `make`, never with `docker compose`
> directly.** The Makefile exports your host `UID`/`GID` so the container
> runs as your user and can write the bind-mounted `offchain/state/` tree.
> A bare `docker compose up` defaults to `1000:1000`, which may not match
> your user and leaves the SQLite DB read-only to the daemon
> (`attempt to write a readonly database`).

### Operator setup — pick your scenario

All commands run from `offchain/`. Pick the one that matches your machine.

**Scenario A — fresh machine, never ran the CLI.**
The image is self-contained, so the full on-chain deployment runs in Docker. Set
`offchain/feeder/.env` (network + Blockfrost key + wallet seed + DIA creds), then:

```sh
make build      # build the image (once)
make wallet     # create the operator wallet (fund it before deploying)
make run-all    # full deployment runbook end to end
                #   (or step by step: make protocol-init && make client-init)
```

That produces the deployment under `offchain/state/<network>_run_<id>/`. Then
continue with Scenario B to import it into the feeder and start the daemon.
(Prefer running on the host? The same runbook is documented for npm in
[`offchain/cli/README.md`](../cli/README.md#wallet-setup).)

**Scenario B — CLI state already exists, feeder never started.**
First set the target network in `offchain/feeder/.env`: `CARDANO_NETWORK=Preview`
or `Mainnet` (plus that network's Blockfrost key, wallet seed, DIA creds). Then
import the CLI deployment and start:

```sh
make build             # only if the image isn't built yet
make init-router       # generate config/routers/<net>/<client>-router-<name>.yaml (interactive)
make checkpoint-latest # seed scanner to chain tip
make up MONITORING=1   # start the daemon
```

No `RUN_ID` needed: `init` creates the one run dir, and the other commands
default to the **newest** run, so they pick it up automatically. Pin a specific
one with `RUN_ID=<id>` only when you keep several deployments of the same network
— see [Per-run state (RUN_ID)](#per-run-state-run_id).

**Scenario C — everything set up, just want clean logs + DB.**
The CLI state and router YAML already exist; you only want a fresh runtime:

```sh
make reset-restart   # stop → wipe DB+logs+pairs → reseed checkpoint → start feeder + indexer
make logs            # follow the daemon
```

`make reset-restart` keeps the CLI bootstrap files
(`config-bootstrap.json`, `clients/*.json`) and the router YAML config —
it only deletes feeder-generated runtime state.

Open `http://localhost:8080/health/live` to verify the daemon is running.

### Day-2 operations (Docker)

These targets run the **feeder** binary as one-off containers (not `dia-cli`):

| Target | What it does |
| --- | --- |
| `make init-router` | Generate a router YAML from a client's JSON, interactively (`feeder init router`) |
| `make checkpoint-get` | Print the current scanner checkpoint |
| `make checkpoint-latest` | Seed the checkpoint to the current chain tip (only new intents) |
| `make restart` | Restart the daemon with **no** data changes |
| `make restart-latest` | Restart feeder + indexer skipping the backlog: reseed checkpoint to tip, **keep** DB + logs |
| `make reset` | Delete runtime state (DB + logs + pairs) and exit; keeps CLI bootstrap files |
| `make reset-restart` | Stop → `reset` → reseed checkpoint → start feeder + indexer (no rebuild — config-only changes) |
| `make fresh` | After **code** changes: rebuild image → wipe Prometheus/Grafana volumes + DB/logs/pairs → reseed → start feeder + indexer. Keeps on-chain deploy. (`MONITORING=1` opt) |
| `make down VOLUMES=1` | Stop the stack **and** delete the Prometheus + Grafana + Alertmanager volumes (fresh metrics; `../state`/contracts untouched) |
| `make prune` | Prune only **old** rows/logs (keeps DB). `make prune MAX_AGE=30m` |

### Fault-drill intent injection

A workaround for end-to-end drills: `make inject` signs an intent with our
authorized key (via the CLI) and drops it into the run's `inject/` directory,
which the daemon's file injector pushes on-chain like any scanned intent — to
force a stale / drifted / out-of-order update on demand.

```sh
make inject SYMBOL=BTC/USD PRICE=6500000000000                       # normal
make inject SYMBOL=BTC/USD PRICE=6500000000000 TIMESTAMP=1700000000  # stale
make inject SYMBOL=BTC/USD PRICE=1                                   # drifted
make inject SYMBOL=BTC/USD PRICE=6500000000000 NONCE=1               # out-of-order
```

Watch it with `make logs | grep "intent injector"`. Mechanism:
[architecture §3](../../docs/architecture/feeder.md#3-ingestion-http-websocket-and-the-file-source).

### Deploy, contracts & teardown (Docker)

These run the **CLI** / runbook scripts inside the same image:

| Target | What it does |
| --- | --- |
| `make wallet` | Create the operator wallet |
| `make protocol-init` / `make client-init` | Deploy the protocol / register a client (individual CLI steps) |
| `make run-all ARGS="…"` | Full deployment runbook end to end (`run-all-cli.sh`); `ARGS` forwards `--from-step` / `--run-id` |
| `make contracts-build` / `make contracts-check` | `aiken build` / `aiken check` in-image (regenerates `plutus.json`) |
| `make teardown ARGS="…"` | Decommission + recover ADA (`run-teardown-cli.sh`) |

### Volume layout

The image mirrors the repo under `/app` (`/app/contracts`, `/app/offchain/cli`,
`/app/offchain/feeder`) with everything baked. Only the mutable dirs below are
bind-mounted so their contents persist on the host:

| Host / named volume | Container path | Used by | Contents |
| --- | --- | --- | --- |
| `feeder/config/` | `/app/offchain/feeder/config` | feeder | Modular YAML config (router YAML written by `init-router`) |
| `offchain/state/` | `/app/offchain/state` | feeder, cli | Shared per-run state: the CLI deployment record (config-bootstrap.json, clients) **and** the feeder runtime (DB, logs, pair state). One tree, used by both. |
| `contracts/aiken/` | `/app/contracts/aiken` | cli | Aiken sources + `plutus.json` (so `contracts-build` persists) |
| `docs/milestones/evidence/` | `/app/docs/milestones/evidence` | cli | `run-all` / `teardown` evidence logs |
| `.env` | env_file | feeder, cli | Secrets + selectors |
| `postgres-data` | (postgres svc) | postgres | Postgres data dir |
| `prometheus-data` | `/prometheus` | prometheus | Prometheus TSDB (metric retention) |
| `grafana-data` | `/var/lib/grafana` | grafana | Dashboard and alert state |

The three **named** volumes are project-scoped, so each network gets its own —
`dia-feeder-<network>_postgres-data`, `…_prometheus-data`, `…_grafana-data` (see
[Network-scoped stacks](#network-scoped-stacks)). The bind-mount rows are shared
across networks; they stay network-safe because their contents are already keyed
by network (`config/routers/<network>/`, `*_<NETWORK>` env suffixes,
`state/<network>_run_<id>/`).

## Running locally (npm)

Run the feeder directly on your machine, without Docker. Requires
**Node.js 22+** and the toolchain to build the native deps
(`better-sqlite3`, `lucid-evolution`). Everything below runs from
`offchain/feeder/`. This is the **mirror** of the Docker path above — pick
one or the other, do not mix them.

> **No Grafana/Prometheus on this path.** The npm forms start the feeder only;
> the monitoring stack is Docker-only (see
> [How to run — three forms](#how-to-run--three-forms)). You still get
> `/metrics` and the HTTP API on `:8080` — bring your own dashboard server if
> you want graphs.

The bare `npm run feeder:dev -- daemon` runs **without a supervisor**: if the
daemon self-exits on a persistent lucid WASM fault (code 17) it stays stopped.
For a resilient local run, wrap it with `npm run feeder:supervised -- daemon`
(same args), which restarts with backoff exactly like Docker's
`restart: unless-stopped` (see [How to run](#how-to-run--three-forms)). All the
commands below use `feeder:dev`; swap in `feeder:supervised` to get the restart
loop.

Each `npm run feeder:dev` is **one process for one network** (the network from
`CARDANO_NETWORK`, the run from `RUN_ID` — see
[Per-run state (RUN_ID)](#per-run-state-run_id)). To run two networks at once,
start two processes from two shells, each with its own `CARDANO_NETWORK` and a
distinct API port via `api.host`/port in `config/infrastructure.<network>.yaml`.

```sh
cd offchain/feeder
npm install
cp .env.example .env   # fill in secrets from offchain/cli/.env
```

### Operator setup — pick your scenario

**Scenario A — fresh machine, never ran the CLI.**
First do the full on-chain setup by following the CLI runbook:
[**Wallet Setup → Protocol Deployment → Client Deployment**](../cli/README.md#wallet-setup)
(run locally with `npm run cli -- ...` from `offchain/cli/`). That produces
the CLI state under `offchain/state/<network>_run_<id>/`. Then continue with
Scenario B.

**Scenario B — CLI state already exists, feeder never started.**
First set the target network in `.env`: `CARDANO_NETWORK=Preview` or `Mainnet`
(plus that network's secrets). Then import the CLI deployment and start:

```sh
npm run feeder:dev -- init router                   # generate the client's router YAML for the run
npm run feeder:dev -- checkpoint set --from-latest  # seed scanner to chain tip
npm run feeder:dev                                  # start the daemon
```

No `RUN_ID` needed: `init` creates the one run dir, and the other commands
default to the **newest** run. Set `RUN_ID=<id>` (inline, e.g.
`RUN_ID=… npm run feeder:dev`) only when you keep several deployments of the same
network — see [Per-run state (RUN_ID)](#per-run-state-run_id).

**Scenario C — everything set up, just want clean logs + DB.**
One command wipes the runtime state, reseeds the checkpoint, and starts:

```sh
npm run feeder:dev -- --clean --from-latest
```

The feeder needs two bootstrap files from the CLI; `init` copies them in:

| Artifact | Produced by CLI command |
| --- | --- |
| `state/<network>_run_<id>/config-bootstrap.json` | `config:bootstrap` |
| `state/<network>_run_<id>/clients/<id>.json` | `receiver:bootstrap` |

`init` auto-scans `../state/` for the latest matching network run; use
`--from <path>` to point at a specific run, and `--force` to overwrite
without the confirmation prompt. If the daemon starts and a required file
is missing, it exits immediately printing the exact `init` command to run.

### Day-2 operations (npm)

| Operation | Command |
| --- | --- |
| Restart with no data changes | Ctrl-C, then `npm run feeder:dev` |
| Restart skipping the backlog (keep DB + logs) | `npm run feeder:dev -- --from-latest` |
| Restart clean (wipe DB + logs) | `npm run feeder:dev -- --clean --from-latest` |
| Wipe runtime state and exit | `npm run feeder:dev -- reset` |
| Prune only old rows/logs (keep DB) | `npm run feeder:dev -- prune [--max-age 30m]` |
| Inspect / set the scanner checkpoint | `npm run feeder:dev -- checkpoint get` / `... set --from-latest` |

`reset` and `--clean` never delete the CLI bootstrap files
(`config-bootstrap.json`, `clients/*.json`) — only feeder-generated runtime
state. `reset` exits after wiping; `--clean` wipes then starts the daemon.

### All commands — copy-paste examples

Every useful invocation, grouped by purpose. Copy the one you need.

```sh
# ── Configure the router for a deployment ──────────────────────────
npm run feeder:dev -- init router                            # auto-scan ../state/ + interactive router YAML wizard
npm run feeder:dev -- init router --from ../state/preview_run_20260516-090057/clients/client-a.json
npm run feeder:dev -- init router --force                    # overwrite without prompting

# ── Start the daemon ───────────────────────────────────────────────
npm run feeder:dev                                           # normal start (resume from persisted checkpoint)
npm run feeder:dev -- --from-latest                          # start skipping the backlog (chain tip), keep DB + logs
npm run feeder:dev -- --from-block 7800000                   # start from a specific block, keep DB + logs
npm run feeder:dev -- --clean --from-latest                  # clean start: wipe DB + logs, then scan only new intents
npm run feeder:dev -- --clean --from-block 7800000           # clean start from a specific block
npm run feeder:dev -- --log-level debug                      # start with verbose console output

# ── Inspect / verify (no writes) ───────────────────────────────────
npm run feeder:dev -- --validate-only                        # load + validate the config and exit
npm run feeder:dev -- --scan                                 # scanner + enricher only, HTTP (verify connectivity)
npm run feeder:dev -- --scan --transport ws                  # same over WebSocket — requires DIA_WS_CREDENTIAL_*
npm run feeder:dev -- --dry-run                              # full pipeline, no-op write-client (no txs, no fees)
npm run sanity:feeds                                         # per-feed accuracy check: on-chain value vs latest DIA source → report under docs/.../evidence

# ── Scanner checkpoint (run while the daemon is stopped) ───────────
npm run feeder:dev -- checkpoint get                         # show the persisted checkpoint + next scan block
npm run feeder:dev -- checkpoint set --from-latest           # jump to chain tip — scan only new intents
npm run feeder:dev -- checkpoint set --from-block 7800000    # set an explicit block
npm run feeder:dev -- checkpoint set --clear                 # reset to the YAML start_block

# ── Clean up state ─────────────────────────────────────────────────
npm run feeder:dev -- reset                                  # wipe ALL runtime state (DB + logs + pairs) and exit
npm run feeder:dev -- prune --dry-run                        # preview an age-based prune, delete nothing
npm run feeder:dev -- prune                                  # prune rows/logs older than 1h (default), keep DB
npm run feeder:dev -- prune --max-age 30m                    # prune anything older than 30 minutes
```

> The daemon always runs both HTTP polling and (if `ws_url` is configured)
> a WebSocket transport — there is no `--transport` flag for the daemon.
> `--transport` only applies to `--scan`.

The active network (Cardano Preview ↔ DIA Testnet, Cardano Mainnet ↔
DIA Mainnet) is selected by `CARDANO_NETWORK` in `.env`.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--config <dir>` | `./config` | Modular config directory |
| `--transport http\|ws` | `http` | Scanner transport |
| `--scan` | — | Scanner + enricher only — router/coalescer/write-client not started. Verify DIA registry connectivity. |
| `--dry-run` | false | Full pipeline with a no-op write-client — no Cardano txs, no fees. All logs and API run normally. Also `DRY_RUN=true` env |
| `--validate-only` | — | Load + validate config and exit |
| `--clean` | false | Delete feeder-generated state before starting (see below) |
| `--from-block <N>` | — | Seed the checkpoint to block N−1 before starting; scanner processes from block N onwards. Mutually exclusive with `--from-latest`. |
| `--from-latest` | false | Query the current chain tip and seed the checkpoint to that block; only intents arriving after startup are processed. Mutually exclusive with `--from-block`. |
| `--log-level debug\|info\|warn\|error` | `info` | Console verbosity (file always gets everything) |
| `--help` | — | Show help |

### `--log-level` — what each level shows

| Level | Console shows |
|---|---|
| `debug` | Everything — including `condition-filtered` (very noisy: one per non-matching intent, ~10/s), `policy-filtered`, scanner block deliveries, internal build/UTxO-fetch calls |
| `info` (default) | Daemon lifecycle, tx milestones (submitted, confirmed/failed), lane events |
| `warn` | Transaction failures, preflight rejections, reconcile warnings |
| `error` | Only TRANSACTION FAILED and fatal errors |

The log file (`feeder.log`) always receives all lines regardless of `--log-level`.
Level prefixes (`[debug]`, `[warn]`, `[error]`) are preserved in the file for
grep/filtering; they are stripped from console output.

### `--clean` flag / `reset` sub-command — what gets deleted

Both delete the exact same files — everything the feeder writes at runtime;
CLI bootstrap state files are never touched. The only difference is what
happens next: `--clean` (flag) wipes **then starts** the daemon, while
`reset` (sub-command) wipes **then exits**. For an age-based partial prune
that keeps the DB, use `prune` instead.

All paths below are inside the active run dir (`state/<network>_run_<id>/`,
selected by `RUN_ID`).

| Deleted | Reason |
|---|---|
| `<run>/logs/` | All log streams (feeder.log, transactions.jsonl, lane.jsonl, intents/) |
| `<run>/feeder.sqlite*` | Full DB reset — clears processed_events, chain_state (scanner position), transaction_log |
| `<run>/clients/*/pairs/*.json` | Feeder-written pair state — reconciled from live Cardano UTxOs on startup/update |

| Never deleted | Why |
|---|---|
| `<run>/config-bootstrap.json` | CLI state file (`config:bootstrap`) |
| `<run>/clients/*.json` | CLI state file (`receiver:bootstrap`) |

The block-scanner position is stored in `chain_state.last_scan_block` in the
SQLite/Postgres DB. `--clean` / `reset` reset it by removing the DB entirely.
`feeder prune --max-age` prunes old rows from `processed_events` and
`transaction_log` but never removes the DB file itself.

## Log streams

The feeder writes four separate log streams under the active run dir's logs
(`state/<network>_run_<id>/logs/`):

| File | Contents |
|---|---|
| `feeder.log` | Linear event stream — one line per daemon event (mirrors stderr) |
| `transactions.jsonl` | One JSON line per tx pipeline step in real time: `tx_start`, `connecting`, `building`, `signing`, `submitting`, `submitted` (with txHash), `waiting_confirm`, `waiting_utxo`, `writing_state`, `tx_confirmed`/`tx_failed`. Plus a final summary line with per-step ms timings. |
| `lane.jsonl` | Lane state events: `intent_buffered`, `intent_superseded`, `flush_triggered`, `flush_empty`, `tx_confirmed_reflush`, `lane_idle` |
| `intents/<ts>_<hash>.log` | Per-intent lifecycle: enriched → routed → queued → step-by-step → superseded OR confirmed OR failed |

## Environment

**Design rule:** the YAML config in `config/` is the single source of
truth for every public data point (chain ids, RPC URLs, WS URLs, registry
addresses, ABIs). `.env` carries only secrets and selectors.

The feeder's `.env` carries:

- **Selectors** — `CARDANO_NETWORK`, `CARDANO_PROVIDER`, `DRY_RUN`
- **Cardano-side secrets** — `BLOCKFROST_PROJECT_ID_*`,
  `BLOCKFROST_API_URL_*`, `KOIOS_API_URL_*`, `CARDANO_WALLET_SEED_*`,
  `CARDANO_PRIVATE_KEY_*`. By default the feeder signs with the single wallet in
  `CARDANO_WALLET_SEED_<NETWORK>`. To run a **pool** of signer wallets — so
  parallel lanes never contend for the same fee/collateral UTxO — add a
  `wallets:` block in `infrastructure.<network>.yaml` (one entry per wallet, each
  with a unique `id`, a `role` of `main` or `pool`, and a `private_key_env`) plus
  one env var per wallet here (e.g. `CARDANO_WALLET_SEED_MAINNET_POOL_1`). Exactly
  one `main` wallet — the on-chain PaymentHook withdraw target — funds the rest.
- **DIA-side secret** — `DIA_WS_CREDENTIAL_*` (WebSocket transport only)
- **Feeder daemon ops** — `API_LISTEN_ADDR`, `METRICS_ENABLED`,
  `METRICS_NAMESPACE`, `DATABASE_DRIVER`, `DATABASE_PATH_*`,
  `DATABASE_DSN_*`, `FEEDER_LOG_DIR`, `INTENT_INJECT_POLL_MS` (drop-dir poll
  cadence for [intent injection](#fault-drill-intent-injection); default 2000 ms)

Variables that live in YAML (not in `.env`):

| Variable | Lives in |
|---|---|
| `DIA_SOURCE_CHAIN_ID_*` | `config/infrastructure.<network>.yaml::source.chain_id` |
| `DIA_RPC_URL_*` | `config/infrastructure.<network>.yaml::source.rpc_urls` |
| `DIA_WS_URL_*` | `config/infrastructure.<network>.yaml::source.ws_url` |
| `DIA_REGISTRY_ADDRESS_*` | `config/contracts.yaml::<id>.address` |

The scanner's starting block is controlled by three mechanisms, in priority order:

1. **`--from-latest` / `--from-block N`** — seed the checkpoint at startup. Use these after `--clean` to avoid replaying weeks of already-expired intents.
2. **Persisted checkpoint** — `chain_state.last_scan_block` in the DB stores the last processed block; the scanner resumes from that block+1 on restart.
3. **YAML `source.start_block`** — the fallback when no DB row exists yet (e.g. first run after `--clean` without `--from-*`).

## Database

The feeder uses SQLite (default) or Postgres for scanner, transaction, alert,
and metric history. Confirmed Cardano pair snapshots also live in the active
run dir under `<run>/clients/*/pairs/*.json`. On startup the daemon reconciles
those pair-state files with live Cardano UTxOs, hydrates `priceCache` and
last-confirmed metrics from them, and only then starts cron.

The sqlite DB path is derived from the active per-run state dir
(`<run>/feeder.sqlite`); the `DATABASE_PATH_<NETWORK>` env var overrides it. For
Postgres set `database.driver: postgres` and supply `DATABASE_DSN_<NETWORK>`.

### Schema — 6 tables

| Table | Purpose |
|---|---|
| `processed_events` | Dedup and pipeline audit for source-chain events. Prevents reprocessing the same `intentHash` after a reconnect or restart. |
| `chain_state` | Scanner position (`last_scan_block`) and health flags. Updated after every confirmed scan range. |
| `transaction_log` | Full pending → submitted → confirmed → failed lifecycle for every Cardano tx, including `txHash`, error codes, and latency breakdowns. |
| `contract_symbol_updates` | Latest confirmed value per `(chain, contract, symbol)`, upserted on every confirmation — for Cardano: `chain` = network magic, `contract` = the client's pair validator address, `symbol` = the pair. Stores `last_price`, `last_timestamp`, `last_nonce`, intent/tx hash, `update_count`, and fee. Runtime cold-start hydration of the price cache uses the reconciled pair-state files (so the cron and policy gate see the same on-disk Cardano state); `last_nonce` is the persistent backing for the cron's monotonic-nonce baseline. |
| `performance_metrics` | Persistent counters (event totals, confirmed tx counts, latencies) that survive restarts. Used by the evidence-pack scripts to produce aggregate statistics. |
| `alert_log` | Alert firing history recorded via the Alertmanager webhook (Prometheus → Alertmanager → feeder webhook → `alert_log`). Includes `acknowledged` and `resolved` state. Queryable via `GET /api/v1/alerts`. |

`feeder prune --max-age <duration>` prunes old rows from `processed_events`
and `transaction_log` (keeps recent rows). It never deletes the DB file or
removes `chain_state` / `contract_symbol_updates` rows.

## Config layout

```text
config/
├── infrastructure.preview.yaml     # source RPC/WS, scanner, dedup, API, DB (Preview ↔ DIA Testnet)
├── infrastructure.mainnet.yaml     # same shape for Mainnet ↔ DIA Mainnet
├── chains.yaml                     # DIA Testnet/Mainnet chain definitions
├── contracts.yaml                  # OracleIntentRegistry per network (ABI + address)
├── events.yaml                     # IntentRegistered ABI + getIntent enrichment
└── routers/                        # network-scoped: only the active network's folder loads
    ├── preview/
    │   └── client-a-router-default.yaml  # router YAML; may point to a shared Cardano client deployment
    └── mainnet/                    # one or more routers per network
```

A router YAML is not a Cardano client by itself. It points to a Cardano client
deployment through `cardano.client_state_path` and `cardano.protocol_state_path`. Create
another router when you need another off-chain symbol/policy group; create another
on-chain client deployment only when you need a separate Receiver balance, deposit
address, pair namespace, or lane throughput.

### Validation

Every YAML is checked at load time. A subset of what the validator catches:

- destination declares both `method:` (EVM) and `cardano:`, or neither
- destination declares an EVM `method:` block (this feeder is Cardano-only)
- router referencing an undefined event in `events.yaml`
- unknown `triggers.conditions[].operator`
- `cardano:` block with invalid `network` or missing
  `client_state_path` / `protocol_state_path`
- two enabled routers sharing one lane while declaring overlapping symbols
- non-conventional `private_key_env` name (warning)

Run `npm run feeder:dev -- --validate-only` to see the full report.

### `event_processor` knobs

Read from `infrastructure.<network>.yaml::event_processor`:

| Key | Meaning |
|---|---|
| `coalesce_window` | Initial accumulation window before the first flush in an idle lane |
| `max_intent_age` | Drop buffered intents older than this when the lane flushes |
| `max_batch_size` | Hard cap on symbols included in one Cardano batch update tx |
| `size_fallback_enabled` | When `true`, split an oversized batch into smaller retries automatically |
| `enable_parallel_mode` | (reserved) Enable parallel enrichment pipeline — not yet active |

### `block_scanner` knobs

| Key | Meaning |
|---|---|
| `scan_interval` | Idle wait between polling ticks when caught up to HEAD |
| `block_range` | Max blocks per `eth_getLogs` request (default 500) |
| `confirmations` | Source blocks kept behind the tip before a range is treated as final |
| `max_block_gap` | Block distance that triggers backward-sync mode |
| `backward_sync` | When `true`, switch to 5000-block chunks and skip `scan_interval` until caught up |

### `worker_pool` knobs

| Key | Meaning |
|---|---|
| `retry_delay` | Wait between consecutive submission retries |
| `max_retries` | Give up after this many consecutive failures for one intent |
| `inflight_timeout_ms` | Max ms a submitted tx holds the lane lock before it is considered stuck |

### `cron_service` knobs

| Key | Meaning |
|---|---|
| `enabled` | Master switch for the periodic resubmission loop |
| `tick_interval` | How often the cron service inspects every cron-enabled destination |
| `aligned_heartbeat` | When `true`, the heartbeat fires on a shared `time_threshold` boundary so all pairs become due together and coalesce into one batch (fewer, fuller txs); per-pair cadence when `false`. Only affects `time_threshold` destinations. |

### `api` knobs

| Key | Meaning |
|---|---|
| `enable_cors` | Set `true` only when the API is consumed directly from a browser |
| `debug_enabled` | Expose extra diagnostic endpoints (not for production) |

### Code-level defaults

The fallback a knob takes when its YAML/env value is absent — plus fixed
code-level constants (retry/backoff curve, cache sizes, API rate limits,
pagination caps, the metrics namespace) — all live in one file:
[`src/config/constants.ts`](./src/config/constants.ts), grouped by domain
with a docstring per constant. Config-sourced values are **not** duplicated
there: `infrastructure.<network>.yaml`, `.env`, and
`state/<network>/config-bootstrap.json` stay authoritative; `constants.ts`
holds only the code-level defaults the modules import.

## HTTP API

The daemon exposes a lightweight HTTP API (default `0.0.0.0:8080`):

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness alias |
| `GET /health/live` | Liveness — always 200 if the process is running |
| `GET /health/ready` | Readiness — 200 only if last registry poll is within `max_processing_lag` |
| `GET /metrics` | Prometheus metrics (requires `METRICS_ENABLED=true`) |
| `GET /api/v1/prices` | Latest confirmed prices per `(routerId, destinationIndex, symbol)` |
| `GET /api/v1/prices/:symbol` | Latest confirmed prices for one symbol across destinations |
| `GET /api/v1/symbols` | Symbols declared in the active router YAMLs |
| `GET /api/v1/symbols/:symbol/updates` | Recent joined transaction rows for one symbol |
| `GET /api/v1/transactions/:txHash` | Enriched view of one Cardano tx and its member intents |
| `GET /api/v1/chains` | Source-chain status from YAML + runtime state |
| `GET /api/v1/chains/:id/status` | One chain status entry |
| `GET /api/v1/alerts` | Active and recent alerts from the `alert_log` DB table |

### What "confirmed" means

Every entry returned by `/api/v1/prices` carries a `confirmedAtDepth` field — the
number of Cardano blocks observed before the feeder declared the tx confirmed.
That depth is `cardano.confirmation_depth` in
`config/infrastructure.<network>.yaml` (default `1`): the feeder waits for that
many blocks before emitting `tx_confirmed`, updating the price cache, and
recording the event in the DB.

| `confirmation_depth` | Meaning |
| --- | --- |
| `1` (default) | Observed in one block. Probabilistically final and sufficient for a price oracle feed. |
| `3`–`5` | Practical finality for most DeFi integrations. |
| `2160` | Cryptographic security bound. Never needed for oracle feeds. |

For the Cardano finality / reorg model behind these numbers (Ouroboros Praos,
how the feeder detects a rollback, the `ReorgCounter` panel), see
[Architecture (see also)](#architecture-see-also).

## Thresholds and alerts

### How alerts work — one pipeline

Every alert flows through a single path, so a firing condition reaches both the
queryable record and (optionally) a human:

```
feeder emits metrics → Prometheus evaluates monitoring/alerts.yml
  → Alertmanager (groups · deduplicates · silences)
      ├─ webhook → feeder POST /api/v1/alerts/ingest → alert_log (GET /api/v1/alerts) + logs   [always on]
      └─ Telegram / email                                                                        [off by default]
```

**All** rules (including `OraclePairStale`) are Prometheus rules; Alertmanager's
webhook records them in `alert_log`. Alertmanager runs under the `monitoring`
profile on port **9093** (its own UI at http://localhost:9093) and is wired
automatically; the log + DB path needs no configuration.

**Notifications (Telegram / email) — off by default.** Turn a channel on in
`infrastructure.<network>.yaml::notifications` (`enabled: true` + chat id /
recipients) and put its secret in `feeder/.env`
(`ALERTMANAGER_TELEGRAM_BOT_TOKEN` / `ALERTMANAGER_SMTP_PASSWORD`); the generator
writes it into the generated `monitoring/alertmanager.yml`. Until then, alerts go
only to the logs + DB.

**Fire an alert on demand (testing / demo).** With the stack up
(`make up MONITORING=1`), `scripts/monitoring/trigger-alert.sh <AlertName>` makes one
alert fire for real. It pushes a synthetic value for that alert's metric to a
**Pushgateway** (port 9091, `monitoring` profile) that Prometheus scrapes; the value
crosses the **real** threshold from `alerts.yml`, so the genuine rule fires and runs the
whole pipeline above (Alertmanager → webhook → `alert_log` → notifications). Only the one
input metric is synthetic — the rules and routing are the production ones. The pushed
series carries its own labels (`client_id="trigger"`), so it stands alongside the feeder's
real metrics and the alert stays firing until you `clear` it. Watch it land and reset:

```sh
scripts/monitoring/trigger-alert.sh list                 # supported alerts
scripts/monitoring/trigger-alert.sh OraclePairStale      # fire one
curl -s localhost:9090/api/v1/alerts                     # Prometheus: pending → firing
curl -s localhost:8080/api/v1/alerts                     # feeder alert_log (recorded via the webhook)
scripts/monitoring/trigger-alert.sh clear                # remove the pushed value → alert resolves
```

### Alert thresholds — single source of truth

Operational thresholds live in ONE place: `infrastructure.<network>.yaml::alerting.<key>`,
which the feeder code reads directly. `monitoring/alerts.yml` (Prometheus rules),
`monitoring/alertmanager.yml`, and the Grafana panel thresholds are **generated
from that YAML** by `make generate-monitoring` (run automatically before
`make up`). Do **not** hand-edit the generated files — change the YAML and
regenerate.

**Enforced — they cannot drift silently.** `src/config/__tests__/threshold-drift.test.ts`
(run by `npm test`, or on demand with `make check-thresholds`) fails if any
generated `expr` or Grafana panel threshold diverges from the YAML, if the two
network YAMLs disagree, or if a dashboard template variable is left dead.

### Client funding (side-deposits)

A client tops up its Receiver by sending an ordinary wallet ADA payment to its
per-client deposit address — no CLI, no datum, just a normal send. The daemon
then folds those accumulated deposits into the Receiver balance automatically.

On top of the threshold-driven standalone merge, the feeder also folds up to
`configState.depositMaxPerUpdateFold` confirmed deposits into the oracle update
it is already submitting (best-effort — if the combined transaction fails it
falls back to a plain update). A top-up thus rides along on an update that
happens anyway, reducing the number of standalone merges; the standalone merge
stays for bulk sweeps.

You control **when** the daemon merges with two thresholds in
`infrastructure.<network>.yaml::alerting`:

| Key | What it does | Default |
| --- | --- | --- |
| `receiver_balance_low_lovelace` | Merge pending deposits once the Receiver balance falls below this | `2 000 000` (2 ADA) |
| `deposit_pending_merge_lovelace` | Merge once the pending deposit pile reaches this, regardless of the Receiver balance | `5 000 000` (5 ADA); optional — omit to disable this arm |

For the merge mechanism, how a merge and an oracle update on the same Receiver
stay mutually exclusive (lane concurrency), and the deposit floor / per-merge
cap that come from the CLI protocol state, see
[Architecture (see also)](#architecture-see-also) →
[Client funding: side-deposit address + merge](../../docs/architecture/feeder.md#client-funding-side-deposit-address--merge).

**Units convention**: balances are **lovelace** (1 ADA = 1 000 000
lovelace). Time intervals are **seconds** (or `_ms` for milliseconds).
Price deviation is **percent** (0–100).

### Full alert map

| Alert | Metric | YAML key | Default | Action |
| --- | --- | --- | --- | --- |
| `OraclePairStale` | `dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds` | `oracle_pair_stale_seconds` | `3600` s | Check `make logs`; usually a low Receiver or Admin wallet. |
| `ReceiverBalanceLow` | `dia_bridge_cardano_receiver_balance_lovelace` | `receiver_balance_low_lovelace` | `2 000 000` (2 ADA) | Send ADA to the alert's `deposit_address`; the feeder folds it into Receiver balance automatically. Operator fallback: `receiver:top-up`. |
| `SettleOverdue` | `dia_bridge_cardano_receiver_accrued_lovelace` | `settle_overdue_lovelace` | `10 000 000` (10 ADA) | `make cli CMD="settle --protocol-state /app/offchain/state/preview_run_<id>/config-bootstrap.json --client-state /app/offchain/state/preview_run_<id>/clients/<client>.json"` |
| `PaymentHookWithdrawReady` | `dia_bridge_cardano_payment_hook_accrued_lovelace` | `payment_hook_withdraw_ready_lovelace` | `50 000 000` (50 ADA) | `make cli CMD="payment-hook:withdraw --amount-lovelace <lovelace> --protocol-state /app/offchain/state/preview_run_<id>/config-bootstrap.json"` |
| `AdminWalletLow` | `dia_bridge_cardano_admin_wallet_lovelace` | `admin_wallet_low_lovelace` | `5 000 000` (5 ADA) | Collect protocol revenue into this wallet: `settle` then `payment-hook:withdraw` (the withdraw_address is this wallet). Only if there is no accrued revenue, fund the address in `state/<net>_run_<id>/config-bootstrap.json` externally (Preview: faucet). |
| `AdminWalletFragmented` | `dia_bridge_cardano_admin_wallet_max_utxo_lovelace` | `admin_wallet_min_collateral_lovelace` | `10 000 000` (10 ADA) | The wallet's **largest** pure-ADA UTxO fell below the collateral floor — no UTxO can back collateral and builds trap, even if the total looks fine. The daemon auto-consolidates below `auto_consolidate_below_lovelace`; to force it: `make cli CMD="wallet:consolidate"`. |
| `PriceDeviationHigh` | `dia_bridge_price_deviation_percent_bucket` (p95) | `price_deviation_high_percent` | `5` % | Investigate DIA source — possible misreport. |
| `PriceAgeHigh` | `dia_bridge_price_age_seconds_bucket` (p95) | `price_age_high_seconds` | `600` s | DIA source publishing stale prices for a **routed** pair (the metric is scoped to symbols this feeder publishes, not every scanned symbol). |
| `ReorgRateHigh` | `dia_bridge_transactions_reorg_total` | `reorg_rate_high_per_hour` | `> 3 / 1 h` | Check provider lag + scanner block-lag panel. |
| `ReceiverDepositsPending` | `dia_bridge_cardano_deposit_pending_lovelace` | `deposit_pending_merge_lovelace` | `5 000 000` (5 ADA) | Un-merged client deposits waiting; the daemon auto-merges. Operator fallback: `make cli CMD="deposit:merge --protocol-state /app/offchain/state/preview_run_<id>/config-bootstrap.json --client-state /app/offchain/state/preview_run_<id>/clients/<client>.json"`. |
| `PrimaryProviderDown` | `dia_bridge_provider_last_ok_timestamp_seconds{role="primary"}` | `provider_primary_unhealthy_seconds` | `600` s | **Critical** — the build/submit provider (selected by `CARDANO_PROVIDER`) is down → nothing builds, every pair freezes. Often a Blockfrost `402` (quota). Rotate `BLOCKFROST_PROJECT_ID_<NET>` / `KOIOS_API_URL_<NET>` in `feeder/.env` or switch `CARDANO_PROVIDER`, then `make restart`. |
| `SecondaryProviderDown` | `dia_bridge_provider_last_ok_timestamp_seconds{role="secondary"}` | `provider_secondary_unhealthy_seconds` | `900` s | **Warning** — the confirmation/reorg redundancy provider is down; core operation continues. Fix/rotate its endpoint in `feeder/.env`, then `make restart`. |
| `ProviderRequestQuotaHighBlockfrost` | `dia_bridge_provider_requests_total{provider="Blockfrost"}` | `provider_request_quota_per_day_blockfrost` × `provider_request_quota_warn_ratio` | `40 000` (`50 000` × `0.8`) | **Warning, proactive** — 24 h Blockfrost requests approaching the plan quota, **before** the `402` wall. Rotate to a higher-quota `BLOCKFROST_PROJECT_ID_<NET>` / upgrade the plan / switch `CARDANO_PROVIDER`, then `make restart`. If usage is legitimate, raise the YAML quota to your plan and `make generate-monitoring`. |
| `ProviderRequestQuotaHighKoios` | `dia_bridge_provider_requests_total{provider="Koios"}` | `provider_request_quota_per_day_koios` × `provider_request_quota_warn_ratio` | `40 000` (`50 000` × `0.8`) | **Warning, proactive** — same, for the Koios (secondary) provider. Point `KOIOS_API_URL_<NET>` at a higher-quota endpoint, then `make restart`. |
| `ProviderQuotaWall` | `dia_bridge_provider_requests_total{outcome="quota_exceeded"}` | — (fixed: any `402` in 5 m) | n/a | **Critical, hard backstop** — a provider returned `402 Payment Required`; its quota is exhausted and every build/submit through it fails. Rotate/upgrade the key, then `make restart`. Fires immediately, ahead of `PrimaryProviderDown`. |
| `ProviderErrorRateHigh` | `dia_bridge_provider_requests_total{outcome=~"error\|rate_limited"}` (÷ total) | `provider_error_rate_warn_ratio` | `0.2` (20 %) | **Warning** — >20 % of a provider's requests failed/throttled (`429`) over 10 m; a rising `429` share warns the key nears its ceiling. Inspect `sum by (outcome) (...)`; upgrade/rotate the key or switch provider. |
| `FeedAccuracyFail` | `dia_bridge_feed_sanity_status` | — (fixed: status `2` = broken, sustained 10 m) | n/a | The on-chain value for a feed both diverged from the latest DIA source beyond tolerance AND went stale — the per-feed sanity check rated it BROKEN. Inspect with `npm run sanity:feeds` or `GET /api/v1/alerts`; confirm the feeder still publishes that pair and the source delivers fresh intents. Not a wallet issue. |

### Operational wallets at a glance

The feeder emits four balance gauges, one per operational wallet involved
in the oracle update flow:

| Gauge | Wallet | Behaviour |
| --- | --- | --- |
| `dia_bridge_cardano_receiver_balance_lovelace{client_id,receiver_address,deposit_address}` | Per-client Receiver UTxO `balanceLovelace` | Drains by `protocolFee` per oracle update. Fund the labelled `deposit_address` when low; the feeder auto-merges/folds it into the Receiver. |
| `dia_bridge_cardano_receiver_accrued_lovelace{client_id}` | Per-client Receiver UTxO `accruedToHookLovelace` | Grows by `protocolFee` per oracle update. Settle drains it to the PaymentHook. |
| `dia_bridge_cardano_payment_hook_accrued_lovelace` | Singleton PaymentHook `accruedFeesLovelace` (DIA-managed) | Grows on each `settle`. DIA withdraws via `payment-hook:withdraw`. |
| `dia_bridge_cardano_admin_wallet_lovelace` | Operator/signer wallet (off-chain) — total | Pays Cardano tx fees for every oracle update. Receives PaymentHook withdrawals. |
| `dia_bridge_cardano_admin_wallet_max_utxo_lovelace` | Operator/signer wallet — **largest pure-ADA UTxO** | The collateral signal: a script tx needs a collateral UTxO distinct from its fee inputs, so this — not the total — says whether the wallet can build. Below `admin_wallet_min_collateral_lovelace` the wallet is fragmented; the daemon auto-consolidates. |

All four are refreshed two ways: (1) post-confirm, right after each
`tx_confirmed`, and (2) on a periodic **balance-refresh poll** that runs
independently of oracle-update traffic (read-only, on the
`cron_service.tick_interval` cadence, default 30 s). The poll exists so the
dashboard shows real balances even when no update is flowing — e.g. when a
Receiver is empty and updates are stalled, you can still see the Admin wallet
and PaymentHook balances. A transient provider failure leaves an individual
gauge unchanged (no misleading 0).

### Automatic fee-loop maintenance (settle / withdraw / consolidate)

The admin/signer wallet drains as it pays Cardano fees; it is refilled by collecting
protocol revenue (`settle`: Receiver accrued → PaymentHook; `payment-hook:withdraw`:
PaymentHook → admin wallet). The daemon runs this loop **itself** on the balance-refresh
poll, each step as a serial lane task (mutually exclusive with updates on the same
Receiver). Each automatic threshold sits **beyond** its paired alert, so the **alert
fires first and the automatic step only follows** — enforced by the `threshold-drift`
test. Each `auto_*` key is optional; unset disables that step.

| Key | Default | Acts when | Paired alert (fires first) |
| --- | --- | --- | --- |
| `auto_settle_lovelace` | `30 000 000` (30 ADA) | Receiver accrued ≥ this → auto `settle` | `SettleOverdue` (10 ADA) |
| `auto_withdraw_lovelace` | `100 000 000` (100 ADA) | PaymentHook accrued ≥ this → auto `payment-hook:withdraw` | `PaymentHookWithdrawReady` (50 ADA) |
| `auto_consolidate_below_lovelace` | `7 000 000` (7 ADA) | largest wallet UTxO < this → auto `wallet:consolidate` | `AdminWalletFragmented` (10 ADA) |

`wallet:consolidate` is also a manual command (`make cli CMD="wallet:consolidate"` /
`npm run cli -- wallet:consolidate [--max-inputs 60]`): a plain self-payment that folds
the wallet's dust into one **dedicated collateral UTxO** + working balance. It needs no
collateral to build, so it recovers even an all-dust wallet. Full rationale (the fee loop,
the fragmentation failure, the alert→automatic ordering, and the WASM self-heal) is in
[Architecture → Fee loop & automatic maintenance](../../docs/architecture/feeder.md#fee-loop--automatic-maintenance-settle--withdraw--consolidate)
and the [at-a-glance table](../../docs/architecture/feeder.md#alerts--automatic-remediation--at-a-glance).

### Provider health (primary vs secondary)

The feeder reaches Cardano through **two** API providers, with roles set by
`CARDANO_PROVIDER`: a **primary** (the build/submit provider lucid uses for everything)
and a **secondary** (confirmation/reorg redundancy). A primary outage — classically a
Blockfrost `402 Payment Required` quota wall — freezes **every** pair at once; a secondary
outage only loses redundancy. The daemon emits, per `{provider, role}`,
`dia_bridge_component_health` (1/0) and `dia_bridge_provider_last_ok_timestamp_seconds`
(the alert signal). The primary is measured passively from the balance-refresh calls (no
extra provider load); the secondary is probed actively once per tick. Because the alerts
key off **role**, they always track whichever provider actually builds — see
`PrimaryProviderDown` / `SecondaryProviderDown` above. The primary also gates
`/health/ready` (component `cardano_provider`).

> **`NonMonotonicNonce` is not a failure.** When a newer intent already won on chain the
> feeder declines to submit (no tx, no fee). Those are counted in
> `dia_bridge_intents_superseded_total{reason}` and logged at info as `intent superseded
> (no tx)` — **not** in `transactions_failed_total` / the `TRANSACTION FAILED` log — so the
> failure counters and the dashboard success ratio reflect only real failures.

## Architecture (see also)

This README covers **operating** the feeder. For **how it works** and **why it
diverges from its EVM ancestor (Spectra)**, see the architecture guides — kept in
one place so the deep detail does not drift across docs:

- [`docs/architecture/feeder.md`](../../docs/architecture/feeder.md) —
  plain-language walkthrough of the whole feeder pipeline (scanner → enricher →
  router → coalescer → queue → write-client), the persisted-state warm-up model,
  and concurrent HTTP + WebSocket transports. Notable anchors:
  - [Client funding: side-deposit address + merge](../../docs/architecture/feeder.md#client-funding-side-deposit-address--merge)
    — the deposit-merge mechanism and lane mutual-exclusion (concurrency).
  - [Confirmation depth (Cardano finality)](../../docs/architecture/feeder.md#11-confirmation-depth-cardano-finality)
    — the reorg / Ouroboros finality model behind `confirmation_depth`.
  - [Spectra parity and Cardano divergences (full table)](../../docs/architecture/feeder.md#spectra-parity-and-cardano-divergences-full-table)
    — the canonical parity disposition table.
- [`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md)
  — the formal architecture spec (on-chain contracts, UTxO model, transaction
  shapes, fee flow, and the feeder's DB/API/metrics).
