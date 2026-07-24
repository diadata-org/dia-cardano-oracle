# DIA Cardano Oracle Docker Runbook

**Audience:** DIA operators recording the Milestone 4 demonstration or taking
over operation. **Scope:** reproducible Preview or Mainnet setup from a clean
clone, plus reuse of the verified deployment state already in this repository.

## Before You Start

The Docker workflow needs Git, Docker Engine with the Compose plugin, GNU Make,
Node.js 20+, npm, Aiken, curl, jq, sqlite3, and bash. Node and Aiken are used on
the host for monitoring generation, tests, the consumer demo, and evidence
packaging; the long-running feeder, indexer, and monitoring services run in
Docker.

Only one network stack may publish the configured host ports at a time. Stop the
active network with `make down` before changing `CARDANO_NETWORK`.

The state artifacts contain public deployment identifiers and operational
history. They do not contain Blockfrost keys, wallet seeds/private keys, DIA WebSocket
credentials, or Grafana passwords. A full writer deployment therefore requires
an appropriately funded and authorized wallet; an indexer-only inspection only
requires the selected network's provider configuration.

## Clean Clone Setup

```sh
git clone https://github.com/diadata-org/dia-cardano-oracle.git
cd dia-cardano-oracle

cp offchain/feeder/.env.example offchain/feeder/.env
cp offchain/cli/.env.example offchain/cli/.env

(cd offchain/feeder && npm ci)
(cd offchain/cli && npm ci)
(cd offchain/indexer && npm ci)
```

For Docker, the two environment files have separate responsibilities:

| File | Used by | Required values |
| --- | --- | --- |
| `offchain/feeder/.env` | feeder, indexer, monitoring, and CLI | `CARDANO_NETWORK`, Cardano provider credentials, wallet seed/private key, DIA WebSocket credential, DIA authorized public keys, and optional host ports/monitoring credentials. |
| `offchain/cli/.env` | CLI service only | `CARDANO_NETWORK`, Cardano provider credentials, wallet seed/private key, DIA source domain/RPC/registry values, DIA WebSocket credential, DIA authorized public keys, and the Preview demo signing key when a full Preview run is required. |

Set the same `CARDANO_NETWORK`, Cardano provider, provider credentials, and
operator wallet in both files. Use `Preview` for Cardano Preview and DIA Testnet;
use `Mainnet` for Cardano Mainnet and DIA Mainnet. Do not copy a Preview key to
Mainnet or vice versa.

The default public service ports are feeder `8080`, indexer `3001`, Grafana
`3000`, Prometheus `9090`, and Alertmanager `9093`. Change only the
`*_HOST_PORT` values in `offchain/feeder/.env` if those ports are occupied.

## Credentials and Variables

The public data points — Blockfrost/Koios API URLs, DIA RPC/WebSocket URLs, DIA
registry addresses and source chain ids, the DIA authorized *public* keys, the
EIP-712 domain, and the explorer URLs — ship already filled in the two
`.env.example` files. Only the secrets below start blank and must be supplied.
Each `*_TESTNET` value is for Preview and each `*_MAINNET` value for Mainnet; fill
only the active network's block.

| Variable | Set in | What it is | Source |
| --- | --- | --- | --- |
| `BLOCKFROST_PROJECT_ID_TESTNET` / `_MAINNET` | `feeder/.env` + `cli/.env` | Cardano chain-provider project id for the network | a Blockfrost account (blockfrost.io) |
| `CARDANO_WALLET_SEED_TESTNET` / `_MAINNET` | `feeder/.env` + `cli/.env` | seed phrase of the operator wallet that pays every oracle-update transaction | create with `make wallet`; fund from the Preview faucet (Preview) or with real ADA (Mainnet) |
| `DIA_WS_CREDENTIAL_TESTNET` / `_MAINNET` | `feeder/.env` + `cli/.env` | DIA price-feed WebSocket credential | DIA |
| `DIA_AUTHORIZED_PRIVATE_KEY_TESTNET` | `cli/.env` only | local Preview-only demo signer that self-signs demonstration intents | create with `make cli CMD="ethereum-wallet:create"` |
| `DIA_AUTHORIZED_PRIVATE_KEY_MAINNET` | `cli/.env` only | private half of an authorized Mainnet signer; its public key must be in the deployed Config's authorized set | DIA — see the Mainnet Deployment Boundary section |

