# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](./final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included here.

Verification date: **2026-05-04** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260504/`](./evidence/m1-preview-20260504/) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

Fee audit source: [`tx-fees.koios.json`](./evidence/m1-preview-20260504/tx-fees.koios.json) — raw Koios Preview `tx_info` responses captured on **2026-05-04** for every confirmed transaction in this pack.

A historical pack from 2026-04-27 (older bytecode, kept for traceability only) is preserved at [`docs/milestones/evidence/m1-preview-20260427/`](./evidence/m1-preview-20260427/).

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | `aiken check` — **83/83** tests; `offchain/cli` `npm run test` + `npm run typecheck` + `npm run build` green (2026-05-04). End-to-end Preview chain walk captured below. |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending (mainnet not executed yet — separate gate) |

## Local tooling verification (2026-05-04)

Logs are in [`./evidence/m1-preview-20260504/`](./evidence/m1-preview-20260504/).

| Area | Working directory | Command | Result | Captured output |
| --- | --- | --- | --- | --- |
| Aiken contracts | `contracts/aiken` | `aiken check` | 83/83 tests passed | [`aiken-check.log`](./evidence/m1-preview-20260504/aiken-check.log) |
| CLI tests | `offchain/cli` | `npm run test` | `CLI tests passed` | [`npm-test.log`](./evidence/m1-preview-20260504/npm-test.log) |
| CLI typecheck | `offchain/cli` | `npm run typecheck` | exit 0 | [`npm-typecheck.log`](./evidence/m1-preview-20260504/npm-typecheck.log) |
| CLI build | `offchain/cli` | `npm run build` | exit 0 | [`npm-build.log`](./evidence/m1-preview-20260504/npm-build.log) |

## Preview transactions executed end-to-end

All transactions below were submitted on Cardano Preview and confirmed. The chain walk demonstrates every Milestone 1 protocol surface, including the new **Settle** transaction, and ends with both maintenance withdrawals.

The integration also exercises **eleven price pairs** (`USDC/USD`, `USDT/USD`, `BTC/USD`, `ETH/USD`, `ADA/USD`, `DAI/USD`, `SOL/USD`, `BNB/USD`, `XRP/USD`, `MATIC/USD`, `DOT/USD`) — covering the ten live feeds referenced in the Catalyst proposal — and a two-step batch update across all ten of those non-USDC pairs (5 + 5, split because the Plutus per-tx execution-units budget on Preview cannot fit ten ECDSA verifications in a single transaction).

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 1 | `preview:config:parameterize` (compute Config + Coordinator script hashes) | *(local artifact step)* | [`01-config-parameterize.log`](./evidence/m1-preview-20260504/01-config-parameterize.log) |
| 2 | `preview:config:bootstrap` | `f6975c53582a2dfc2031ed05dae0ee82c252b0d050f1805d55f8f87e5d5fdd4f` | [`02-config-bootstrap.log`](./evidence/m1-preview-20260504/02-config-bootstrap.log) |
| 3 | `preview:config:reference-scripts` (Config + Coordinator) | `aa672cb34019fd3839a914553f4dacb677ed0fed3ec196f8d8c4fb9f70408bf9` | [`03-config-reference-scripts.log`](./evidence/m1-preview-20260504/03-config-reference-scripts.log) |
| 4 | `preview:payment-hook:parameterize` | *(local artifact step)* | [`04-payment-hook-parameterize.log`](./evidence/m1-preview-20260504/04-payment-hook-parameterize.log) |
| 5 | `preview:payment-hook:bootstrap` | `bbc542f9b8a0efc7402fccd9c396c117ffc8a49175867bde960ab72b474b535a` | [`05-payment-hook-bootstrap.log`](./evidence/m1-preview-20260504/05-payment-hook-bootstrap.log) |
| 6 | `preview:payment-hook:reference-script` | `2aecfd981003eccf7cb20a122ad7320b73e124c4c573954996d600cc4341f857` | [`06-payment-hook-reference-script.log`](./evidence/m1-preview-20260504/06-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 7 | `preview:receiver:parameterize` | *(local artifact step)* | [`07-receiver-parameterize.log`](./evidence/m1-preview-20260504/07-receiver-parameterize.log) |
| 8 | `preview:receiver:bootstrap` | `cde0d8b4be4597216bbdf52304883fb16c3a2b1ff5e797596fc64190ecc42224` | [`08-receiver-bootstrap.log`](./evidence/m1-preview-20260504/08-receiver-bootstrap.log) |
| 9 | `preview:reference-scripts:publish-client` (Receiver + Pair) | `cc0c685e1b389bb3b6866caf2a2adcc20e0574aa51aa789728c9347d6a3bbc77` | [`09-client-reference-scripts.log`](./evidence/m1-preview-20260504/09-client-reference-scripts.log) |
| 10 | `preview:receiver:top-up` (30 ADA) | `fa763874da069e3aefdf7a04c278f5f09154364f5ba41adc5b40897e18e23fc8` | [`10-receiver-top-up.log`](./evidence/m1-preview-20260504/10-receiver-top-up.log) |

### Single-pair updates — 11 pair bootstraps via `preview:update`

Each of these is a `preview:update` whose coordinator branch is `ApplySingle(witness)` and whose target Pair UTxO does not yet exist (the Pair NFT is minted in the same transaction and the Pair UTxO is created from the signed intent). Each update accrues one protocol fee on the Receiver UTxO via `AccrueFee` (no PaymentHook input/output).

| Pair | Tx hash | Log |
| --- | --- | --- |
| USDC/USD | `ad48a66a00d5295fd3d9435d0366b13f4d7d94888d2c24fdb61170058c8ea127` | [`11b-update-usdc-bootstrap.log`](./evidence/m1-preview-20260504/11b-update-usdc-bootstrap.log) |
| BTC/USD | `0fc6bf5bcdd6a27819cc7521e2e8259ea7be78a3199b17fb7c4cb2de93d9179f` | [`12-bootstrap-btc-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-btc-usd.log) |
| ETH/USD | `407c49a5f10c15c105ee7c368a6133a03f3c1b808f1fd254d1b2a7082cd3449f` | [`12-bootstrap-eth-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-eth-usd.log) |
| ADA/USD | `ddae0b30ce9f60cd8f6c972c616e075316971d4cddb1b20cc34acfbd111e144c` | [`12-bootstrap-ada-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-ada-usd.log) |
| USDT/USD | `ca6aefe94aa6939ae7ae37fffbe1371cb2a58f58f01645fd6e859708f1720169` | [`12-bootstrap-usdt-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-usdt-usd.log) |
| DAI/USD | `6b2a6364980188608e88f02ca905be69e96d67a8aaef1ba9b6c6ae2365f25d31` | [`12-bootstrap-dai-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-dai-usd.log) |
| SOL/USD | `c8149192530b2566908ee5f46c73844276f30731580bf470eccf7e4ebbd2e670` | [`12-bootstrap-sol-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-sol-usd.log) |
| BNB/USD | `68f6b566566db4c7afa70aeaf8230145296f18c6d5168491352468fe632a598f` | [`12-bootstrap-bnb-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-bnb-usd.log) |
| XRP/USD | `d6d4b11417d7dc76451217a353b7ed0def98439a304ae49f4f0f63820ed23eb9` | [`12-bootstrap-xrp-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-xrp-usd.log) |
| MATIC/USD | `a3c3abf2bcec9a89a537f5a1516f1e7086e0bec75470d1e5019d91491f2e2ea3` | [`12-bootstrap-matic-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-matic-usd.log) |
| DOT/USD | `77f627a7cb575596c58124c096735169b5aaef3872ccd2d57d2013b194478303` | [`12-bootstrap-dot-usd.log`](./evidence/m1-preview-20260504/12-bootstrap-dot-usd.log) |

