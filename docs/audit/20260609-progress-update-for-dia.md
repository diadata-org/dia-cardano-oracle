# Progress Update for DIA — toward Milestone 2 delivery (and beyond)

**Date:** 2026-06-09 · **Status:** progress summary for DIA review · **Audience:** DIA + PROTOFIRE
**Purpose:** a single place to see where the project stands since the June 5 feeder
presentation — what changed, what is ready for the Milestone 2 submission, and what remains for
Milestones 3 and 4.

This is a status note, not a remediation document. Every claim links to the in-repo source.

## Contents

- [TL;DR](#tldr)
- [What changed since June 5](#what-changed-since-june-5)
- [Milestone 2 status](#milestone-2-status)
- [Plan once you approve](#plan-once-you-approve)
- [ADA we will need](#ada-we-will-need)
- [Fees](#fees)
- [What remains for M3 and M4](#what-remains-for-m3-and-m4)
- [Document map](#document-map)

## TL;DR

- The **feeder runs end-to-end on Preview**: it reads DIA intents and produces confirmed Cardano
  oracle updates for the ten feeds. The Milestone 2 Preview evidence pack is captured.
- A large amount of the work for **Milestones 3 and 4 is already in the codebase** (monitoring
  machinery, dashboards, alerts, teardown, mainnet rollout plan). What remains is mostly the
  Mainnet run, the Proof-of-Achievement documents, QA artifacts, the indexer, and the videos.
- **Contracts were upgraded**: full asset burns with better ADA recovery on teardown, and a
  per-client deposit address so a client can fund with an ordinary wallet payment.
- For Milestone 2 the only remaining items are the **PoA document** and the **demo video**; the
  on-chain Mainnet evidence run is what produces them.

## What changed since June 5

- **Contracts — side deposits and teardown burns.** Clients now have a dedicated **deposit
  address**: they can top up their balance with an ordinary wallet payment, and the feeder
  **sweeps that deposit into the client's balance automatically, in the same transaction as an
  update**. Decommissioning now **burns all protocol assets and recovers the locked ADA**. See
  [`20260605-receiver-concurrency-and-griefing.md`](./20260605-receiver-concurrency-and-griefing.md)
  (client-funding usability) and
  [`20260607-contract-teardown-ada-recovery.md`](./20260607-contract-teardown-ada-recovery.md).
- **Shared codebase — CLI as a library.** The feeder now consumes the CLI's transaction builders
  as an imported package, shipped as a single Docker image. This is the shared-codebase split that
  lets future integrations reuse the same tooling.
- **Run-scoped shared state.** CLI and feeder now share one run-scoped state layout, so a run's
  deployment artifacts and feeder state live together and survive restarts.
- **On-chain validation of updates.** Before submitting, the feeder now **validates each oracle
  update against the live on-chain pair datum**, rejecting stale or inconsistent intents at the
  source.
- **Push policy — fewer transactions, on purpose.** The decision of *when* to push is now a
  configurable OR-gate (price deviation + cron heartbeat), documented mode by mode in
  [`20260609-feeder-push-policy-config.md`](./20260609-feeder-push-policy-config.md).
- **Observability.** Clearer dashboards plus a **new per-transaction dashboard**, and an alert
  catalog generated from `monitoring/alerts.yml`.
- **Hardening and tests.** An adversarial-audit remediation pass landed (117 Aiken tests plus
  feeder integration tests), tightening validation and error handling across the stack.

## Milestone 2 status

Essentially complete. The Preview evidence pack is captured —
[`m2-preview-20260609-132545`](../milestones/evidence/m2-preview-20260609-132545/milestone-2-preview-evidence.md)
— with per-pair confirmed-transaction counts, sample tx hashes verifiable on Cardanoscan,
end-to-end latency, failures by error code, and both Grafana dashboards embedded.

Remaining for the submission:

- **`milestone-2-poa.md`** — the Proof-of-Achievement document, mirroring the accepted Milestone 1
  PoA.
- **Demo video** — a short walkthrough of the system feeding the ten price feeds with the live
  dashboards and alert behaviour.

Both are produced from the Mainnet run described next.

## Plan once you approve

Once you approve the current state, the sequence to close Milestone 2 on Mainnet is:

1. **Teardown the Milestone 1 Mainnet deployment** — burn the protocol assets and **recover the
   locked ADA** (see the teardown note).
2. **Deploy the new contracts on Mainnet** — protocol, client, and the ten pairs, with the current
   contract upgrades.
3. **Run the feeder on Mainnet** for a short evidence window (target ~1 h 30 m).
4. **Generate the final Mainnet evidence pack and the Milestone 2 PoA**, then record the demo
   video.

## ADA we will need

The headline: **we already control enough ADA on Mainnet to fund almost the entire cycle by
recycling it.** A small top-up plus a margin is all we expect to request. The figures below are
grounded in a live Mainnet query of the existing Milestone 1 deployment and in real run/teardown
evidence on Preview.

### What we control on Mainnet today

Live query of the Milestone 1 deployment (operator wallet + the protocol's script addresses):

| Location | ADA | Recoverable by teardown? |
| --- | --- | --- |
| Operator wallet | 80.80 | already free |
| Reference scripts (`reference_holder`) | 134.24 | **yes — full** (reclaim) |
| Pairs (10 NFTs) | 50.00 | **yes — full** (`pair:burn`) |
| Receiver (balance + min-UTxO) | 47.55 | balance **yes** (`receiver:withdraw`); min-UTxO no |
| Payment hook (accrued + min-UTxO) | 7.45 | accrued **yes** (`payment-hook:withdraw`); min-UTxO no |
| Config (min-UTxO) | 5.00 | **no** |
| **Total controlled** | **325.04** | |

> **Note on funding origin.** The initial Mainnet allocation from DIA was **245 ADA**. An
> additional **100 ADA was added by the operator** (Manuel Padilla / Protofire) to ensure the
> Milestone 1 run had enough margin. Those 100 ADA are part of the 325.04 total above and
> **must be reimbursed** via the current ADA request — they are not absorbed project cost and
> are included explicitly in the request below.

### What teardown of the old deployment recovers (and what it cannot)

The current Mainnet contracts predate the `Burn` redeemers. As documented in
[`20260607-contract-teardown-ada-recovery.md`](./20260607-contract-teardown-ada-recovery.md), the
teardown runs in `--skip-singleton-burns` mode for them: it reclaims all reference scripts in full,
burns every pair in full, and drains the receiver balance and the hook's accrued fees. The only ADA
it **cannot** recover is the **min-UTxO of the three singleton NFTs** (config, payment hook,
receiver), because those old policies have no burn action and their datums have no spend redeemer to
release the ADA — that min-ADA stays locked permanently.

- **Recovered to the wallet:** ≈ 134.24 (reference scripts) + 50.00 (pairs) + ≈ 42.55 (receiver
  balance) + ≈ 2.45 (hook accrued) ≈ **≈ 229 ADA**.
- **Permanently stuck:** the three singleton min-UTxOs ≈ **≈ 15 ADA** (config 5 + hook 5 +
  receiver ≈ 5).
- **Teardown transaction fees:** ≈ **10 – 15 ADA** (~20 txs).

After teardown we therefore have **≈ 295 – 300 ADA back in the operator wallet** (the 80.80 already
free plus ≈ 229 recovered, less fees).

> **Future teardowns recover even more.** The redeployed contracts add a `Burn` path to config,
> payment hook and receiver. So the *next* teardown (of the deployment we are about to stand up)
> recovers those three min-UTxOs too, leaving no per-deployment floor of stuck ADA beyond dust. The
> ≈ 15 ADA stuck is a one-time cost of the **old** Milestone 1 deployment only.

### What the new cycle costs

- **Redeploy (full `run-all`, current contracts).** The same end-to-end bootstrap + exercise we run
  on Preview executes **31 CLI transactions** (measured from `m1-preview-20260608-040304`):

  | Phase | Txs | Tx fees (non-recoverable) | Capital locked (recoverable) |
  | --- | --- | --- | --- |
  | Protocol bootstrap (config, hook, receiver, ref scripts) | 7 | ≈ 3.65 ADA | ≈ 30–40 ADA |
  | Pair bootstrap (11 pairs × 1 update tx) | 11 | ≈ 8.97 ADA | ≈ 55 ADA (5 ADA/pair NFT) |
  | Exercise: batch-10 update, settle, withdraw, reclaim | 8 | ≈ 5.78 ADA | — (funds returned to wallet) |
  | Deposit demo (fund × 3, merge, update-fold) | 5 | ≈ 1.88 ADA | — |
  | **Total** | **31** | **≈ 20.3 ADA** | **≈ 230–250 ADA** |

  The **≈ 20 ADA in tx fees is permanently spent** (network cost — not capital). The locked capital
  (min-UTxO in script UTxOs + pair NFTs) is **fully recoverable** on the next teardown because the
  new contracts include the `Burn` redeemers the old ones lacked.

- **Feeder operation.** Recurring network fees for the ~1 h 30 m evidence window: **≈ 29 – 42 ADA**
  (see [`20260609-mainnet-cost-forecast.md`](./20260609-mainnet-cost-forecast.md)); budget ~50 ADA.

### The number to present

Because teardown returns **≈ 295 – 300 ADA** to the wallet *before* we redeploy, the new cycle is
funded almost entirely by recycling existing ADA. The **only money that is permanently spent** is the
network transaction fees:

| Item | ADA | Recoverable? |
| --- | --- | --- |
| Available after teardown | ≈ +298 | — |
| Redeploy locked capital (min-UTxO + pair NFTs) | ≈ −240 | **Yes** — next teardown |
| **Redeploy tx fees (31 txs, non-recoverable)** | **≈ −20** | **No — permanently spent** |
| Feeder operation fees (~1 h 30 m, non-recoverable) | ≈ −50 | No — permanently spent |
| **Net gap to fund (protocol only)** | **≈ −12** | — |
| **Operator personal contribution to reimburse** | **≈ −100** | Must be returned |
| **Margin (fee variability + stuck ADA + buffer)** | **≈ −88** | — |
| **Total request from DIA** | **≈ −200** | — |

> **Request: 200 ADA from DIA.** Two distinct components:
>
> **100 ADA — operator reimbursement.** The initial DIA allocation was 245 ADA. The operator
> added 100 ADA of personal funds to cover the Milestone 1 Mainnet run. This is a debt to the
> operator, not a project surplus, and must be returned in full now.
>
> **100 ADA — protocol operating budget.** Covers the ≈ 12 ADA net operating gap (teardown +
> redeploy tx fees + feeder operation) plus a margin for the ≈ 15 ADA permanently stuck in the
> old Milestone 1 singleton UTxOs, fee variability, and any feeder runtime beyond 1 h 30 m.
>
> The **true unrecoverable cost** of the whole cycle (Milestone-1-teardown → redeploy →
> Milestone-2 run) is ≈ 35 – 40 ADA in tx fees (≈ 20 redeploy + ≈ 15 stuck ADA from old
> singletons) plus feeder operation fees; everything else circulates back to the wallet.

We will confirm exact figures against a fresh live query before requesting the transfer.

## Fees

Lowering on-chain fees matters for the protocol's economics, and there is genuine room to do so
without sacrificing security — see
[`20260530-deep-research-lower-fee-report.md`](./20260530-deep-research-lower-fee-report.md). To set
expectations clearly: **fee reduction is not a requirement of Milestones 2, 3 or 4**. We will pursue
a few of the lower-risk improvements opportunistically, but it is not on the delivery critical path.

## What remains for M3 and M4

Grounded in [`../plans/m3-m4-plan.md`](../plans/m3-m4-plan.md),
[`../plans/work-plan.md`](../plans/work-plan.md), and
[`../plans/milestone-feeder-plan.md`](../plans/milestone-feeder-plan.md):

**Milestone 3 (Monitoring Library)** — the monitoring machinery already exists; what remains is
validation artifacts and a live-Mainnet demonstration:

- QA validation report (end-to-end ingestion + alert triggering + per-feed sanity checks).
- Captured alert-trigger logs (each alert actually firing).
- Uptime and accuracy report over a sustained window.
- Live Mainnet monitoring demonstration and an M3 demo video.
- `milestone-3-poa.md`.

**Milestone 4 (End-to-End Integration and Mainnet Deployment)** — most net-new work lives here:

- **Indexer** — the largest remaining net-new code deliverable. A per-pair query surface (latest
  price/timestamp/nonce/signer/intent-hash from live Pair UTxOs) plus a client-level view and
  integration examples; it underpins the "how any developer requests any of DIA's feeds"
  documentation. Not started yet.
- **Sustained Mainnet operation with 99.99% uptime/accuracy** — the headline M4 acceptance number.
  As a prerequisite we must **drive down the daemon's crash-recovery / WASM self-exit restarts**
  seen in the Preview window before a long Mainnet run can meet the bar.
- Sample-live-feeds + contract-addresses document, developer documentation published on DIA's site
  (consolidated and deferred to M4 per the accepted M1 precedent), the close-out report and video,
  and `milestone-4-poa.md`.

## Document map

- **Architecture:** [`../architecture/feeder.md`](../architecture/feeder.md) ·
  [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- **Operator manual:** [`../../offchain/feeder/README.md`](../../offchain/feeder/README.md)
- **Plans:** [`../plans/work-plan.md`](../plans/work-plan.md) ·
  [`../plans/milestone-feeder-plan.md`](../plans/milestone-feeder-plan.md) ·
  [`../plans/m3-m4-plan.md`](../plans/m3-m4-plan.md)
- **Audits:** [`20260609-feeder-push-policy-config.md`](./20260609-feeder-push-policy-config.md) ·
  [`20260607-contract-teardown-ada-recovery.md`](./20260607-contract-teardown-ada-recovery.md) ·
  [`20260605-receiver-concurrency-and-griefing.md`](./20260605-receiver-concurrency-and-griefing.md) ·
  [`20260530-deep-research-lower-fee-report.md`](./20260530-deep-research-lower-fee-report.md) ·
  [`20260609-mainnet-cost-forecast.md`](./20260609-mainnet-cost-forecast.md)
- **Security:** [`../security/security-notes.md`](../security/security-notes.md)
- **Milestones:** [`../milestones/final-cardano-milestones.md`](../milestones/final-cardano-milestones.md) ·
  [`m2-preview-20260609-132545`](../milestones/evidence/m2-preview-20260609-132545/milestone-2-preview-evidence.md)