`CARDANO_WALLET_SEED_*` and `CARDANO_PRIVATE_KEY_*` are two ways to give the same
operator wallet — set the seed phrase or the raw private key, not both. The
`DIA_AUTHORIZED_PRIVATE_KEY_*` keys are used only by the CLI to self-sign demo
intents; the running feeder relays intents already signed by DIA and does not
need them. Keep the provider, wallet, and WebSocket values identical in both
`.env` files.

Optional, in `feeder/.env` only: the `*_HOST_PORT` values (remap the published
ports), `GRAFANA_ADMIN_PASSWORD` (read only on first Grafana boot), and the
`ALERTMANAGER_*` notification secrets (only when a channel is enabled in the
infrastructure YAML).

When you reuse a verified deployment, the Blockfrost account, DIA WebSocket
credential, and DIA authorized signer keys are your own and are entered
directly. The wallet is not interchangeable: the deployment's admin wallet
address is compiled into the PaymentHook contract as its withdraw address (and is
referenced by the client/receiver configuration), so reusing those contracts
requires that exact wallet (`CARDANO_WALLET_SEED_*`) — a freshly created wallet
does not match the deployed contracts and cannot administer or withdraw from
them. Obtain that wallet from the prior operator to run the reused deployment.

## New Preview Deployment

This path creates new on-chain contracts and spends Preview test ADA. It is the
appropriate full end-to-end path for a new Preview demonstration.

1. Configure both environment files with `CARDANO_NETWORK=Preview` and the
   required `_TESTNET` values.
2. Create a Cardano operator wallet if needed, then place its seed in both
   environment files and fund its displayed address from the Preview faucet.

```sh
cd offchain
make wallet
```

3. Create a local Preview-only EIP-712 demo signer, then set the generated key
   as `DIA_AUTHORIZED_PRIVATE_KEY_TESTNET` in `offchain/cli/.env`.

```sh
cd offchain
make cli CMD="ethereum-wallet:create"
```

4. Build the unified image and choose a new run ID. The run ID identifies all
   deployment artifacts, feeder logs, database state, and evidence for this
   deployment.

```sh
cd offchain
make build
export RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
```

5. Run the complete deployment and exercise workflow. It creates Config,
   PaymentHook, Receiver, reference scripts, initial Pair UTxOs, updates, and
   the run-level transaction evidence.

```sh
cd offchain
make run-all ARGS="--run-id ${RUN_ID}"
```

6. Generate a router for the new client. The interactive wizard selects the
   client JSON, symbols, operator wallet environment variable, customer ID,
   and push policy. With multiple candidate states, select
   `preview_run_${RUN_ID}/clients/client-test-01.json`.

```sh
cd offchain
make init-router RUN_ID="${RUN_ID}"
```

7. Start the feeder, consumer indexer, Prometheus, Grafana, Alertmanager, and
   renderer for exactly that run.

```sh
cd offchain
make up RUN_ID="${RUN_ID}" MONITORING=1
```

8. Verify the runtime before recording a demonstration.

```sh
curl -fsS http://localhost:8080/health/live
curl -fsS http://localhost:8080/health/ready
curl -fsS http://localhost:3001/v1/health | jq
curl -fsS http://localhost:3001/v1/pairs | jq
```

Open `http://localhost:3001/docs` for the consumer API, `http://localhost:8080/docs`
for the feeder API, `http://localhost:3000` for Grafana, and
`http://localhost:9090/alerts` for Prometheus alert status. Use the remapped
ports from `offchain/feeder/.env` when defaults were changed.

## Reuse A Verified Deployment

Reusing a state does not deploy contracts and does not create a new on-chain
deployment. It is the preferred path for the M4 demonstration because the
repository already contains the public state, router configuration, and
evidence lineage for the verified runs.

| Network | Preferred run ID | State directory | Published clients |
| --- | --- | --- | --- |
| Preview | `20260608-040304` | `offchain/state/preview_run_20260608-040304/` | `client-test-01`, `client-test-02` |
| Mainnet | `20260616-074413` | `offchain/state/mainnet_run_20260616-074413/` | `client-test-01` |

For Preview reuse from a clean clone:

