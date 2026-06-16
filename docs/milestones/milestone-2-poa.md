<!--
  PLACEHOLDERS TO FILL BEFORE SUBMISSION (search for ⟨):
    ⟨SUBMISSION-COMMIT⟩ — the tag/commit hash this PoA is pinned to
  Everything else is filled from the committed evidence packs + the QA video.
-->

# Milestone 2 — Proof of Achievement (Catalyst)

**Project:** DIA Oracles on Cardano
**Milestone:** 2 — Implement Data Feeder and Documentation
**Public repository:** <https://github.com/diadata-org/dia-cardano-oracle>
**Submission commit:** `⟨SUBMISSION-COMMIT⟩`

Primary evidence:

- **QA demo video** (dashboards, alerts firing and clearing, anomaly detection):
  <https://www.youtube.com/watch?v=S-9-2jVUB5I>
- **Mainnet feeder evidence pack** (live mainnet transactions):
  [`evidence/m2-mainnet-20260616-074413/`](evidence/m2-mainnet-20260616-074413/) —
  [`milestone-2-mainnet-evidence.md`](evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md)
  and [`SUMMARY.json`](evidence/m2-mainnet-20260616-074413/SUMMARY.json).
- **Preview feeder evidence pack** (the deployment the QA video was recorded on):
  [`evidence/m2-preview-20260608-040304/`](evidence/m2-preview-20260608-040304/) —
  [`milestone-2-preview-evidence.md`](evidence/m2-preview-20260608-040304/milestone-2-preview-evidence.md).

---

## Contents

