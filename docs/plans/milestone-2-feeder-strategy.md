# Milestone 2 Feeder Strategy

This note explains the proposed Cardano feeder for Milestone 2, using the same
high-level pattern already present in DIA's Spectra services.

## The short version

We are not building the part of DIA that discovers prices.

For Cardano, we are building the destination side:

1. DIA produces or exposes a signed price update.
2. Our feeder reads that signed update.
3. Our feeder builds a Cardano transaction.
4. The Cardano validator verifies the DIA signature.
5. The Pair UTxO is updated with the latest price.

**Milestone 1 note (fee path):** updates accrue the protocol fee on the Receiver (`accrued_to_hook_lovelace`); moving those accruals to the global PaymentHook is a separate **Settle** transaction (coordinator + admin). The feeder in Milestone 2 may emit updates only, with Settle on an operator cadence, unless product requires the feeder to drive Settle as well. See [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md) §5.11.

The important idea is this: the feeder does not make the price true. DIA's
signature makes the price authoritative. The feeder is only the delivery
mechanism that brings that signed message onto Cardano.

## Names translated

### Lumina

Lumina is DIA's newer oracle system.

Think of Lumina as the full factory that produces oracle data:

- some nodes collect raw market data;
- DIA aggregates/checks that data;
- final values become available from DIA infrastructure;
- those values can then be delivered to other chains.

For us, Lumina matters because it is the source side of the data. We do not
need to re-create Lumina in Cardano.

### Lasernet

Lasernet is DIA's own EVM-compatible chain/rollup.

Think of it as DIA's internal/public data chain where Lumina data lives. DIA
feeders submit data there, and DIA contracts aggregate it there.

For us, Lasernet matters because the signed Cardano updates may come from a
contract or service connected to Lasernet.

### Feeder

This word is confusing because it can mean two different things.

In DIA/Lumina docs, a feeder is a source-side process that collects market data
from exchanges and sends it into DIA.

In our Milestone 2, "feeder" means a Cardano updater service. It does not fetch
raw exchange prices. It reads DIA-approved updates and submits Cardano
transactions.

So the M2 feeder is closer to a bridge/relayer than a price-discovery engine.

### Spectra

Spectra is DIA's cross-chain delivery layer.

Think of Lumina as the factory, Lasernet as the DIA data chain, and Spectra as
the delivery truck that carries oracle data from DIA to other blockchains.

On EVM chains, Spectra uses Hyperlane-style messaging. Cardano does not need to
implement Hyperlane inside Aiken for this requirement. The requirement
explicitly excludes Hyperlane-specific receiver features such as mailbox and
ISM.

For us, Spectra matters because the reference contracts come from that world,
especially `PushOracleReceiverV2`.

### OracleIntent

An OracleIntent is the key payload.

It is a signed message that says, in effect:

```text
For symbol BTC/USD,
the price is 123456789,
the timestamp is T,
the nonce is N,
and this was signed by an authorized DIA signer.
```

The exact fields in the DIA Solidity reference are:

- intent type;
- version;
- source chain id;
- nonce;
- expiry;
- symbol;
- price;
- timestamp;
- source;
- signature;
- signer.

Our Cardano contract verifies the same idea: the update is accepted only if the
signature matches an authorized DIA signer and the update is newer than the
previous one.

### OracleIntentRegistry

This is the source-chain registry for signed intents.

Think of it as a public bulletin board where DIA-signed price messages can be
registered or emitted.

Our feeder should read production intents from this registry path: scan
`IntentRegistered` events, then fetch the full intent by `intentHash` with the
registry view method.

### PushOracleReceiverV2

This is the EVM receiver contract used as the reference.

It can receive oracle updates and store the latest value by pair. It has logic
for:

- authorized signers;
- EIP-712 signature verification;
- stale update rejection;
- replay protection;
- batch updates;
- protocol fee handling.

Our Cardano scripts are the Cardano-native equivalent of this behavior, but
implemented with UTxOs instead of EVM storage.

### ProtocolFeeHook

This is the EVM fee collection helper.

In Cardano, our `payment_hook` plays the same conceptual role: each successful
update pays the configured protocol fee into the hook state.

## How a price reaches Cardano

The intended M2 path is:

```text
DIA Lumina / Lasernet
  -> OracleIntentRegistry emits IntentRegistered
  -> Cardano feeder
  -> Cardano transaction
  -> update_coordinator validates the update
  -> Pair UTxO stores latest price
  -> dApp/indexer reads latest value
```

