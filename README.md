# DIA Cardano Oracle

![DIA Ecosystem Architecture](docs/architecture/assets/dia-ecosystem-architecture.png)

Implementation repository for the DIA oracle integration on Cardano.

This repository is part of the Project Catalyst initiative **Integration of DIA Price Oracles on Cardano** and contains the work required to deliver the Cardano-specific oracle contracts, supporting off-chain components, deployment tooling, validation flows, and project documentation.

The current implementation direction preserves Cardano wallets as configuration authorities and transaction submitters, while oracle price validity is derived from official DIA `OracleIntent` payloads and their `EIP-712` secp256k1 signatures.

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

All project documents, grouped by purpose, with their current status.
Status tags:

- `source` — external source of truth, not edited here.
- `current` — aligned with the latest confirmed architecture.
- `needs-update` — predates the 2026-04-21 DIA clarifications and conflicts with them.

### Requirements and milestones (source of truth)

- [Final Cardano Milestones](specs/milestones/final-cardano-milestones.md) — `source`. Catalyst milestone text.
- [Cardano Integration Requirement [PF]](specs/requirements/cardano-integration-requirement-pf.md) — `source`. DIA requirement document (via Protofire).
- [Milestone Mapping](specs/milestone-mapping.md) — `current`. Maps milestones to repository areas.

### Architecture and design (live)

- [Cardano Oracle Integration – Technical Specification](specs/design/20260416-cardano-oracle-integration-technical-specification.md) — `needs-update`. The single architecture spec. Written for a single-tenant model; architecture is under revision (multi-tenant, Config location, signature scheme, pair whitelist, updater model).
- [Architecture Overview](docs/architecture/overview.md) — `current`. Repository layout only. Does not describe deployment topology.

### Milestone 1 plan (live)

- [Milestone 1 Contract and Transaction Architecture Plan](specs/plans/20260415-142121-milestone1-contract-and-transaction-architecture-plan.md) — `needs-update`. The single implementation plan. Assumes single-tenant model; will be revised together with the spec.

### Component docs

- [On-chain contracts (Aiken) README](contracts/aiken/README.md) — `current`. Reflects current on-chain scaffolding; will follow the spec revision.
- [Off-chain CLI README](offchain/cli/README.md) — `current` for Preview flow; will follow the spec revision.
- [Deployment evidence README](docs/deployment/evidence/README.md) — `current`. Evidence index skeleton.

### References

- [Reference Links](specs/references/input-links.md) — `source`. External links (Google Docs, Catalyst, Spectra).

### Known divergences to reconcile

These are the deltas between what is documented today and what DIA confirmed on 2026-04-21.

- **Single-tenant vs multi-tenant.** Current spec is single-tenant. DIA confirmed multi-tenant: one `PushOracleReceiver` per client, one shared `ProtocolFeeHook` per chain.
- **Config location.** Current spec has a separate Config contract. EVM and DIA guidance: no separate Config; signers, fee params, and domain live inside the Receiver's configuration.
- **Client identity NFT.** Current spec mints per-client / per-pair NFTs. DIA said the receiver's address is the only client identifier; a per-client identity NFT is not desired. Pair-level state tokens are still required by Cardano's UTxO model to identify "the one live UTxO per pair", but they are not a client-identity mechanism.
- **Signature scheme.** Current spec uses `Ed25519 + blake2b-256`. DIA uses `secp256k1 ECDSA` with EIP-712-style domain separation. Plutus V2+ supports `verifyEcdsaSecp256k1Signature` natively, so the Cardano port must use `secp256k1` to match DIA signers.
- **Allowed-pair whitelist.** Current spec enforces `allowed_pairs` on-chain. DIA: not enforced on-chain; any symbol passes if the signature is valid. Pair filtering stays off-chain.
- **Updater permissioning.** Current spec implies an updater allowlist. DIA: permissionless submitters, authority comes from the signed Intent.

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
   The Config state stores the Cardano config signers, the authorized DIA oracle public keys, the active payment-hook reference, and the `EIP-712` domain parameters required for intent verification.

8. Bootstrap the PaymentHook state, register the coordinator staking credential, and update the Config artifact with the active hook reference.

9. Bootstrap each pair from that persisted config state and store pair-specific outputs under `offchain/cli/state/preview/pairs/`.
   Pair bootstrap consumes an official DIA `OracleIntent` fixture and creates the initial Pair state on Cardano.

10. Submit oracle updates from the persisted pair state files and overwrite them with the latest confirmed on-chain state.
    Oracle updates consume newer DIA `OracleIntent` payloads for the same symbol, validate the recovered signer against the authorized DIA key set stored in Config, and accumulate protocol fees in the dedicated PaymentHook UTxO.

The CLI model is non-interactive:

- `.env` for secrets and provider configuration
- JSON input files for repeatable execution commands
- persisted deployment state under `offchain/cli/state/preview/`
- explicit commands for config bootstrap, payment-hook bootstrap, pair bootstrap, and oracle update flows

## Reference Implementations

The current document set references DIA interoperability contracts and related materials, including:

- <https://github.com/diadata-org/Spectra-interoperability>
- <https://github.com/diadata-org/diadata>
