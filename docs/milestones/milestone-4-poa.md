# Milestone 4 — Proof of Achievement (Catalyst)

**Project:** DIA Oracles on Cardano
**Milestone:** 4 — End-to-End Integration and Deployment on Cardano Mainnet
**Public repository:** <https://github.com/diadata-org/dia-cardano-oracle>
**Submission commit:** `[PLACEHOLDER: submission commit hash]`

> **Status: DRAFT.** The repository deliverables (contracts, feeders, monitoring,
> indexer, deployment scripts, developer documentation, sample feeds) are
> complete and verifiable now. The items still marked `[PLACEHOLDER]` are the
> externally-produced or time-windowed deliverables — the final close-out report,
> the close-out video, publication on DIA's developer documentation website, and
> the sustained mainnet uptime measurement — to be filled in at submission.

Primary evidence:

- **Close-out report:** `[PLACEHOLDER: link to final close-out report]`
- **Close-out video:** `[PLACEHOLDER: link to final closeout video]`
- **End-to-end install/access demo** (how a developer installs the tooling and
  accesses the live oracles on mainnet): `[PLACEHOLDER: link to E2E demo]`
- **Mainnet integration evidence pack** (live mainnet deployment — contract
  addresses, feeder logs, confirmed updates, sustained-uptime window):
  `[PLACEHOLDER: evidence/m4-mainnet-<stamp>/]`
- **Preview integration evidence pack** (full consume loop — indexer responses,
  the example consumer contract accepting/rejecting on price, the on-chain demo):
  [`evidence/m4-preview-20260608-040304-01/`](evidence/m4-preview-20260608-040304-01/) —
  [`milestone-4-preview-evidence.md`](evidence/m4-preview-20260608-040304-01/milestone-4-preview-evidence.md).

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

All source, the test suites (**feeder + CLI + indexer, all green**), the
monitoring configuration, and developer documentation are public in the
repository above. All transaction hashes are verifiable on Cardano explorers
(Cardanoscan).

`[PLACEHOLDER: one paragraph reporting the sustained mainnet uptime/accuracy
window — start/end UTC, confirmed updates, 0 failed / 0 reorgs, measured uptime
% against the 99.99% bar — once the measurement window is captured.]`

---

## 2. Acceptance Criteria → Evidence

The Acceptance Criteria of Milestone 4 are quoted verbatim and mapped to evidence
below.

### AC #1 — Stable operation with 99.99% uptime and accuracy

> *"End-to-end deployment of DIA oracles on Cardano must demonstrate stable
> operation with 99.99% uptime and accuracy."*

| Evidence | Where |
| --- | --- |
| Live mainnet deployment — confirmed on-chain oracle updates (0 failed, 0 reorgs) over the sustained window | `[PLACEHOLDER: mainnet pack — confirmed tx count, sample hashes, SUMMARY.json]` |
| Measured uptime % + per-feed accuracy (on-chain value vs DIA source) over the window | `[PLACEHOLDER: mainnet pack — uptime/accuracy report]` |
| Monitoring stack tracking the live deployment in real time (the M3 library) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/), [`docs/architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md) |

Headline mainnet transaction for immediate verification:

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| `ARS/USDT` oracle update (confirmed on Cardano mainnet) | `[PLACEHOLDER: tx hash]` | `[PLACEHOLDER: Cardanoscan link]` |

### AC #2 — Functional verification: contracts + feeders + monitoring working together

> *"Functional verification includes successful operation of smart contracts,
> data feeders, and monitoring tools working together."*

| Evidence | Where |
| --- | --- |
| On-chain contracts deployed + publishing updates (the live Pair UTxOs) | [`contracts/aiken/`](../../contracts/aiken/); indexer [`Published contract addresses`](../../offchain/indexer/README.md#published-contract-addresses) |
| Feeder publishing DIA prices to Cardano | [`offchain/feeder/`](../../offchain/feeder/); confirmed updates in the evidence packs |
| Monitoring tracking the deployment (dashboards + alerts + provider-quota panel) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/) |
| **Consumer reading a live feed end-to-end** — query the indexer, reference the Pair UTxO, the example contract accepts/rejects on price | preview pack [consume demo](evidence/m4-preview-20260608-040304-01/milestone-4-preview-evidence.md); [`consumer-demo-onchain.ts`](../../offchain/indexer/src/examples/consumer-demo-onchain.ts) |
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
> instructions … specific instructions for how any developer on Cardano can
> request any of the 2,500+ price feeds … and 10,000+ real-world asset price
> feeds."*

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

**Publication on the DIA main developer documentation website:**
`[PLACEHOLDER: link to the published DIA documentation]` — the consolidated
publication deferred from M1/M2/M3 (per the accepted M1 PoA), published once
against the final stable M4 surface.

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
| Supporting developer documentation (incl. request 2,500+/10,000+ feeds) | Delivered (in repo; DIA-site publication — see AC #4) | See AC #4 table |
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
- DIA documentation publication: `[PLACEHOLDER: link]`
- Mainnet evidence pack: `[PLACEHOLDER: evidence/m4-mainnet-<stamp>/]`
- Preview evidence pack: [`evidence/m4-preview-20260608-040304-01/milestone-4-preview-evidence.md`](evidence/m4-preview-20260608-040304-01/milestone-4-preview-evidence.md)
- Indexer (consumer service): [`offchain/indexer/README.md`](../../offchain/indexer/README.md)
- Example consumer contract: [`contracts/aiken/validators/example_oracle_consumer.ak`](../../contracts/aiken/validators/example_oracle_consumer.ak)
- Consumer workflow (read a feed, pay, request a feed): [`README.md`](../../README.md#consumer-workflow)
- Protocol architecture: [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- Milestone 1 PoA (accepted): [`milestone-1-poa.md`](milestone-1-poa.md)
- Milestone 2 PoA: [`milestone-2-poa.md`](milestone-2-poa.md)
- Milestone 3 PoA: [`milestone-3-poa.md`](milestone-3-poa.md)
- License: [`LICENSE`](../../LICENSE) (MIT)
