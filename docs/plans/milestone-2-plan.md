# Milestone 2 Implementation Plan

Operational task breakdown for Milestone 2 (Data Feeder and Documentation).

This is the executable checklist. The conceptual reference (why and how) lives
in [`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md). The
Catalyst milestone text lives in
[`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)
(Milestone 2). The cross-workstream view lives in [`work-plan.md`](./work-plan.md)
(Workstream C).

## Scope

Build and operate a Cardano-side feeder service that:

- reads DIA-signed `OracleIntent` payloads from `OracleIntentRegistry` on
  DIA Lasernet (testnet then mainnet),
- routes each intent to the corresponding Cardano client receiver,
- builds and submits the matching Cardano oracle update transaction,
- captures verifiable evidence (tx hashes, logs, QA dashboards) for the
  Catalyst milestone.

## Canonical endpoints

The DIA endpoints below were confirmed by DIA on 2026-05-20. Full context and
re-runnable verification commands are in
[`milestone-2-feeder-strategy.md` § DIA source configuration](./milestone-2-feeder-strategy.md#dia-source-configuration).

| Environment | Source chain ID | RPC | `OracleIntentRegistry` |
| --- | ---: | --- | --- |
| **DIA Mainnet** | `1050` | `https://rpc.diadata.org` | `0x5612599CF48032d7428399d5Fcb99eDcc75c06A7` |
| **DIA Testnet** | `10050` | `https://testnet-rpc.diadata.org` | `0xF8c614A483A0427A13512F52ac72A576678bE317` |

The Cardano `Config` datum's `domain.source_chain_id` and
`domain.verifying_contract` MUST match whichever DIA environment the feeder
is consuming, because `OracleIntent` signatures are bound to those values.

## Open dependencies on DIA

These items must be answered before the corresponding phase can start. They
are tracked as "Open questions for DIA" in
[`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md#open-questions-for-dia).

- [x] **D1 — Authorized signer set.** Resolved 2026-05-21 by recovering
  signer public keys directly from live `IntentRegistered` events via
  EIP-712 signature recovery. Keys documented in
  [`milestone-2-feeder-strategy.md` § Authorized signer sets](./milestone-2-feeder-strategy.md#authorized-signer-sets-resolved-2026-05-21).
  DIA confirmation of completeness pending (message sent 2026-05-21);
  **Phase 1 can proceed** with the observed sets.
- [x] **D2 — WebSocket credentials (optional).** Resolved 2026-05-21. DIA's
  RPC is hosted on Conduit; the API key is passed as the URL path (no `/ws`
  suffix, no header, no query string). Confirmed working:
  `wss://testnet-rpc.diadata.org/<credential>` (chain id `0x2742`) and
  `wss://rpc.diadata.org/<credential>` (chain id `0x41a`). Credentials are
  loaded from `.env` as `DIA_WS_CREDENTIAL_TESTNET` /
  `DIA_WS_CREDENTIAL_MAINNET` (see Annex A). See
  [feeder-strategy § open question 2](./milestone-2-feeder-strategy.md#open-questions-for-dia)
  and probe script
  [`offchain/cli/scripts/tools/probe-dia-ws.ts`](../../offchain/cli/scripts/tools/probe-dia-ws.ts).
  WebSocket transport in Phase 3 (`source/scanner-ws.ts`) is now unblocked;
  HTTP polling remains the fallback.
- [ ] **D3 — Change-notification policy.** How DIA will communicate future
  changes to chain ids, registry addresses, or signer sets. Not blocking;
  needed before Phase 5 mainnet rollout.
- [ ] **D4 — Repo location.** Confirm whether the feeder lives in the
  existing `diadata-org/dia-cardano-oracle` monorepo as
  `offchain/feeder/` (recommended), or in a new
  `diadata-org/dia-cardano-feeder` repo. Blocks Phase 3.
- [ ] **D5 — Updater wallet ownership and custody.** Which party operates
  the Cardano updater wallet that signs the long-running submission
  transactions, and how the signing key is provisioned at runtime. Blocks
  Phase 4 live submission.
- [ ] **D6 — Expected update cadence per pair.** Polling interval the DIA
  attestor uses for the 10 Catalyst-listed pairs, so the feeder's
  per-route `min_interval` and `price_deviation` policies can be sized.
  Needed before Phase 4.

---

## Phase 0 — Documentation alignment with confirmed DIA data

Goal: bring repo docs in sync with the canonical endpoints DIA confirmed.

- [x] Refactor `milestone-2-feeder-strategy.md`: replace prior "Live
  verification" section with the canonical endpoints table (mainnet +
  testnet), resolve open questions 1–4, keep the remaining open items
  (signer-set completeness confirmation and change-notification policy;
  WebSocket auth was resolved 2026-05-21 — Conduit path-style key), move
  historical curl/discrepancy material to Appendix A.
- [x] Annotate that **Cardano Mainnet `Config` requires a `config:update`**
  before the first live feed (current Mainnet datum was bootstrapped with
  the old `source_chain_id = 100640`).
- [x] Create this plan document (`milestone-2-plan.md`) and link it from
  `work-plan.md` Workstream C and from the strategy doc.
- [x] Update `work-plan.md` Workstream C with a 1-paragraph summary and
  link to this plan.

**Acceptance**: a reader landing on `work-plan.md` reaches the operational
M2 checklist in one click; the strategy doc no longer carries an open
debate about chain ids or registry addresses.

## Phase 1 — Re-point Cardano `Config` to the confirmed DIA domain

Goal: make signature validation against live DIA intents possible.

Depends on **D1** (authorized signer set).

- [x] Authorized signer sets recovered from live registries (D1 resolved
  — see above). Testnet: `[03aafe60…b807, 03c7d448…b2d]`.
  Mainnet: `[02fa12f4…706d, 02571284…b958bd]`.
- [x] Submit `config:update` on **Cardano Preview** — tx
  `5f2d52183c6c56bd90259dfefe46427b1af8c844fc6580c0170743688001d1dc`
  confirmed 2026-05-21. Draft:
  `offchain/cli/state/preview_run_20260516-090057/config-updates/config-update-draft-m2-phase1.json`.

**Acceptance**: Cardano Preview `Config` datum now points at
`source_chain_id = 10050`, `verifying_contract = 0xF8c614…8bE317`,
with `authorized_dia_public_keys = [03aafe60…b807, 03c7d448…9b2d]`.
A fresh signed `OracleIntent` from the DIA testnet registry will
validate against this datum.

> **Mainnet `config:update` and fixture/test regeneration are
> deliberately deferred to Phase 5.** Mainnet will not be touched
> until the feeder is validated end-to-end on Preview + DIA testnet
> (Phase 4). See Phase 5 below.

## Phase 2 — CLI refactor: tx builders as a reusable library

Goal: let the long-running feeder call the existing tx-build logic in-process,
without spawning the interactive CLI as a subprocess.

- [x] Audit `offchain/cli/src/transactions/` to identify which functions
  mix prompts/state I/O with pure tx-building logic.
- [x] Extract pure builders for the three priority targets, returning a
  built (but not signed/submitted) Lucid `Tx`:
  - [x] `update.ts` → `buildOracleUpdateTx(...)` in
    `offchain/cli/src/lib/transactions/build-oracle-update.ts`.
  - [x] `update-batch.ts` → `buildBatchOracleUpdateTx(...)` in
    `offchain/cli/src/lib/transactions/build-batch-oracle-update.ts`.
  - [x] `settle.ts` → `buildSettleTx(...)` in
    `offchain/cli/src/lib/transactions/build-settle.ts`.
- [x] Keep the existing CLI commands working as thin wrappers over the
  pure builders. Wrapper structure now uniform across all non-deploy txs:
  build → sign → submit → wait1 (`awaitTxConfirmation`) → wait2
  (`waitForWalletSettlement`) → wait3 (`waitForUnitUtxoReplacement` /
  `waitForOutRefAvailable` / `waitForOutRefGone`) → persist.
- [x] Export the pure builders from `offchain/cli/src/lib/index.ts` so
  `offchain/feeder/` can import them without reaching into private paths.
- [x] **Tx-construction audit (2026-05-21).** Confirmed no manual coin
  selection / collateral / change handling in any non-deploy tx; Lucid
  `.complete()` handles balancing throughout. Removed manual
  `fundingUtxos` from the three bootstraps
  (`config-bootstrap.ts`, `payment-hook-bootstrap.ts`,
  `receiver-bootstrap.ts`) and the forced `fundingUtxo` from the three
  reference-script publishes
  (`config-reference-scripts.ts`,
  `payment-hook-reference-script.ts`,
  `client-reference-scripts.ts`). Bootstraps keep their one-shot seed
  input (the parameterized minting-policy ref). Added
  `waitForOutRefAvailable` (wait 3 for ref-script publishes) and
  `waitForOutRefGone` (wait 3 for `pair-burn` and
  `reclaim-reference-script`) so every tx now ends with the same three
  waits regardless of whether the script UTxO is replaced, created, or
  destroyed.
- [ ] **(Deferred to Phase 4 acceptance)** Run `run-all-cli.sh` Preview
  end-to-end to validate the post-refactor wrappers; held back so the
  evidence captured in Phase 4 already includes the cleaned-up tx
  shapes.

**Acceptance**: pure builders importable from `offchain/feeder/`;
`run-all-cli.sh` deferred to Phase 4 acceptance window.

## Phase 3 — Feeder service implementation (`offchain/feeder/`)

Goal: ship the M2 daemon, **architecturally aligned with the DIA Spectra
Bridge** (`diadata-org/Spectra-interoperability/services/bridge`), so DIA
ops can configure it with the same router YAML shape they already use for
EVM destinations. See Annex C for the full Spectra↔Cardano mapping.

**Status**: unblocked 2026-05-21 — Phase 2 closed. Pure builders are
importable from `offchain/cli/src/lib/index.ts`.

Repo location is `offchain/feeder/` in this monorepo, sibling of
`offchain/cli/`. Pending **D4** confirmation.

### Target folder structure

```text
offchain/feeder/
├── README.md
├── package.json
├── tsconfig.json
├── Dockerfile
├── cmd/
│   └── feeder/main.ts                # entry: --config <dir> --log-level <lvl>
├── config/
│   ├── infrastructure.preview.yaml   # source RPC/WS, scanner, dedup, API, DB
│   ├── infrastructure.mainnet.yaml
│   ├── chains.yaml                   # DIA Testnet/Mainnet chain definitions
│   ├── events.yaml                   # IntentRegistered ABI + getIntent enrichment
│   ├── contracts.yaml                # OracleIntentRegistry per network
│   └── routers/
│       ├── client-a.preview.yaml
│       └── client-a.mainnet.yaml
└── src/
    ├── config/{loader,types,validate}.ts
    ├── source/{registry-client,scanner-http,scanner-ws,extractor}.ts
    ├── pipeline/{enricher,transformer,pipeline}.ts
    ├── processor/{dedup-cache,price-cache,event-processor}.ts
    ├── router/{registry,router,policy}.ts
    ├── submitter/{cardano-write-client,queue-manager,queue,inflight}.ts
    ├── persistence/{db,schema,migrations/}            # sqlite | postgres
    ├── api/{server,health,metrics,prices}.ts
    ├── ops/{logger,shutdown}.ts
    └── lib-bridge/index.ts            # re-export from offchain/cli/src/lib
```

The 5-file modular config layout (`infrastructure.yaml` + `chains.yaml` +
`contracts.yaml` + `events.yaml` + `routers/*.yaml`) **mirrors Spectra's
`ModularLoader` exactly**, so DIA's existing router YAMLs can be dropped
into `config/routers/` with only the destination block adapted.

### Sub-phases (each is a mergeable PR)

#### Phase 3.0 — Bootstrap (`offchain/feeder/`) — **done 2026-05-21**

- [x] Create the package: `package.json`, `tsconfig.json`,
  matching `offchain/cli/` conventions (NodeNext, strict, target ES2022).
- [x] `src/lib-bridge/index.ts` stub. The actual cross-package wiring
  to `buildOracleUpdateTx`, `buildBatchOracleUpdateTx`, `buildSettleTx`
  is deferred to Phase 3.4 (when there is something to call) to keep
  3.0 self-contained.
- [x] `cmd/feeder/main.ts`: arg parsing (`--config`, `--log-level`,
  `--help`), graceful shutdown on SIGINT/SIGTERM, no-op start that
  logs the parsed args.
- [x] Multi-stage `Dockerfile` skeleton (filled out further in 3.6).
- [x] `README.md` + `.gitignore`.

**Acceptance**: `npm run feeder:dev -- --help` prints CLI usage; `tsc
--noEmit` exits 0.

#### Phase 3.1 — Modular config — **done 2026-05-21**

- [x] `src/config/types.ts`: TypeScript mirror of Spectra's
  `modular_types.go` / `event_definitions.go` (`InfrastructureConfig`,
  `ChainConfig`, `ContractConfig`, `EventDefinition`, `RouterConfig`,
  `RouterTriggers`, `TriggerCondition`, `RouterDestination`).
- [x] `src/config/yaml-fs.ts`: shared FS + YAML helpers (`readYaml`,
  `readYamlIfExists`, `readYamlTopLevelMap`, `fileExists`,
  `directoryExists`) — every load path goes through these so error
  messages always carry the file path.
- [x] `src/config/loader.ts`: load the 5-file modular layout, glob
  `routers/*.yaml`, merge into a typed object; tolerate the three
  router YAML shapes Spectra has shipped (`router:`, `routers:`,
  `config.routers:`).
- [x] `src/config/issues.ts`: `IssueCollector` with scoped prefixes
  and `required` / `oneOf` assertion helpers — keeps the per-section
  validators terse and consistent.
- [x] `src/config/validate.ts`: per-section validators
  (`validateInfrastructure`, `validateChainsMap`,
  `validateContractsMap`, `validateEventDefinitionsMap`,
  `validateRoutersMap`) plus stricter Cardano-destination checks
  (reject EVM `method:`, validate `cardano:` block shape).
- [x] `src/config/index.ts`: single public re-export surface.
- [x] `RouterDestination` carries a Cardano-specific `cardano:` block
  (parallel to the EVM `method:` block) declaring `network`,
  `client_state_path`, `protocol_state_path`, `tx_mode: single|batch`.
- [x] `cmd/feeder/args.ts` + `cmd/feeder/validate-cmd.ts` split out of
  `main.ts` so the entry point is a thin orchestrator.
- [x] Bootstrap configs: `infrastructure.preview.yaml`,
  `infrastructure.mainnet.yaml`, `chains.yaml`, `contracts.yaml`,
  `events.yaml`, `routers/client-a.preview.yaml`.

**Acceptance**:
`npm run feeder:dev -- --config ./config --validate-only` on the
shipped sample configs reports `0 error(s), 0 warning(s)` for both
`CARDANO_NETWORK=Preview` and `CARDANO_NETWORK=Mainnet`; a smoke test
with an intentionally bad router file surfaces 3 errors + 1 warning at
correctly-scoped paths (`routers.<id>.triggers.events`,
`routers.<id>.triggers.conditions[0].operator`,
`routers.<id>.destinations[0]`, `routers.<id>.private_key_env`).

#### Phase 3.2 — Source pipeline + dual transport (HTTP + WS) — **done 2026-05-22**

- [x] `src/source/abi.ts`: typed (`as const`) ABI fragments for
  `IntentRegistered` and `getIntent`. Source-of-truth signature
  verified against the deployed testnet registry — the event is
  `IntentRegistered(bytes32 indexed intentHash, string indexed symbol, uint256 indexed price, uint256 timestamp, address signer)`.
- [x] `src/source/env.ts`: per-network env resolver (`envVarFor`,
  `requireNetworkEnv`, `readNetworkEnv`) used by every source-side
  module to keep the `_TESTNET` / `_MAINNET` suffix scheme in one place.
- [x] `src/source/registry-client.ts`: narrow `RegistryClient` facade
  with HTTP and WS factories (`createHttpRegistryClient`,
  `createWsRegistryClient`); exposes `getHeadBlockNumber`,
  `getIntentRegisteredLogs`, `getIntent`, `close`.
- [x] `src/source/extractor.ts`: ABI decode `IntentRegistered`
  topics and data into the canonical `ExtractedEvent`.
- [x] `src/source/checkpoint.ts`: JSON-backed `Checkpoint` (atomic
  write via temp file + rename, default path
  `state/<network>/feeder-checkpoint.json`); DB-backed variants land
  in Phase 3.5 behind the same interface.
- [x] `src/source/scan-handler.ts`: shared decode, checkpoint
  advance, and delivery, used by both scanners (no duplication
  between transports).
- [x] `src/source/scanner-http.ts`: `eth_getLogs` polling with
  per-confirmation finalisation trail, chunked range fetches, and
  abort-aware sleep.
- [x] `src/source/scanner-ws.ts`: WebSocket subscription via
  `watchEvent`, auto-reconnect with budget, abort-aware shutdown;
  fails over to throwing on budget exhaustion so the supervisor can
  switch to HTTP.
- [x] `src/pipeline/enricher.ts`: `createRegistryEnricher` calls
  `getIntent(intentHash)` to enrich each event with the full
  `OracleIntent`.
- [x] `src/pipeline/transformer.ts`: identity transformer with an
  explicit "no transformations yet" guard so silent expectations
  cannot creep in.
- [x] `src/processor/dedup-cache.ts`: in-memory LRU + TTL keyed on
  `intentHash`; `stats()` ready for `/metrics`.
- [x] `cmd/feeder/args.ts`: `--scan`, `--transport <http|ws>`, and
  `--dry-run` flags added; mutually exclusive with `--validate-only`.
  `DRY_RUN=true` env var is honoured for Spectra parity.
- [x] `cmd/feeder/scan-cmd.ts`: composes scanner + dedup + enricher
  end-to-end; wires the abort signal from `main.ts` for graceful
  shutdown; prints each enriched intent as a one-line summary + JSON
  for grep ergonomics.

**Acceptance** (verified 2026-05-22 against live DIA testnet):

`npm run feeder:dev -- --config ./config --scan --transport http`
ingests live `IntentRegistered` events, enriches each via
`getIntent(intentHash)`, and prints them; observed real symbols
`KERNEL/USD`, `NEIRO/USD`, etc., with valid prices, timestamps,
signers, and full EIP-712 signatures. A restart resumes from the
persisted `state/<network>/feeder-checkpoint.json`. The WS transport
without `DIA_WS_CREDENTIAL_<network>` fails loudly with the missing
env var name (live WS smoke test is gated on the operator setting
the credential).

#### Phase 3.2.5 — Config canonicalisation (YAML = single source of truth) — **done 2026-05-22**

**Why this phase exists.** Phase 3.2 shipped working but left two
honest defects that contradict the goal of Spectra-shape parity:

1. The runtime ABI was a TypeScript `as const` constant
   (`src/source/abi.ts`), not the YAML's `events.yaml::IntentRegistered::abi`.
   Editing the YAML therefore did **not** change the feeder's
   behaviour. This betrays the modular design — DIA's bridge uses the
   YAML ABI at runtime so legacy support, contract upgrades, and
   schema migrations all happen via config swap.
2. Public source-side coordinates (`chain_id`, `rpc_urls`, `ws_url`,
   `registry address`) were declared twice — once in env
   (`DIA_RPC_URL_*`, `DIA_REGISTRY_ADDRESS_*`, etc.) and once in YAML
   (`infrastructure.yaml::source`, `chains.yaml`, `contracts.yaml`).
   Two sources of truth for the same fact.

This phase fixes both. Rules:

- **The YAML directory is the single source of truth** for every
  public data point: chain ids, RPC URLs, WS URLs, registry
  addresses, ABIs, EIP-712 domain, explorer URLs.
- **`.env` carries only secrets and operational selectors.** Concretely:
  - selectors: `CARDANO_NETWORK`, `CARDANO_PROVIDER`, `LOG_LEVEL`, `DRY_RUN`;
  - secrets: `BLOCKFROST_PROJECT_ID_*`, `CARDANO_WALLET_SEED_*`,
    `CARDANO_PRIVATE_KEY_*`, `DIA_WS_CREDENTIAL_*`, `DATABASE_DSN_*`;
  - daemon-only: `API_LISTEN_ADDR`, `API_ENABLE_CORS`,
    `METRICS_ENABLED`, `METRICS_NAMESPACE`, `DATABASE_DRIVER`,
    `DATABASE_PATH_*`.
- **No env interpolation in YAML.** No `${VAR}` substitution at load
  time. If two YAML files happen to repeat the same value (e.g.
  `chains.yaml::dia-testnet::rpc_urls` and
  `infrastructure.preview.yaml::source.rpc_urls`), that is **intentional
  parity with Spectra** — the upstream config layout duplicates the
  same way and it is left untouched.
- **No magic merging of network suffixes inside YAML.** Spectra ships
  one infrastructure file per deployment; we ship one per network
  (`infrastructure.preview.yaml`, `infrastructure.mainnet.yaml`)
  picked by `CARDANO_NETWORK`. The files are mostly identical but
  carry different `source` blocks. This matches Spectra's
  one-deployment-one-file model.

Tasks (gated on operator approval before any code change):

- [x] **Delete the TS ABI source-of-truth.** Remove
  `offchain/feeder/src/source/abi.ts`. Any module that imported from
  it now reads the ABI from the loaded `ModularConfig`.
- [x] **Extend the loader** to parse the ABI strings declared in
  `events.yaml` (one entry per `event_definitions.<name>.abi` plus
  `event_definitions.<name>.enrichment.abi`) and in `contracts.yaml`
  (one entry per `contracts.<id>.abi`). Parsed ABIs are attached to
  the same `ModularConfig` object the validator already produces,
  under a new `parsedAbis` field, so downstream code never re-parses.
- [x] **`src/source/extractor.ts`** receives the parsed event ABI
  from the config and uses it with viem instead of importing from
  `abi.ts`. Type assertions replace the `as const` inference at the
  decode boundary.
- [x] **`src/source/registry-client.ts`** takes the source chain
  coordinates from the loaded config:
  - `chain_id`, `rpc_urls`, `ws_url` from `infrastructure.yaml::source`,
  - `registryAddress` from the entry in `contracts.yaml` whose
    `chain_id` matches `infrastructure.yaml::source.chain_id` (and
    whose `type` is `registry`).
- [x] **`src/pipeline/enricher.ts`** consumes the enrichment ABI
  from `event_definitions.IntentRegistered.enrichment.abi` instead
  of the hardcoded `GET_INTENT_FUNCTION`.
- [x] **Validator** is extended:
  - every `event_definitions.<name>.abi` must parse as valid JSON
    and describe exactly one event input;
  - every `contracts.<id>.abi` must parse as valid JSON and contain
    the methods/events referenced from `event_definitions`;
  - the loader fails loudly on parse errors with a `file:fragment`
    pointer.
- [x] **Delete env vars that duplicate YAML facts**, from
  `offchain/feeder/.env.example`:
  - `DIA_SOURCE_CHAIN_ID_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.chain_id` and in
    `chains.yaml`.
  - `DIA_RPC_URL_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.rpc_urls` and in
    `chains.yaml`.
  - `DIA_WS_URL_TESTNET` / `_MAINNET` — lives in
    `infrastructure.<network>.yaml::source.ws_url`.
  - `DIA_REGISTRY_ADDRESS_TESTNET` / `_MAINNET` — lives in
    `contracts.yaml::<id>.address`.
- [x] **Delete env vars the feeder does not consume**:
  - `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION` — the EIP-712 domain is
    needed by intent signers (the CLI) and by on-chain verifiers
    (the Cardano `Config` datum). The feeder consumes intents
    already signed and verified; it never reaches for the domain.
- [x] **Keep**, unchanged, the env vars that are not present in
  Spectra's YAML schema:
  - `DIA_EXPLORER_URL_TESTNET` / `_MAINNET` — informational only
    (used in future link rendering for logs and `/prices`). Spectra
    does not catalogue explorer URLs in `chains.yaml`; we therefore
    do **not** invent that field — the value stays in env.
  - all secrets and selectors listed earlier in this section.
- [x] **`src/source/env.ts`** survives but loses every `DIA_*` helper
  for fields that moved into YAML. The explorer-URL reader stays
  (env-only). Only the secret + selector readers + explorer reader
  remain.
- [x] **`src/source/registry-client.ts::resolveRegistryCoordinates`**
  is replaced by a `resolveSourceFromConfig(config: ModularConfig)`
  helper that pulls every coordinate from the YAML.
- [x] **No new fields are added to any YAML schema.** The
  `chains.yaml`, `contracts.yaml`, `events.yaml`, and
  `infrastructure.<network>.yaml` shapes match Spectra's upstream
  exactly. The only feeder-side schema extension is the `cardano:`
  block inside `RouterDestination` (a variant on an existing field,
  not a new field on the other config files).
- [x] **Update the validator's smoke-test fixture** so the bad-router
  test still passes after the schema tightening.
- [x] **Re-run `--validate-only` and `--scan --transport http`** as
  Phase 3.2 acceptance gates; both must still pass against the live
  testnet with the env-vars-deleted .env.

**Acceptance** (will be checked after implementation):

- `grep -rE "DIA_RPC_URL|DIA_REGISTRY_ADDRESS|DIA_SOURCE_CHAIN_ID|DIA_WS_URL|DIA_EXPLORER_URL|DIA_DOMAIN_(NAME|VERSION)" offchain/feeder/src offchain/feeder/cmd offchain/feeder/.env.example` returns **zero** matches.
- `npm run feeder:dev -- --config ./config --scan --transport http` against the live DIA testnet produces enriched intents — proving the ABI in `events.yaml` actually drives the decode and that the registry address in `contracts.yaml` actually drives `getIntent`.
- Editing the `IntentRegistered` ABI in `events.yaml` to a deliberately wrong shape (e.g. swap two parameter types) causes the next `--validate-only` to fail at load time, before the scanner connects. This is the regression test for "YAML changes change behaviour".

See **Annex D** for the conceptual rationale and the env-vs-YAML
field map.

#### Phase 3.3 — Router + policy gating

- [ ] `src/router/registry.ts`: collect enabled routers; index by event
  name; provide `dispatch(event)`.
- [ ] `src/router/router.ts`: evaluate `triggers.conditions` (operator `in`,
  `eq`, `gt`, etc. — match the operator set used by Spectra).
- [ ] `src/router/policy.ts`: `time_threshold` and `price_deviation` gating
  per destination, with the cache of last (price, timestamp) per
  `(routerId, destination, symbol)` — mirror Spectra's
  `DestinationState`.
- [ ] `src/processor/price-cache.ts`: shared cache feeding both
  `router/policy.ts` and the `/prices` API endpoint.

**Acceptance**: with a loaded router, `feeder scan --dry-run` annotates
each intent with `routed:<routerId>:<destination>` or
`filtered:<reason>`.

#### Phase 3.4 — Cardano write client + queue

- [ ] `src/submitter/cardano-write-client.ts`: one instance per
  `(network, clientId)`; consumes the Cardano destination block from
  `RouterDestination.cardano`; calls `buildOracleUpdateTx` or
  `buildBatchOracleUpdateTx` from `lib-bridge`.
- [ ] `src/submitter/queue-manager.ts`: per-`(updaterWallet, receiverUnit)`
  FIFO queue (Cardano analogue of Spectra's per-`(wallet, chainID)`
  queue).
- [ ] `src/submitter/queue.ts`: serial executor (sign → submit →
  `awaitTxConfirmation` → `waitForUnitUtxoReplacement`).
- [ ] `src/submitter/inflight.ts`: in-memory + DB-backed table of
  in-flight txs; blocks reuse of a `receiverUnit` until the previous
  tx confirms; rebuild-from-tip policy on timeout.

**Acceptance**: against the Lucid Emulator (re-using the M1 harness),
scan + route + submit produces the expected oracle-update txs for a
recorded `IntentRegistered` fixture.

#### Phase 3.5 — Persistence + API + metrics

- [ ] `src/persistence/db.ts`: pluggable adapter,
  `DATABASE_DRIVER=sqlite|postgres`. SQLite is the default (single
  file in `state/<network>/feeder.sqlite`); Postgres opt-in via DSN.
- [ ] `src/persistence/schema.ts` + `migrations/`: tables `processed_events`,
  `chain_state`, `transaction_log` (Cardano-adapted: txHash hex,
  outRef columns for receiver/pair); migrations runnable on both
  engines.
- [ ] `src/api/server.ts`: HTTP server (default `:8080`).
- [ ] `src/api/health.ts`: `/healthz` (liveness), `/readyz` (registry
  reachable + last submission age within budget).
- [ ] `src/api/metrics.ts`: `/metrics` (Prometheus, `prom-client`):
  counters (events_scanned, events_dedup_hit, intents_routed,
  intents_filtered, cardano_tx_submitted, cardano_tx_confirmed,
  cardano_tx_failed) + histograms (intent-to-confirm latency).
- [ ] `src/api/prices.ts`: `/prices` returning the `price-cache`
  contents (per `(clientId, symbol)`: last price, timestamp,
  intentHash, txHash) — same shape as Spectra's `/prices`.

**Acceptance**: `curl :8080/healthz`, `/readyz`, `/metrics`, `/prices`
all respond; a feeder restart resumes from `chain_state.last_processed_block`;
switching `DATABASE_DRIVER` between sqlite and postgres in
`infrastructure.yaml` works without code changes.

#### Phase 3.6 — Dockerization

- [ ] Fill in multi-stage `Dockerfile`.
- [ ] `docker-compose.yml` (dev) with two profiles: `sqlite` (no extra
  service) and `postgres` (postgres-15 sidecar). Mount `config/`
  read-only.
- [ ] `README.md` with `cp .env.example .env`, `docker-compose --profile sqlite up`,
  pointers to the operator runbook.

**Acceptance**: `docker-compose --profile sqlite up` brings the feeder
up; `--profile postgres up` brings it up with a Postgres sidecar; both
serve `/healthz` on port 8080.

#### Phase 3 acceptance (rolled up)

`npm run feeder:dev -- --config offchain/feeder/config/` against
`CARDANO_NETWORK=Preview` scans the live DIA testnet registry over both
HTTP and WS, applies routers, gates by `time_threshold` /
`price_deviation`, and submits Cardano Preview update transactions for
the 10 Catalyst pairs; restart resumes from persisted state; metrics
and `/prices` track every intent end-to-end.

## Phase 4 — End-to-end validation on Preview ↔ DIA testnet

Goal: produce reviewer-ready M2 evidence on Preview before touching mainnet.

Depends on **D5** (updater wallet custody) and **D6** (cadence).

- [ ] Configure the Preview routes for the 10 Catalyst-referenced pairs.
- [ ] Run the feeder against Cardano Preview + DIA testnet for a
  multi-day window. Capture:
  - [ ] daemon logs (structured JSON, daily rotation),
  - [ ] every Cardano `update` / `update:batch` tx hash with the
    originating `intentHash` and `signer`,
  - [ ] uptime stats (target ≥ 99.9% for the window),
  - [ ] freshness stats (per-pair p50/p95 latency from
    `IntentRegistered` to Cardano confirmation),
  - [ ] anomaly events (skipped intents, retries, failures).
- [ ] Settle accrued fees periodically and capture the settle tx hashes.
- [ ] Package evidence under
  `docs/milestones/evidence/m2-preview-<YYYYMMDD-HHMMSS>/` with the same
  layout used by the M1 evidence packs.
- [ ] Record a short demo video showing the live dashboard, the feed
  status for the 10 pairs, and a few representative tx hashes on
  Cardanoscan + the DIA testnet explorer.

**Acceptance**: evidence pack contains verified tx hashes for each of the
10 pairs, structured logs covering the full window, and a demo video that
matches the milestone wording.

## Phase 5 — Cardano Mainnet rollout

Goal: deliver the Catalyst-required mainnet evidence.

Depends on **D1**, **D5** confirmed for mainnet. Blocked until Phase 4
(feeder end-to-end on Preview) is complete.

- [ ] Submit `config:update` on **Cardano Mainnet** with
  `source_chain_id = 1050`,
  `verifying_contract = 0x5612599CF48032d7428399d5Fcb99eDcc75c06A7`,
  `authorized_dia_public_keys = [02fa12f4143fca6652fa5a365fd1ada14495aab0dd3c1e568755e2230b38a4706d, 02571284d2657052e68dc506c879f710d997a9801a5502339ff22f26bf85b958bd]`.
  Capture evidence under `docs/milestones/evidence/m2-config-update-mainnet-<date>/`.
- [ ] Regenerate any test fixtures that hard-code `sourceChainId = 100640`
  and the prior `verifyingContract`. Targets:
  `offchain/cli/src/__tests__/run-tests.ts`, `oracle/intent-create.ts`,
  `core/dia-intent.ts`, `init/protocol-init.ts`,
  `init/config-update-create.ts` (and any others surfaced by `grep`).
- [ ] Re-run the Aiken contract test suite and the off-chain Lucid emulator
  benchmark against the regenerated fixtures; fail the phase if any test
  regresses.
- [ ] Verify Phase 1 mainnet `config:update` is in place (done above).
- [ ] Promote the feeder config to `feeder.mainnet.yaml` and target the
  mainnet registry `0x5612…06A7` on `https://rpc.diadata.org`.
- [ ] Run the feeder against Cardano Mainnet + DIA mainnet for the
  Catalyst evidence window. Capture the same artifact set as Phase 4
  but tagged `mainnet`.
- [ ] Package evidence under
  `docs/milestones/evidence/m2-mainnet-<YYYYMMDD-HHMMSS>/`.
- [ ] Update the M2 Proof-of-Achievement document and submit to Catalyst.

**Acceptance**: verified Cardano Mainnet tx hashes covering the 10
Catalyst pairs over the evidence window; M2 PoA submitted.

---

## Workstream B/F items folded into M2

Some Workstream B (off-chain CLI) and Workstream F (deployment / docs) tasks
naturally finish during M2 and are tracked here so they do not slip:

- [ ] Developer documentation aligned with M2 acceptance criteria
  (oracle configuration, all relevant smart contracts, integration
  example for the feeder), published on the DIA developer documentation
  website (Workstream F).
- [ ] `run-all-cli.sh` updated so the Preview end-to-end smoke test
  exercises the post-Phase-2 pure builders (Workstream B).

## Annex A — Env hygiene (network endpoints out of code)

Goal: eliminate every hardcoded network endpoint, chain id, registry
address, RPC/WS/explorer URL from the CLI source so that switching
between Cardano Preview ↔ DIA Testnet and Cardano Mainnet ↔ DIA Mainnet
is a single env flip (`CARDANO_NETWORK`). Implemented as part of M2
because the feeder (Phase 3) will read the same env block.

**Scheme:** one `.env`, suffix `_TESTNET` / `_MAINNET` on **every**
endpoint, credential and secret. `CARDANO_NETWORK` is the only
unsuffixed variable; it selects which suffix the code reads.
`CARDANO_NETWORK=Preview` → `*_TESTNET`; `CARDANO_NETWORK=Mainnet` →
`*_MAINNET`. This lets a single `.env` carry both environments' creds
side by side; switching networks is a one-line change.

Full env block (added to / replacing `offchain/cli/.env.example`):

```dotenv
# Active network selector. ONLY unsuffixed variable in the file.
# Supported: Preview | Mainnet. Drives which *_TESTNET / *_MAINNET
# values the CLI reads.
CARDANO_NETWORK=Preview

# Cardano provider switch. Network-agnostic.
CARDANO_PROVIDER=Blockfrost   # Blockfrost | Koios

# --- Cardano — Testnet (Preview) ---
BLOCKFROST_PROJECT_ID_TESTNET=
BLOCKFROST_API_URL_TESTNET=https://cardano-preview.blockfrost.io/api/v0
KOIOS_API_URL_TESTNET=https://preview.koios.rest/api/v1
CARDANO_WALLET_SEED_TESTNET=
CARDANO_PRIVATE_KEY_TESTNET=

# --- Cardano — Mainnet ---
BLOCKFROST_PROJECT_ID_MAINNET=
BLOCKFROST_API_URL_MAINNET=https://cardano-mainnet.blockfrost.io/api/v0
KOIOS_API_URL_MAINNET=https://api.koios.rest/api/v1
CARDANO_WALLET_SEED_MAINNET=
CARDANO_PRIVATE_KEY_MAINNET=

# --- DIA source — Testnet (paired with Cardano Preview) ---
DIA_SOURCE_CHAIN_ID_TESTNET=10050
DIA_RPC_URL_TESTNET=https://testnet-rpc.diadata.org
DIA_WS_URL_TESTNET=wss://testnet-rpc.diadata.org
DIA_REGISTRY_ADDRESS_TESTNET=0xF8c614A483A0427A13512F52ac72A576678bE317
DIA_EXPLORER_URL_TESTNET=https://testnet-explorer.diadata.org
DIA_EVM_PRIVATE_KEY_TESTNET=
DIA_WS_CREDENTIAL_TESTNET=

# --- DIA source — Mainnet (paired with Cardano Mainnet) ---
DIA_SOURCE_CHAIN_ID_MAINNET=1050
DIA_RPC_URL_MAINNET=https://rpc.diadata.org
DIA_WS_URL_MAINNET=wss://rpc.diadata.org
DIA_REGISTRY_ADDRESS_MAINNET=0x5612599CF48032d7428399d5Fcb99eDcc75c06A7
DIA_EXPLORER_URL_MAINNET=https://explorer.diadata.org
DIA_EVM_PRIVATE_KEY_MAINNET=
DIA_WS_CREDENTIAL_MAINNET=

# --- DIA EIP-712 domain (network-independent) ---
DIA_DOMAIN_NAME=DIA Oracle
DIA_DOMAIN_VERSION=1.0

# --- Tx confirmation timeouts (network-agnostic, optional) ---
# TX_CONFIRMATION_PRIMARY_TIMEOUT_MS=180000
# TX_CONFIRMATION_KOIOS_ATTEMPTS=60
# TX_CONFIRMATION_KOIOS_DELAY_MS=3000
# TX_CONFIRMATION_BLOCKFROST_ATTEMPTS=30
# TX_CONFIRMATION_BLOCKFROST_DELAY_MS=6000
```

Tasks (implemented 2026-05-21):

- [x] Add `pickNetworkEnv(name)` helper in
  `offchain/cli/src/core/config.ts` that reads `<name>_TESTNET` when
  `CARDANO_NETWORK=Preview` and `<name>_MAINNET` when
  `CARDANO_NETWORK=Mainnet`.
- [x] Extend `getCliConfig()` to centralize **every** per-network
  read: Blockfrost project id and API URL, Koios API URL, wallet
  seed / private key, DIA chain id / RPC / WS / registry / explorer,
  DIA EVM private key, DIA WS credential, DIA EIP-712 domain.
- [x] Refactor every consumer (`core/lucid.ts`, `oracle/intent-sign.ts`,
  `init/protocol-init.ts`, `oracle/intent-create.ts`,
  `scripts/tools/probe-dia-ws.ts`, `scripts/emulator-benchmark.ts`,
  `scripts/run-all-cli.sh`) so that no `process.env.<unsuffixed>` read
  remains for per-network vars.
- [x] Strip the obsolete chain-id `100640` and registry address from
  the CLI usage example in `offchain/cli/src/index.ts`; point the user
  at `.env` for canonical defaults.
- [x] Replace `offchain/cli/.env.example` with the full block above so
  a fresh `cp .env.example .env` carries every endpoint pre-filled;
  operators only fill secrets (Blockfrost project ids, wallet seeds,
  signing keys).

**Out of scope (tracked in Phase 5):** test fixtures in
`offchain/cli/src/__tests__/run-tests.ts` still carry the legacy
`sourceChainId = 100640`. They are regenerated during Phase 5 alongside
the Mainnet `config:update`, as already listed in that phase's tasks.

**Acceptance**: `grep -rE "(diadata\\.org|0xF8c614|0x5612599|100640|1050|10050)" offchain/cli/src offchain/cli/scripts` returns
only test files (`__tests__/`) and no source-code matches outside them.

## Annex B — DIA Spectra Bridge: canonical reference for the feeder

The Cardano feeder follows the DIA Spectra Bridge architecture so DIA ops
can configure it with the same operational primitives they use for EVM
destinations.

**Canonical source:** `diadata-org/Spectra-interoperability/services/bridge`
(Go service). Confirmed 2026-05-21 by `gh api` inspection of the repo;
the `config.feeder.txt` example provided by the client matches the
`RouterConfig` schema defined in
`services/bridge/config/event_definitions.go` and
`services/bridge/config/modular_types.go`.

**Why other DIA / Protofire feeders are NOT relevant references:**

- `protofire/dia-xrpl-feeder`, `diadata-org/soroban-oracle-feeders` →
  legacy pre-Spectra pattern, poll `api.diadata.org` REST directly. Not
  intent-based.
- `diadata-org/dia-kadena-oracles`, `protofire/dia-midnight-oracle` →
  on-chain contracts + deploy CLI only; no daemon/feeder.
- `diadata-org/decentral-data-feeder` (Lumina) → a different DIA product
  (decentralized feeder network), unrelated architecture.

The Spectra Bridge is currently **EVM-only**; our Cardano feeder is the
first non-EVM consumer of `OracleIntentRegistry`.

## Annex C — Spectra Bridge → Cardano feeder mapping

Component-level parallelism. Left column is the Spectra reference, right
is what the Cardano feeder does in `offchain/feeder/src/`.

| Spectra (Go) | Cardano feeder (TS) | Notes |
| --- | --- | --- |
| `cmd/bridge/main.go` (`--config <dir>`) | `cmd/feeder/main.ts` | Same flag surface (`--config`, `--log-level`). Daemon, no subcommands. |
| `config/modular_loader.go` + 5 YAML files | `src/config/loader.ts` + same 5 YAML files | `infrastructure.yaml`, `chains.yaml`, `contracts.yaml`, `events.yaml`, `routers/*.yaml`. |
| `config/event_definitions.go` (RouterConfig) | `src/config/types.ts` (same shape) | DIA's existing router YAMLs drop in unchanged except destination block. |
| `internal/scanner/block_scanner_enhanced.go` | `src/source/scanner-http.ts` | `eth_getLogs` polling with checkpoint persistence. |
| `internal/bridge/event_source.go` (WS) | `src/source/scanner-ws.ts` | WebSocket subscribe + reconnect + HTTP fallback. |
| `internal/pipeline/extractor.go` | `src/source/extractor.ts` | ABI decode `IntentRegistered` topics+data. |
| `internal/pipeline/enricher.go` | `src/pipeline/enricher.ts` | `getIntent(intentHash)` view-call. |
| `internal/pipeline/transformer.go` | `src/pipeline/transformer.ts` | Stub; placeholder for future transforms. |
| `internal/processor/dedup_cache.go` | `src/processor/dedup-cache.ts` | LRU+TTL keyed on `intentHash`. |
| `internal/processor/price_cache.go` | `src/processor/price-cache.ts` | Last `(price, ts)` per `(routerId, dest, symbol)`. |
| `internal/processor/generic_event_processor.go` | `src/processor/event-processor.ts` | Central loop. |
| `pkg/router/generic_router.go` (dispatch) | `src/router/router.ts` | Trigger evaluator + destination iterator. |
| `pkg/router/generic_registry.go` | `src/router/registry.ts` | Enabled routers keyed by event. |
| Router `DestinationState` + `time_threshold` + `price_deviation` | `src/router/policy.ts` | Identical gating semantics. |
| `internal/bridge/write_client.go` (EVM ABI calls) | `src/submitter/cardano-write-client.ts` | **Adapted.** Consumes `buildOracleUpdateTx` / `buildBatchOracleUpdateTx` from `offchain/cli/src/lib/`. |
| `internal/contracts/nonce_manager.go` | (n/a) — replaced by UTxO in-flight lock | Cardano has no nonce; serialization key is `(updaterWallet, receiverUnit)`. |
| `internal/transaction/queue_manager.go` (per `(wallet, chainID)`) | `src/submitter/queue-manager.ts` (per `(updaterWallet, receiverUnit)`) | Same FIFO-per-key shape, different key. |
| `internal/transaction/queue.go` / `executor.go` | `src/submitter/queue.ts` | Serial: sign → submit → `awaitTxConfirmation` → `waitForUnitUtxoReplacement`. |
| `internal/database/schema.go` (Postgres) | `src/persistence/{db,schema,migrations}.ts` | **Dual driver.** SQLite default; Postgres opt-in via `DATABASE_DRIVER=postgres`. Same logical tables: `processed_events`, `chain_state`, `transaction_log` (Cardano-adapted columns). |
| `internal/api/server.go` (`/healthz`, `/prices`, etc.) | `src/api/{server,health,metrics,prices}.ts` | Same endpoints + `/metrics` via `prom-client`. |
| `internal/metrics/collector.go` | `src/api/metrics.ts` | Counters + histograms; same naming where it makes sense. |
| `internal/cron/cron_service.go` (mandatory periodic update) | (deferred to M3) | Spectra fires periodic updates if no event was seen for `time_threshold`. Out of M2 scope. |
| `internal/leader/onchain_monitor.go` (replica failover) | (deferred to M3) | Active-passive HA needs ≥2 instances; single-node is fine for M2 evidence. |
| `internal/processor/event_worker_pool.go` + `parallel_pipeline.go` | (deferred) | Optimization; sequential processing is enough until QPS demands otherwise. |

**RouterDestination extension for Cardano.** Spectra's destination block
hard-codes EVM concepts (`chain_id`, `contract`, `method.abi`,
`method.params`). For Cardano we ship a parallel `cardano:` block; both
forms can coexist in the same YAML so DIA can copy an EVM router and
just swap the destination payload:

```yaml
# EVM destination (Spectra-native)
destinations:
  - chain_id: 50312
    contract: 0xCACc...
    method:
      name: handleIntentUpdate
      abi: '{"name":"handleIntentUpdate", ...}'
      params: { intent: ${enrichment.fullIntent} }

# Cardano destination (added by this feeder)
destinations:
  - cardano:
      network: Preview                                    # Preview | Mainnet
      client_state_path: state/preview/clients/client-a.json
      protocol_state_path: state/preview/config-bootstrap.json
      tx_mode: single                                      # single | batch
    time_threshold: 1m
    price_deviation: "0.1%"
```

When the dispatcher sees `destination.cardano`, it routes to
`CardanoWriteClient`; when it sees `destination.method`, it errors out
loudly (we don't silently no-op EVM destinations — that would mask
misconfiguration).

## Annex D — Config canonicalisation: YAML as single source of truth

### Background

Phase 3.2 shipped a feeder that scans and enriches `IntentRegistered`
end-to-end. During operator review, two architectural defects
surfaced:

1. The runtime ABI was hard-coded in
   `offchain/feeder/src/source/abi.ts` as a TypeScript `as const`
   constant. The same ABI also appeared in
   `offchain/feeder/config/events.yaml` and
   `offchain/feeder/config/contracts.yaml`, but those copies were
   **inert** — nothing in the runtime read them. Editing the YAML
   had no effect on decoding.
2. Public source-side coordinates (DIA chain id, RPC URL, WS URL,
   registry address, explorer URL, EIP-712 domain) were declared in
   **both** `.env` (`DIA_RPC_URL_*` etc.) and YAML
   (`infrastructure.yaml::source`, `chains.yaml`, `contracts.yaml`).
   Two sources of truth for the same fact.

Both defects break the modularity spirit Spectra's design carries.
In the upstream DIA Bridge the YAML ABI is read at runtime by
`services/bridge/internal/pipeline/extractor.go` and
`services/bridge/internal/pipeline/enricher.go`, and the contract
addresses come from `contracts.yaml` — never from env.

Phase 3.2.5 fixes both defects.

### Decision

**YAML is the single source of truth for every public data point.**
`.env` carries only secrets and operational selectors. There is no
env-to-YAML interpolation: if a value appears in two YAML files (the
way Spectra's own configs do — `chains.yaml::dia-testnet::rpc_urls`
and `infrastructure.yaml::source.rpc_urls` carry the same string),
that repetition is intentional and inherited from upstream. Drift is
caught by the validator (Phase 3.2.5 tightens it).

### Env-vs-YAML field map

| Field | Source of truth |
| --- | --- |
| DIA source chain id | `infrastructure.<network>.yaml::source.chain_id` (also catalogued in `chains.yaml`) |
| DIA source RPC URLs | `infrastructure.<network>.yaml::source.rpc_urls` (also `chains.yaml::<id>.rpc_urls`) |
| DIA source WS URL | `infrastructure.<network>.yaml::source.ws_url` |
| DIA registry address | `contracts.yaml::<id>.address` (the entry whose `chain_id` matches `source.chain_id` and whose `type` is `registry`) |
| DIA explorer URL | `chains.yaml::<id>.explorer_url` (field added in 3.2.5) |
| `IntentRegistered` ABI | `events.yaml::event_definitions.IntentRegistered.abi` (authoritative; runtime parses + uses) |
| `getIntent` ABI | `events.yaml::event_definitions.IntentRegistered.enrichment.abi` (authoritative) |
| EIP-712 domain (name, version) | `contracts.yaml::<id>.eip712_domain.{name,version}` (field added in 3.2.5; feeder does not use it at runtime but a sibling CLI/monitor reads from the same place) |
| Active network selector | `.env::CARDANO_NETWORK` (only) |
| Provider selector | `.env::CARDANO_PROVIDER` (only) |
| Log level | `.env::LOG_LEVEL` or `--log-level` flag |
| Dry-run flag | `.env::DRY_RUN` or `--dry-run` flag |
| API listen addr / CORS | `.env::API_LISTEN_ADDR`, `API_ENABLE_CORS` |
| Metrics enabled / namespace | `.env::METRICS_ENABLED`, `METRICS_NAMESPACE` |
| Database driver | `.env::DATABASE_DRIVER` |
| SQLite path | `.env::DATABASE_PATH_<network>` |
| Postgres DSN (contains password) | `.env::DATABASE_DSN_<network>` |
| Blockfrost project id | `.env::BLOCKFROST_PROJECT_ID_<network>` |
| Updater wallet seed / PK | `.env::CARDANO_WALLET_SEED_<network>` / `CARDANO_PRIVATE_KEY_<network>` |
| DIA WS credential | `.env::DIA_WS_CREDENTIAL_<network>` |

### Env vars removed by Phase 3.2.5

These are deleted from `offchain/feeder/.env.example` because they
duplicate YAML facts:

- `DIA_SOURCE_CHAIN_ID_TESTNET`, `DIA_SOURCE_CHAIN_ID_MAINNET`
- `DIA_RPC_URL_TESTNET`, `DIA_RPC_URL_MAINNET`
- `DIA_WS_URL_TESTNET`, `DIA_WS_URL_MAINNET`
- `DIA_REGISTRY_ADDRESS_TESTNET`, `DIA_REGISTRY_ADDRESS_MAINNET`
- `DIA_EXPLORER_URL_TESTNET`, `DIA_EXPLORER_URL_MAINNET`
- `DIA_DOMAIN_NAME`, `DIA_DOMAIN_VERSION`

The CLI (`offchain/cli/.env.example`) keeps these vars because the
CLI's roles include intent signing — which **does** require the
EIP-712 domain and the registry address at runtime. The feeder does
not sign intents, only consumes them already signed; the feeder
therefore drops the EVM-side env block entirely.

### Why we keep five YAML files (not collapse to two)

A simpler design — fold `chains.yaml`, `contracts.yaml`,
`events.yaml` into a single combined file or into env — was
considered and rejected. The modular split exists in Spectra for
three reasons the feeder will eventually need:

1. **Contract version coexistence.** A future
   `IntentRegistryV2` would be a second entry in `contracts.yaml`
   and a parallel `IntentRegisteredV2` entry in `events.yaml`, with
   legacy routers still referencing the V1 names. Collapsing the
   files makes this expansion painful.
2. **Multiple event types.** When DIA adds `IntentCanceled` or
   `IntentReplaced`, `events.yaml` gains entries with their own
   ABIs and enrichment routing.
3. **Ops / engineering separation.** Routers (`routers/`) belong to
   ops; events and contracts belong to engineering. Folding them
   into one file mixes change-control boundaries.

The redundancy between files (RPC URLs in both `chains.yaml` and
`infrastructure.yaml::source`) is upstream behaviour and is left
as-is: validation runs at load time, drift fails loudly.

### Acceptance regression for "YAML changes change behaviour"

After 3.2.5 lands, the following operator workflow must work
end-to-end without any code change:

```sh
# 1. Edit the IntentRegistered ABI in events.yaml to add a fictional
#    `uint256 epoch` field at the end of the inputs list.
$ $EDITOR offchain/feeder/config/events.yaml

# 2. The validator catches the mismatch (the contract still emits
#    the original shape, so live logs won't decode against the new
#    ABI) — fails before the scanner connects.
$ npm run feeder:dev -- --config ./config --validate-only
[feeder] [ERROR] event_definitions.IntentRegistered.abi:
        decoded payload length 160 bytes does not match expected layout for the
        declared ABI (extra `epoch` input declared but absent on chain).

# 3. Revert events.yaml. Validation passes, scanner picks up logs
#    again.
$ git checkout offchain/feeder/config/events.yaml
$ npm run feeder:dev -- --config ./config --validate-only
[feeder] validation: 0 error(s), 0 warning(s).
```

(The exact diagnostic wording is illustrative — the implementation
decides the precise check, e.g. a sanity decode against a known
log fixture at validate time.)

## Open questions for DIA (extension of the D-list above)

These come out of the Spectra-alignment analysis and need DIA's input
before Phase 3.1 (`routers/*.yaml` schema is finalized) and Phase 4
(live evidence window):

- [ ] **D7 — Feeder operator.** Will DIA operate the Cardano feeder
  themselves (like they operate the EVM bridge), or does Protofire
  run it? Affects who owns `config/routers/*.yaml` and the updater
  wallet custody policy. Blocks Phase 3 finalization.
- [ ] **D8 — `customer` field semantics.** In Spectra Bridge the
  `customer` router field is a metrics label only — confirm we should
  preserve it as a label and that it does not gate routing for our
  feeder either.
- [ ] **D9 — Customer → pair mapping for M2.** Which `customer`
  identifiers and which pairs per customer for the 10 Catalyst-listed
  pairs in M2? Needed to write `config/routers/*.preview.yaml`.
  Blocks Phase 4 routes config.
- [ ] **D10 — Gating granularity.** In Spectra `time_threshold` and
  `price_deviation` are per destination, shared across all symbols
  matched by `triggers.conditions`. Confirm this matches DIA's intent,
  or whether they want per-`(destination × symbol)` granularity for
  Cardano.

## Out of scope for M2

These belong to M3 (monitoring) or M4 (final close-out) and are not gating
M2 acceptance:

- Production-grade alerting / on-call rotation.
- Long-running uptime SLA contracts.
- The 2,500+ price feeds catalogue and self-serve request flow (M4).

## Reference index

- Conceptual reference: [`milestone-2-feeder-strategy.md`](./milestone-2-feeder-strategy.md)
- Catalyst milestone text: [`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md) (M2)
- Cross-workstream plan: [`work-plan.md`](./work-plan.md) (Workstream C)
- Architecture: [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- M1 mainnet evidence (with the `100640` config that Phase 1 supersedes):
  [`../milestones/evidence/m1-mainnet-20260517-063917/`](../milestones/evidence/m1-mainnet-20260517-063917/)