### Second top-up (replenish before batches)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 13 | `preview:receiver:top-up` (30 ADA) | `f35de82d892001e11aafb31bae4acf6c33036cb659460bc8cfe3dfdeb7e6ff84` | [`13-receiver-top-up-2.log`](./evidence/m1-preview-20260504/13-receiver-top-up-2.log) |

### Batch updates — coordinator `ApplyBatch`

A single batch with all ten non-USDC pairs exceeds the per-tx Plutus execution-units budget on Cardano Preview (each ECDSA verification is ~440M CPU units; ten verifications plus the per-witness checks land above the ~10B per-tx limit). The integration therefore submits **two batch transactions of five witnesses each**, fully covering the ten Catalyst feeds. The "10-in-one-tx" attempt is preserved as evidence of the Plutus budget reaching its limit.

| Step | Operation | Pairs | Tx hash | Log |
| --- | --- | --- | --- | --- |
| 14 | `preview:update:batch` (10 pairs, attempted) | BTC, ETH, ADA, USDT, DAI, SOL, BNB, XRP, MATIC, DOT | *(rejected at script-evaluation: `Withdraw[0] execution went over budget`)* | [`14-update-batch.log`](./evidence/m1-preview-20260504/14-update-batch.log) |
| 14a | `preview:update:batch` (5 pairs) | BTC, ETH, ADA, USDT, DAI | `1a676b49f83b2dd7855eb1e34697f01ba383914e035120fdaf1d8363e75e1d35` | [`14a-update-batch-A.log`](./evidence/m1-preview-20260504/14a-update-batch-A.log) |
| 14b | `preview:update:batch` (5 pairs) | SOL, BNB, XRP, MATIC, DOT | `8e04c3e07f53c560efbefb478b2cb6a29acfa1d7644924ac09da799e6b7d55d3` | [`14b-update-batch-B.log`](./evidence/m1-preview-20260504/14b-update-batch-B.log) |

