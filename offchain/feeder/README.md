# DIA Cardano Oracle Feeder

Long-running daemon that consumes `IntentRegistered` events from the DIA
`OracleIntentRegistry` (DIA Lasernet testnet or mainnet) and submits
matching Cardano oracle update transactions through the contracts
deployed by `offchain/cli/`.

The architecture mirrors
[`diadata-org/Spectra-interoperability/services/bridge`](https://github.com/diadata-org/Spectra-interoperability/tree/main/services/bridge):
modular YAML config, scanner → extractor → enricher → router →
write-client pipeline, per-key transaction queues, HTTP API for health
/ metrics / prices. The Cardano write-client is the only piece that
diverges substantively — it builds Cardano txs via the pure builders in
`offchain/cli/src/lib/` instead of EVM ABI calls.

## Contents

- [Directory guide](#directory-guide)
- [Service URLs — where to look (once it's running)](#service-urls--where-to-look-once-its-running)
- [Running with Docker](#running-with-docker)
  - [Compose services & profiles](#compose-services--profiles)
  - [Daemon only](#daemon-only)
  - [Daemon + monitoring](#daemon--monitoring)
  - [Capturing an operational snapshot](#capturing-an-operational-snapshot)
  - [Admin commands (CLI)](#admin-commands-cli)
  - [Operator setup — pick your scenario](#operator-setup--pick-your-scenario)
  - [Day-2 operations (Docker)](#day-2-operations-docker)
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
- [HTTP API](#http-api)
  - [What "confirmed" means](#what-confirmed-means)
- [Thresholds and alerts](#thresholds-and-alerts)
  - [Built-in alert evaluator](#built-in-alert-evaluator)
  - [Prometheus alert thresholds](#prometheus-alert-thresholds)
  - [Full alert map](#full-alert-map)
  - [Operational wallets at a glance](#operational-wallets-at-a-glance)
- [Architecture & Spectra parity](#architecture--spectra-parity)

## Directory guide

| Path | What's there |
| --- | --- |
| [`config/`](./config/README.md) | YAML configuration the feeder loads — infrastructure, chains, contracts, events, routers, pair selection. |
| [`scripts/`](./scripts/README.md) | Evidence-pack tooling (`make evidence`) and the on-chain pair-scan helper. |
| [`state/`](./state/README.md) | Per-network state: imported CLI artifacts (committed) + runtime DB/logs (gitignored). |
| `src/`, `cmd/` | The feeder daemon source (TypeScript). |

The deep architecture and the Spectra-parity table live in
[`docs/architecture/feeder.md`](../../docs/architecture/feeder.md) — see
[Architecture & Spectra parity](#architecture--spectra-parity) below.

## Service URLs — where to look (once it's running)

Start with `make up MONITORING=1` (feeder + Grafana + Prometheus) or
`make up` (feeder only), then open these in a browser. All are published
on `localhost`.

| What | URL | Up with |
| --- | --- | --- |
| **Grafana** dashboards | <http://localhost:3000> — login `admin` / `${GRAFANA_ADMIN_PASSWORD:-admin}` | `make up MONITORING=1` |
| **Prometheus** (raw metrics, alert state) | <http://localhost:9090> | `make up MONITORING=1` |
| Feeder **liveness** | <http://localhost:8080/health/live> | `make up` |
| Feeder **readiness** | <http://localhost:8080/health/ready> | `make up` |
| Feeder **metrics** (Prometheus scrape) | <http://localhost:8080/metrics> | `make up` |

Feeder HTTP API (all under `http://localhost:8080`):

| Endpoint | Shows |
| --- | --- |
| `/api/v1/prices` | Latest confirmed price per symbol |
| `/api/v1/prices/:symbol` | One symbol across destinations |
| `/api/v1/symbols` | Symbols from the active router YAMLs |
| `/api/v1/transactions` | Recent Cardano submissions |
| `/api/v1/transactions/:txHash` | One tx + its member intents |
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
[§ HTTP API](#http-api) below. Monitoring stack details are in
[§ Running with Docker](#running-with-docker).

## Running with Docker

The feeder and all CLI admin commands ship in **one image**
(`dia-cardano-feeder:local`). Docker is the recommended deployment method
because it bundles the compiled feeder, compiled CLI, and all native deps
(better-sqlite3, lucid-evolution) without any host-side Node setup.

All `make` targets below run from `offchain/` (where `Makefile` lives).
Run `make help` for a complete target list.
The Makefile exports your current host `UID`/`GID` so Docker can write to
the bind-mounted `offchain/feeder/state/` tree without leaving it
read-only to the daemon.

### Compose services & profiles

Everything runs from one image (`dia-cardano-feeder:local`) selected through Docker
Compose **profiles**. You normally drive these with `make` (below); this is the
underlying map.

| Service | Profile | What it is |
| --- | --- | --- |
| `feeder-sqlite` | `sqlite` | The feeder daemon with the **SQLite** backend (default). SQLite is an embedded file (`state/<network>/feeder.sqlite`) — **there is no database server**; the service *is* the feeder. |
| `feeder-postgres` | `postgres` | The **same** feeder daemon with the **PostgreSQL** backend. |
| `postgres` | `postgres` | A real PostgreSQL 15 server, started only under this profile (data in the `postgres-data` volume). |
| `cli` | `cli` | Short-lived admin container for one-off CLI commands (`make cli CMD="…"`). |
| `prometheus`, `grafana`, `renderer` | `monitoring` | The observability stack (`MONITORING=1`). |

Things worth knowing:

- `feeder-sqlite` and `feeder-postgres` are the **same image** — the suffix only picks
  the DB backend. Run **exactly one** (both publish port 8080).
- **SQLite needs no server** (it is just a file in the `state/` volume). **PostgreSQL**
  adds the `postgres` server container. SQLite is the default and is sufficient for
  single-instance deployments; Postgres is there for higher-scale / external-DB setups.
- Pick the backend with the make target: `make up` (SQLite, default) or
  `make up-postgres`. That sets `DATABASE_DRIVER`; the path/DSN come from `.env`
  (`DATABASE_PATH_*` for SQLite, `DATABASE_DSN_*` for Postgres), and the `database` block
  in `config/infrastructure.<network>.yaml` documents the knobs (see
  [`config/`](./config/README.md)).
- Profiles **compose**: `MONITORING=1` adds the `monitoring` profile on top of the
  feeder profile. `make down` stops every profile.

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

### Daemon + monitoring

`MONITORING=1` is a toggle on any start target (`up`, `up-postgres`,
`restart-latest`, `reset-restart`). With it, Prometheus + Grafana + the
renderer come up alongside the feeder; without it, only the feeder starts.
There is no separate `up-monitoring` target. Monitoring stays up until
`make down`.

```sh
cd offchain
make up MONITORING=1   # feeder-sqlite + Prometheus + Grafana + renderer
make up                # feeder only (monitoring untouched)
make down              # stops everything
```

- Prometheus: `http://localhost:9090` — raw metrics and alert state
  (`/alerts` shows the configured alert rules).
- Grafana: `http://localhost:3000` — default credentials
  `admin` / value of `GRAFANA_ADMIN_PASSWORD` in `.env` (defaults to
  `admin`). The **DIA Cardano Oracle Feeder** dashboard is pre-provisioned.
- Renderer: a `grafana/grafana-image-renderer` sidecar reachable to
  Grafana over the compose network at `http://renderer:8081/render`.
  Grafana is configured via `GF_RENDERING_SERVER_URL` (where to reach
  the renderer) and `GF_RENDERING_CALLBACK_URL` (how the renderer's
  headless Chrome calls back into Grafana to fetch the dashboard).
  Used by `GET /render/d/...` requests to produce PNG snapshots of the
  dashboard. The renderer adds no exposed port; access is only
  intra-compose.

To add a new alert rule, edit
`offchain/feeder/monitoring/alerts.yml` and restart Prometheus
(`docker compose restart prometheus`) — no Grafana changes needed.

### Capturing an operational snapshot

The `scripts/m2-evidence/` directory contains a script that packages a
feeder's current logs, DB tables, live API responses and Grafana
dashboard PNGs into a self-contained dated directory. Useful for
sharing a point-in-time deployment record with another team or
attaching to a release note. The script does not stop or restart the
feeder. See
[`scripts/README.md`](./scripts/README.md) for
the full description (inputs, outputs, dependencies, dashboard rendering).

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

# Inspect the shared state tree inside the container.
docker compose -f feeder/docker-compose.yml --project-directory feeder --profile cli run --rm --entrypoint sh cli -c "ls -R /app/state"
```

> **Always start/restart containers with `make`, never with `docker compose`
> directly.** The Makefile exports your host `UID`/`GID` so the container
> runs as your user and can write the bind-mounted `feeder/state/` tree.
> A bare `docker compose up` defaults to `1000:1000`, which may not match
> your user and leaves the SQLite DB read-only to the daemon
> (`attempt to write a readonly database`).

### Operator setup — pick your scenario

All commands run from `offchain/`. Pick the one that matches your machine.

**Scenario A — fresh machine, never ran the CLI.**
First do the full on-chain setup by following the CLI runbook:
[**Wallet Setup → Protocol Deployment → Client Deployment**](../cli/README.md#wallet-setup)
in `offchain/cli/README.md`. That produces the CLI state under
`offchain/cli/state/<network>/`. Then continue with Scenario B.

**Scenario B — CLI state already exists, feeder never started.**
Import the CLI state into the feeder and start:

```sh
make build             # only if the image isn't built yet
make init-bootstrap    # import config-bootstrap.json into feeder/state/
make init-client       # import client JSON + generate router YAML (interactive)
make checkpoint-latest # seed scanner to current chain tip (only new intents)
make up MONITORING=1   # start feeder + Prometheus + Grafana
```

**Scenario C — everything set up, just want clean logs + DB.**
The CLI state and router YAML already exist; you only want a fresh runtime:

```sh
make reset-restart   # stop → wipe DB+logs+pairs → reseed checkpoint → start
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
| `make init-bootstrap` | Import `config-bootstrap.json` from CLI state (`feeder init bootstrap`) |
| `make init-client` | Import client JSON + generate router YAML interactively (`feeder init client`) |
| `make checkpoint-get` | Print the current scanner checkpoint |
| `make checkpoint-latest` | Seed the checkpoint to the current chain tip (only new intents) |
| `make restart` | Restart the daemon with **no** data changes |
| `make restart-latest` | Restart skipping the backlog: reseed checkpoint to tip, **keep** DB + logs |
| `make reset` | Delete runtime state (DB + logs + pairs) and exit; keeps CLI bootstrap files |
| `make reset-restart` | Stop → `reset` → reseed checkpoint → start the daemon |
| `make prune` | Prune only **old** rows/logs (keeps DB). `make prune MAX_AGE=30m` |

### Volume layout

| Host / named volume | Container path | Used by | Contents |
| --- | --- | --- | --- |
| `./config/` | `/config` (ro) | feeder | Modular YAML config (read-only) |
| `./config/` | `/app/config` (rw) | cli | Modular YAML config (writable — router YAML is written during `make init-client`) |
| `.env` | env_file | feeder, cli | Secrets + selectors |
| `./state/` | `/app/state` | feeder, cli | Bootstrap JSON, pair state, logs, SQLite DB |
| `postgres-data` | (postgres svc) | postgres | Postgres data dir |
| `prometheus-data` | `/prometheus` | prometheus | Prometheus TSDB (metric retention) |
| `grafana-data` | `/var/lib/grafana` | grafana | Dashboard and alert state |

## Running locally (npm)

Run the feeder directly on your machine, without Docker. Requires
**Node.js 22+** and the toolchain to build the native deps
(`better-sqlite3`, `lucid-evolution`). Everything below runs from
`offchain/feeder/`. This is the **mirror** of the Docker path above — pick
one or the other, do not mix them.

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
the CLI state under `offchain/cli/state/<network>/`. Then continue with
Scenario B.

**Scenario B — CLI state already exists, feeder never started.**
Import the CLI state into the feeder and start:

```sh
npm run feeder:dev -- init bootstrap              # import config-bootstrap.json
npm run feeder:dev -- init client                 # import client JSON + router YAML
npm run feeder:dev -- checkpoint set --from-latest  # seed scanner to chain tip
npm run feeder:dev                                # start the daemon
```

**Scenario C — everything set up, just want clean logs + DB.**
One command wipes the runtime state, reseeds the checkpoint, and starts:

```sh
npm run feeder:dev -- --clean --from-latest
```

The feeder needs two bootstrap files from the CLI; `init` copies them in:

| Artifact | Produced by CLI command |
| --- | --- |
| `state/<network>/config-bootstrap.json` | `config:bootstrap` |
| `state/<network>/clients/<id>.json` | `receiver:bootstrap` |

`init` auto-scans `../cli/state/` for the latest matching network run; use
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
# ── Import CLI state ───────────────────────────────────────────────
npm run feeder:dev -- init bootstrap                         # auto-scan ../cli/state/ for config-bootstrap.json
npm run feeder:dev -- init bootstrap --from ../cli/state/preview_run_20260516-090057  # explicit source
npm run feeder:dev -- init bootstrap --force                 # overwrite without prompting
npm run feeder:dev -- init client                            # auto-scan + interactive router YAML wizard
npm run feeder:dev -- init client --from ../cli/state/preview_run_20260516-090057/clients/client-a.json
npm run feeder:dev -- init client --force                    # overwrite without prompting

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
| `--from-latest` | false | Query the current chain tip via RPC and seed the checkpoint to that block; only intents arriving after startup are processed. Mutually exclusive with `--from-block`. |
| `--log-level debug\|info\|warn\|error` | `info` | Console verbosity (file always gets everything) |
| `--help` | — | Show help |

### `--log-level` — what each level shows

| Level | Console shows |
|---|---|
| `debug` | Everything — including `condition-filtered` (very noisy: one per non-matching intent, ~10/s), `policy-filtered`, scanner block deliveries (`scanner-ws: delivered N log(s)`), bridge internal calls (connecting, building, UTxO fetches) |
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

| Deleted | Reason |
|---|---|
| `state/<network>/logs/` | All log streams (feeder.log, transactions.jsonl, lane.jsonl, intents/) |
| `state/<network>/feeder-checkpoint.json` | Stale file from an older run — deleted if present; scanner position is now stored in the DB (`chain_state` table) |
| `state/<network>/feeder.sqlite*` | Full DB reset — clears processed_events, chain_state (scanner position), transaction_log |
| `state/<network>/clients/*/pairs/*.json` | Feeder-written pair state — reconstructed from chain on next update |

| Never deleted | Why |
|---|---|
| `state/<network>/config-bootstrap.json` | CLI state file (`config:bootstrap`) |
| `state/<network>/clients/*.json` | CLI state file (`receiver:bootstrap`) |

The block-scanner position is stored in `chain_state.last_scan_block` in the SQLite/Postgres DB.
`--clean` / `reset` reset it by removing the DB entirely. `feeder prune --max-age` prunes old rows
from `processed_events` and `transaction_log` but never removes the DB file itself.

## Log streams

The feeder writes four separate log streams under `state/<network>/logs/`:

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
  `CARDANO_PRIVATE_KEY_*`
- **DIA-side secret** — `DIA_WS_CREDENTIAL_*` (WebSocket transport only)
- **Feeder daemon ops** — `API_LISTEN_ADDR`, `METRICS_ENABLED`,
  `METRICS_NAMESPACE`, `DATABASE_DRIVER`, `DATABASE_PATH_*`,
  `DATABASE_DSN_*`, `FEEDER_LOG_DIR`

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

The feeder uses SQLite (default) or Postgres as its single source of truth for
all persistent state. Every table survives restarts; in-memory caches are
seeded from the DB on startup.

The DB path is set by `database.path` in `infrastructure.<network>.yaml` or
overridden by the `DATABASE_PATH_<NETWORK>` env var. For Postgres set
`database.driver: postgres` and supply `DATABASE_DSN_<NETWORK>`.

### Schema — 6 tables

| Table | Purpose |
|---|---|
| `processed_events` | Dedup and pipeline audit for source-chain events. Prevents reprocessing the same `intentHash` after a reconnect or restart. |
| `chain_state` | Scanner position (`last_scan_block`) and health flags. Replaces the old `feeder-checkpoint.json` file. Updated after every confirmed scan range. |
| `transaction_log` | Full pending → submitted → confirmed → failed lifecycle for every Cardano tx, including `txHash`, error codes, and latency breakdowns. |
| `contract_symbol_updates` | Last confirmed price per `(routerId, destinationIndex, symbol)`. Seeded into the in-memory `priceCache` at boot so the cron service and router policy gate work correctly after a restart. |
| `performance_metrics` | Persistent counters (event totals, confirmed tx counts, latencies) that survive restarts. Used by the evidence-pack scripts to produce aggregate statistics. |
| `alert_log` | Alert firing history written by the in-process alert evaluator (`src/alerting/evaluator.ts`). Includes `acknowledged` and `resolved` state. Queryable via `GET /api/v1/alerts`. |

`feeder cleanup --max-age <duration>` prunes old rows from `processed_events`
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
└── routers/
    └── client-a.preview.yaml       # 10 active DIA testnet pairs → one Cardano client
```

### Validation

Every YAML is checked at load time. A subset of what the validator catches:

- destination declares both `method:` (EVM) and `cardano:`, or neither
- destination declares an EVM `method:` block (this feeder is Cardano-only)
- router referencing an undefined event in `events.yaml`
- unknown `triggers.conditions[].operator`
- `cardano:` block with invalid `network` or missing
  `client_state_path` / `protocol_state_path`
- non-conventional `private_key_env` name (warning)

Run `npm run feeder:dev -- --validate-only` to see the full report.

### `event_processor` knobs

The lane coalescer reads these keys from `infrastructure.<network>.yaml::event_processor`:

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

### `api` knobs

| Key | Meaning |
|---|---|
| `enable_cors` | Set `true` only when the API is consumed directly from a browser |
| `debug_enabled` | Expose extra diagnostic endpoints (not for production) |

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

Every entry returned by `/api/v1/prices` carries a `confirmedAtDepth` field.
This is the number of Cardano blocks that elapsed between the tx's inclusion
block and the moment the feeder declared it confirmed — i.e. the value of
`cardano.confirmation_depth` in `infrastructure.<network>.yaml` (default `1`).

| `confirmedAtDepth` | Meaning |
| --- | --- |
| `1` (default) | The tx was observed in **one block** by at least one indexer provider (Blockfrost primary, Koios or Blockfrost REST as fallback). Probabilistically final: rollbacks beyond 1–2 blocks are essentially unobserved on mainnet. |
| `3`–`5` | Practical finality for most DeFi integrations. |
| `2160` | Cryptographic security bound (Ouroboros Praos, `k = 2160` blocks ≈ 12 hours). Never needed for oracle feeds. |

**Cardano finality model**: Cardano uses Ouroboros Praos. The maximum
theoretical rollback depth is `k = 2160` blocks (~12 hours at ~20 s/block).
In practice, rollbacks deeper than 1–2 blocks are not observed on mainnet.
For a price oracle feed, `confirmation_depth = 1` is practically sufficient.

To configure a stricter depth: set `cardano.confirmation_depth` in
`config/infrastructure.<network>.yaml`. The feeder waits for
`confirmation_depth` additional blocks before emitting `tx_confirmed`,
updating the price cache, and recording the event in the DB.

**Reorg handling**: in this feeder, a "reorg" means a Cardano rollback
where a transaction that had already looked confirmed is later no longer
present on the canonical chain.

The feeder detects this conservatively. After confirmation, and again
during the long post-confirmation UTxO wait loops, it checks the
transaction hash against **both** Koios and Blockfrost REST. It treats
the transaction as dropped only when **both** providers definitively
report it missing. A single provider outage, timeout, or transient
indexer lag does **not** count as a reorg.

When that happens, the feeder classifies the failure as
`TxDroppedFromChain`, increments
`dia_bridge_transactions_reorg_total{symbol, client_id}`, and applies
the normal queue retry policy for transient submission failures. If
retries are exhausted, the failure is recorded in the logs/metrics, and
a later fresh intent can produce a new Cardano transaction.

The `ReorgCounter` panel in Grafana therefore means: "transactions that
looked confirmed at first, but were later dropped from the canonical
chain after a rollback."

## Thresholds and alerts

### Built-in alert evaluator

The feeder runs an in-process alert evaluator loop (`src/alerting/evaluator.ts`)
that writes firing and resolved events to the `alert_log` DB table. Alerts are
readable at `GET /api/v1/alerts`.

Current rules:

| Rule | Fires when | Config key |
|---|---|---|
| `OraclePairStale` | A price-cache entry has not been refreshed within `pairStalenessThresholdMs` | `alerting.oracle_pair_stale_seconds` |
| `PriceDeviationHigh` | p95 of observed price deviation exceeds the threshold | `alerting.price_deviation_high_percent` |
| `ScannerLag` | The scanner has not processed a new block within the lag window | `alerting.max_processing_lag` |
| `WorkerQueueSaturated` | The submission queue depth exceeds the saturation threshold | (evaluator internal) |
| `TransactionFailureRateHigh` | The ratio of failed to total submissions exceeds the threshold | (evaluator internal) |

The evaluator runs on the same `evaluationIntervalMs` cadence as `cron_service.tick_interval`
(default 30 s). Prometheus alert rules in `monitoring/alerts.yml` cover additional
conditions that are threshold-evaluated externally via `PromQL`.

### Prometheus alert thresholds

Operational thresholds live in two places with explicit responsibilities:

- `infrastructure.<network>.yaml::alerting.<key>` — **canonical source**.
  The feeder code reads these values directly (e.g. to emit
  `dia_bridge_cardano_receiver_topup_warnings_total` when the receiver
  balance drops below `receiver_balance_low_lovelace`).
- `monitoring/alerts.yml` (Prometheus rules) — mirrors the YAML values
  in alert `expr` lines. Each rule carries an inline comment naming the
  YAML key so the two cannot drift silently. Operators tune thresholds
  in the YAML; if you change a number, update `alerts.yml` to match.

**Units convention**: balances are **lovelace** (1 ADA = 1 000 000
lovelace). Time intervals are **seconds** (or `_ms` for milliseconds).
Price deviation is **percent** (0–100).

### Full alert map

| Alert | Metric | YAML key | Default | Action |
| --- | --- | --- | --- | --- |
| `OraclePairStale` | `dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds` | `oracle_pair_stale_seconds` | `3600` s | Check `make logs`; usually a low Receiver or Admin wallet. |
| `ReceiverBalanceLow` | `dia_bridge_cardano_receiver_balance_lovelace` | `receiver_balance_low_lovelace` | `2 000 000` (2 ADA) | `make cli CMD="receiver:top-up --amount-lovelace 5000000 --protocol-state /app/state/preview/config-bootstrap.json --client-state /app/state/preview/clients/<client>.json"` |
| `SettleOverdue` | `dia_bridge_cardano_receiver_accrued_lovelace` | `settle_overdue_lovelace` | `10 000 000` (10 ADA) | `make cli CMD="settle --protocol-state /app/state/preview/config-bootstrap.json --client-state /app/state/preview/clients/<client>.json"` |
| `PaymentHookWithdrawReady` | `dia_bridge_cardano_payment_hook_accrued_lovelace` | `payment_hook_withdraw_ready_lovelace` | `50 000 000` (50 ADA) | `make cli CMD="payment-hook:withdraw --amount-lovelace <lovelace> --protocol-state /app/state/preview/config-bootstrap.json"` |
| `AdminWalletLow` | `dia_bridge_cardano_admin_wallet_lovelace` | `admin_wallet_low_lovelace` | `5 000 000` (5 ADA) | Collect protocol revenue into this wallet: `settle` then `payment-hook:withdraw` (the withdraw_address is this wallet). Only if there is no accrued revenue, fund the address in `state/<net>/config-bootstrap.json` externally (Preview: faucet). |
| `PriceDeviationHigh` | `dia_bridge_price_deviation_percent_bucket` (p95) | `price_deviation_high_percent` | `5` % | Investigate DIA source — possible misreport. |
| `PriceAgeHigh` | `dia_bridge_price_age_seconds_bucket` (p95) | `price_age_high_seconds` | `600` s | DIA source publishing stale prices. |
| `ReorgRateHigh` | `dia_bridge_transactions_reorg_total` | (alerts.yml only) | `> 3 / 1 h` | Check provider lag + scanner block-lag panel. |

### Operational wallets at a glance

The feeder emits four balance gauges, one per operational wallet involved
in the oracle update flow:

| Gauge | Wallet | Behaviour |
| --- | --- | --- |
| `dia_bridge_cardano_receiver_balance_lovelace{client_id}` | Per-client Receiver UTxO `balanceLovelace` | Drains by `protocolFee` per oracle update. Top-up needed when low. |
| `dia_bridge_cardano_receiver_accrued_lovelace{client_id}` | Per-client Receiver UTxO `accruedToHookLovelace` | Grows by `protocolFee` per oracle update. Settle drains it to the PaymentHook. |
| `dia_bridge_cardano_payment_hook_accrued_lovelace` | Singleton PaymentHook `accruedFeesLovelace` (DIA-managed) | Grows on each `settle`. DIA withdraws via `payment-hook:withdraw`. |
| `dia_bridge_cardano_admin_wallet_lovelace` | Operator/signer wallet (off-chain) | Pays Cardano tx fees for every oracle update. Receives PaymentHook withdrawals. |

All four are refreshed two ways: (1) post-confirm, right after each
`tx_confirmed`, and (2) on a periodic **balance-refresh poll** that runs
independently of oracle-update traffic (read-only, on the
`cron_service.tick_interval` cadence, default 30 s). The poll exists so the
dashboard shows real balances even when NO update is flowing — e.g. when a
Receiver is empty and updates are stalled, you can still see the Admin
wallet and PaymentHook balances. A transient provider failure leaves an
individual gauge unchanged (no misleading 0); the label-less gauges
(`admin_wallet`, `payment_hook_accrued`) stay absent until the first real
reading rather than reporting a default 0.

## Architecture & Spectra parity

The deep architecture — the full pipeline (scanner → enricher → router → coalescer →
queue → write-client), the DB-as-source-of-truth model, the concurrent HTTP + WebSocket
transports, and the **canonical Spectra-parity / Cardano-divergence table** — lives in
the architecture guide, so it stays in one place instead of drifting across docs:

- [`docs/architecture/feeder.md`](../../docs/architecture/feeder.md) — plain-language
  walkthrough of the whole feeder; the Spectra-parity disposition table is in
  [§15](../../docs/architecture/feeder.md#spectra-parity-and-cardano-divergences-full-table).
- [`docs/architecture/cardano-oracle-architecture.md`](../../docs/architecture/cardano-oracle-architecture.md)
  — the formal architecture spec (on-chain contracts, UTxO model, transaction shapes,
  fee flow, and the feeder's DB/API/metrics).

This README stays focused on **operating** the feeder (the sections above); the
architecture guide explains **how it works** and **why it diverges from Spectra**.
