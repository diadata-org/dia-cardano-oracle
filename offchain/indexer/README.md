# DIA Cardano Oracle — Indexer

A read-only, **consumer-facing** query service over the live on-chain DIA oracle
feeds. Its source of truth is the **Pair / Receiver / PaymentHook UTxOs on
Cardano** — not any feeder's cache — so it answers "what does the chain say right
now" for any published pair, **independent of whether the feeder is running**.
Anyone can run it with only a chain-provider key and the published contract
addresses below.

This is the layer a Cardano dApp consumes. (The feeder's own API is
producer/operator-facing — "what did this feeder push, is it healthy"; the
indexer is "what is on-chain now".)

## Contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [Run it](#run-it)
- [Try it locally (end-to-end demo)](#try-it-locally-end-to-end-demo)
- [HTTP API](#http-api)
  - [Docs, schema & metrics](#docs-schema--metrics)
- [Published contract addresses](#published-contract-addresses)
- [For client dApps: paying for the service](#for-client-dapps-paying-for-the-service)
- [Requesting a new feed](#requesting-a-new-feed)
- [Consuming a feed (examples)](#consuming-a-feed-examples)
- [Develop / test](#develop--test)

## What it is

- A stateless HTTP service that reads live Pair/Receiver UTxOs, decodes their
  inline datums, and serves the latest value + the exact UTxO ref to reference.
- **Scope:** read-only queries. Building/submitting transactions and managing
  clients stay with the feeder/CLI; the indexer runs on the chain + a provider
  key, reading the same shared state the feeder/CLI write.

## Architecture

Top → bottom:

| Layer | File | Responsibility |
| --- | --- | --- |
| HTTP API | [`src/http.ts`](src/http.ts) | `node:http` routing → JSON v1 + Swagger UI / OpenAPI / Prometheus |
| Route table | [`src/api/routes.ts`](src/api/routes.ts) | TypeBox descriptors that drive the OpenAPI doc (`/v1/openapi.json`) |
| Metrics | [`src/api/metrics.ts`](src/api/metrics.ts) | `dia_bridge_provider_requests_total` counter — same series the feeder exposes |
| Index service | [`src/index-service.ts`](src/index-service.ts) | `listPairs` / `getPair` / `listClients` / `getClient` / `getProtocolFees` / `health` |
| Registry | [`src/registry-config.ts`](src/registry-config.ts) | published script ids/addresses + the Config UTxO location, per network |
| Decode core | `@…/cli/core/datum-decoders` | `decodePairDatum` / `decodeReceiverDatum` / `decodeConfigFees` (shared, dependency-free) |
| Chain-reader | [`src/chain-reader.ts`](src/chain-reader.ts) · [`-providers.ts`](src/chain-reader-providers.ts) | `utxosAt(address)` + `tip()` over Blockfrost/Koios, wrapped in the CLI's retrying provider (counts every call) |
| OpenAPI + Swagger UI | `@…/shared` | `buildOpenApiDocument` + the `/docs` page + vendored assets — the SAME machinery the feeder serves |

The `ChainReader` is an interface, so the index service is unit-tested against a
fake reader. The providers are wrapped with the CLI's `createRetryingProvider`
(same as the feeder), which retries transient errors and reports every request
to the metrics counter.

## Run it

The indexer **reuses the feeder/CLI env conventions**, so the same `.env` drives
both (see [`.env.example`](.env.example)). Only `INDEXER_PORT` and the optional
`INDEXER_REGISTRY_FILE` are indexer-specific.

**Docker (production — alongside the feeder).** `make up` builds the unified
image and starts the feeder **and** the indexer (the `indexer` compose service,
port 3001), both reading the shared state tree and `feeder/.env`:

```bash
cd offchain
make up           # feeder + indexer  (make down stops both; make logs-indexer)
curl -s localhost:3001/v1/health | jq
```

The indexer is stateless — it reads the shared-state bind-mount and the chain,
so the image plus that mount is all it runs on.

**Local dev (without Docker).**

```bash
cd offchain/indexer
npm install

# Blockfrost on Mainnet (reads the *_MAINNET variants)
CARDANO_NETWORK=Mainnet \
BLOCKFROST_API_URL_MAINNET=https://cardano-mainnet.blockfrost.io/api/v0 \
BLOCKFROST_PROJECT_ID_MAINNET=mainnet<your-key> \
npm run indexer:dev

# or Koios on Preview (no key; reads the *_TESTNET variant)
CARDANO_NETWORK=Preview CARDANO_PROVIDER=Koios \
KOIOS_API_URL_TESTNET=https://preview.koios.rest/api/v1 \
npm run indexer:dev
```

| Env var | Default | Notes |
| --- | --- | --- |
| `CARDANO_NETWORK` | `Preview` | `Mainnet` or `Preview` — selects the registry. Shared with the feeder. |
| `CARDANO_PROVIDER` | `Blockfrost` | `Blockfrost` or `Koios`. Shared with the feeder. |
| `BLOCKFROST_API_URL_<SFX>` / `BLOCKFROST_PROJECT_ID_<SFX>` | — | required for Blockfrost; `SFX` = `MAINNET` (Mainnet) or `TESTNET` (Preview). |
| `KOIOS_API_URL_<SFX>` | — | required for Koios. |
| `INDEXER_PORT` | `3001` | HTTP listen port (indexer-specific). |
| `INDEXER_REGISTRY_FILE` | bundled | path to a registry JSON, overriding `config/registry.<network>.json`. |

## Try it locally (end-to-end demo)

The consumption loop — query the **indexer** for a pair, then build a spend
against the example consumer validator that references the pair's UTxO and gates
on its price — has two demos, same flow, two targets:

**Emulator (offline, no wallet/funds).** Publishes a Pair UTxO on a Lucid
in-memory emulator, queries the indexer for it, and builds two spends — one that
**succeeds** (min-price below the feed price) and one that **fails** (above):

```bash
bash src/examples/run-consumer-demo-emulator.sh
# … → "DEMO PASSED — the validator consumed our oracle price correctly."
```

**On-chain (real network).** Same proof against the **real deployed pair**: reads
the live pair from the running indexer over HTTP, then builds a real spend that
**rejects** when min-price > the live price and **accepts** when below. Needs the
indexer running and a funded wallet + provider in `.env` (network/provider/wallet,
like the CLI/feeder):

```bash
bash src/examples/run-consumer-demo-onchain.sh
# optional: DEMO_SYMBOL=ETH/USD INDEXER_URL=http://localhost:3001 bash …
```

For a clean run, pause the feeder first so it does not compete for the operator
wallet's UTxOs or update (and spend) the Pair UTxO the demo references — the
indexer keeps serving the already-published pairs:

```bash
cd offchain && make stop-feeder      # indexer stays up
bash indexer/src/examples/run-consumer-demo-onchain.sh | tee /tmp/onchain.txt
make start-feeder                    # resume
```

Both compile the [Aiken consumer](../../contracts/aiken/validators/example_oracle_consumer.ak)
(`aiken build`) and run [`consumer-demo-emulator.ts`](src/examples/consumer-demo-emulator.ts)
/ [`consumer-demo-onchain.ts`](src/examples/consumer-demo-onchain.ts).

## HTTP API

The data endpoints are `GET` and return JSON. A `symbol` contains a `/`, so it
MUST be URL-encoded (`BTC/USD` → `BTC%2FUSD`).

| Path | Returns |
| --- | --- |
| `/v1/health` | `{ tip, pairCount }` — provider reachable, chain tip, live pair count |
| `/v1/pairs` | `{ pairs: [...] }` — every published pair (latest value + `utxoRef`) |
| `/v1/pairs/{symbol}` | one pair: `{ symbol, pairId, pairPolicyId, price, timestamp, nonce, signer, intentHash, minUtxoLovelace, utxoRef, ageSeconds, clientId }` |
| `/v1/pairs/{symbol}/utxo` | just `{ txHash, outputIndex }` — the TxIn to use as a reference input |
| `/v1/clients` | `{ clients: [...] }` — every client publishing feeds (balance + subscribed pairs) |
| `/v1/clients/{clientId}` | `{ clientId, receiverBalanceLovelace, accruedToHookLovelace, subscribedPairs }` |
| `/v1/protocol/fees` | `{ baseFeeLovelace, perPairFeeLovelace, feeFormula, exampleSinglePairFeeLovelace }` — the on-chain fee a client pays per update |

`pairPolicyId` is the Pair NFT's policy id — a consumer needs it to authenticate
the reference input (the feed is real only if the referenced UTxO carries that
NFT). Plus three operator endpoints:

| Path | Returns |
| --- | --- |
| `/docs` | interactive API reference (Swagger UI) — `http://localhost:3001/docs` |
| `/v1/openapi.json` | the OpenAPI 3.0 schema, generated from the route table |
| `/metrics` | Prometheus exposition (`dia_bridge_provider_requests_total` — the indexer's Blockfrost/Koios usage) |

`price`/`timestamp` are integer strings (DIA's fixed-point encoding / unix
seconds). `ageSeconds = now − timestamp` at query time — a consumer should
bound it before trusting a value.

```bash
curl -s localhost:3001/v1/pairs/ARS%2FUSDT | jq
curl -s localhost:3001/v1/pairs/ARS%2FUSDT/utxo | jq   # → { "txHash": "...", "outputIndex": 0 }
```

### Docs, schema & metrics

The indexer serves the same operational surface as the feeder, from the shared
[`@…/shared`](../shared) machinery — a route table drives the OpenAPI document,
so the spec cannot drift from what the server serves:

| Path | Returns |
| --- | --- |
| `/docs` | Interactive **Swagger UI** — fill params and fire requests with **Try it out** |
| `/v1/openapi.json` | The **OpenAPI 3.0** document, generated from the route table |
| `/metrics` | **Prometheus** exposition — `dia_bridge_provider_requests_total{provider,method,outcome}` counts every Blockfrost/Koios request the indexer makes |
| `/public/*` | Vendored Swagger UI assets |

```bash
open http://localhost:3001/docs            # interactive API reference
curl -s localhost:3001/metrics | grep provider_requests_total
```

The `/metrics` counter shares the feeder's metric name, so Prometheus scrapes the
indexer as its own `job` and a `sum by (provider)` query reports the combined
Blockfrost/Koios draw on the shared key (see the feeder's
[Grafana dashboards guide §6](../../docs/architecture/grafana-dashboards.md#6-dashboard-3--internals-dia-cardano-feeder-internals)
and the `ProviderRequestQuotaHigh*` alerts).

## Published contract addresses

The registry lives in per-network JSON config files
([`config/registry.mainnet.json`](config/registry.mainnet.json) /
[`config/registry.preview.json`](config/registry.preview.json)), loaded by
[`src/registry-config.ts`](src/registry-config.ts) and overridable wholesale via
`INDEXER_REGISTRY_FILE`. These are public on-chain identifiers. This table
doubles as the M4 "contract addresses" deliverable.

### Mainnet

| Client | Pair policy id | Pair validator address | Receiver validator address |
| --- | --- | --- | --- |
| `client-test-01` | `b1b933a7…b95e052f` | `addr1wxcmjva8kz8tmmndj4a54c7sy7ky5yle6vvahk9zh90q2tcgwmdlu` | `addr1w9hvfdd22u3c9043rwudk29g0zzdz3a0un3t8k845ue35fg7fc477` |

### Preview

| Client | Pair policy id | Pair validator address | Receiver validator address |
| --- | --- | --- | --- |
| `client-test-01` | `def5c14b…1c1bd902` | `addr_test1wr00ts2tu67wa7u4w6g3pgxgcl2nvtjch7830dhwrsdajqszug5ju` | `addr_test1wrn8y8773tm7gzhvh4h3g6cywrxzqu3wqknpey3s5pffqrgn9jphd` |
| `client-test-02` | `02435906…e0b1a293` | `addr_test1wqpyxkgxkkljawk90fed34tqn2nlvs44urjd09nxuzc69ycc26zxz` | `addr_test1wzrzrh36g9s9qdj7rrm6yq9entwn23zfr6maguw04kpez0qjwg4dt` |

Full untruncated values are in the JSON config files above.

## For client dApps: paying for the service

Reading a feed on-chain is free (the Pair UTxO is a reference input). What costs
is **keeping the feed updated**: each on-chain price update for the pairs you
subscribe to charges a protocol fee, drawn from a **prepaid balance** you fund.
As a client you do not operate any contract yourself — DIA admin manages your
Receiver; you only prepay and consume.

- **Your account is your Receiver UTxO.** It holds a `balanceLovelace` (your
  prepaid pool) and `accruedToHookLovelace` (fees already charged, awaiting
  settlement). Read them live at `GET /v1/clients/{clientId}`.
- **You top up at your deposit address.** Each client has a dedicated on-chain
  deposit address; you fund your balance with an **ordinary wallet payment** of
  ADA to it (no CLI, no special tooling). The operator later folds your deposits
  into your Receiver balance. Ask DIA for your client's deposit address when you
  are onboarded.
- **The fee per update** is `baseFeeLovelace + N × perPairFeeLovelace`, where `N`
  is the number of pairs in that update. Read the live values at
  `GET /v1/protocol/fees` — it returns the base, the per-pair amount, the formula,
  and a worked single-pair example.
- **When you are charged:** on every on-chain update of your subscribed pairs,
  the fee moves from your `balanceLovelace` to `accruedToHookLovelace`. If the
  balance runs low, top up at your deposit address before it reaches zero, or
  updates for your pairs can no longer be funded.

```bash
curl -s localhost:3001/v1/protocol/fees | jq        # what an update costs
curl -s localhost:3001/v1/clients/client-test-01 | jq   # your prepaid balance
```

The full on-chain mechanics (Receiver datum, the AccrueFee/Settle flow, the
PaymentHook) are in the
[architecture doc §4.3 / §5.11](../../docs/architecture/cardano-oracle-architecture.md).

## Requesting a new feed

The pairs published on Cardano are a subset of DIA's catalogue (2,500+ price
feeds and 10,000+ RWA feeds). To have a feed you need published on-chain as a
Pair UTxO you can consume:

1. **Pick the feed** from DIA's catalogue at
   [diadata.org](https://www.diadata.org/) (any of the 2,500+ price / 10,000+ RWA
   feeds, identified by its DIA symbol, e.g. `ARS/USDT`).
2. **Request it** through DIA — see the
   [DIA request channels](https://www.diadata.org/) (the same onboarding that
   sets up your client Receiver + deposit address).
3. **It appears as a Pair UTxO** once DIA onboards it: the operator subscribes
   the pair for your client and the feeder publishes its first update. From then
   on it shows up in `GET /v1/pairs` and you consume it like any other.

Time to availability is the onboarding turnaround plus one feeder update cycle.
There is no on-chain self-service step on the consumer side — once published, the
indexer serves it automatically on the next request.

## Consuming a feed (examples)

- **Off-chain** ([`src/examples/read-pair-offchain.ts`](src/examples/read-pair-offchain.ts)):
  a Lucid script that asks the indexer for a pair's `utxoRef`, then includes that
  Pair UTxO as a **reference input** in a transaction.
- **On-chain** ([`contracts/aiken/validators/example_oracle_consumer.ak`](../../contracts/aiken/validators/example_oracle_consumer.ak)):
  an Aiken validator that reads the referenced Pair datum's `price` and gates its
  spend — after **authenticating** the reference input by its Pair NFT (the
  critical rule: require the Pair NFT, which binds the datum to the real oracle).

- **End-to-end** (the two demos above): emulator
  ([`run-consumer-demo-emulator.sh`](src/examples/run-consumer-demo-emulator.sh) →
  [`consumer-demo-emulator.ts`](src/examples/consumer-demo-emulator.ts)) and on-chain
  ([`run-consumer-demo-onchain.sh`](src/examples/run-consumer-demo-onchain.sh) →
  [`consumer-demo-onchain.ts`](src/examples/consumer-demo-onchain.ts)) — read a feed
  via the indexer and show a spend that succeeds vs one that fails against the price.

The pattern: the oracle UTxO is read-only (a reference input), so its value/NFT
stay in place and many dApps can read the same feed in the same block.

## Develop / test

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test — fake ChainReader + the Lucid emulator
npm run build       # tsc → dist
```

The suite runs on fakes and the Lucid in-memory emulator: the chain reader and
index service use a fake `ChainReader`, and the full consumption loop
(`src/examples/run-consumer-demo-emulator.sh`) runs on the emulator.

A separate script reads every published pair on the **real configured network**
(`CARDANO_NETWORK` + the provider env) and decodes them — read-only, it never
writes a transaction:

```bash
CARDANO_NETWORK=Mainnet BLOCKFROST_API_URL_MAINNET=… BLOCKFROST_PROJECT_ID_MAINNET=… \
  npm run pairs:read      # → src/examples/read-pairs.ts
```