### Settle, receiver withdraw, payment-hook withdraw

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 15 | **`preview:settle`** — drain `accrued_to_hook` from Receiver into PaymentHook (coordinator `ApplySettle` + admin signature) | `8e996d89368739ca80ef4620db713a8e44de1b828c8f17d71a443dd58e187791` | [`15-settle.log`](./evidence/m1-preview-20260504/15-settle.log) |
| 16 | `preview:receiver:withdraw` (5 ADA → admin wallet) | `7982be4b1bb27ac5f2919f786cb5742666398af4cb1623aae4c4f221a008c554` | [`16-receiver-withdraw.log`](./evidence/m1-preview-20260504/16-receiver-withdraw.log) |
| 17 | `preview:payment-hook:withdraw` (10 ADA → admin wallet) | `1cf8258f56c0775f4bdd244e60b535826ea9dce84f6b8cb28dd9ded82bdbad61` | [`17-payment-hook-withdraw.log`](./evidence/m1-preview-20260504/17-payment-hook-withdraw.log) |

## On-chain fee audit

Queried from Koios Preview `tx_info` on **2026-05-04**. This ledger covers **every confirmed Preview transaction** in the walkthrough above, plus the rejected 10-pair batch attempt.

| Step | Operation | Tx hash | Fee paid |
| --- | --- | --- | --- |
| 2 | `preview:config:bootstrap` | `f6975c53582a2dfc2031ed05dae0ee82c252b0d050f1805d55f8f87e5d5fdd4f` | `0.300362 ADA` |
| 3 | `preview:config:reference-scripts` | `aa672cb34019fd3839a914553f4dacb677ed0fed3ec196f8d8c4fb9f70408bf9` | `0.610693 ADA` |
| 5 | `preview:payment-hook:bootstrap` | `bbc542f9b8a0efc7402fccd9c396c117ffc8a49175867bde960ab72b474b535a` | `0.598308 ADA` |
| 6 | `preview:payment-hook:reference-script` | `2aecfd981003eccf7cb20a122ad7320b73e124c4c573954996d600cc4341f857` | `0.387261 ADA` |
| 8 | `preview:receiver:bootstrap` | `cde0d8b4be4597216bbdf52304883fb16c3a2b1ff5e797596fc64190ecc42224` | `0.425212 ADA` |
| 9 | `preview:reference-scripts:publish-client` | `cc0c685e1b389bb3b6866caf2a2adcc20e0574aa51aa789728c9347d6a3bbc77` | `0.552921 ADA` |
| 10 | `preview:receiver:top-up` (30 ADA) | `fa763874da069e3aefdf7a04c278f5f09154364f5ba41adc5b40897e18e23fc8` | `0.350012 ADA` |
| 11b | `preview:update` — USDC/USD bootstrap | `ad48a66a00d5295fd3d9435d0366b13f4d7d94888d2c24fdb61170058c8ea127` | `0.697579 ADA` |
| 12 | `preview:update` — BTC/USD bootstrap | `0fc6bf5bcdd6a27819cc7521e2e8259ea7be78a3199b17fb7c4cb2de93d9179f` | `0.697843 ADA` |
| 12 | `preview:update` — ETH/USD bootstrap | `407c49a5f10c15c105ee7c368a6133a03f3c1b808f1fd254d1b2a7082cd3449f` | `0.697843 ADA` |
| 12 | `preview:update` — ADA/USD bootstrap | `ddae0b30ce9f60cd8f6c972c616e075316971d4cddb1b20cc34acfbd111e144c` | `0.697491 ADA` |
| 12 | `preview:update` — USDT/USD bootstrap | `ca6aefe94aa6939ae7ae37fffbe1371cb2a58f58f01645fd6e859708f1720169` | `0.697579 ADA` |
| 12 | `preview:update` — DAI/USD bootstrap | `6b2a6364980188608e88f02ca905be69e96d67a8aaef1ba9b6c6ae2365f25d31` | `0.697491 ADA` |
| 12 | `preview:update` — SOL/USD bootstrap | `c8149192530b2566908ee5f46c73844276f30731580bf470eccf7e4ebbd2e670` | `0.697843 ADA` |
| 12 | `preview:update` — BNB/USD bootstrap | `68f6b566566db4c7afa70aeaf8230145296f18c6d5168491352468fe632a598f` | `0.697843 ADA` |
| 12 | `preview:update` — XRP/USD bootstrap | `d6d4b11417d7dc76451217a353b7ed0def98439a304ae49f4f0f63820ed23eb9` | `0.697491 ADA` |
| 12 | `preview:update` — MATIC/USD bootstrap | `a3c3abf2bcec9a89a537f5a1516f1e7086e0bec75470d1e5019d91491f2e2ea3` | `0.697677 ADA` |
| 12 | `preview:update` — DOT/USD bootstrap | `77f627a7cb575596c58124c096735169b5aaef3872ccd2d57d2013b194478303` | `0.697491 ADA` |
| 13 | `preview:receiver:top-up` (30 ADA) | `f35de82d892001e11aafb31bae4acf6c33036cb659460bc8cfe3dfdeb7e6ff84` | `0.349757 ADA` |
| 14 | `preview:update:batch` (10 pairs, attempted) | *(not submitted)* | `0 ADA` — rejected locally at script evaluation (`Withdraw[0] execution went over budget`) |
| 14a | `preview:update:batch` (5 pairs) | `1a676b49f83b2dd7855eb1e34697f01ba383914e035120fdaf1d8363e75e1d35` | `1.848581 ADA` |
| 14b | `preview:update:batch` (5 pairs) | `8e04c3e07f53c560efbefb478b2cb6a29acfa1d7644924ac09da799e6b7d55d3` | `1.842452 ADA` |
| 15 | `preview:settle` | `8e996d89368739ca80ef4620db713a8e44de1b828c8f17d71a443dd58e187791` | `0.762751 ADA` |
| 16 | `preview:receiver:withdraw` (5 ADA → admin wallet) | `7982be4b1bb27ac5f2919f786cb5742666398af4cb1623aae4c4f221a008c554` | `0.379981 ADA` |
| 17 | `preview:payment-hook:withdraw` (10 ADA → admin wallet) | `1cf8258f56c0775f4bdd244e60b535826ea9dce84f6b8cb28dd9ded82bdbad61` | `0.379367 ADA` |