```sh
# Configure both .env files for Preview and provide the necessary credentials.
cd offchain
make build
make up RUN_ID=20260608-040304 MONITORING=1

curl -fsS http://localhost:3001/v1/health | jq
curl -fsS http://localhost:3001/v1/pairs | jq
```

For Mainnet reuse from a clean clone:

```sh
# Configure both .env files for Mainnet and provide the necessary credentials.
cd offchain
make build
make up RUN_ID=20260616-074413 MONITORING=1

curl -fsS http://localhost:3001/v1/health | jq
curl -fsS http://localhost:3001/v1/pairs | jq
```

The repository router YAML files already reference these preferred state paths.
Do not run `make run-all` or `make init-router` when reusing them: those actions
create a new deployment or router configuration. To submit new live updates,
the configured writer wallet must be funded and authorized for the reused
deployment. To show only the consumer/indexer surface, provider credentials are
sufficient and no Cardano transaction is submitted.

## Mainnet Deployment Boundary

`make run-all` is a complete QA/exercise runbook, not a production-neutral
Mainnet bootstrap command. It requires `DIA_AUTHORIZED_PRIVATE_KEY_MAINNET` to
self-sign its demonstration intents and authorizes the derived public key in
the new Config. That is incompatible with a policy that permits only DIA-held
Mainnet signing keys.

Do not set a Mainnet private key merely to make this command proceed. A new
production Mainnet deployment requires written approval of the signer policy,
the wallet and ADA budget, the authorized DIA public-key set, and the intended
initial feeds. After that decision, either execute the individual protocol and
client commands documented in `offchain/cli/README.md`, or use an approved
deployment mode that omits the self-signed QA intent steps. The verified
Mainnet state above can be reused immediately without making that deployment
decision.

## Recording The Demonstration

The deterministic consumer demo does not submit a Cardano transaction:

```sh
cd offchain
bash indexer/src/examples/run-consumer-demo-emulator.sh
```

The optional on-chain consumer demo sends real transactions. Run it on Preview
with a funded wallet, and pause the feeder so both do not contend for the same
operator wallet or Pair UTxO:

```sh
cd offchain
make stop-feeder
bash indexer/src/examples/run-consumer-demo-onchain.sh | tee /tmp/onchain-consumer-demo.txt
make start-feeder
```

Build the M4 evidence pack only after the stack is healthy. The command is
read-only with respect to Cardano unless an existing on-chain demo log is passed
for embedding.

```sh
cd offchain
make evidence4 RUN_ID=20260608-040304

# Optional: include the on-chain consumer demo already captured above.
EVIDENCE_ONCHAIN_LOG=/tmp/onchain-consumer-demo.txt \
  make evidence4 RUN_ID=20260608-040304
```

The pack records Aiken, feeder, CLI, and indexer test output; feeder reliability
totals; feed sanity checks; indexer API responses; the emulator demo; and five
Grafana dashboard renders. The output directory is printed at the end of the
command.

## Safe Day-Two Operations

```sh
cd offchain

# Stop only the active network's Docker project; state, logs, and named volumes stay.
make down

# Restart the selected run without changing data.
make restart RUN_ID=20260608-040304

# Rebuild after code changes, reset runtime DB/logs/pair cache, preserve contracts/state.
make fresh RUN_ID=20260608-040304 MONITORING=1

# Reset runtime DB/logs/pair cache without rebuilding, preserve contracts/state.
make reset-restart RUN_ID=20260608-040304 MONITORING=1
```

`make fresh` and `make reset-restart` preserve `config-bootstrap.json` and
`clients/*.json`, but remove feeder runtime history. Do not use either command
when the existing runtime logs/database are the evidence being preserved.
Never use `make run-all ARGS="--clean-previous=true"` unless deletion of prior
non-protected runs and their M1 evidence is intentional.

## Troubleshooting Checklist

1. Confirm both environment files select the same network and hold matching
   provider and wallet settings.
2. Confirm the selected `RUN_ID` exists under `offchain/state/` and router YAML
   paths reference that exact run.
3. Run `make down` before switching `CARDANO_NETWORK`, then start the next
   network with `make up RUN_ID=<id> MONITORING=1`.
4. Use `docker compose -f feeder/docker-compose.yml --project-directory feeder -p dia-feeder-preview ps`
   or replace `preview` with `mainnet` to inspect the network-scoped services.
5. Use `make logs` and `make logs-indexer` from `offchain/` for runtime logs.
