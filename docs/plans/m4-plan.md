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
- [x] **Monitoring stack** (M3 machinery): 3 dashboards, 13 alerts, Alertmanager →
  webhook → `alert_log` pipeline, per-feed sanity check. See [`m3-plan.md`](./m3-plan.md).

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

- [ ] **Per-pair query surface** — latest price, timestamp, nonce, signer, and intent
  hash from live Pair UTxOs.
- [ ] **Client-level query surface** — Receiver balance, subscribed pairs, accrued fees
  per Hook.
- [ ] **Integration examples** for Cardano dApp developers.
- [ ] **On-chain consumption example** (minor) — a small consumer script/validator
  reading a Pair UTxO as a reference input, to ship with the integration examples. No
  first-party example exists today (only Spectra reference material).

### 2 · Feeder stability hardening

- [ ] Drive down the daemon crash-recovery / WASM self-exit loop (hundreds of restarts in
  the Preview pack window). The self-exit guard exists
  ([`src/submitter/wasm-failure-guard.ts`](../../offchain/feeder/src/submitter/wasm-failure-guard.ts)),
  but the root cause of the recurrent WASM build failures must be diagnosed and fixed so a
  long mainnet window can hit the 99.99% uptime bar. This is feeder code, not ops, and it
  is the **prerequisite** for any credible sustained-uptime number.

### 3 · Sustained mainnet run + 99.99% uptime/accuracy evidence

- [ ] A longer production-style window against the mainnet contracts, with confirmed-tx
  logs, monitoring attached, and an uptime/accuracy report meeting the **99.99%** bar (the
  headline M4 acceptance number). M2 already proved a short live mainnet feeder run; this
  is the long clean window, only credible after the stability work above.

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
</content>
