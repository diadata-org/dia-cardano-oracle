# DIA Cardano Oracle

![DIA Ecosystem Architecture](docs/architecture/assets/dia-ecosystem-architecture.png)

Implementation repository for the DIA oracle integration on Cardano.

This repository is part of the Project Catalyst initiative **Integration of DIA Price Oracles on Cardano** and contains the work required to deliver the Cardano-specific oracle contracts, supporting off-chain components, deployment tooling, validation flows, and project documentation.

The current implementation uses the final Receiver-based Cardano architecture: DIA admins control Config and client onboarding, each client has an isolated Receiver balance, each client's pairs live under a Receiver-specific Pair script, and oracle price validity is derived from official DIA `OracleIntent` payloads plus their `EIP-712` secp256k1 signatures.

## Status

This repository is under active development.

## Project Context

The objective of this project is to deliver a Cardano-native integration for DIA price oracles, including:

- on-chain oracle contracts
- off-chain update submission components
- operational and deployment tooling
- monitoring and validation artifacts
- developer documentation

Project references:

- Catalyst proposal: <https://projectcatalyst.io/funds/14/cardano-use-cases-concepts/integration-of-dia-price-oracles-on-cardano>
- Catalyst milestone page: <https://milestones.projectcatalyst.io/projects/1400073>

## Repository Scope

The repository is organized around the main project areas:

- [`contracts/`](contracts): on-chain implementation artifacts
- [`offchain/`](offchain): off-chain implementation artifacts
- [`e2e/`](e2e): end-to-end validation artifacts
- [`specs/`](specs): milestone, requirement, design, and reference documents
- [`docs/`](docs): technical and operational documentation
- [`scripts/`](scripts): automation artifacts
- [`infra/`](infra): infrastructure-related artifacts

## Documentation Index

### Source of truth

- [Cardano Integration Requirement [PF]](specs/requirements/cardano-integration-requirement-pf.md) — DIA requirement document (via Protofire).
- [Final Cardano Milestones](specs/milestones/final-cardano-milestones.md) — Catalyst milestone text.

### Architecture and plan

- [Cardano Oracle Architecture](specs/design/cardano-oracle-architecture.md) — single architecture reference.
- [Work Plan](specs/plans/work-plan.md) — single work plan for the project.

### Component docs

- [On-chain contracts (Aiken) README](contracts/aiken/README.md)
- [Off-chain CLI README](offchain/cli/README.md)
- [Deployment evidence README](docs/deployment/evidence/README.md)

### References

- [Reference Links](specs/references/input-links.md) — external links (Google Docs, Catalyst, Spectra).

## Preview Workflow

The current implementation flow starts on the Cardano `Preview` network before any mainnet milestone run.

The current operator sequence is:

1. Inspect the generated contract blueprint:

```sh
cd offchain/cli
npm install
npm run cli -- blueprint:list
```

2. Verify protocol access through the configured Preview provider:

```sh
npm run cli -- preview:protocol
```

3. Create a Preview wallet with the off-chain CLI:

```sh
npm run cli -- preview:wallet:create
```

4. Fund the generated address through the official Cardano faucet:

- Faucet guide: <https://docs.cardano.org/cardano-testnets/tools/faucet>
- Environment: `Preview Testnet`

5. Configure the generated wallet and Preview provider in `offchain/cli/.env`.

6. Verify wallet and provider access:

```sh
npm run cli -- preview:wallet
npm run cli -- preview:wallet:defaults
```

7. Bootstrap the Config state and persist the result under `offchain/cli/state/preview/`.
   The Config state stores the Cardano config admins, the authorized DIA oracle public keys, the `EIP-712` domain parameters, and the protocol fee charged per updated pair.

8. Bootstrap the PaymentHook state, register the coordinator staking credential, and update the Config artifact with the active hook reference.

9. Bootstrap each client Receiver from the persisted Config state and store client-specific outputs under `offchain/cli/state/preview/clients/`.
   The Receiver holds the prepaid ADA balance used to pay protocol fees.

10. Bootstrap each subscribed pair from the persisted client Receiver state and store pair-specific outputs under `offchain/cli/state/preview/clients/<client>/pairs/`.
    Pair bootstrap creates a zeroed Pair UTxO whose Pair NFT asset name is `blake2b_256(pair_id)`.

11. Submit oracle updates from the persisted pair state files and overwrite them with the latest confirmed on-chain state.
    Oracle updates consume newer DIA `OracleIntent` payloads for the same symbol, validate the recovered signer against the authorized DIA key set stored in Config, move the protocol fee from the client's Receiver to the global PaymentHook, and update the Pair datum.

The CLI model is non-interactive:

- `.env` for secrets and provider configuration
- JSON input files for repeatable execution commands
- persisted deployment state under `offchain/cli/state/preview/`
- explicit commands for config bootstrap, payment-hook bootstrap, receiver bootstrap, pair bootstrap, and oracle update flows

## Reference Implementations

The current document set references DIA interoperability contracts and related materials, including:

- <https://github.com/diadata-org/Spectra-interoperability>
- <https://github.com/diadata-org/diadata>
