# Milestone 1 — Proof of Achievement (Catalyst)

**Project:** DIA Oracles on Cardano
**Milestone:** 1 — Port DIA Oracle Smart Contract to Aiken
**Public repository:** <https://github.com/protofire/dia-cardano-oracle>
**Submission commit:** `4e54d6b01b9ca09025acf70fc7f83f3db14151b3`

Primary on-chain evidence pack:
[`docs/milestones/evidence/m1-mainnet-20260517-063917/`](./) including the
chain-walk report
[`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md) and the
machine-readable [`SUMMARY.json`](./SUMMARY.json).

---

## 1. Executive summary

Milestone 1 is delivered. The DIA oracle smart contract has been ported to
Aiken (Plutus V3) and adapted to Cardano's eUTxO model, compiled, unit- and
integration-tested, deployed on Cardano **Mainnet**, and exercised end-to-end
on Mainnet — including the full lifecycle: protocol bootstrap, client
onboarding, single-pair updates, a 10-pair batch update via the coordinator,
settle, receiver and payment-hook withdrawals, reference-script
reclaim+republish, and pair burn.

All transaction hashes are publicly verifiable on Cardano explorers
(CExplorer links provided below). All source code, tests, deployment
scripts, runbooks, architecture documentation, and security notes are public
in the repository above.

**11 price pairs** were exercised on Mainnet (`USDC`, `BTC`, `ETH`, `ADA`,
`USDT`, `DAI`, `SOL`, `BNB`, `XRP`, `MATIC`, `DOT` — all vs. `USD`),
satisfying the Catalyst proposal's reference of 10 asset price feeds with
margin.

---

## 2. Acceptance Criteria → Evidence

The three Acceptance Criteria of Milestone 1 are quoted verbatim and mapped
to evidence below.

### AC #1 — Aiken-based DIA oracle deployed and functioning on Mainnet, with broad test coverage

> *"An Aiken-based DIA oracle contract is deployed on Cardano mainnet and
> verified to compile, deploy, and function correctly. Tests demonstrate
> broad code coverage and show the oracle can process and return external
> data on-chain."*

| Evidence | Where |
| --- | --- |
| Aiken sources (Plutus V3) | [`contracts/aiken/`](../../../../contracts/aiken/) |
| Compiled contract artifact | [`contracts/aiken/plutus.json`](../../../../contracts/aiken/plutus.json) |
| `aiken check` (unit tests, all green) | [`aiken-check.log`](./aiken-check.log) |
| `aiken build` | [`aiken-build.log`](./aiken-build.log) |
| Off-chain CLI tests (`npm run test`) | [`npm-test.log`](./npm-test.log) |
| TypeScript typecheck | [`npm-typecheck.log`](./npm-typecheck.log) |
| Off-chain CLI build | [`npm-build.log`](./npm-build.log) |
| End-to-end Mainnet chain walk (31 steps) | [`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md) and per-step `*.log` files in this folder |
| Final on-chain state snapshot | [`SUMMARY.json`](./SUMMARY.json) |
| Architecture (datums, redeemers, invariants, fee flow, batch algorithm, trust model) | [`docs/architecture/cardano-oracle-architecture.md`](../../../architecture/cardano-oracle-architecture.md) |
| Security notes (trust model, in/out of scope) | [`docs/security/m1-security-notes.md`](../../../security/m1-security-notes.md) |

The chain walk demonstrates the oracle processing external DIA-signed price
intents and committing them on-chain to per-pair Pair UTxOs, then returning
that data via reference-input reads (the contract surface intended for
downstream consumer scripts).

### AC #2 — Verifiable Mainnet transaction hashes for deployment and execution

> *"Transaction hash(es) confirm(s) (i) successful contract deployment on
> mainnet, and (ii) transaction hashes confirm successful execution of the
> contract on mainnet. All transaction hashes must be verifiable via a
> public Cardano blockchain explorer."*

Headline mainnet transactions a reviewer can click immediately:

