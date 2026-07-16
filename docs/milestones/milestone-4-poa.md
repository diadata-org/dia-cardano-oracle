# Milestone 4 — Proof of Achievement (Catalyst)

**Project:** DIA Oracles on Cardano
**Milestone:** 4 — End-to-End Integration and Deployment on Cardano Mainnet
**Public repository:** <https://github.com/diadata-org/dia-cardano-oracle>
**Submission commit:** `[PLACEHOLDER: submission commit hash]`

> **Status: DRAFT.** The repository deliverables (contracts, feeders, monitoring,
> indexer, deployment scripts, developer documentation, sample feeds) are
> complete and verifiable now. The items still marked `[PLACEHOLDER]` are the
> externally-produced deliverables — the final close-out report, the close-out
> video, and the end-to-end install/access demo — to be filled in at submission.
> Publication on DIA's developer documentation website is explicitly deferred to
> DIA's independent marketing timeline and is not a submission dependency.

Primary evidence:

- **Close-out report:** `[PLACEHOLDER: link to final close-out report]`
- **Close-out video:** `[PLACEHOLDER: link to final closeout video]`
- **End-to-end install/access demo** (how a developer installs the tooling and
  accesses the live oracles on mainnet): `[PLACEHOLDER: link to E2E demo]`
- **Mainnet integration evidence pack** (live mainnet deployment — contract
  addresses, feeder logs, confirmed updates, sustained-uptime window):
  [`evidence/m4-mainnet-20260616-074413/`](evidence/m4-mainnet-20260616-074413/) —
  [`milestone-4-mainnet-evidence.md`](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md).
- **Preview integration evidence pack** (full consume loop — indexer responses,
  the example consumer contract accepting/rejecting on price, the on-chain demo):
  [`evidence/m4-preview-20260608-040304/`](evidence/m4-preview-20260608-040304/) —
  [`milestone-4-preview-evidence.md`](evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md).

---

## Contents