Total confirmed on-chain fees in this Preview walkthrough: **`16.461829 ADA`** (`16,461,829` lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./evidence/m1-preview-20260504/SUMMARY.json) at the end of the Preview chain walk.

### Identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wzwyjd7eza9rrndl7hwkesadzpq7ajchxxd67mj4zrz80hcka7jtk` |
| Config policy / validator hash | `a346e1fe5b9bf33fd5afa49ed0d840ee6346d12a12abfba61079bac4` |
| Config NFT unit (`DIA_CONFIG`) | `a346e1fe5b9bf33fd5afa49ed0d840ee6346d12a12abfba61079bac44449415f434f4e464947` |
| Coordinator stake validator hash | `98719f388bd18a386e7baff107f37e1e3761a7ea4a3a5d881b96b018` |
| PaymentHook policy / validator hash | `7aa0a4029e2c5c00a74ee4f0dd5036c1a3b5bfa3413505e9413f9027` |
| PaymentHook NFT unit (`DIA_PAYMENT_HOOK`) | `7aa0a4029e2c5c00a74ee4f0dd5036c1a3b5bfa3413505e9413f90274449415f5041594d454e545f484f4f4b` |
| Receiver validator address (`client-a`) | `addr_test1wzydrzuc7s0jpgvqsdq2kqarputsp333665fncmm0hdc5vs3fs8k6` |
| Pair validator address (`client-a`) | `addr_test1wr22ktazlu2wzpzntr0m45pns2jwgm6knhx83007jwsz6zctjx355` |

