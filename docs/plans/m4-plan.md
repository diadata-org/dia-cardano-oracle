# Plan — Milestone 4 (End-to-End Integration and Mainnet Deployment)

What is left for **Milestone 4 — End-to-End Integration and Deployment on Cardano
Mainnet**, grounded in the official Catalyst wording
([`final-cardano-milestones.md`](../milestones/final-cardano-milestones.md)) and the
accepted PoA format
([`milestone-1-poa.md`](../milestones/milestone-1-poa.md) /
[`milestone-2-poa.md`](../milestones/milestone-2-poa.md)).

M4 is where the most net-new work lives: a sustained mainnet operation meeting the
uptime bar, the **indexer**, and the consolidated documentation/closeout. Tasks: `[x]`
done · `[ ]` open · `[~]` partial.

## Contents

- [Plan — Milestone 4 (End-to-End Integration and Mainnet Deployment)](#plan--milestone-4-end-to-end-integration-and-mainnet-deployment)
  - [Contents](#contents)
  - [What M4 asks for](#what-m4-asks-for)
  - [Already built](#already-built)
  - [What remains](#what-remains)
    - [1 · Indexer (the largest net-new code deliverable)](#1--indexer-the-largest-net-new-code-deliverable)
    - [2 · Feeder stability hardening](#2--feeder-stability-hardening)
    - [3 · Sustained mainnet run + 99.99% uptime/accuracy evidence](#3--sustained-mainnet-run--9999-uptimeaccuracy-evidence)
    - [4 · Sample live feeds + contract addresses](#4--sample-live-feeds--contract-addresses)
    - [5 · Developer documentation published on DIA's site](#5--developer-documentation-published-on-dias-site)
    - [6 · Final close-out report + video](#6--final-close-out-report--video)
    - [7 · milestone-4-poa.md](#7--milestone-4-poamd)
    - [8 · Heavier verification drills](#8--heavier-verification-drills)
  - [Dependencies and ordering](#dependencies-and-ordering)
  - [Annex A — Indexer design](#annex-a--indexer-design)

## What M4 asks for

Official outputs: **contracts · feeders · monitoring stack · deployment scripts · sample
live feeds · contract addresses · developer documentation** (incl. how any developer
requests any of DIA's 2,500+ price feeds / 10,000+ RWA feeds) **· final close-out report
· final closeout video.**

Acceptance: stable operation with **99.99% uptime and accuracy**; contracts + feeders +
monitoring working together; documentation published on DIA's site.

## Already built

- [x] **Aiken contracts deployed and exercised on Mainnet** (M1: bootstrap, single +
  10-pair batch update, settle, withdrawals, reference-script reclaim/republish, burn —
  see the M1 PoA).
- [x] **Feeder service + CLI tooling exercised on Mainnet** (M2:
  `m2-mainnet-20260616-074413` — 10 DIA mainnet RWA feeds, 23 confirmed txs, 0 reorgs),
  plus the longer Preview QA/video run and `milestone-2-poa.md`.
- [x] **Multi-router / multi-client operation, validated.** Multiple routing lanes can
  share one client and multiple clients run side by side; configuration guard-rails reject
  cross-client and symbol-collision misconfigurations
  ([`config/__tests__/validate.test.ts`](../../offchain/feeder/src/config/__tests__/validate.test.ts)),
  the per-lane serial queue enforces mutual exclusion between a client's updates, and
  Preview exercises a two-lane client (majors / alts) plus a second client
  (`client-test-02`) with single-transaction multi-receiver settle
  ([`settle-manifest.ts`](../../offchain/cli/src/preflight/settle-manifest.ts)). Covered by
  the feeder test suite (531 cases).
- [x] **Monitoring stack — Milestone 3 DELIVERED** ([`milestone-3-poa.md`](../milestones/milestone-3-poa.md),
  submission commit `7749df6`): 3 dashboards, 13 alerts, Alertmanager → webhook → `alert_log`
  pipeline (API-exposed via `GET /api/v1/alerts`), per-feed sanity check; validated live on
  **Mainnet** (ARS/USDT — 7 confirmed, 0 reorgs, accuracy PASS, alert fired→resolved) and
  Preview. See [`_archived/m3-plan.md`](_archived/m3-plan.md).

## What remains

### 1 · Indexer (the largest net-new code deliverable)

**Confirmed absent today.** The only "indexer" references in the repo are to the external
chain indexer (Blockfrost/Koios) the CLI waits on — not a service of ours.

**Why it is its own deliverable, and how it differs from the feeder API we already have.**
The feeder already exposes an HTTP API, but that API looks **inward, from the feeder's own
point of view**: `/api/v1/prices` serves the feeder's **in-memory cache** of what it
pushed, and the rest serves its internal database (events it processed, transactions it
submitted, its alert log, its health). It is a **producer/operator** API — "what did this
feeder do, what is in its cache, is it healthy" — and it only knows the clients that
feeder manages, and only answers while the daemon is running.

The **indexer looks outward, from the consumer's point of view**. Its source of truth is
the **live Pair UTxOs on Cardano**, not any feeder's memory. It reads and decodes the
on-chain datum and answers "what does the chain say right now" — for any published pair,
independent of whether our feeder is up. That is the layer a Cardano dApp developer needs,
and it is exactly what the M4 acceptance requires ("how any developer requests and
consumes any of the 2,500+ feeds"); you cannot answer that with "query my feeder's cache".

| | Feeder API (today) | Indexer (M4) |
| --- | --- | --- |
| Source of truth | feeder's cache / internal DB | the live Pair UTxOs on-chain |
| Viewpoint | producer / operator ("what I pushed") | consumer ("what is on-chain now") |
| Depends on | the feeder daemon running | only the chain (anyone can run it) |
| For | operating the service | a dApp / developer reading a feed |
| Scope | the clients this feeder manages | any pair published on-chain |

Some on-chain **reading** code already exists but for a different purpose and will be
reused: the CLI's [`reconcile/pair-state.ts`](../../offchain/cli/src/lib/reconcile/pair-state.ts)
reads live Pair UTxOs and decodes the datum but reconciles **nonce only** (no
price/timestamp), and the M3 sanity check already decodes pairs against the DIA source.
The indexer reuses that decoder but as a **consumer-facing query service**, which does not
exist today.

**Task list** (build order; full design in [Annex A](#annex-a--indexer-design)):

- [x] **A1 · Shared datum decoders — DONE.** The pure `decodePairDatum` /
  `decodeReceiverDatum` / `decodePaymentHookDatum` now live in
  [`cli/src/core/datum-decoders.ts`](../../offchain/cli/src/core/datum-decoders.ts) — it
  imports only `@lucid-evolution/plutus` (the CBOR codec, not the full lucid/provider stack),
  the hex normaliser, and type-only shapes, so the indexer can decode chain datums without
  pulling in tx-building/wallets. `chain-helpers.ts` re-exports them for its existing call
  sites (one canonical impl); exposed via the CLI `./core/datum-decoders` export. The feeder
  switched to the lightweight path. No behaviour change (existing round-trip tests still pass;
  added a direct-module equivalence test).
- [ ] **A2 · Chain-reader port + standalone provider** — a `ChainReader` interface
  (`utxosAt(address)`, `tip()`) with a Blockfrost/Koios implementation that needs **only a
  provider key**, not the feeder daemon. Mirrors the sanity-check's injectable `utxosAt`
  ([`feed-sanity.ts`](../../offchain/feeder/src/sanity-check/feed-sanity.ts)).
- [ ] **A3 · Index service** (TDD with a fake reader) — `listPairs()`, `getPair(symbol)`,
  `getClient(clientId)` combining the protocol registry + reader + decoders. Source of truth
  = the live Pair / Receiver / Hook UTxOs.
- [ ] **A4 · HTTP API** (`node:http`, same as the feeder) — `GET /v1/pairs`,
  `/v1/pairs/{symbol}`, `/v1/pairs/{symbol}/utxo`, `/v1/clients/{clientId}`, `/v1/health`.
- [ ] **A5 · Registry config + README** — the published contract addresses / policy IDs the
  indexer reads (doubles as the §4 "contract addresses" deliverable).
- [ ] **A6 · Integration example (off-chain)** — a Lucid example that reads a Pair UTxO as a
  **reference input** and uses its price, for Cardano dApp developers.
- [ ] **A7 · On-chain consumption example** — a small Aiken validator that consumes a Pair
  UTxO as a reference input (a "price-gated" demo), shipped with the examples. No first-party
  example exists today (only Spectra reference material).

### 2 · Feeder stability hardening

- [x] **Cron in-flight guard — DONE** (commit `e9a468e`). The aligned-heartbeat cron re-fired a
  due pair on every ~30 s tick until a confirmation crossed the boundary, producing a burst of
  2-3 duplicate submissions per boundary (seen live on the mainnet ARS/USDT run). A persistent
  per-(router, dest, symbol) in-flight map now suppresses re-dispatch until the prior heartbeat
  confirms (priceCache advances) or a ceiling elapses. TDD'd; verified live: 1 push/boundary,
  `cron_resubmissions_total{outcome="skipped_in_flight"}`.
- [x] **Extend the in-flight guard to event↔cron collisions — DONE.** A shared
  `SymbolInflightTracker` (`src/submitter/symbol-inflight.ts`) keyed by
  (routerId, destinationIndex, symbol): the coalescer marks a pair when its batch **flushes**
  (covering BOTH event and cron submissions) and clears it after `onResult`, with a TTL safeguard
  (= `worker_pool.inflight_timeout_ms`) for the crash case. The cron consults it (`isInFlight`)
  and skips a due pair whose event-flow submission is still pending → `skipped_in_flight`, no
  duplicate the chain would reject as `NonMonotonicNonce`. TDD'd (tracker, coalescer mark/clear,
  cron skip). See
  [`_archived/20260614-190648-cron-event-flow-race-inflight-guard.md`](_archived/20260614-190648-cron-event-flow-race-inflight-guard.md).
- [~] Drive down the daemon crash-recovery / WASM self-exit loop (hundreds of restarts in
  the Preview pack window). **Restart driver diagnosed and fixed:** the recurrent restarts in
  that window were NOT the WASM guard — they were the scan pipeline exiting on a transient RPC
  rate-limit (next item, DONE), which is what produced the restart churn. The transient WASM
  build error itself is already mitigated by `completeWithRetry` (rebuild-on-detached-ArrayBuffer)
  and bounded by the self-exit guard
  ([`src/submitter/wasm-failure-guard.ts`](../../offchain/feeder/src/submitter/wasm-failure-guard.ts));
  its true root cause is an upstream `@lucid-evolution` WASM memory bug, not feeder logic, so
  there is no feeder-side root-cause fix beyond the existing retry. **Remaining:** confirm over a
  long mainnet window that restarts have flat-lined now that the scan pipeline no longer exits
  (tracked under §3, the sustained-run evidence).
- [x] **Scan pipeline must survive a transient RPC rate-limit instead of exiting — DONE.** The
  last line before every restart (21:31, 00:03, 02:32 UTC) was `daemon: scan pipeline failed —
  RPC Request failed … Rate Limit Exceeded` from the DIA testnet RPC (`testnet-rpc.diadata.org`,
  a keyless conduit.xyz node): a transient upstream rate-limit was treated as fatal, so the daemon
  exited and Docker restarted it (~every 2.5 h). `runHttpScanner` now classifies the error,
  counts it (`incRpcError`), and retries with exponential backoff (capped at
  `SCANNER_RPC_RETRY_MAX_MS`) instead of throwing — only a real abort breaks the loop. The daemon
  stays up across a transient RPC blip. TDD'd. Parallel ops mitigation: provision an API key for
  the DIA RPC.
- [x] **Reconcile the local UTxO view before building (stale-input failures) — DONE.** The
  `UtxoNotFound` failures in the pack were a single coalesced batch tx per lane built against a
  UTxO already spent on-chain (`BadInputsUTxO` / `TranslationLogicMissingInput`): after a restart
  / RPC turbulence the provider's indexer lagged the real chain and reported a UTxO the previous
  batch had already spent. The batch build+sign+submit is now wrapped in `withStaleInputReconcile`
  (`src/lib-bridge/reconcile-retry.ts`): on a stale-input rejection it waits
  `STALE_INPUT_RECONCILE_DELAY_MS` (indexer catch-up), re-fetches the script UTxO set fresh
  (config, receiver, pairs) and rebuilds — wallet inputs self-heal via lucid's fresh coin
  selection — up to `STALE_INPUT_RECONCILE_ATTEMPTS`, instead of failing the batch. Non-stale
  errors rethrow immediately; the happy path runs the closure once. TDD'd (classifier + retry
  helper). Downstream of the scan-pipeline fix above — eliminating the restart loop removes the
  main source of the drift; this is the defense-in-depth for residual RPC turbulence.
- [x] **Crash-recovery must verify "submitted" txs against the chain, not blind-fail them — DONE.**
  On restart, a tx left in `submitted` status was marked `failed / CrashRecovery` unconditionally,
  so a tx that DID land on-chain was recorded as a failure and never counted — under-reporting
  confirmed-count and uptime. The startup sweep now calls `recoverSubmittedTx`
  (`src/submitter/recover-submitted-tx.js`) which asks the chain via `isTxOnChain` (Koios +
  Blockfrost REST, in `cli/src/core/tx-onchain-check.ts`): a tx still on-chain → `confirmed`
  (counted); only one genuinely absent (or unverifiable) → `failed`, so the event flow
  re-processes it (idempotent on-chain). TDD'd. (Build-time reconcile stops spending stale UTxOs;
  this stops a restart from corrupting the confirmation count.)
- [x] **Provider consumption metrics + quota alerts (Blockfrost & Koios) — DONE.** New counter
  `dia_bridge_provider_requests_total{provider,method,outcome}` counts every Cardano API request
  (each retry attempt = one request = real quota consumption), `outcome ∈ {ok, rate_limited,
  quota_exceeded, error}`. It is fed by an observer on the same provider wrapper the CLI retry
  uses (`setProviderCallObserver`, registered by the daemon), so it covers the whole build/submit
  path with no per-call-site instrumentation. Four alerts in `monitoring/alerts.yml`, all with
  thresholds config-driven from `infrastructure.<network>.yaml::alerting.*` (single source of
  truth, generator-injected, threshold-drift-test-guarded — same machinery as every other alert):
  **ProviderRequestQuotaHighBlockfrost** / **ProviderRequestQuotaHighKoios** (warning, proactive —
  fire when 24 h requests cross `provider_request_quota_per_day_<provider>` ×
  `provider_request_quota_warn_ratio`, i.e. *before* the wall; this is the KPI/headroom signal),
  **ProviderQuotaWall** (critical, the hard 402 backstop), and **ProviderErrorRateHigh** (warning,
  error/429 share over `provider_error_rate_warn_ratio`). Per-provider daily limits are set to the
  plan's quota in YAML; exact remaining-quota is not exposed by the provider APIs, so the
  request-rate-vs-configured-quota projection is the actionable equivalent. TDD'd (classifiers +
  observer outcomes + threshold-drift guard extended for the per-provider product thresholds).
- [x] **Retry/backoff on one-shot CLI admin commands — DONE.** Instead of touching each of the
  ~16 `.submit()` call sites, the Lucid **provider itself** is wrapped (`createRetryingProvider`,
  `cli/src/core/provider-retry.ts`) at the single chokepoint where both factories build it
  (`makeRealConfiguredProvider` / `makeProviderWithConfig`). Every provider call — UTxO/wallet
  fetches during `.complete()`, `submitTx`, protocol-parameter lookups — retries transient
  transport errors (`fetch failed`, ECONNRESET, 503, 429, …) with exponential backoff
  (`PROVIDER_RETRY_ATTEMPTS` / `PROVIDER_RETRY_DELAY_MS`). Real ledger/validation errors and the
  402 quota wall rethrow immediately. `submitTx` retry is safe (resubmitting the identical signed
  tx is idempotent on its hash). The emulator factory is left unwrapped so tests never sleep.
  Covers every admin command AND the feeder's CLI-backed path. TDD'd.

### 3 · Sustained mainnet run + 99.99% uptime/accuracy evidence

- [~] A long production-style window meeting the **99.99%** uptime/accuracy bar (the headline
  M4 acceptance number), with confirmed-tx logs and monitoring attached. The run is already
  **set up and live**: same contracts as M2 (no redeploy, `m2-mainnet-20260616-074413`), a
  single feed (**ARS/USDT**) on a 30-min heartbeat. A short ~2.4 h clean bring-up is already
  captured (M3 mainnet pack: 7 confirmed, 0 failed, 0 reorgs, accuracy PASS). **What remains:**
  sustain it over a multi-day window once the stability fixes below land, then compute the
  uptime/accuracy number over that window.
- [x] **Retired the unused on-chain pairs — DONE.** All 20 mainnet Pair NFTs were burned
  (`pair:burn`, min-ADA recovered) and the feeder minted a single fresh feed, **ARS/USDT** —
  the symbol DIA publishes continuously on its mainnet registry. (BTC/USD and the crypto majors
  are **not** emitted on DIA mainnet; confirmed by `scan-dia-intents.ts` — see
  [`pair-selection-mainnet-20260616-074413`](../milestones/evidence/pair-selection-mainnet-20260616-074413/).)
  The mainnet router now tracks only ARS/USDT on a 30-min heartbeat.

### 4 · Sample live feeds + contract addresses

- [ ] Published list of mainnet contract addresses and live Pair UTxOs for the 10 feeds,
  with how-to-read instructions — the consumer-facing companion to the indexer.

### 5 · Developer documentation published on DIA's site

- [ ] The consolidated publication deferred from M1/M2/M3 (per the accepted M1 PoA),
  published once against the final stable surface: oracle configuration, on-chain
  contracts available for consumption, and the **procedure + timeline to request any of
  DIA's 2,500+ price feeds and 10,000+ RWA feeds**. In-repo docs stay complete at each
  milestone; only the external publication consolidates here.

### 6 · Final close-out report + video

- [ ] **Final close-out report** and **final closeout video**, plus the end-to-end
  install/access demo informing future adopters how to install the tooling and access the
  live oracles on mainnet.

### 7 · milestone-4-poa.md

- [ ] `docs/milestones/milestone-4-poa.md` mapping M4 acceptance → evidence: mainnet
  addresses, feeder logs, E2E results, uptime/accuracy report, the doc-site link, and the
  closeout links.

### 8 · Heavier verification drills

- [~] **Off-chain Lucid emulator adversarial matrix** — the happy-path orchestrator is
  delivered (`npm run benchmark:emulator`); finish the negative-case matrix (two-client
  parallelism, expired intent, stale bootstrap duplicate, NFT redirect, accrued drain,
  settle without admin signature, non-admin withdraw, duplicate live pair) if it is to
  back the E2E functional-verification claim.
- [ ] **File-source intent injection (E2E fault drill)** — a mechanism to drive the feeder
  from a file of hand-signed intents instead of the live DIA registry: pause the DIA read,
  feed pre-signed intents (built with the CLI wallet) for a window, then resume. This
  forces the *real* update path end-to-end with controlled inputs (stale, drifted,
  out-of-order) so accuracy/freshness alerts fire on genuine on-chain state, not just on
  synthetic metrics. Complements the M3 Pushgateway harness (which fires alerts at the
  metric layer); this exercises ingestion → submission → confirmation with manipulated
  data. Heavier (touches real state + ADA), hence M4.

## Dependencies and ordering

1. **Drive down daemon restarts** (stability hardening) — prerequisite for any credible
   sustained mainnet uptime window.
2. **Run the sustained mainnet window** — produces the uptime/accuracy evidence and the
   live-feeds/addresses material.
3. **Indexer** can proceed in parallel (independent of the live run); it gates the
   "request any feed" developer instructions and the integration examples.
4. **Documentation publication on DIA's site** and the **closeout report/video** land
   last, against the final stable surface.

## Annex A — Indexer design

The detailed design for [§1 · Indexer](#1--indexer-the-largest-net-new-code-deliverable).
It is grounded in code that already exists and is tested; the indexer is mostly a new
**consumer-facing query layer** over those primitives.

### A.1 Purpose and non-goals

**Purpose.** A read-only service whose **source of truth is the live on-chain Pair /
Receiver / PaymentHook UTxOs** — it answers "what does Cardano say right now" for any
published pair, **independent of whether our feeder is running**. This is the layer a
Cardano dApp developer consumes (the feeder API is producer/operator-facing; see the table
in §1).

**Non-goals.** It never builds or submits transactions, never manages clients, and never
depends on the feeder daemon. Anyone can run it with only a chain-provider key and the
published contract addresses.

### A.2 Architecture (layers, top → bottom)

| Layer | Responsibility | New / reuse |
| --- | --- | --- |
| **HTTP API** | Thin request handlers (`node:http`, same as the feeder — no new framework) | new |
| **Index service** | `listPairs()` / `getPair(symbol)` / `getClient(clientId)` — aggregate + shape | new |
| **Registry** | The protocol script identifiers (pair policy + validator addresses) for the network | reuse (from the deploy artifacts) |
| **Decode core** | `decodePairDatum`, `decodeReceiverDatum`, hook decoder, `pairId ↔ symbol` | **reuse** (pure fns) |
| **Chain-reader port** | `ChainReader { utxosAt(address), tip() }` over Blockfrost/Koios; **standalone** (no feeder) | new impl over an existing pattern |

The `ChainReader` is an interface so the index service is **unit-tested with a fake reader**
(no live chain) — exactly how [`feed-sanity.ts`](../../offchain/feeder/src/sanity-check/feed-sanity.ts)
already injects `utxosAt` + `decodePairDatum`.

### A.3 Data model (decoded, served)

- **Pair** — `{ symbol, pairId, price, timestamp, nonce, signer, intentHash, minUtxoLovelace,
  utxoRef: { txHash, outputIndex }, ageSeconds }`. All fields except `utxoRef`/`ageSeconds`
  come straight from `decodePairDatum`; `symbol` is `hex→utf8(pairId)`.
- **Client** — `{ clientId, receiverBalanceLovelace, accruedToHookLovelace, subscribedPairs }`
  from `decodeReceiverDatum` (+ the pairs published under that client).

### A.4 API surface (consumer-facing)

| Method · Path | Returns | Source |
| --- | --- | --- |
| `GET /v1/pairs` | every published pair: latest value + `utxoRef` | UTxOs at the pair validator address, filtered by the pair policy NFT |
| `GET /v1/pairs/{symbol}` | one pair's latest on-chain value + metadata | one Pair UTxO |
| `GET /v1/pairs/{symbol}/utxo` | the exact `TxIn` (txHash#ix) to use as a **reference input** | the Pair UTxO ref |
| `GET /v1/clients/{clientId}` | receiver balance, accrued-to-hook, subscribed pairs | Receiver + Hook UTxOs |
| `GET /v1/health` | provider reachable, chain tip, pair count | `tip()` |

### A.5 Reuse map

| Reuse (exists, tested) | Net-new (this milestone) |
| --- | --- |
| `decodePairDatum`, `decodeReceiverDatum`, hook decoder | `ChainReader` standalone provider (no feeder/daemon) |
| `pairId ↔ symbol` (hex⇆utf8) | index aggregation (`listPairs`/`getPair`/`getClient`) |
| injectable `utxosAt` pattern (sanity-check) | the `node:http` consumer API |
| contract addresses / policy IDs (deploy artifacts) | integration + on-chain consumption examples |

### A.6 Package layout

New package `offchain/indexer/` (parallel to `cli/` and `feeder/`):

```
offchain/indexer/
  src/
    chain-reader.ts        # ChainReader port + Blockfrost/Koios impl
    registry.ts            # network → { pairPolicyId, pairValidatorAddress, receiver/hook addrs }
    index-service.ts       # listPairs / getPair / getClient  (pure, fake-reader testable)
    http.ts                # node:http handlers
    __tests__/             # fake-reader unit tests + a live mainnet smoke test
  examples/
    read-pair-offchain.ts  # Lucid: reference-input read of a Pair UTxO (A6)
  README.md                # run instructions + the published contract addresses
```

The pure decoders move to a shared module (task **A1**) so the indexer imports them without
pulling in the whole CLI.

### A.7 On-chain consumption example (task A7)

A small Aiken validator under the contracts repo that takes a Pair UTxO as a **reference
input**, reads its `price`/`timestamp` from the inline datum, and gates its own spend on it
(e.g. "allow only if price ≥ X and timestamp is fresh"). It demonstrates the canonical
Cardano oracle-consumption pattern (reference inputs, no value moved from the oracle) and
ships next to the off-chain example (A6).

### A.8 How this satisfies "any of DIA's 2,500+ / 10,000+ feeds"

The indexer serves **whatever pairs exist on-chain** — it needs no change when a new feed is
added. Requesting a new feed is: a developer asks DIA to publish it → the feeder mints the
Pair UTxO → the indexer serves it immediately. So the indexer (consume) **plus** the
§5 "how to request a feed" instructions (the request/timeline procedure) together close the
M4 "request and consume any feed" requirement.

### A.9 Testing

Decode core + index service are unit-tested against a **fake `ChainReader`** (deterministic,
no live chain), mirroring the sanity-check test. HTTP handlers test against the fake service.
A single live smoke test hits the mainnet pair validator address to prove the standalone
provider decodes real UTxOs end-to-end.
</content>