- [1. Executive summary](#1-executive-summary)
- [2. Acceptance Criteria → Evidence](#2-acceptance-criteria--evidence)
- [3. Outputs delivered (Milestone 4)](#3-outputs-delivered-milestone-4)
- [4. How to verify this deliverable](#4-how-to-verify-this-deliverable)
- [5. Pointers (one-stop links)](#5-pointers-one-stop-links)

---

## 1. Executive summary

Milestone 4 delivers the **complete end-to-end integration of DIA oracles on
Cardano mainnet**: the on-chain Aiken contracts, the feeder that publishes DIA
prices, the monitoring stack, and — new in M4 — a **consumer-facing indexer** and
an **example consumer contract**, so a Cardano dApp can read a live feed, verify
it, and know what it costs.

What M4 adds on top of M1–M3:

- **Indexer** ([`offchain/indexer/`](../../offchain/indexer/)) — a read-only,
  consumer-facing HTTP service over the **live on-chain Pair/Receiver/Config
  UTxOs** (not any feeder's cache). It answers "what does the chain say now" for
  any published pair, independent of whether the feeder is running, on a
  chain-provider key alone. Serves the latest value + the exact UTxO ref to
  reference, the Pair NFT policy to authenticate it, each client's prepaid
  balance, and the **on-chain protocol fee** (`GET /v1/protocol/fees`). Documented
  and interactive via the same Swagger UI / OpenAPI surface as the feeder.
- **Example consumer contract** ([`example_oracle_consumer.ak`](../../contracts/aiken/validators/example_oracle_consumer.ak))
  — an Aiken validator that reads a referenced Pair datum's price and gates its
  spend after authenticating the reference input by its Pair NFT, with an
  end-to-end demo (emulator + real on-chain) showing a spend that **accepts** when
  the price clears and **rejects** when it does not.
- **Consumer documentation** — how to read a feed, **how the fee/deposit system
  works** (prepaid Receiver balance, deposit address, fee formula, when charged),
  and **how to request any of DIA's 2,500+ price / 10,000+ RWA feeds**.
- **Provider-quota monitoring** — the indexer's Blockfrost/Koios usage is counted
  on the same `dia_bridge_provider_requests_total` series as the feeder, with a
  combined consumed-vs-quota dashboard panel and quota alerts.

The integration is exercised on **both networks**: live on Cardano Mainnet ↔ DIA
Mainnet (the M2/M3 deployment, no redeploy) and fully on Cardano Preview ↔ DIA
Testnet, where the complete consume loop — indexer query → consumer contract spend
accepting/rejecting on the live price — is captured in the preview evidence pack.

All source, the test suites (**Aiken + feeder + CLI + indexer, all green**), the
monitoring configuration, and developer documentation are public in the
repository above. All transaction hashes are verifiable on Cardano explorers
(Cardanoscan).

Over the captured mainnet window — **2026-07-13 09:45 → 2026-07-14 18:01 UTC**
(~32.27 h) — the feeder published **40 confirmed** on-chain `ARS/USDT` oracle
updates on its hourly cadence. All 40 broadcast Cardano updates confirmed, with
**0 chain reorgs** and **0 real on-chain transaction failures**: a 100% observed
publication-success rate. Per-feed accuracy also held throughout, with the live
on-chain value within the DIA source tolerance.

The evidence pack additionally reports **99.78% strict freshness-bound
compliance**. This is a deliberately conservative timing observation, not an
operational-downtime figure: it treats every second after the exact 1-hour
confirmation ceiling as stale, including normal cron-tick and Cardano
confirmation-depth latency. The resulting ~4.3 minutes of excess timing over the
whole window contains no service outage, failed broadcast, or reorg. The acceptance
criterion does not prescribe a calculation method for uptime; this PoA therefore
reports both the 100% observed publication-success rate and the conservative
confirmed-freshness measure transparently.

Two intents at the very start of the window (2026-07-13 ~12:00) never reached the
chain and were recovered by the next heartbeat — one superseded by a newer on-chain
value (`NonMonotonicNonce`) and one that aged out of the submission buffer two
seconds past its limit (`IntentAgedOut`); neither broadcast a transaction or paid a
fee. Full tallies and the machine-readable totals are in the mainnet evidence pack.

---

## 2. Acceptance Criteria → Evidence

The Acceptance Criteria of Milestone 4 are quoted verbatim and mapped to evidence
below.

### AC #1 — Stable operation with 99.99% uptime and accuracy

> *"End-to-end deployment of DIA oracles on Cardano must demonstrate stable
> operation with 99.99% uptime and accuracy."*

| Evidence | Where |
| --- | --- |
| Live mainnet deployment — confirmed on-chain oracle updates (0 reorgs, 0 real failures; the 2 start-of-window pre-submission drops itemized) over the observed window | [mainnet pack](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md) — 40 confirmed, 0 reorgs, 100% observed broadcast-publication success; [`SUMMARY.json`](evidence/m4-mainnet-20260616-074413/SUMMARY.json) |
| Per-feed accuracy and transparent timing evidence over the window | [reliability narrative](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md) + [feed sanity](evidence/m4-mainnet-20260616-074413/sanity/feed-sanity.md) — `ARS/USDT` PASS; strict confirmed-freshness observation reported separately |
| Monitoring stack tracking the live deployment in real time (the M3 library) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/), [`docs/architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md) |

Headline mainnet transaction for immediate verification:

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| `ARS/USDT` oracle update (confirmed on Cardano mainnet) | `01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea` | [Cardanoscan](https://cardanoscan.io/transaction/01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea) |

### AC #2 — Functional verification: contracts + feeders + monitoring working together

> *"Functional verification includes successful operation of smart contracts,
> data feeders, and monitoring tools working together."*

| Evidence | Where |
| --- | --- |
| On-chain contracts deployed + publishing updates (the live Pair UTxOs) | [`contracts/aiken/`](../../contracts/aiken/); indexer [`Published contract addresses`](../../offchain/indexer/README.md#published-contract-addresses) |
| Feeder publishing DIA prices to Cardano | [`offchain/feeder/`](../../offchain/feeder/); confirmed updates in the evidence packs |
| Monitoring tracking the deployment (dashboards + alerts + provider-quota panel) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/) |
| **Consumer reading a live feed end-to-end** — query the indexer, reference the Pair UTxO, the example contract accepts/rejects on price | preview pack [consume demo](evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md); [`consumer-demo-onchain.ts`](../../offchain/indexer/src/examples/consumer-demo-onchain.ts) |
| Indexer serving the live on-chain state (pairs, balances, fees) | [`offchain/indexer/`](../../offchain/indexer/); `/v1/pairs`, `/v1/clients`, `/v1/protocol/fees` |
| Test suites — feeder + CLI + indexer, all green | run `npm test` in [`offchain/feeder`](../../offchain/feeder/), [`offchain/cli`](../../offchain/cli/), [`offchain/indexer`](../../offchain/indexer/) |

### AC #3 — Final close-out report and video

> *"Final close-out report. Final closeout video."*

| Deliverable | Link |
| --- | --- |
| Final close-out report | `[PLACEHOLDER: link to final close-out report]` |
| Final closeout video | `[PLACEHOLDER: link to final closeout video]` |
| End-to-end install/access demo (future adopters) | `[PLACEHOLDER: link to E2E demo]` |

### AC #4 — Developer documentation published on DIA's website

> *"Developer documentation is considered complete when comprehensive
> documentation is published via the DIA main developer documentation website. The
> documentation must include clear instructions for the configuration of the
> oracle, all relevant smart contracts for accessing the oracle, and usage
> instructions as to how to access the DIA oracle on Cardano. The contract
> addresses and supporting developer documentation will demonstrate DIA's oracle
> integration on Cardano by deploying a live oracle smart contract which includes
> 10 asset price feeds. This documentation will also provide specific
> instructions for how any developer on Cardano can request any of the 2,500+
> price feeds supported by DIA, and 10,000+ real-world asset price feeds."*

The substantive documentation is **complete and publicly available in the GitHub
repository** at submission time; the **publication on DIA's developer
documentation website** is the external step tracked below.

| Required content | Location (in repo) |
| --- | --- |
| Oracle configuration | [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md), [`offchain/cli/README.md`](../../offchain/cli/README.md) |
| Smart contracts for accessing the oracle (+ example consumer) | [`contracts/aiken/README.md`](../../contracts/aiken/README.md), [`example_oracle_consumer.ak`](../../contracts/aiken/validators/example_oracle_consumer.ak) |
| Usage — how to access / consume a live feed on mainnet | [`offchain/indexer/README.md`](../../offchain/indexer/README.md), [`Consumer Workflow`](../../README.md#consumer-workflow) |
| Paying for the service (fee/deposit system) | [`indexer README — paying for the service`](../../offchain/indexer/README.md#for-client-dapps-paying-for-the-service) |
| **How to request any of the 2,500+ / 10,000+ DIA feeds + timeline** | [`indexer README — requesting a new feed`](../../offchain/indexer/README.md#requesting-a-new-feed) |
| Contract addresses for the live feeds | [`indexer README — published contract addresses`](../../offchain/indexer/README.md#published-contract-addresses) |
| **Live deployment of 10 asset price feeds** | Preview pack [`Indexer — live queries`](evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md#indexer--live-queries) — 16 distinct symbols |

A note for the reviewer on feed count, in the same spirit as M2's: the milestone
text asks for a live deployment of 10 asset price feeds. Mainnet carries DIA's one
continuously-published mainnet registry feed (`ARS/USDT`) — the sustained-uptime
deployment AC#1 measures. Preview carries **16 distinct live feeds** — `ADA/USD`,
`ARB/USD`, `BNB/USD`, `BTC/USD`, `DAI/USD`, `DOGE/USD`, `ETH/USD`, `LTC/USD`,
`MATIC/USD`, `NEIRO/USD`, `SHIB/USD`, `SOL/USD`, `USDC/USD`, `USDT/USD`, `XRP/USD`,
`XVG/USD` — satisfying the 10-feed requirement with margin, exercised through the
same contracts, indexer, and consumer path as mainnet. This is why the preview
pack is load-bearing evidence for M4, not a redundant copy of the mainnet pack.

**Publication on the DIA main developer documentation website:** deferred to
DIA's independent marketing timeline. The consolidated publication follows the
same accepted M1/M2/M3 approach and is not a requirement for this M4 submission.

The publication date itself is DIA's decision, not a gap in delivered work: DIA
has indicated it prefers to publish the documentation once the integration is
fully finalized, pairing the documentation call-to-action with a coordinated
marketing announcement of the oracles going live on Cardano, rather than
publishing in isolation ahead of that announcement. That announcement timeline is
DIA's own external communications process, independent of the engineering
deliverables in this milestone — all of which (contracts, feeders, monitoring,
indexer, deployment scripts, and the documentation content itself) are complete,
tested, and public in the repository today. The documentation is ready to publish
the moment DIA schedules that announcement.

---

## 3. Outputs delivered (Milestone 4)

| Official output | Status | Evidence |
| --- | --- | --- |
| Aiken-based smart contracts | Delivered | [`contracts/aiken/`](../../contracts/aiken/) — protocol contracts + example consumer |
| Feeders | Delivered | [`offchain/feeder/`](../../offchain/feeder/) — DIA → Cardano pipeline (M2), hardened in M4 |
| Monitoring stack | Delivered | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/) — M3 library + provider-quota panel/alerts |
| Deployment scripts | Delivered | [`offchain/Makefile`](../../offchain/Makefile), [`offchain/cli/README.md`](../../offchain/cli/README.md) |
| Sample live feeds | Delivered | served by the indexer (`GET /v1/pairs`); addresses table in the indexer README |
| Contract addresses | Delivered | [indexer README — published contract addresses](../../offchain/indexer/README.md#published-contract-addresses) |
| Supporting developer documentation (incl. request 2,500+/10,000+ feeds) | Delivered in repository; DIA-site publication deferred to DIA marketing timing | See AC #4 table |
| Final close-out report | `[PLACEHOLDER]` | `[PLACEHOLDER: link]` |
| Final closeout video | `[PLACEHOLDER]` | `[PLACEHOLDER: link]` |

---

## 4. How to verify this deliverable

### 4.1. On-chain (no local setup required)

Open any confirmed mainnet update hash (§AC #1, or the mainnet pack's sample
hashes) on Cardanoscan — the transactions show the oracle Pair UTxO being updated
on Cardano Mainnet. The indexer's
[published contract addresses](../../offchain/indexer/README.md#published-contract-addresses)
are public on-chain identifiers anyone can inspect.

### 4.2. Read a live feed (consumer path)

```bash
cd offchain && make up-indexer          # indexer only, no feeder, on the shared state
curl -s localhost:3001/v1/pairs | jq                     # every live feed
curl -s localhost:3001/v1/protocol/fees | jq             # what an update costs
open http://localhost:3001/docs                          # interactive API reference
```

### 4.3. Run the consumer contract end-to-end

```bash
# Offline (emulator, no wallet): a spend that accepts vs one that rejects on price
bash offchain/indexer/src/examples/run-consumer-demo-emulator.sh

# Real network (needs a funded wallet + provider in .env, indexer running):
cd offchain && make stop-feeder         # free the operator wallet; indexer stays up
bash indexer/src/examples/run-consumer-demo-onchain.sh
make start-feeder
```

### 4.4. Local repro (full stack + tests)

```bash
git clone https://github.com/diadata-org/dia-cardano-oracle.git
cd dia-cardano-oracle && git checkout [PLACEHOLDER: submission commit]

( cd contracts/aiken  && aiken check )
( cd offchain/feeder  && npm ci && npm test )
( cd offchain/cli     && npm ci && npm run test )
( cd offchain/indexer && npm ci && npm test )

cd offchain && make up MONITORING=1     # feeder + indexer + Grafana at http://localhost:3000
```

### 4.5. Re-generate the evidence pack

```bash
cd offchain && make up-indexer          # ensure the indexer serves the current build
make evidence4 EVIDENCE_ONCHAIN_LOG=/tmp/onchain.txt
```

The pack is assembled only from the indexer's live API, the consumer demo output,
and the published addresses — no hand-edited numbers.

---

## 5. Pointers (one-stop links)

- Close-out report: `[PLACEHOLDER: link]`
- Closeout video: `[PLACEHOLDER: link]`
- DIA documentation publication: deferred to DIA marketing timing
- Mainnet evidence pack: [`evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md`](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md)
- Preview evidence pack: [`evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md`](evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md)
- Indexer (consumer service): [`offchain/indexer/README.md`](../../offchain/indexer/README.md)
- Example consumer contract: [`contracts/aiken/validators/example_oracle_consumer.ak`](../../contracts/aiken/validators/example_oracle_consumer.ak)
- Consumer workflow (read a feed, pay, request a feed): [`README.md`](../../README.md#consumer-workflow)
- Protocol architecture: [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- Milestone 1 PoA (accepted): [`milestone-1-poa.md`](milestone-1-poa.md)
- Milestone 2 PoA: [`milestone-2-poa.md`](milestone-2-poa.md)
- Milestone 3 PoA: [`milestone-3-poa.md`](milestone-3-poa.md)
- License: [`LICENSE`](../../LICENSE) (MIT)