The feeder does not decide whether the price is correct. That belongs to
Lumina/DIA. The feeder also does not create DIA's source-side oracle cadence.

In the Spectra reference stack, cadence belongs to the DIA `attestor`: it has
configured symbols and a configured polling interval, signs intents, and
publishes them to `OracleIntentRegistry`. The bridge side is event-driven: it
scans or subscribes to registry events and forwards the intents that already
exist.

For Cardano, the same split should apply:

- DIA/source side decides which symbols are attested and how often intents are
  produced.
- Cardano feeder watches the registry and forwards matching intents to Cardano.
- Cardano feeder may still have an allowlist/mapping so one Cardano deployment
  only forwards the pairs that belong to that receiver/client.

Important: the `OracleIntent` is not client-specific. It is a DIA-signed price
message for a symbol. The client/destination is chosen by bridge configuration.

In the Spectra bridge this is handled by routers:

- router trigger: which event to listen to, for example `IntentRegistered`;
- router condition: which symbols or fields match this route;
- router destination: which destination chain and receiver contract should get
  the update;
- destination policy: optional time threshold and/or price deviation threshold.

For Cardano, the equivalent router entry should say:

```text
when an IntentRegistered event arrives
and the full intent symbol is BTC/USD
send it to Cardano receiver/client X
using the Cardano update transaction builder
only if the Cardano freshness/threshold policy allows it
```

So the Cardano updater learns the client from its own routing config, not from
the DIA intent itself.

Example Cardano route:

```yaml
routes:
  - id: btc_usd_preview_demo
    trigger_event: IntentRegistered
    symbol: BTC/USD
    client: preview-demo
    receiver: <cardano receiver/client id>
    min_interval: 1h
    price_deviation: 0.5%
```

This means: when `BTC/USD` intents appear in the registry, the Cardano feeder
may forward them to the configured Cardano receiver, but only when the
destination policy allows it.

The scanner itself should run faster than the most demanding destination route.
For example, if the fastest client route allows updates every 30 seconds, the
scanner should check much more frequently than that, or subscribe by WebSocket.
The scanner is the radar; the route policy decides whether to actually submit a
Cardano transaction.

## What we already have from Milestone 1

Milestone 1 already gives the feeder the destination it needs:

- Aiken validators for Config, Receiver, Pair, PaymentHook, and Coordinator.
- EIP-712/secp256k1 verification against authorized DIA signers.
- stale/replay protection through timestamp, nonce, and intent hash.
- single update transaction flow.
- batch update transaction flow.
- CLI code that can build the Cardano transactions.

That means M2 should not start from zero. The feeder should reuse or wrap the
existing transaction-building logic.

## What M2 should build

M2 should build an operator service around the existing CLI/transaction logic.

Minimum useful shape:

| Piece | What it does |
|---|---|
| Source reader | Scans or subscribes to `IntentRegistered` logs from `OracleIntentRegistry` and fetches the full signed intent by hash. |
| Pair/router mapping | Maps registry symbols to the Cardano receiver/client that should receive them. This is not price discovery; it is routing. |
| Update policy | Skips stale intents, avoids resubmitting the same intent hash, groups safe batches, retries failed transactions. |
| Cardano submitter | Builds and submits the Cardano transaction using the DIA-operated updater wallet. |
| Logger | Writes reproducible logs: pair, price, timestamp, nonce, intent hash, tx hash, fee, status, error if any. |
| Health command | Shows wallet balance, latest submitted update, latest on-chain Pair datum, and stale/failure status. |

For local tests and reviewer evidence, the same source-reader interface can be
backed by recorded `OracleIntent` fixtures. That is a testing convenience, not
the production data path.

## Existing DIA/Spectra config pattern

The existing services already show the config split:

| Existing service | What it configures |
|---|---|
| `services/attestor` | `ATTESTOR_ATTESTOR_SYMBOLS`, `ATTESTOR_ATTESTOR_POLLING_TIME`, batch mode, source oracle address, registry address, signer key. This service creates and publishes signed intents. |
| `services/bridge` | source chain RPC/WebSocket, start block, event scanner interval, retry/worker settings, routers, destinations, destination contract/method mapping, optional per-destination time/deviation thresholds. This service routes existing intents to receivers. |

So the Cardano feeder should behave like a Cardano destination bridge, not like
a DIA source attestor.

## Existing Spectra inspiration