### Final UTxOs

| Artifact | Value |
| --- | --- |
| Receiver UTxO (final) | `balance 0` lovelace, `accrued_to_hook 0` lovelace, `min_utxo 3000000` lovelace (after step 16). |
| PaymentHook UTxO (final) | `accrued 32_000_000` lovelace, `lifetime_collected 42_000_000` lovelace, `lifetime_withdrawn 10_000_000` lovelace, `min_utxo 3000000` lovelace (after step 17). The 42 ADA collected equals 21 fees × 2 ADA each (11 single bootstraps + 10 batch updates). |
| Pair UTxOs | 11 live Pair UTxOs (`SUMMARY.json#pairs`), one per supported feed. Latest prices and tx outrefs in the per-pair state files under `offchain/cli/state/preview/clients/client-a/pairs/`. |

## Final explorer verification

Preview explorer links use CExplorer's Preview instance.

| Operation | Tx hash | Explorer link |
| --- | --- | --- |
| Config bootstrap | `f6975c53582a2dfc2031ed05dae0ee82c252b0d050f1805d55f8f87e5d5fdd4f` | https://preview.cexplorer.io/tx/f6975c53582a2dfc2031ed05dae0ee82c252b0d050f1805d55f8f87e5d5fdd4f |
| PaymentHook bootstrap | `bbc542f9b8a0efc7402fccd9c396c117ffc8a49175867bde960ab72b474b535a` | https://preview.cexplorer.io/tx/bbc542f9b8a0efc7402fccd9c396c117ffc8a49175867bde960ab72b474b535a |
| Receiver bootstrap (`client-a`) | `cde0d8b4be4597216bbdf52304883fb16c3a2b1ff5e797596fc64190ecc42224` | https://preview.cexplorer.io/tx/cde0d8b4be4597216bbdf52304883fb16c3a2b1ff5e797596fc64190ecc42224 |
| First single-pair update / mint (USDC/USD) | `ad48a66a00d5295fd3d9435d0366b13f4d7d94888d2c24fdb61170058c8ea127` | https://preview.cexplorer.io/tx/ad48a66a00d5295fd3d9435d0366b13f4d7d94888d2c24fdb61170058c8ea127 |
| Batch update A (5 pairs) | `1a676b49f83b2dd7855eb1e34697f01ba383914e035120fdaf1d8363e75e1d35` | https://preview.cexplorer.io/tx/1a676b49f83b2dd7855eb1e34697f01ba383914e035120fdaf1d8363e75e1d35 |
| Batch update B (5 pairs) | `8e04c3e07f53c560efbefb478b2cb6a29acfa1d7644924ac09da799e6b7d55d3` | https://preview.cexplorer.io/tx/8e04c3e07f53c560efbefb478b2cb6a29acfa1d7644924ac09da799e6b7d55d3 |
| **Settle** | `8e996d89368739ca80ef4620db713a8e44de1b828c8f17d71a443dd58e187791` | https://preview.cexplorer.io/tx/8e996d89368739ca80ef4620db713a8e44de1b828c8f17d71a443dd58e187791 |
| Receiver withdraw | `7982be4b1bb27ac5f2919f786cb5742666398af4cb1623aae4c4f221a008c554` | https://preview.cexplorer.io/tx/7982be4b1bb27ac5f2919f786cb5742666398af4cb1623aae4c4f221a008c554 |
| PaymentHook withdraw | `1cf8258f56c0775f4bdd244e60b535826ea9dce84f6b8cb28dd9ded82bdbad61` | https://preview.cexplorer.io/tx/1cf8258f56c0775f4bdd244e60b535826ea9dce84f6b8cb28dd9ded82bdbad61 |

