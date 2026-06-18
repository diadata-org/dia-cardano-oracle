# DIA Cardano Oracle

Implementation repository for the DIA oracle integration on Cardano.

## Contents

- [DIA Cardano Oracle](#dia-cardano-oracle)
  - [Contents](#contents)
  - [Repository Scope](#repository-scope)
  - [Prerequisites](#prerequisites)
  - [Quick Start](#quick-start)
  - [Operator Workflow](#operator-workflow)

The source-of-truth architecture is:

- [Cardano Oracle Architecture](docs/architecture/cardano-oracle-architecture.md)

Project and delivery documents:

- [Final Cardano Milestones](docs/milestones/final-cardano-milestones.md)
- ([Project Catalyst](https://milestones.projectcatalyst.io/projects/1400073))
- [Milestone 1 Proof of Achievement](docs/milestones/milestone-1-poa.md) — Catalyst submission document (links to all M1 evidence)
- [Milestone 2 Proof of Achievement](docs/milestones/milestone-2-poa.md) — Catalyst submission document (links to all M2 evidence)
- [Requirements](docs/requirements/cardano-integration-requirement-pf.md)

Component docs:

- [On-chain contracts (Aiken)](contracts/aiken/README.md)
- [Off-chain CLI runbook](offchain/cli/README.md) — protocol bootstrap, client onboarding, maintenance txs (settle, withdraw, pair lifecycle).
- [Feeder daemon](offchain/feeder/README.md) — long-running service that consumes DIA Lasernet `OracleIntent` events and submits Cardano oracle updates (M2 deliverable).

## Repository Scope

- `contracts/`: on-chain Aiken implementation.
- `offchain/cli/`: admin CLI — protocol/client bootstrap, treasury ops, lifecycle txs.
- `offchain/feeder/`: long-running feeder daemon — DIA → Cardano pipeline, HTTP API, Prometheus metrics, cron-based liveness.
- `offchain/Makefile`: operator shortcuts wrapping the unified `dia-cardano-feeder` Docker image (CLI + feeder in one image; profiles `sqlite`, `postgres`, `cli`, `monitoring`).
- `docs/`: architecture, milestones, requirements, plans, references.

## Prerequisites

- **Node.js 20+** with `npm`, for the off-chain CLI.
- **Aiken `v1.1.21`** (Plutus V3), only needed to modify or rebuild the
  on-chain contracts. See the
  [official installation instructions](https://aiken-lang.org/installation-instructions).
  The compiled blueprint `contracts/aiken/plutus.json` is committed, so a fresh
  clone can run the CLI runbook without Aiken installed.
- A **Blockfrost** project id (or a Koios endpoint) for Cardano Preview, and
  a funded Preview wallet seed. Setup details are in the CLI runbook.

## Quick Start

For a fresh clone, the recommended order is:

1. (Optional) Build and test the on-chain contracts —
   see [`contracts/aiken/README.md`](contracts/aiken/README.md). Skip this if
   you have not changed the contracts; the committed `plutus.json` is what the
   CLI consumes.
2. Install and configure the off-chain CLI — see
   [`offchain/cli/README.md`](offchain/cli/README.md).
3. Follow the CLI runbook end-to-end on Preview.

## Operator Workflow

Two complementary surfaces, each with its own full manual:

- **CLI (admin, one-shot ops)** — protocol/client bootstrap and maintenance
  transactions (settle, withdraws, min-UTxO updates, pair burn,
  reference-script reclaim). Phase-by-phase runbook in
  [`offchain/cli/README.md`](offchain/cli/README.md).
- **Feeder daemon (long-running)** — consumes DIA Lasernet `OracleIntent`
  events, routes and batches them, submits Cardano update txs, and exposes
  `/health`, `/metrics`, and `/api/v1/prices` over HTTP. Pipeline steps and the
  optional Prometheus + Grafana monitoring profile are in
  [`offchain/feeder/README.md`](offchain/feeder/README.md).

The fastest path to a working deployment is the unified Docker image:

```sh
cd offchain
make build               # builds the dia-cardano-feeder image (feeder + CLI)
make up                  # starts the feeder daemon (sqlite profile)
make up MONITORING=1     # feeder + Prometheus + Grafana (toggle on any start target)
make cli CMD="protocol"  # one-shot CLI command in the same image
```

For the protocol design behind each phase — datums, redeemers, cross-script
invariants, fee flow, batch validation algorithm, trust model — see the
[architecture document](docs/architecture/cardano-oracle-architecture.md)
and [security notes](docs/security/security-notes.md).