The proposal above is based on the current structure in
`diadata-org/Spectra-interoperability`:

| Reference path | Relevant behavior |
|---|---|
| `services/attestor/pkg/config/config.go` | Defines symbols, polling interval, batch mode, source oracle address, registry address, signer key, and guardian parameters. |
| `services/attestor/pkg/service/attestor.go` | Reads oracle values, signs intents, and publishes them to the registry. |
| `services/attestor/pkg/intent/intent.go` | Builds the EIP-712 `OracleIntent` payload and signature. |
| `services/bridge/internal/scanner/block_scanner_enhanced.go` | Scans blocks and also attempts WebSocket subscription for real-time events. |
| `services/bridge/internal/contracts/registry.go` | Defines the `IntentRegistered` event and `getIntent(bytes32)` view used to retrieve the full intent. |
| `services/bridge/internal/pipeline/enricher.go` | Enriches an event by calling a view method, such as fetching the full intent from the registry. |
| `services/bridge/pkg/router/generic_router.go` | Routes events by trigger conditions, destination mappings, time thresholds, and price-deviation thresholds. |
| `services/bridge/internal/processor/generic_event_processor.go` | Connects scanner, enrichment, router decisions, destination config, and transaction submission. |

The Cardano-specific change is the final submit step. In Spectra/EVM, the
bridge routes to a destination contract method such as `handleIntentUpdate`.
For Cardano, the route should call the Cardano transaction builder that updates
the matching Pair UTxO.

## Practical implementation order

The ordered, executable task breakdown for M2 lives in
[`milestone-2-plan.md`](./milestone-2-plan.md). This strategy document is the
conceptual reference (why and how); the plan document is the operational
checklist (what, in which order, with acceptance criteria).

## DIA source configuration

The architecture is clear: signed intents come from the DIA
`OracleIntentRegistry` path used by Spectra. The bridge does not discover this
at runtime; it is configured with the source network, RPC endpoint, registry
address, and start block.

### Canonical endpoints (confirmed by DIA, 2026-05-20)