## Local state artifacts

The off-chain CLI persists Preview state under `offchain/cli/state/preview/`. Key files mirror the on-chain state at the end of this run:

- `offchain/cli/state/preview/config-bootstrap.json`
- `offchain/cli/state/preview/clients/client-a.json`
- `offchain/cli/state/preview/clients/client-a/pairs/*.json` (11 files, one per pair)
- `offchain/cli/state/preview/intents/*.signed.json` (per-update + per-batch signed intents)
- `offchain/cli/state/preview/update-batches/update-batch-A.{manifest,result}.json`, `update-batch-B.{manifest,result}.json`
- `offchain/cli/state_preview_20260504/` — backup of the Preview state from immediately before this re-bootstrap (kept as historical reference; not used by the CLI).

## Notes

Each DIA `OracleIntent` signature is valid only for the exact payload it signs (`symbol`, `price`, `timestamp`, `nonce`, `expiry`). The Preview flow used fresh intents for every single-pair update and for each of the two batches. The on-chain expiry check requires the transaction to declare a finite upper validity bound; the off-chain CLI sets a 30-minute window centred on the time of submission, capped below the signed intent's `expiry`.

Reference-script UTxOs live at the `reference_holder` script address derived from `contracts/aiken/plutus.json`. The deploy wallet funds those outputs but cannot spend them; updates and settles read them as `reference_input`s.

The original step-16 and step-17 logs say the receiver/payment-hook reference scripts were "missing on-chain". That wording came from an off-chain CLI bug, not from missing reference UTxOs on Preview. The scripts had already been published in step 6 (`payment-hook`) and step 9 (`receiver` + `pair`). The bug was that the withdraw paths tested the whole `missingReferenceScript` object for truthiness instead of checking the boolean entry inside it, so they always fell back to attaching the validator inline even when the reference script UTxO existed.

Single and batch oracle updates accrue protocol fees on the Receiver UTxO (`AccrueFee`) without touching the PaymentHook. A separate `Settle` transaction (coordinator `ApplySettle` + admin signature) drains accrued lovelace from one or more Receivers into the PaymentHook in a single atomic transaction. The chain walk above demonstrates this end-to-end: 21 updates accrued 42 ADA on the Receiver, the Settle transaction transferred all of it to the PaymentHook, and a subsequent admin withdrawal moved 10 ADA from the PaymentHook to the configured withdraw address.

Mainnet evidence will be recorded after the final transaction flow is executed on Cardano mainnet (separate gate; see `docs/plans/work-plan.md` Workstream F).