- [1. Executive summary](#1-executive-summary)
- [2. Acceptance Criteria → Evidence](#2-acceptance-criteria--evidence)
- [3. Outputs delivered (Milestone 2)](#3-outputs-delivered-milestone-2)
- [4. How to verify this deliverable](#4-how-to-verify-this-deliverable)
- [5. Pointers (one-stop links)](#5-pointers-one-stop-links)

---

## 1. Executive summary

Milestone 2 is delivered. A Cardano-specific data feeder was built that consumes
DIA's signed `OracleIntent` events and pushes them onto the Milestone 1 oracle
contracts on Cardano, with a full quality-assurance surface: a Prometheus +
Grafana monitoring stack, automated alerting, and anomaly detection for stale or
misreported data.

The feeder was exercised on **both networks**:

- **Cardano Mainnet ↔ DIA Mainnet.** The feeder ran live against the DIA Mainnet
  registry (chain id 1050), minting and updating **10 real DIA mainnet asset
  feeds** — US equities and metals ETFs: `SPYM`, `CRCL`, `TSLA`, `NVDA`, `IAU`,
  `PPLT`, `MSTR`, `AMZN`, `SIVR`, `COIN` — with **23 confirmed on-chain
  transactions** over a ~77-minute window (0 reorgs). Mid-run, the monitoring
  stack surfaced a genuine anomaly — a DIA signing key that was not yet
  authorized in the on-chain Config — which was diagnosed and remediated live
  with an on-chain `config:update` transaction. That detect → diagnose → fix
  loop is itself a concrete demonstration of the QA and alerting working
  end-to-end on mainnet.
- **Cardano Preview ↔ DIA Testnet** (the deployment the QA video was recorded
  on). The feeder fed the **10 asset price feeds referenced in the Catalyst
  proposal** over a ~27-hour window with **335 confirmed transactions**,
  exercising the full QA surface: real-time dashboards, alerts firing and
  clearing, and anomaly detection.

All transaction hashes are publicly verifiable on Cardano explorers
(Cardanoscan). Feeder source code, the test suites (**632 feeder tests + 46 CLI
tests, all green**), the monitoring configuration, operator runbooks, and
developer documentation are public in the repository above.

As stated in the milestone text, this is an **early signal to validate
assumptions and demonstrate the intended architecture, not a complete production
deployment**.

---

## 2. Acceptance Criteria → Evidence

The three Acceptance Criteria of Milestone 2 are quoted verbatim and mapped to
evidence below.

### AC #1 — Feeder pushes price feeds to Cardano mainnet, validated by tests, QA review, and confirmed mainnet transactions

> *"The feeder successfully pushes price feeds to Cardano mainnet contracts with
> reproducible performance for any custom oracle requests. Functionality is
> validated through test cases, QA review, and confirmed transactions recorded
> on the Cardano mainnet."*

| Evidence | Where |
| --- | --- |
| Feeder source code | [`offchain/feeder/`](../../offchain/feeder/) |
| Confirmed Cardano **mainnet** transactions (23 confirmed, 10 feeds, 0 reorgs) | mainnet pack — [`Confirmed Cardano tx count per pair`](evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md#confirmed-cardano-tx-count-per-pair), [`Sample Cardano tx hashes`](evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md#sample-cardano-tx-hashes-one-per-pair-first-observed), [`SUMMARY.json`](evidence/m2-mainnet-20260616-074413/SUMMARY.json) |
| Test cases (632 feeder + 46 CLI, all green) | [`tests/`](evidence/m2-mainnet-20260616-074413/tests/) in the pack; run with `npm test` in `offchain/feeder` and `offchain/cli` |
| QA review (dashboards, alerts, anomaly detection) | mainnet + preview packs (`Dashboards`, `Alerts active during the window`) and the QA video |
| Reproducible performance (per-pair latency + fee) | [`End-to-end latency per pair`](evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md#end-to-end-latency-per-pair) and the feeder DB CSVs in [`db/`](evidence/m2-mainnet-20260616-074413/db/) |
| "Custom oracle requests" — per-client, config-driven feed selection + push policy | [`offchain/feeder/config/routers/mainnet/client-test-01-router-default.yaml`](../../offchain/feeder/config/routers/mainnet/client-test-01-router-default.yaml) |

Headline mainnet transactions for immediate verification (the full per-pair list
is in the pack's *Sample Cardano tx hashes* section):

| Role | Operation | Tx hash | Explorer |
| --- | --- | --- | --- |
| Execution | First oracle update (`CRCL`, mints the Pair UTxO) | `8bf45972b2e0cfc3adf8b570efaafd4ffe47c5659ed5ddf51ffaaf0ddb395ce9` | [Cardanoscan](https://cardanoscan.io/transaction/8bf45972b2e0cfc3adf8b570efaafd4ffe47c5659ed5ddf51ffaaf0ddb395ce9) |
| Execution | Batch oracle update (`MSTR` mint + `CRCL` update, one tx) | `e2b922cd008ccf5726146ed650858ec1ddd8fc89b49ad3bbf173888da4c703cf` | [Cardanoscan](https://cardanoscan.io/transaction/e2b922cd008ccf5726146ed650858ec1ddd8fc89b49ad3bbf173888da4c703cf) |
| Maintenance | `config:update` — authorize the full DIA mainnet signer set (the live anomaly fix) | `86ecd2870c5d1f9f26bbe295b7ebe254e47341c269e0fd0cfefef8336943b7e2` | [Cardanoscan](https://cardanoscan.io/transaction/86ecd2870c5d1f9f26bbe295b7ebe254e47341c269e0fd0cfefef8336943b7e2) |

The feeder consumes DIA's EIP-712-signed `OracleIntent` events from the DIA
registry, recovers and authorizes the signer against the on-chain Config, and
commits the price on-chain to the per-pair Pair UTxO — the same contract surface
delivered in Milestone 1. A batch transaction updates several pairs in one
Cardano transaction, which is why the per-pair update counts exceed the
transaction count.

### AC #2 — Demo (QA review logs) with a lightweight preview of the 10 asset price feeds

> *"The demo associated with the output 'QA review logs' will include a
> lightweight preview of the system feeding data for the 10 asset price feeds
> referenced in the Catalyst proposal. This milestone is intended as an early
> signal to validate assumptions and demonstrate the intended architecture,
> rather than a complete production deployment."*

| Evidence | Where |
| --- | --- |
| QA demo video (dashboards, alerts firing and clearing, anomaly detection) | <https://www.youtube.com/watch?v=S-9-2jVUB5I> |
| Lightweight preview of the **10 Catalyst-referenced feeds** (335 confirmed tx, ~27 h) | preview pack — [`Confirmed Cardano tx count per pair`](evidence/m2-preview-20260608-040304/milestone-2-preview-evidence.md#confirmed-cardano-tx-count-per-pair) |
| 10 **real DIA mainnet** feeds fed live on-chain | mainnet pack (see AC #1) and [`pair-selection-mainnet-20260616-074413`](evidence/pair-selection-mainnet-20260616-074413/pair-selection.md) |
| Real-time dashboards (oracle health + transactions) | both packs — `Dashboards` section (rendered panel PNGs) |
| Automated alerts + anomaly detection (stale / misreported data) | both packs — `Alerts active during the window`; the mainnet anomaly-and-fix demonstrates it live |

A note for the reviewer on the two feed sets: the 10 feeds *referenced in the
Catalyst proposal* (crypto majors such as BTC/ETH/USDC) are demonstrated on
**Preview**, where DIA's testnet feed publishes them — this is the lightweight
preview the video records. On **Mainnet**, DIA's registry publishes real-world
asset feeds (equities and metals ETFs), so the live mainnet run feeds those 10.
Both are 10-feed runs; together they show the system feeding the proposal's
reference feeds *and* operating live on mainnet. The DIA-mainnet feed set was
discovered reproducibly with the on-chain scan recorded in
[`evidence/pair-selection-mainnet-20260616-074413/`](evidence/pair-selection-mainnet-20260616-074413/).

### AC #3 — Developer documentation

> *"Developer documentation is considered complete when comprehensive
> documentation is published via the DIA main developer documentation website.
> The documentation must include clear instructions for the configuration of the
> oracle, all relevant smart contracts for accessing the oracle, and usage
> instructions as to how to access the DIA oracle on Cardano."*

Comprehensive developer documentation is **complete and publicly available in the
GitHub repository** at submission time:

| Documentation surface | Location |
| --- | --- |
| Top-level repository overview | [`README.md`](../../README.md) |
| Feeder architecture (data flow, routing, monitoring, alerting, metrics) | [`docs/architecture/feeder.md`](../architecture/feeder.md) |
| Feeder developer docs + runbook (configuration, routers, monitoring, integration) | [`offchain/feeder/README.md`](../../offchain/feeder/README.md) and [`offchain/feeder/scripts/README.md`](../../offchain/feeder/scripts/README.md) |
| Protocol architecture (datums, redeemers, fee flow, trust model) | [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md) |
| Off-chain CLI runbook (deploy + oracle access) | [`offchain/cli/README.md`](../../offchain/cli/README.md) |
| Integration example — per-client router config | [`offchain/feeder/config/routers/`](../../offchain/feeder/config/routers/) |

This covers each documentation requirement quoted in AC #3:

- *Configuration of the oracle* — feeder README (router config, `.env`,
  monitoring) and the per-network `infrastructure.<network>.yaml`.
- *All relevant smart contracts* — the M1 architecture document and Aiken README;
  the feeder pushes to those same contracts.
- *Usage / how to access the oracle* — feeder README "integration" sections and
  the architecture document's "reading prices on-chain".

**Publication on the DIA main developer documentation website** is **deferred to
Milestone 4 (End-to-End Integration and Deployment)**, with the same reasoning
the evaluator accepted for Milestone 1: the integration is still iterating across
M2/M3/M4, so publishing the final stable surface once at M4 is materially better
for downstream developers than republishing a moving target. The same DIA-site
clause appears in M2, M3, and M4; consolidating its publication at M4 avoids
shipping four partial revisions. The repository documentation is complete now and
meets the substantive content requirements of AC #3.

---

## 3. Outputs delivered (Milestone 2)

| Official output | Status | Evidence |
| --- | --- | --- |
| Feeder scripts | Delivered | [`offchain/feeder/`](../../offchain/feeder/) |
| Test coverage (uptime / accuracy / oracle liveness via confirmed mainnet tx) | Delivered | 632 feeder + 46 CLI tests; mainnet + preview packs (`Totals`, `Confirmed tx per pair`, `End-to-end latency`) |
| QA review logs (anomaly detection + automated alerts) + demo video | Delivered | QA video; both packs (`Alerts`, `Dashboards`); the live mainnet anomaly-and-fix |
| Verified Cardano mainnet transaction logs (feeder delivering live price data) | Delivered | mainnet pack — see AC #1 |
| Developer documentation with integration examples | Delivered (in repo; DIA-site publication deferred to M4 — see §AC #3) | See AC #3 table |

---

## 4. How to verify this deliverable

### 4.1. On-chain (no local setup required)

Open any Cardanoscan link in §AC #1, or any hash from the pack's *Sample Cardano
tx hashes* section. The transactions show the oracle Pair UTxOs being minted and
updated on Mainnet, and the `config:update` shows the authorized-signer set
being rotated on-chain.

### 4.2. Watch the QA demo video

<https://www.youtube.com/watch?v=S-9-2jVUB5I> — the real-time Grafana dashboards,
alerts firing and clearing, and anomaly detection, recorded on the Preview
deployment ([`evidence/m2-preview-20260608-040304/`](evidence/m2-preview-20260608-040304/)).

### 4.3. Local repro (feeder + monitoring)

```bash
git clone https://github.com/diadata-org/dia-cardano-oracle.git
cd dia-cardano-oracle && git checkout ⟨SUBMISSION-COMMIT⟩

# Tests
( cd offchain/feeder && npm ci && npm test )
( cd offchain/cli && npm ci && npm run test )

# Run the feeder + Prometheus + Grafana (network from offchain/feeder/.env)
cd offchain && make up MONITORING=1     # Grafana at http://localhost:3000
```

### 4.4. Re-generate the evidence pack

```bash
cd offchain && make evidence            # writes docs/milestones/evidence/m2-<network>-<run-id>/
```

The pack is assembled only from the feeder's database, logs, live API, and
Grafana — no hand-edited numbers.

---

## 5. Pointers (one-stop links)

- QA demo video: <https://www.youtube.com/watch?v=S-9-2jVUB5I>
- Mainnet evidence pack:
  [`evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md`](evidence/m2-mainnet-20260616-074413/milestone-2-mainnet-evidence.md)
- Preview evidence pack (QA video basis):
  [`evidence/m2-preview-20260608-040304/milestone-2-preview-evidence.md`](evidence/m2-preview-20260608-040304/milestone-2-preview-evidence.md)
- DIA-mainnet feed selection (reproducible scan):
  [`evidence/pair-selection-mainnet-20260616-074413/`](evidence/pair-selection-mainnet-20260616-074413/)
- Feeder source: [`offchain/feeder/`](../../offchain/feeder/)
- Feeder architecture: [`docs/architecture/feeder.md`](../architecture/feeder.md)
- Feeder README + runbook: [`offchain/feeder/README.md`](../../offchain/feeder/README.md)
- Milestone 1 PoA (accepted): [`milestone-1-poa.md`](milestone-1-poa.md)
- License: [`LICENSE`](../../LICENSE) (MIT)
