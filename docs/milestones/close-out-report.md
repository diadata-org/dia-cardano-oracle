# Project Completion (Close-out) Report

**Project:** Integration of DIA Price Oracles on Cardano  
**Catalyst Fund:** Fund 14 — Cardano Use Cases: Concepts  
**Project number:** 1400073  
**Project Manager:** Dillon Hanson (<dillon.hanson@diadata.org>)  
**Start date:** 2026-04-14  
**Completion date:** 2026-08-10

**Project Completion Video:** <https://youtu.be/iPOC-Ojb5k8>  
**Repository:** <https://github.com/diadata-org/dia-cardano-oracle> (MIT License)  
**Permanent link to this document:**  
<https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/close-out-report.pdf>

---

## 1. Deliverables

DIA's push-oracle protocol was ported to Cardano (Aiken, Plutus V3), deployed on
Mainnet, fed continuously by a purpose-built Cardano feeder, monitored end to
end, and made consumable by any Cardano dApp through a read-only indexer and an
example consumer contract.

**On-chain evidence:**

| Artifact | Reference |
| --- | --- |
| Live mainnet Pair (oracle feed), client `client-test-01` | Pair policy id `b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f` — [indexer README, published contract addresses](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/offchain/indexer/README.md#published-contract-addresses) |
| Headline mainnet oracle-update transaction | [`01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea`](https://cardanoscan.io/transaction/01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea) |
| Full mainnet deployment chain-walk (Milestone 1) | [`milestone-1-poa.md`](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/milestone-1-poa.md) |
| Sustained mainnet reliability window (Milestone 4) | 40 confirmed on-chain updates, 2026-07-13 09:45 → 2026-07-14 18:01 UTC — [mainnet evidence pack](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md) |
| Preview deployment — 16 distinct live feeds | [preview evidence pack](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md#indexer--live-queries) |

**Off-chain evidence:**

| Component | Location |
| --- | --- |
| Aiken contracts (7 validators) + unit tests | [`contracts/aiken/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/contracts/aiken) — 167/167 tests passing |
| Off-chain CLI (protocol/client bootstrap, maintenance) | [`offchain/cli/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/offchain/cli) — 59/59 tests passing |
| Feeder daemon (DIA → Cardano pipeline) | [`offchain/feeder/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/offchain/feeder) — 790/790 tests passing |
| Indexer (consumer-facing query service) | [`offchain/indexer/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/offchain/indexer) — 67/67 tests passing |
| Monitoring (Prometheus + Grafana + Alertmanager) | [`offchain/feeder/monitoring/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/offchain/feeder/monitoring), [dashboards guide](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/architecture/grafana-dashboards.md) |
| Architecture + security documentation | [architecture](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/architecture/cardano-oracle-architecture.md), [security notes](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/security/security-notes.md) |

**Hosting:** the repository is public on GitHub (MIT License); no separate hosted
service is required to run any component — every service (feeder, indexer,
monitoring) is a Docker image + `docker-compose` a third party can run
themselves against their own chain-provider key.

**Testing:** all four test suites (Aiken, CLI, feeder, indexer) were re-run and
verified passing during this milestone's evidence review — 1,083 automated tests
in total. See the per-suite counts above and the raw console output in each
evidence pack's `tests/` directory.

### Visual evidence

The five Grafana dashboards the system ships, rendered live over the Mainnet run
window (2026-07-13 → 2026-07-14). Full-resolution originals:
[`dashboards/`](https://github.com/diadata-org/dia-cardano-oracle/tree/catalyst-m4-closeout/docs/milestones/evidence/m4-mainnet-20260616-074413/dashboards).

![Overview dashboard](evidence/m4-mainnet-20260616-074413/dashboards/overview-full.png)

*Overview — per-feed health: is each price feed alive, fresh, accurate and
funded.*

![Transactions dashboard](evidence/m4-mainnet-20260616-074413/dashboards/tx-full.png)

*Transactions — every oracle update published to Cardano, its confirmation and
its outcome.*

![Internals dashboard](evidence/m4-mainnet-20260616-074413/dashboards/internals-full.png)

*Internals — pipeline latency, scanner, worker pools, database and provider
health.*

![Signer Wallets dashboard](evidence/m4-mainnet-20260616-074413/dashboards/wallets-full.png)

*Signer Wallets — the multi-wallet signing pool that publishes the updates.*

![Operational Cost dashboard](evidence/m4-mainnet-20260616-074413/dashboards/cost-full.png)

*Operational Cost — the ADA cost of running the system, by transaction kind and
signing wallet.*

## 2. Usage

The intended users are **Cardano dApp developers who need a DIA price feed**.
They interact with the system exclusively through the indexer's read-only HTTP
API — no CLI, no admin access, no on-chain transaction of their own required to
read a price:

1. Query `GET /v1/pairs/{symbol}` for the latest value and the exact UTxO to
   reference.
2. Include that Pair UTxO as a reference input in their own transaction and
   authenticate it by its Pair NFT (`GET /v1/protocol/fees` for the cost of
   keeping a subscribed feed updated).
3. Optionally consume through the published
   [example consumer contract](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/contracts/aiken/validators/example_oracle_consumer.ak)
   as a working reference implementation.

**On-chain activity to date**, independently verifiable on Cardanoscan:

| Measure | Value |
| --- | --- |
| Confirmed oracle-update transactions on Mainnet (window) | 40 |
| Live client on Mainnet | 1 (`client-test-01`) |
| Continuously published Mainnet feed | `ARS/USDT` |
| Distinct feeds live and queryable on Preview | 16 |
| Mainnet live since | 2026-06-16 |

No integrations are confirmed yet, as the oracle has just gone live. DIA is in
active outreach and preliminary discussions with a number of Cardano-ecosystem
protocols, including Liqwid Finance, Indigo Protocol, Djed Alliance, Fluid
Tokens, Surf Lending, Ascend, Dano Finance, Strike Finance, Minswap, Sundaeswap,
Muesliswap, WingRiders, and VyFinance.
DIA will continue connecting with partner prospects across the Cardano ecosystem
and is now beginning support in the live production environment.
Because no third-party dApp is consuming the feed yet, no external user-count is
reported here; the transaction figures above are the protocol's own published
oracle updates.

## 3. Impact

Measurable, verified results as of this report:

- **100% observed broadcast-publication success** on the live Mainnet feed
  (`ARS/USDT`) over a ~32.27 h sustained window: 40 confirmed updates, 0 real
  on-chain transaction failures, and 0 chain reorgs.
- **32.3 s median time to on-chain confirmation** across those 40 updates
  (average 36.9 s, fastest 19.2 s, slowest 87.7 s) — recomputable from the
  transaction log shipped in the mainnet evidence pack.
- **0.90 ADA average cost per published oracle update**, measured from the
  32.24 ADA of Cardano fees paid across the sampled updates — about 645 ADA per
  year-round feed at the hourly cadence used here. This is a measured operating
  cost, not an estimate.
- **99.78% freshness compliance** against a strict one-hour ceiling. This is a
  deliberately conservative timing figure: it counts ordinary scheduling and
  block-confirmation latency as staleness, and is not a measure of downtime. The
  method is documented in the
  [mainnet evidence pack](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md).
- **16 distinct price feeds** deployed and live-queryable on Preview,
  demonstrating the architecture's capacity beyond a single feed.
- **1,083 automated tests passing** across contracts, CLI, feeder, and indexer.
- Cardano previously had no DIA oracle integration; this closes that gap and
  gives any Cardano dApp a documented path to any of DIA's 2,500+ price feeds
  and 10,000+ real-world-asset feeds.

No TVL or ecosystem-adoption figures are reported yet, as the oracle has just
gone live. DIA is now initiating the onboarding process with protocols across
the ecosystem.

## 4. Sustainability

**Ongoing project — maintenance and roadmap:**

- The oracle, feeder, and indexer are designed to run continuously; the feeder
  already carries the operational tooling (automated fee settlement, wallet
  maintenance, alerting) needed for unattended production operation.
- Requesting a new feed is a standing, documented process — see
  [indexer README — requesting a new feed](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/offchain/indexer/README.md#requesting-a-new-feed) —
  not a one-off integration effort.
- The protocol carries its own on-chain revenue mechanism: each client holds a
  prepaid balance in an on-chain Receiver and is charged the published protocol
  fee per update, queryable at `GET /v1/protocol/fees`.
- DIA will fund the ongoing infrastructure and maintenance costs for the
  deployed price oracles. Costs tied to custom NAV oracle requests, or
  additional features outside the scope of the original grant, will be discussed
  and negotiated directly with the requesting protocol, or proposed as a
  follow-up Catalyst submission.

**Forking / permanent availability (in case the project is not continued):**

- The repository is public, MIT-licensed, and pinned per milestone by commit —
  anyone can fork, redeploy, or extend it independently of DIA or Protofire.
- The compiled contract artifact (`contracts/aiken/plutus.json`) is committed,
  so a fork does not depend on rebuilding from source or on any hosted service
  remaining available.
- All on-chain state (Config, Receiver, Pair UTxOs) is public and independently
  readable by the indexer from any chain-provider key — no centralized
  dependency on Protofire's or DIA's own infrastructure is required to read a
  published feed.

---

## Pointers

- Project Completion Video: <https://youtu.be/iPOC-Ojb5k8>
- Milestone 4 Proof of Achievement: [`milestone-4-poa.md`](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/milestone-4-poa.md)
- Milestone 1–3 Proofs of Achievement: [1](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/milestone-1-poa.md), [2](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/milestone-2-poa.md), [3](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/milestones/milestone-3-poa.md)
- Protocol architecture: [`cardano-oracle-architecture.md`](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/docs/architecture/cardano-oracle-architecture.md)
- License: [`LICENSE`](https://github.com/diadata-org/dia-cardano-oracle/blob/catalyst-m4-closeout/LICENSE) (MIT)