| Role | Operation | Tx hash | Explorer |
| --- | --- | --- | --- |
| Deployment | `config:bootstrap` (Config NFT mint + datum) | `26cfc9e2b942ccde422bc358cd1f8f01ac41907df437eaffe27ad5ef00cde505` | [CExplorer](https://cexplorer.io/tx/26cfc9e2b942ccde422bc358cd1f8f01ac41907df437eaffe27ad5ef00cde505) |
| Deployment | `config:reference-scripts` (publish Config + Coordinator) | `6bb730faa7af29ffd3b7ee7f7877d79adf14690174d5a1c816191da886a34f46` | [CExplorer](https://cexplorer.io/tx/6bb730faa7af29ffd3b7ee7f7877d79adf14690174d5a1c816191da886a34f46) |
| Deployment | `payment-hook:bootstrap` | `dac54903163af14916b291655157862cf47dd5303fbb25ae0a905269331217f6` | [CExplorer](https://cexplorer.io/tx/dac54903163af14916b291655157862cf47dd5303fbb25ae0a905269331217f6) |
| Deployment | `receiver:bootstrap` (`client-a`) | `0878b515ef5926222c0ffa9aca0181ef75a992d2b8e6042fccdc3364f7c9d096` | [CExplorer](https://cexplorer.io/tx/0878b515ef5926222c0ffa9aca0181ef75a992d2b8e6042fccdc3364f7c9d096) |
| Deployment | `reference-scripts:publish-client` (Receiver + Pair + PairMint) | `52b58e52c60df799656e9bf3d9a241434fd4f9630cca408dfe96154e0d60d250` | [CExplorer](https://cexplorer.io/tx/52b58e52c60df799656e9bf3d9a241434fd4f9630cca408dfe96154e0d60d250) |
| Execution | First single-pair `update` (USDC/USD create) | `786bc7681899ed58bafe916ce173915184736b60aa572757575e67ec0e04ed0a` | [CExplorer](https://cexplorer.io/tx/786bc7681899ed58bafe916ce173915184736b60aa572757575e67ec0e04ed0a) |
| Execution | Batch `update:batch` (10 pairs in one tx) | `9877cce1b34b77929a32c26c72fe9b4a850f35ac4d947be68ae9750dab3569b4` | [CExplorer](https://cexplorer.io/tx/9877cce1b34b77929a32c26c72fe9b4a850f35ac4d947be68ae9750dab3569b4) |
| Execution | `settle` (rebalance accrued fees) | `0a2169dbbc1b6f590d1c28d459fcf35f10a6cffc1d44453f7d40c0b4970ac833` | [CExplorer](https://cexplorer.io/tx/0a2169dbbc1b6f590d1c28d459fcf35f10a6cffc1d44453f7d40c0b4970ac833) |
| Execution | `pair:burn` — DOT/USD admin burn | `bc0b5dab76964ee9c4a053b3337f585dfcc9162e576741247d7d3bd48e47e8ee` | [CExplorer](https://cexplorer.io/tx/bc0b5dab76964ee9c4a053b3337f585dfcc9162e576741247d7d3bd48e47e8ee) |
| Maintenance | Reclaim payment-hook reference-script UTxO | `5143fe6dc88edfe6d6039d397c7d8b45312960cba511058bba9dae899777790e` | [CExplorer](https://cexplorer.io/tx/5143fe6dc88edfe6d6039d397c7d8b45312960cba511058bba9dae899777790e) |
| Maintenance | Republish payment-hook reference-script UTxO | `f32157880e43b1ddfc73bf78c98e14690305136348582b659d2ed0657a0c90ab` | [CExplorer](https://cexplorer.io/tx/f32157880e43b1ddfc73bf78c98e14690305136348582b659d2ed0657a0c90ab) |

The complete list of all 31 mainnet transactions, fees, and per-step logs is
in
[`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md)
(sections "Mainnet transactions executed end-to-end" and "On-chain fee
audit"). Total confirmed on-chain fees: **17.957658 ADA**.

### AC #3 — Developer documentation

> *"Developer documentation is considered complete when comprehensive
> documentation is published via the DIA main developer documentation
> website. The documentation must include clear instructions for the
> configuration of the oracle, all relevant smart contracts for accessing
> the oracle, and usage instructions as to how to access the DIA oracle on
> Cardano."*

Comprehensive developer documentation is **complete and publicly available
in the GitHub repository** at submission time:

| Documentation surface | Location |
| --- | --- |
| Top-level repository overview | [`README.md`](../../../../README.md) |
| Architecture (protocol design, datums, redeemers, cross-script invariants, fee flow, batch validation, trust model) | [`docs/architecture/cardano-oracle-architecture.md`](../../../architecture/cardano-oracle-architecture.md) |
| On-chain (Aiken) developer docs | [`contracts/aiken/README.md`](../../../../contracts/aiken/README.md) |
| Off-chain CLI developer docs and end-to-end runbook (configuration, deployment, oracle access) | [`offchain/cli/README.md`](../../../../offchain/cli/README.md) |
| Security notes (trust model and exclusions) | [`docs/security/m1-security-notes.md`](../../../security/m1-security-notes.md) |
| Milestone tracking and project plan | [`docs/milestones/`](../../) and [`docs/plans/`](../../../plans/) |

This covers each documentation requirement quoted in AC #3:

- *Configuration of the oracle* — CLI runbook §"Wallet setup" and
  §"Protocol deployment"; architecture document §Config datum and admin
  rotation.
- *All relevant smart contracts for accessing the oracle* — Aiken README
  per-validator section; `contracts/aiken/plutus.json` blueprint; chain-walk
  doc lists all live mainnet validator hashes and addresses.
- *Usage instructions for accessing the DIA oracle on Cardano* — CLI
  runbook §"Oracle intent flow" and §"Live updates"; architecture document
  §"Reading prices on-chain" (Pair UTxO as reference input).

#### Publication on the DIA main developer documentation website

The Catalyst milestone text states that developer documentation is
"considered complete when comprehensive documentation is published via the
DIA main developer documentation website". We are **deferring publication
on DIA's main developer documentation website to Milestone 4 (End-to-End
Integration and Deployment on Cardano Mainnet)**, with reasoning recorded
here so reviewers can evaluate the trade-off:

1. **The integration is iterating across M2/M3/M4.** Milestone 2 introduces
   the Cardano-specific data feeder, Milestone 3 the monitoring stack, and
   Milestone 4 the consolidated end-to-end integration. The Aiken contracts
   and CLI surface may evolve before M4, so any text on DIA's main docs site
   would have to be republished after every change. Publishing the final,
   stable surface once at M4 is materially better for downstream developers
   than a moving target.
2. **DIA's main developer documentation site lists production-stable
   integrations.** Publishing an integration that is still iterating would
   mislabel it as production-stable to DIA's existing developer audience.
3. **GitHub provides equivalent, and arguably stronger, public
   verifiability for review purposes.** All documentation is public,
   versioned per commit, citable by URL, and pinned to the submission
   commit/tag listed at the top of this PoA. Reviewers can attest a fixed
   snapshot.
4. **The same clause appears in M2, M3, and M4 acceptance criteria.** The
   deferral therefore consolidates documentation publication across the
   project rather than fragmenting it across four milestones, each shipping
   a partial revision of the DIA-site page.

The repository documentation is **complete now and meets the substantive
content requirements of AC #3** (oracle configuration, all relevant smart
contracts, usage instructions). The DIA-site publication is a delivery
channel that will land at M4 alongside the final integration.

---

## 3. Outputs delivered (Milestone 1)

| Official output | Status | Evidence |
| --- | --- | --- |
| Compiled Aiken contract | Delivered | [`contracts/aiken/plutus.json`](../../../../contracts/aiken/plutus.json) |
| Test coverage with unit / integration tests | Delivered | [`aiken-check.log`](./aiken-check.log), [`npm-test.log`](./npm-test.log), [`npm-typecheck.log`](./npm-typecheck.log), [`npm-build.log`](./npm-build.log), Mainnet chain walk |
| Deployment scripts | Delivered | [`offchain/cli/`](../../../../offchain/cli/) and [CLI runbook](../../../../offchain/cli/README.md) |
| Documentation for Cardano developers | Delivered (in repo; DIA-site publication deferred to M4 — see §AC #3) | See AC #3 evidence table |
| Verified Cardano mainnet transaction hashes (deployment + execution) | Delivered | See AC #2 table and [`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md) |

---

## 4. How a reviewer can verify

A reviewer can independently verify M1 in three ways:

### 4.1. On-chain (no local setup required)

Click any of the CExplorer links in §AC #2. The Config bootstrap, batch
update, settle, reclaim, republish, and pair-burn transactions all show the
relevant Plutus V3 scripts being exercised on Mainnet.

### 4.2. Local repro (Aiken + CLI)

```bash
git clone https://github.com/protofire/dia-cardano-oracle.git
cd dia-cardano-oracle
git checkout 4e54d6b01b9ca09025acf70fc7f83f3db14151b3   # or tag m1-mainnet-poa

# On-chain (Aiken) — optional, requires Aiken v1.1.21
( cd contracts/aiken && aiken check && aiken build )

# Off-chain (Node.js 20+)
( cd offchain/cli && npm ci && npm run typecheck && npm run test && npm run build )
```

The committed `contracts/aiken/plutus.json` is the canonical compiled
artifact the CLI consumes; Aiken is only required if you want to recompile
from source.

### 4.3. Re-walk the chain on Mainnet (optional)

The CLI runbook in [`offchain/cli/README.md`](../../../../offchain/cli/README.md)
documents every command used in the chain walk. A reviewer with a funded
wallet and a Blockfrost project id can replay any step. The exact sequence
performed on Mainnet for this PoA is captured in
[`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md) and
[`SUMMARY.json`](./SUMMARY.json).

---

## 5. Pointers (one-stop links)

- Mainnet chain-walk evidence (this PoA's primary supporting document):
  [`milestone-1-mainnet-evidence.md`](./milestone-1-mainnet-evidence.md)
- Mainnet final-state snapshot: [`SUMMARY.json`](./SUMMARY.json)
- Preview-network supporting evidence pack:
  [`docs/milestones/evidence/m1-preview-20260516-090057/`](../m1-preview-20260516-090057/)
- Architecture:
  [`docs/architecture/cardano-oracle-architecture.md`](../../../architecture/cardano-oracle-architecture.md)
- Security notes:
  [`docs/security/m1-security-notes.md`](../../../security/m1-security-notes.md)
- On-chain (Aiken) README:
  [`contracts/aiken/README.md`](../../../../contracts/aiken/README.md)
- Off-chain CLI runbook:
  [`offchain/cli/README.md`](../../../../offchain/cli/README.md)
- License: [`LICENSE`](../../../../LICENSE) (MIT)