| Environment | Source chain ID | RPC | `OracleIntentRegistry` |
|---|---:|---|---|
| **DIA Mainnet** | `1050` | `https://rpc.diadata.org` | [`0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`](https://explorer.diadata.org/address/0x5612599CF48032d7428399d5Fcb99eDcc75c06A7) |
| **DIA Testnet** | `10050` | `https://testnet-rpc.diadata.org` | [`0xF8c614A483A0427A13512F52ac72A576678bE317`](https://testnet-explorer.diadata.org/address/0xF8c614A483A0427A13512F52ac72A576678bE317) |

These are the values the Cardano feeder must use. They supersede earlier
values found in older Spectra config files (testnet chain id `100640` and
two distinct testnet registry addresses); the historical record and the
on-chain verification that surfaced the discrepancy are preserved in
[Appendix A](#appendix-a--historical-endpoint-discrepancies).

The expected registry interface is unchanged:

- `IntentRegistered(bytes32 indexed intentHash, string indexed symbol, uint256 price, uint256 timestamp, address signer)`
- `getIntent(bytes32 intentHash)`

The EIP-712 domain values (`source_chain_id`, `verifying_contract`) baked
into the Cardano `Config` datum **must match the registry the feeder
consumes**, because the `OracleIntent` signature is bound to that domain.

### Required Cardano Config update before first live feed

The Cardano `Config` datum currently deployed on **Cardano Mainnet** (M1)
was bootstrapped against the old DIA testnet values
(`source_chain_id = 100640`, `verifying_contract = 0xF8c614A483A0427A13512F52ac72A576678bE317`),
captured here for traceability:
[`docs/milestones/evidence/m1-mainnet-20260517-063917/00-master.log`](../milestones/evidence/m1-mainnet-20260517-063917/00-master.log).
Live DIA mainnet intents will be signed with `source_chain_id = 1050` and
`verifying_contract = 0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`, so signature
validation against the current Cardano Mainnet Config would fail.

Before the M2 feeder can target Cardano Mainnet, an admin-signed
`config:update` transaction (architecture §5.3) must be submitted to
re-point the Cardano Mainnet `Config` datum at the DIA mainnet domain.

The same applies to **Cardano Preview** if we want to consume DIA testnet
intents: the Config there must point at `source_chain_id = 10050` and
`verifying_contract = 0xF8c614A483A0427A13512F52ac72A576678bE317`.

Concrete tasks and acceptance criteria for these updates live in
[`milestone-2-plan.md`](./milestone-2-plan.md) Phase 1.

### Authorized signer sets (resolved 2026-05-21)

The full authorized signer sets for both environments were recovered
directly from live `IntentRegistered` events on 2026-05-21, without
waiting for an explicit DIA reply. Multiple recent events on each
registry were decoded and EIP-712 signature recovery was run against
each one using `recoverDiaOracleIntentWitness`; all verifications
passed ✅.

**DIA Testnet** (`0xF8c614A483A0427A13512F52ac72A576678bE317`, chain `10050`)

| Compressed public key | Ethereum address | Observed role |
|---|---|---|
| `03aafe60df69602d2600363bf9830b9ba09f199e7c1c1bda7c0be88a3ed341b807` | `0xf64D333c19B007519C7B9316680ED26578f98C08` | primary |
| `03c7d448ea95104a628945f43745f177f1e9895c6d4c8e43614d7b1c0395469b2d` | `0x64e5c9f5…89fb2` | occasional |

**DIA Mainnet** (`0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`, chain `1050`)

| Compressed public key | Ethereum address | Observed role |
|---|---|---|
| `02fa12f4143fca6652fa5a365fd1ada14495aab0dd3c1e568755e2230b38a4706d` | `0x077fdfFc…dC1C2` | primary |
| `02571284d2657052e68dc506c879f710d997a9801a5502339ff22f26bf85b958bd` | `0xB87a6f01…F3dC` | occasional |

These are the values used to populate `authorized_dia_public_keys` in
the Phase 1 `config:update`. A follow-up message was sent to DIA on
2026-05-21 to confirm whether these are the **complete** sets or
whether additional signers may exist that did not appear in our sample
window; Phase 1 can proceed with these keys in the meantime.

The first hardcoded key (`03aafe60…b807`, testnet primary) was already
present in `offchain/cli/src/init/protocol-init.ts` as
`DEFAULT_AUTHORIZED_DIA_PUBLIC_KEY`, which confirms it was the key
originally shared by DIA at project start.

### Open questions for DIA

The endpoint and registry values above (chain ids, RPCs, registry
addresses, mainnet deployment) were confirmed by DIA on 2026-05-20.
The following items remain open and are tracked as M2 prerequisites:

1. **Authorized signer set** *(D1)*: partially resolved — see
   [Authorized signer sets](#authorized-signer-sets-resolved-2026-05-21)
   above. Pending DIA confirmation that the observed sets are complete
   (no additional signers outside our sample window).
2. **Real-time access (WebSocket)** *(resolved 2026-05-21)*: DIA's RPC is
   hosted on Conduit, which authenticates by placing the API key in the URL
   path (not in headers or query string). Confirmed working endpoints:
   - testnet: `wss://testnet-rpc.diadata.org/<credential>`
     (`eth_chainId` → `0x2742` = 10050)
   - mainnet: `wss://rpc.diadata.org/<credential>`
     (`eth_chainId` → `0x41a` = 1050)

   Credentials are read from `.env` as `DIA_WS_CREDENTIAL_TESTNET` and
   `DIA_WS_CREDENTIAL_MAINNET` (see Annex A of the M2 plan). Note that the
   path is `/<key>`, **not** `/ws/<key>` or `/ws?token=<key>`; `/ws` without
   a key returns `HTTP 401 invalid rpc key` and `/ws/<key>` returns 404. The
   probe used to discover this is
   [`offchain/cli/scripts/tools/probe-dia-ws.ts`](../../offchain/cli/scripts/tools/probe-dia-ws.ts)
   and remains re-runnable. HTTP polling against `eth_getLogs` is still
   available as a fallback transport.
3. **Change-notification policy**: how will DIA communicate future changes
   to chain ids, registry addresses, or authorized signer sets, so the
   feeder does not run against stale values?

## Cardano destination concerns

The source-side picture is clear: registry, scanner, enricher, router. The
destination side adds concerns that the operator CLI did not have to solve,
because the CLI was designed for one interactive command at a time. A
long-running service has to handle these explicitly.

The items below are recorded as open problems. The intent of this section is
to make them visible, not to prescribe a solution.

### Updater wallet key management

The feeder signs Cardano transactions continuously with the updater wallet.

Today the CLI reads the signing key from `.env`
(`CARDANO_WALLET_SEED_TESTNET` / `_MAINNET` or
`CARDANO_PRIVATE_KEY_TESTNET` / `_MAINNET`, selected by `CARDANO_NETWORK`).
That is fine for Preview and interactive use. For a
long-running service, how the updater key is provisioned and protected at
runtime needs to be defined.

Open: how the daemon obtains and holds the updater signing key.

### Finality and tx-in-flight tracking

Cardano blocks are ~20 seconds. After submitting a transaction, the feeder
cannot immediately reuse the new Receiver and PaymentHook outputs from its
local copy: the next tx must reference an output that is actually confirmed in
a block.

A daemon needs to:

- Detect confirmation of submitted transactions before reusing their outputs.
- Avoid double-submitting the same intent across restarts.
- Decide what to do when a submitted transaction does not confirm within a
  budget (rebuild from current chain tip vs retry).

Open: the confirmation mechanism, the persistence model for in-flight state,
and the timeout/rebuild policy.

### Operator surface

The CLI exposes one-shot commands. A long-running service needs a different
operator surface: liveness/readiness signals, metrics, structured logs, and a
control to pause or drain submission without losing in-flight state.

The "Health command" row in the M2 table above should be read as this
operator surface, not as a one-shot CLI command.

Open: what is exposed (health endpoints, metrics, controls) and through which
transport.

---

## Appendix A — Historical endpoint discrepancies

This appendix preserves the engineering work that surfaced the testnet
chain-id and registry inconsistencies in DIA's published Spectra
configuration before DIA confirmed canonical values on 2026-05-20. It is
kept for traceability of how the canonical values in the
[DIA source configuration](#dia-source-configuration) section above were
arrived at, and as a re-runnable health check of the DIA RPC endpoints.

### Findings (pre-confirmation)

- **Testnet chain id mismatch.** DIA's published Spectra config files
  ([`config.json`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/config/config.json),
  [`integration_test.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/attestor/test/integration_test.go),
  [`decoder.go`](https://github.com/diadata-org/Spectra-interoperability/blob/fa4292db7330b8595a1b4709ae4c0df9138fece9/services/hyperlane-monitor/internal/blockchain/decoder.go))
  declared `https://testnet-rpc.diadata.org` as chain `100640`. The live
  RPC returns `10050`, and live `OracleIntent` structs are signed with
  `sourceChainId = 10050`. **Resolved**: canonical testnet chain id is
  `10050`.
- **Two competing testnet registry addresses in DIA's own repo.**
  `state.md` + hyperlane-monitor config used
  `0xC1ca83b5df6ce7e21Fb462C86f0C90E182d6db5d`; the attestor integration
  test + decoder used `0xd2313dcabB0E9447d800546b953E05dD47EB2eB9`. Neither
  had bytecode on the live testnet RPC. **Resolved**: canonical testnet
  registry is `0xF8c614A483A0427A13512F52ac72A576678bE317` (the live
  contract that emits `IntentRegistered` and answers `getIntent(bytes32)`).
- **Mainnet registry was undeployed at the time of M1 evidence capture.**
  No public DIA documentation listed a mainnet registry, and the testnet
  address had no bytecode at the same address on mainnet. **Resolved**:
  canonical mainnet registry is
  `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7` (deployed by DIA).
- **WebSocket endpoint requires credentials.** `wss://rpc.diadata.org/ws`
  and `wss://testnet-rpc.diadata.org/ws` exist but reject unauthenticated
  connections (HTTP 401, body
  `invalid rpc key. visit https://app.conduit.xyz/rpc-keys to create a valid key`).
  **Resolved (2026-05-21)**: DIA's RPC is hosted on Conduit, which expects
  the API key as the URL **path** rather than a header or query string. The
  working URLs are `wss://testnet-rpc.diadata.org/<key>` and
  `wss://rpc.diadata.org/<key>` (no `/ws` suffix). The credentials live in
  `.env` as `DIA_WS_CREDENTIAL_TESTNET` and `DIA_WS_CREDENTIAL_MAINNET`
  (see Annex A of the M2 plan). See verification command 5 below.

### Re-runnable verification commands

The following requests can be re-run by anyone with `curl` and an internet
connection. Hex results are annotated with their decimal value where
useful. They serve double duty as an RPC liveness check.

**1. Mainnet RPC chain id and head.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://rpc.diadata.org/
# => {"jsonrpc":"2.0","result":"0x41a","id":1}        (0x41a = 1050)

curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  https://rpc.diadata.org/
```

**2. Testnet RPC chain id and head.**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  https://testnet-rpc.diadata.org
# => {"jsonrpc":"2.0","result":"0x2742","id":1}       (0x2742 = 10050)
```

**3. Confirm canonical registries are deployed.**

```sh
# Mainnet:
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x5612599CF48032d7428399d5Fcb99eDcc75c06A7","latest"],"id":1}' \
  https://rpc.diadata.org/

# Testnet:
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0xF8c614A483A0427A13512F52ac72A576678bE317","latest"],"id":1}' \
  https://testnet-rpc.diadata.org
```

A non-`0x` `result` confirms bytecode is present.

**4. Read recent `IntentRegistered` events (HTTP polling sanity check).**

```sh
curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_getLogs","params":[{"fromBlock":"0x259f0b","toBlock":"latest","address":"0xF8c614A483A0427A13512F52ac72A576678bE317"}],"id":1}' \
  https://testnet-rpc.diadata.org
```

**5. WebSocket endpoint (Conduit-style, key in URL path).**

The credentials live in `offchain/cli/.env` as `DIA_WS_CREDENTIAL_TESTNET`
and `DIA_WS_CREDENTIAL_MAINNET`. The key goes in the URL path; no
`Authorization` header, query string, or `/ws` suffix is involved.

```sh
# from offchain/cli/, with DIA_WS_CREDENTIAL_TESTNET / _MAINNET set in .env
pnpm tsx scripts/tools/probe-dia-ws.ts
# => SUCCESS on 'path /<cred> (no /ws)' against testnet  (eth_chainId 0x2742)
# => SUCCESS on 'path /<cred> (no /ws)' against mainnet  (eth_chainId 0x41a)
```

Equivalent one-liner using `wscat` once a credential is exported in the shell:

```sh
wscat -c "wss://testnet-rpc.diadata.org/${DIA_WS_CREDENTIAL_TESTNET}" \
  -x '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# => {"jsonrpc":"2.0","result":"0x2742","id":1}
```

Negative controls (any of these still return `HTTP 401 invalid rpc key`
or `404 page not found`):

- `wss://testnet-rpc.diadata.org/ws` with `Authorization: Bearer <key>`
- `wss://testnet-rpc.diadata.org/ws?token=<key>` (or `apikey`, `api_key`,
  `key`, `auth`)
- `wss://testnet-rpc.diadata.org/ws/<key>`
- `wss://<key>@testnet-rpc.diadata.org/ws`

**6. Decode a full `OracleIntent` via `getIntent(bytes32)`.**

The 4-byte selector is the first four bytes of
`keccak256("getIntent(bytes32)")`:

```sh
node -e "console.log(require('ethers').id('getIntent(bytes32)').slice(0, 10))"
# => 0xf13c46aa
```

Call the registry with selector + intent hash (replace `<INTENT_HASH>`
with a hash observed in the logs above):

```sh
export DATA=$(curl -s -X POST -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0xF8c614A483A0427A13512F52ac72A576678bE317","data":"0xf13c46aa<INTENT_HASH>"},"latest"],"id":1}' \
  https://testnet-rpc.diadata.org | jq -r '.result')

node -e "
const { AbiCoder } = require('ethers');
const [intent] = AbiCoder.defaultAbiCoder().decode(
  ['tuple(string intentType, string version, uint256 sourceChainId, uint256 nonce, uint256 expiry, string symbol, uint256 price, uint256 timestamp, string source, bytes signature, address signer)'],
  process.env.DATA
);
console.log(intent);
"
```

Sample output observed against the live testnet registry (intent hash
`0x813ba9ea1b439f755ac2bf104cd854afa47c4ca6f5019647ee07746b8b2f2ff6`):

| Field | Value |
| --- | --- |
| intentType | `OracleUpdate` |
| version | `1.0` |
| sourceChainId | `10050` |
| price | `1777292303280293532` |
| expiry | `1777365980` (unix seconds) |
| symbol | `XVG/USD` |
| nonce | `3286397304062500` |
| timestamp | `1777362380` (unix seconds) |
| source | `DIA Oracle` |
| signature | `0xda599e61…1b` (65 bytes) |
| signer | `0xf64D333c19B007519C7B9316680ED26578f98C08` |

The `signer` value above was the primary DIA testnet signer at the
time. The full authorized signer sets for testnet and mainnet (recovered
via live EIP-712 signature verification on 2026-05-21) are documented
in the [Authorized signer sets](#authorized-signer-sets-resolved-2026-05-21)
section above.
