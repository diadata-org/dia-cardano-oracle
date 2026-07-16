# Project Completion (Close-out) Report

**Project:** Integration of DIA Price Oracles on Cardano
**Catalyst Fund:** Fund 14 — Cardano Use Cases: Concepts
**Project number:** 1400073
**Project Manager:** `[PLACEHOLDER: project manager name]`
**Start date:** 2026-04-14
**Completion date:** `[PLACEHOLDER: date of M4 approval]`
**Repository:** <https://github.com/diadata-org/dia-cardano-oracle> (MIT License)

## Contents

- [Project Completion (Close-out) Report](#project-completion-close-out-report)
  - [Contents](#contents)
  - [1. Deliverables](#1-deliverables)
  - [2. Usage](#2-usage)
  - [3. Impact](#3-impact)
  - [4. Sustainability](#4-sustainability)
  - [Pointers](#pointers)

---

## 1. Deliverables

DIA's push-oracle protocol was ported to Cardano (Aiken, Plutus V3), deployed on
Mainnet, fed continuously by a purpose-built Cardano feeder, monitored end to
end, and made consumable by any Cardano dApp through a read-only indexer and an
example consumer contract.

**On-chain evidence:**

| Artifact | Reference |
| --- | --- |
| Live mainnet Pair (oracle feed), client `client-test-01` | Pair policy id `b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f` — [indexer README, published contract addresses](../../offchain/indexer/README.md#published-contract-addresses) |
| Headline mainnet oracle-update transaction | [`01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea`](https://cardanoscan.io/transaction/01315fb64b120a6852722b28f880dfb05f75b78ba9374b16e3771e3c2560fcea) |
| Full mainnet deployment chain-walk (M1) | [`milestone-1-poa.md`](milestone-1-poa.md) |
| Sustained mainnet reliability window (M4) | 40 confirmed on-chain updates, 2026-07-13 09:45 → 2026-07-14 18:01 UTC — [mainnet evidence pack](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md) |
| Preview deployment — 16 distinct live feeds | [preview evidence pack](evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md#indexer--live-queries) |

**Off-chain evidence:**

| Component | Location |
| --- | --- |
| Aiken contracts (7 validators) + unit tests | [`contracts/aiken/`](../../contracts/aiken/) — 167/167 tests passing |
| Off-chain CLI (protocol/client bootstrap, maintenance) | [`offchain/cli/`](../../offchain/cli/) — 59/59 tests passing |
| Feeder daemon (DIA → Cardano pipeline) | [`offchain/feeder/`](../../offchain/feeder/) — 790/790 tests passing |
| Indexer (consumer-facing query service) | [`offchain/indexer/`](../../offchain/indexer/) — 67/67 tests passing |
| Monitoring (Prometheus + Grafana + Alertmanager) | [`offchain/feeder/monitoring/`](../../offchain/feeder/monitoring/), [dashboards guide](../architecture/grafana-dashboards.md) |
| Architecture + security documentation | [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md), [`docs/security/security-notes.md`](../security/security-notes.md) |

**Hosting:** the repository is public on GitHub (MIT License); no separate hosted
service is required to run any component — every service (feeder, indexer,
monitoring) is a Docker image + `docker-compose` a third party can run
themselves against their own chain-provider key.

**Testing:** all four test suites (Aiken, CLI, feeder, indexer) were re-run and
verified passing during this milestone's evidence review. See the per-suite
counts above and the raw console output in each evidence pack's `tests/`
directory.

**Visual evidence:** five Grafana dashboards (Overview, Transactions, Internals,
Signer Wallets, Operational Cost), rendered live over the mainnet run window, are
included in both evidence packs' `dashboards/` directories.

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
   [example consumer contract](../../contracts/aiken/validators/example_oracle_consumer.ak)
   as a working reference implementation.

`[PLACEHOLDER: DIA to confirm any current or committed dApp integrations /
integration requests, if there are any to report.]` No user-count or
transaction-volume adoption figures are reported here because none have been
measured yet at submission time — the system has been live on Mainnet only
since 2026-06-16.

## 3. Impact

Measurable, verified results as of this report:

- **99.78% uptime** on the live Mainnet feed (`ARS/USDT`) over a ~32.27 h
  sustained window — against the milestone's 99.99% target, computed from the
  feeder's own logged freshness ceiling, not a qualitative estimate (see
  [mainnet evidence pack](evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md)).
- **0 real on-chain transaction failures, 0 chain reorgs** in that window.
- **16 distinct price feeds** deployed and live-queryable on Preview,
  demonstrating the architecture's capacity beyond a single feed.
- **1,083 automated tests passing** across contracts, CLI, feeder, and indexer.
- Cardano previously had no DIA oracle integration; this closes that gap and
  gives any Cardano dApp a documented path to any of DIA's 2,500+ price feeds
  and 10,000+ real-world-asset feeds.

`[PLACEHOLDER: DIA to add any TVL, partnership, or ecosystem-adoption figures,
if available — none are asserted here that are not directly measured above.]`

## 4. Sustainability

**Ongoing project — maintenance and roadmap:**

- The oracle, feeder, and indexer are designed to run continuously; the feeder
  already carries the operational tooling (automated fee settlement, wallet
  maintenance, alerting) needed for unattended production operation.
- Requesting a new feed is a standing, documented process — see
  [indexer README — requesting a new feed](../../offchain/indexer/README.md#requesting-a-new-feed) —
  not a one-off integration effort.
- `[PLACEHOLDER: DIA's committed maintenance/support arrangement and revenue
  model for the deployed integration, if decided.]`

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

- Close-out video: `[PLACEHOLDER: link]`
- Milestone 4 PoA: [`milestone-4-poa.md`](milestone-4-poa.md)
- Milestone 1-3 PoAs: [`milestone-1-poa.md`](milestone-1-poa.md), [`milestone-2-poa.md`](milestone-2-poa.md), [`milestone-3-poa.md`](milestone-3-poa.md)
- Architecture: [`docs/architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- License: [`LICENSE`](../../LICENSE) (MIT)
