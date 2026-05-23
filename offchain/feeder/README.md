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

See [`../../docs/plans/milestone-2-plan.md`](../../docs/plans/milestone-2-plan.md)
**Phase 3** for the implementation roadmap and **Annex C** for the
component-by-component mapping to the Spectra Bridge.

## Status

**Phase 3.6 complete — Dockerfile + docker-compose.** All pipeline
phases are implemented and tested (96 unit tests, 0 failures).

| Phase | Module(s) | Status |
| ----- | --------- | ------ |
| 3.1 — source scanner | `src/source/` | ✅ |
| 3.2 — config + ABI parsing | `src/config/` | ✅ |
| 3.3 — router + policy gating | `src/router/`, `src/processor/` | ✅ |
| 3.4 — Cardano write client + queue | `src/submitter/`, `src/lib-bridge/` | ✅ |
| 3.5 — persistence + HTTP API + metrics | `src/persistence/`, `src/api/` | ✅ |
| 3.6 — containerisation | `Dockerfile`, `docker-compose.yml` | ✅ |

**What works today:**

- End-to-end scanning, extraction, deduplication, and enrichment
  against the live DIA testnet (HTTP polling or WebSocket).
- Router with `eq/neq/in/not_in/gt/lt/contains` conditions and
  `time_threshold` + `price_deviation` policy gating.
- Serial per-receiver-UTxO submission queue with in-flight tracking.
- Pluggable DB (`better-sqlite3` default, `pg` opt-in) via `DATABASE_DRIVER`.
- HTTP API: `GET /healthz`, `/readyz`, `/metrics`, `/prices`.
- Prometheus metrics via `prom-client` (opt-in, `METRICS_ENABLED=true`).
- Two-stage Docker image with healthcheck.

**Pending before production:**

- Wire `RealOracleIntentBridge` in `src/lib-bridge/index.ts` once
  `@lucid-evolution/lucid` is added as a feeder dependency (or
  exposed via relative import from `offchain/cli`).
- Integration test with a live Cardano Preview node.
- `cmd/feeder/main.ts` daemon entry point that stitches all modules.

## Usage

```sh
cd offchain/feeder
npm install
cp .env.example .env
# fill in the shared values from offchain/cli/.env (see Environment below)

# Validate the modular config.
npm run feeder:dev -- --help
npm run feeder:dev -- --config ./config --validate-only

# Scan the live source registry (HTTP polling).
npm run feeder:dev -- --config ./config --scan --transport http

# Scan via WebSocket subscription (requires DIA_WS_CREDENTIAL_<network>).
npm run feeder:dev -- --config ./config --scan --transport ws
```

Once the daemon is wired in (Phase 3.4+):

```sh
npm run feeder:dev -- --config ./config --log-level info
```

The active network (Cardano Preview ↔ DIA Testnet, Cardano Mainnet ↔
DIA Mainnet) is selected by `CARDANO_NETWORK` in `.env`, the same
selector the CLI uses.

## Environment

**Design rule** (see [`docs/plans/milestone-2-plan.md` Annex D](../../docs/plans/milestone-2-plan.md)):

> The YAML config in `config/` is the single source of truth for
> every public data point (chain ids, RPC URLs, WS URLs, registry
> addresses, ABIs). `.env` carries only secrets and selectors.

That means the operator only fills in the `.env` for things that
either change with the active deployment (network selector) or that
cannot live in version control (credentials).

The feeder's `.env` carries:

- **Selectors** — `CARDANO_NETWORK`, `CARDANO_PROVIDER`, `LOG_LEVEL`,
  `DRY_RUN`.
- **Cardano-side secrets** — `BLOCKFROST_PROJECT_ID_*`,
  `BLOCKFROST_API_URL_*`, `KOIOS_API_URL_*`, `CARDANO_WALLET_SEED_*`,
  `CARDANO_PRIVATE_KEY_*`.
- **DIA-side secret** — `DIA_WS_CREDENTIAL_*` (Conduit path
  credential for the WebSocket transport).
- **DIA-side informational** — `DIA_EXPLORER_URL_*`. Not in Spectra's
  YAML schema, so we keep it in env rather than invent a YAML field.
- **Feeder daemon ops** — `API_LISTEN_ADDR`, `API_ENABLE_CORS`,
  `METRICS_ENABLED`, `METRICS_NAMESPACE`, `DATABASE_DRIVER`,
  `DATABASE_PATH_*`, `DATABASE_DSN_*`. All names match the upstream
  Spectra Bridge.

The feeder **does not** declare any of these in `.env` (they live in
the YAML or are simply not needed):

| Variable | Lives in |
| --- | --- |
| `DIA_SOURCE_CHAIN_ID_*` | `config/infrastructure.<network>.yaml::source.chain_id` (also `chains.yaml`) |
| `DIA_RPC_URL_*` | `config/infrastructure.<network>.yaml::source.rpc_urls` (also `chains.yaml`) |
| `DIA_WS_URL_*` | `config/infrastructure.<network>.yaml::source.ws_url` |
| `DIA_REGISTRY_ADDRESS_*` | `config/contracts.yaml::<id>.address` |
| `DIA_DOMAIN_NAME` / `_VERSION` | not needed — feeder consumes pre-signed intents |
| `DIA_EVM_PRIVATE_KEY_*` | not needed — feeder never signs an intent |

The scanner's starting block is **not** an env var — it lives in
`config/infrastructure.<network>.yaml` under `source.start_block`,
matching the Spectra Bridge convention. Once the feeder has seen at
least one block, the persisted `chain_state.last_processed_block`
checkpoint always wins over the YAML default.

## Config layout

```text
config/
├── infrastructure.preview.yaml     # source RPC/WS, scanner, dedup, API, DB (Cardano Preview ↔ DIA Testnet)
├── infrastructure.mainnet.yaml     # same shape for Cardano Mainnet ↔ DIA Mainnet
├── chains.yaml                     # DIA Testnet/Mainnet chain definitions
├── contracts.yaml                  # OracleIntentRegistry per network (ABI + address)
├── events.yaml                     # IntentRegistered ABI + getIntent enrichment
└── routers/
    └── client-a.preview.yaml       # example: 10 Catalyst pairs → one Cardano client
```

This is the same 5-file modular layout the DIA Spectra Bridge expects,
so DIA's existing router YAMLs can be dropped into `config/routers/`
with only the `destinations[].cardano` block being Cardano-specific.
See [`milestone-2-plan.md` Annex C](../../docs/plans/milestone-2-plan.md)
for the full mapping.

### Validation

Every YAML is checked at load time. A subset of what the validator
catches:

- a destination that declares both `method:` (EVM) and `cardano:`,
  or neither,
- a destination that declares an EVM `method:` block (refused with a
  pointer to the Spectra Bridge — this feeder is Cardano-only),
- a router referencing an undefined event in `events.yaml`,
- an unknown `triggers.conditions[].operator`,
- a `cardano:` block with invalid `network`, `tx_mode`, or missing
  `client_state_path` / `protocol_state_path`,
- a non-conventional `private_key_env` name (warning).

Run `npm run feeder:dev -- --config ./config --validate-only` to see
the full report.
