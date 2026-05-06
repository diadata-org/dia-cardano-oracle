# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included here.

Verification date: **2026-05-06** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260506-084452/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

A historical pack from 2026-04-27 (older bytecode, kept for traceability only) is preserved at [`docs/milestones/evidence/m1-preview-20260427/`](../m1-preview-20260427/).

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | `aiken check` — **83/83** tests; `offchain/cli` `npm run test` + `npm run typecheck` + `npm run build` green (2026-05-06). End-to-end Preview chain walk captured below. |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending (mainnet not executed yet — separate gate) |

## Local tooling verification (2026-05-06)

| Area | Working directory | Command | Result | Captured output |
| --- | --- | --- | --- | --- |
| Aiken contracts | `contracts/aiken` | `aiken check` | 83/83 tests passed | [`aiken-check.log`](./aiken-check.log) |
| CLI tests | `offchain/cli` | `npm run test` | `CLI tests passed` | [`npm-test.log`](./npm-test.log) |
| CLI typecheck | `offchain/cli` | `npm run typecheck` | exit 0 | [`npm-typecheck.log`](./npm-typecheck.log) |
| CLI build | `offchain/cli` | `npm run build` | exit 0 | [`npm-build.log`](./npm-build.log) |

## Preview transactions executed end-to-end

All transactions below were submitted on Cardano Preview and confirmed. The chain walk demonstrates every Milestone 1 protocol surface, including the **Settle** transaction, and ends with both maintenance withdrawals.

The integration exercises **eleven price pairs** (`USDC/USD`, `BTC/USD`, `ETH/USD`, `ADA/USD`, `USDT/USD`, `DAI/USD`, `SOL/USD`, `BNB/USD`, `XRP/USD`, `MATIC/USD`, `DOT/USD`) — covering the ten live feeds referenced in the Catalyst proposal. All eleven are bootstrapped via individual `preview:update` transactions. A subsequent batch transaction updates six of the ten non-USDC pairs in a single `preview:update:batch` call (batch sizes above 6 exceed the Plutus per-tx execution-units budget on Preview due to the cost of ECDSA secp256k1 verification).

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 1 | `preview:protocol:init` (derive script hashes, write artifact) | *(local artifact step)* | [`01-protocol-init.log`](./01-protocol-init.log) |
| 2 | `preview:config:parameterize` (compute on-chain min-UTxO) | *(local artifact step)* | [`02-config-parameterize.log`](./02-config-parameterize.log) |
| 3 | `preview:config:bootstrap` | `47c6349cb15bf9d749b9be77dc35b7d1b2e08a88110724e419d969d2b74fcca7` | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `preview:config:reference-scripts` (Config + Coordinator) | `9086c58a1b6cb6b63e619f588f7707936d5146c8d98d77bc4af0c74e33437b29` | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `preview:payment-hook:parameterize` | *(local artifact step)* | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `preview:payment-hook:bootstrap` | `9db9da202b65ddf3fcd48f809afc9cda2ccc82ac78c3c9383587cb7f9df67606` | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `preview:payment-hook:reference-script` | `f6ed45e49225813b6f7c7282cae4383ba46dbbcb27a7f86662d4e13f650c516e` | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 8 | `preview:client:init` (derive receiver + pair hashes) | *(local artifact step)* | [`08-client-init.log`](./08-client-init.log) |
| 9 | `preview:receiver:parameterize` (compute on-chain min-UTxO) | *(local artifact step)* | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `preview:receiver:bootstrap` | `e5c971ebc10f5d5e0b7d436166abb62cdd26e31017937ecefe3a4f8bdf3ca042` | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `preview:reference-scripts:publish-client` (Receiver + Pair) | `d918b786ce9db40535dc4a7627d1379a51ea8bd6af967dca9e252e34dd18a2f1` | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `preview:receiver:top-up` (30 ADA) | `77e85f98275f4ec802f27560c59469cf9bd01570b31e0658417d301d913868ad` | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair updates — 11 pair bootstraps via `preview:update`

Each is a `preview:update` where the Coordinator uses the `ApplySingle(witness)` branch, the Pair NFT is minted and its UTxO created from the signed intent, and one protocol fee (2 ADA) is accrued on the Receiver UTxO via `AccrueFee`. Each intent is generated just-in-time from the live chain tip immediately before its transaction.

| Step | Pair | Intent log | Tx hash | Tx log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | [`13a-generate-usdc-usd-intent.log`](./13a-generate-usdc-usd-intent.log) | `b29449f64b15cfde6526c8a4e29c49d81cac56aea5de1ab478790bcfa0a84fcc` | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | [`14a-generate-btc-usd-intent.log`](./14a-generate-btc-usd-intent.log) | `6fdc5a7334907a78238b853c57000cbc5b76955df9e3ea5401a9e964a649f8e7` | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | [`15a-generate-eth-usd-intent.log`](./15a-generate-eth-usd-intent.log) | `0a42484a86eef0266d320e53de58aa25edd76753af556ac38af40338e35b9335` | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | [`16a-generate-ada-usd-intent.log`](./16a-generate-ada-usd-intent.log) | `b9b58c3c42df89457d8b0beec42de519f948939bdeb175572e9eff3b7dd3b8e6` | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | [`17a-generate-usdt-usd-intent.log`](./17a-generate-usdt-usd-intent.log) | `75f75dc9cb9f9fc96870ca00e923e3a5af20413dfda08a740840af68a4f51488` | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | [`18a-generate-dai-usd-intent.log`](./18a-generate-dai-usd-intent.log) | `2f11bfe998e2c17480c0e5b698b55de2e3a2c144a88110ce8eb8a2b8d9102a69` | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | [`19a-generate-sol-usd-intent.log`](./19a-generate-sol-usd-intent.log) | `919f37ea310c29a250388c02421654d013f4d3a813151c7cb44c5a496352823f` | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | [`20a-generate-bnb-usd-intent.log`](./20a-generate-bnb-usd-intent.log) | `3475da9c4bff95a5c9b824ec250a301d286bc3cb9dd482d4887e699cdf935e4d` | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | [`21a-generate-xrp-usd-intent.log`](./21a-generate-xrp-usd-intent.log) | `830ada87d85f8c2608a253c1b248a245cdef323866efa8be55b96f5e6938eb0f` | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | [`22a-generate-matic-usd-intent.log`](./22a-generate-matic-usd-intent.log) | `09bf42c7dbe432e853937b64b39dbfd9027eeb094df625576c6c8731f10c0d87` | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | [`23a-generate-dot-usd-intent.log`](./23a-generate-dot-usd-intent.log) | `47d93be1eb3a317b001e6d3458a88e844d945775251aab7089e1c83ac761ea59` | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 24 | `preview:receiver:top-up` (30 ADA) | `debb2129080b63bce7c20d28ca0585c249fa3c9933f520e30fd2ce8961424dc0` | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Six intents are generated from the live chain tip at the start of this step. Batch sizes 10, 9, 8, 7 are attempted first; all exceed the per-tx Plutus execution-units budget on Preview (each secp256k1 ECDSA verification costs ~440M CPU steps; beyond six verifications the batch surpasses the ~10B per-tx ceiling). Batch size 6 succeeds, updating BTC, ETH, ADA, USDT, DAI, SOL in a single atomic transaction. Batch intent generation and manifests are captured in [`24b-generate-batch-intents.log`](./24b-generate-batch-intents.log) and [`24a-generate-batch-manifests.log`](./24a-generate-batch-manifests.log).

| Step | Operation | Pairs | Tx hash | Log |
| --- | --- | --- | --- | --- |
| 25 | `preview:update:batch` (10, attempted) | BTC…DOT | *(ExUnits over budget — not submitted)* | [`25-update-batch-10.log`](./25-update-batch-10.log) |
| 25 | `preview:update:batch` (9, attempted) | BTC…MATIC | *(ExUnits over budget — not submitted)* | [`25-update-batch-9.log`](./25-update-batch-9.log) |
| 25 | `preview:update:batch` (8, attempted) | BTC…XRP | *(ExUnits over budget — not submitted)* | [`25-update-batch-8.log`](./25-update-batch-8.log) |
| 25 | `preview:update:batch` (7, attempted) | BTC…BNB | *(ExUnits over budget — not submitted)* | [`25-update-batch-7.log`](./25-update-batch-7.log) |
| 25 | **`preview:update:batch` (6 pairs)** | BTC, ETH, ADA, USDT, DAI, SOL | `7a35c41fa54b7097f49e5b5af9ad1aba26173d81ceab6b34cbebde05a570b569` | [`25-update-batch-6.log`](./25-update-batch-6.log) |

### Settle, receiver withdraw, payment-hook withdraw

| Step | Operation | Tx hash | Log |
| --- | --- | --- | --- |
| 26 | **`preview:settle`** — drain `accrued_to_hook` from Receiver into PaymentHook (Coordinator `ApplySettle` + admin signature) | `bdc9013a867ee35fc4913d7289d7517f8ee010fa0c30d020c1bc324860ba6b0b` | [`26-settle.log`](./26-settle.log) |
| 27 | `preview:receiver:withdraw` (5 ADA → admin wallet) | `64f82cc3788ebd65433329fdd7431e7fcd2f15b595e44aecbdd54c272d51c710` | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `preview:payment-hook:withdraw` (10 ADA → admin wallet) | `b3caf9f9bea4a1a10e9b1e3b8aa1efba4aedc95aa251ac7ce17248063a7b07a0` | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |

## On-chain fee audit

Extracted from CLI output logs. This ledger covers every confirmed Preview transaction in the walkthrough above.

| Step | Operation | Tx hash | Fee paid |
| --- | --- | --- | --- |
| 3 | `preview:config:bootstrap` | `47c6349cb15bf9d749b9be77dc35b7d1b2e08a88110724e419d969d2b74fcca7` | `0.300362 ADA` |
| 4 | `preview:config:reference-scripts` | `9086c58a1b6cb6b63e619f588f7707936d5146c8d98d77bc4af0c74e33437b29` | `0.610693 ADA` |
| 6 | `preview:payment-hook:bootstrap` | `9db9da202b65ddf3fcd48f809afc9cda2ccc82ac78c3c9383587cb7f9df67606` | `0.597016 ADA` |
| 7 | `preview:payment-hook:reference-script` | `f6ed45e49225813b6f7c7282cae4383ba46dbbcb27a7f86662d4e13f650c516e` | `0.387261 ADA` |
| 10 | `preview:receiver:bootstrap` | `e5c971ebc10f5d5e0b7d436166abb62cdd26e31017937ecefe3a4f8bdf3ca042` | `0.425212 ADA` |
| 11 | `preview:reference-scripts:publish-client` | `d918b786ce9db40535dc4a7627d1379a51ea8bd6af967dca9e252e34dd18a2f1` | `0.552921 ADA` |
| 12 | `preview:receiver:top-up` (30 ADA) | `77e85f98275f4ec802f27560c59469cf9bd01570b31e0658417d301d913868ad` | `0.350012 ADA` |
| 13 | `preview:update` — USDC/USD bootstrap | `b29449f64b15cfde6526c8a4e29c49d81cac56aea5de1ab478790bcfa0a84fcc` | `0.697579 ADA` |
| 14 | `preview:update` — BTC/USD bootstrap | `6fdc5a7334907a78238b853c57000cbc5b76955df9e3ea5401a9e964a649f8e7` | `0.697843 ADA` |
| 15 | `preview:update` — ETH/USD bootstrap | `0a42484a86eef0266d320e53de58aa25edd76753af556ac38af40338e35b9335` | `0.697843 ADA` |
| 16 | `preview:update` — ADA/USD bootstrap | `b9b58c3c42df89457d8b0beec42de519f948939bdeb175572e9eff3b7dd3b8e6` | `0.697491 ADA` |
| 17 | `preview:update` — USDT/USD bootstrap | `75f75dc9cb9f9fc96870ca00e923e3a5af20413dfda08a740840af68a4f51488` | `0.697579 ADA` |
| 18 | `preview:update` — DAI/USD bootstrap | `2f11bfe998e2c17480c0e5b698b55de2e3a2c144a88110ce8eb8a2b8d9102a69` | `0.697491 ADA` |
| 19 | `preview:update` — SOL/USD bootstrap | `919f37ea310c29a250388c02421654d013f4d3a813151c7cb44c5a496352823f` | `0.697843 ADA` |
| 20 | `preview:update` — BNB/USD bootstrap | `3475da9c4bff95a5c9b824ec250a301d286bc3cb9dd482d4887e699cdf935e4d` | `0.697843 ADA` |
| 21 | `preview:update` — XRP/USD bootstrap | `830ada87d85f8c2608a253c1b248a245cdef323866efa8be55b96f5e6938eb0f` | `0.697491 ADA` |
| 22 | `preview:update` — MATIC/USD bootstrap | `09bf42c7dbe432e853937b64b39dbfd9027eeb094df625576c6c8731f10c0d87` | `0.697677 ADA` |
| 23 | `preview:update` — DOT/USD bootstrap | `47d93be1eb3a317b001e6d3458a88e844d945775251aab7089e1c83ac761ea59` | `0.697491 ADA` |
| 24 | `preview:receiver:top-up` (30 ADA) | `debb2129080b63bce7c20d28ca0585c249fa3c9933f520e30fd2ce8961424dc0` | `0.349757 ADA` |
| 25 | `preview:update:batch` (10–7, attempted) | *(not submitted — ExUnits over budget)* | `0 ADA` |
| 25 | `preview:update:batch` (6 pairs) | `7a35c41fa54b7097f49e5b5af9ad1aba26173d81ceab6b34cbebde05a570b569` | `2.186818 ADA` |
| 26 | `preview:settle` | `bdc9013a867ee35fc4913d7289d7517f8ee010fa0c30d020c1bc324860ba6b0b` | `0.758937 ADA` |
| 27 | `preview:receiver:withdraw` | `64f82cc3788ebd65433329fdd7431e7fcd2f15b595e44aecbdd54c272d51c710` | `0.379981 ADA` |
| 28 | `preview:payment-hook:withdraw` | `b3caf9f9bea4a1a10e9b1e3b8aa1efba4aedc95aa251ac7ce17248063a7b07a0` | `0.378096 ADA` |

Total confirmed on-chain fees in this Preview walkthrough: **`14.951237 ADA`** (`14,951,237` lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Preview chain walk.

### Identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wpz8pe5a390s2euhexd9gppuxwpfc9ntkjjezr60perzw8sc2yne3` (Config validator) |
| Config policy / validator hash | `4470e69d895f056797c99a54043c33829c166bb4a5910f4f0e46271e` |
| Config NFT unit (`DIA_CONFIG`) | `4470e69d895f056797c99a54043c33829c166bb4a5910f4f0e46271e4449415f434f4e464947` |
| Coordinator stake validator hash | `8cef31702e68959e3cfd322ae471deaf73a4bb15beba66cc72b0ec5b` |
| PaymentHook policy / validator hash | `914f87959f8a7a89c5210cfa3d939f919fc7fea7212be6701b4026b7` |
| PaymentHook NFT unit (`DIA_PAYMENT_HOOK`) | `914f87959f8a7a89c5210cfa3d939f919fc7fea7212be6701b4026b74449415f5041594d454e545f484f4f4b` |
| Receiver validator address (`client-a`) | `addr_test1wrvpkkl2vhcf56jju837pnp8vg9wfvdgnd97je87a8llwnc2kple9` |
| Pair validator address (`client-a`) | `addr_test1wqfzm9pqw2gm025hal59kj3rlcsvqrda7lkz35mqgvf7c2syf9twd` |

### Final UTxOs

| Artifact | Value |
| --- | --- |
| Receiver UTxO (final) | `balance 21_000_000` lovelace, `accrued_to_hook 0` lovelace, `min_utxo 5_000_000` lovelace (after step 27 withdraw of 5 ADA). |
| PaymentHook UTxO (final) | `accrued 24_000_000` lovelace, `lifetime_collected 34_000_000` lovelace, `lifetime_withdrawn 10_000_000` lovelace, `min_utxo 5_000_000` lovelace (after step 28). The 34 ADA collected equals 17 fees × 2 ADA each: 11 single-pair bootstraps + 6 batch pairs. |
| Pair UTxOs | 11 live Pair UTxOs (`SUMMARY.json#pairs`), one per supported feed. USDC/USD at bootstrap price; BTC, ETH, ADA, USDT, DAI, SOL at batch-updated price; BNB, XRP, MATIC, DOT at bootstrap price (covered by single updates, not reached by the batch within the ExUnits limit). |

### Pair final prices

| Pair | Final price (scaled) | Updated via |
| --- | --- | --- |
| USDC/USD | `100045678` | single bootstrap (step 13) |
| BTC/USD | `6001000000000` | batch (step 25) |
| ETH/USD | `250100000000` | batch (step 25) |
| ADA/USD | `751000000` | batch (step 25) |
| USDT/USD | `100101234` | batch (step 25) |
| DAI/USD | `100100345` | batch (step 25) |
| SOL/USD | `18510000000` | batch (step 25) |
| BNB/USD | `61500000000` | single bootstrap (step 20) |
| XRP/USD | `520000000` | single bootstrap (step 21) |
| MATIC/USD | `980000000` | single bootstrap (step 22) |
| DOT/USD | `420000000` | single bootstrap (step 23) |

## Final explorer verification

Preview explorer links use CExplorer's Preview instance.

| Operation | Tx hash | Explorer link |
| --- | --- | --- |
| Config bootstrap | `47c6349cb15bf9d749b9be77dc35b7d1b2e08a88110724e419d969d2b74fcca7` | https://preview.cexplorer.io/tx/47c6349cb15bf9d749b9be77dc35b7d1b2e08a88110724e419d969d2b74fcca7 |
| PaymentHook bootstrap | `9db9da202b65ddf3fcd48f809afc9cda2ccc82ac78c3c9383587cb7f9df67606` | https://preview.cexplorer.io/tx/9db9da202b65ddf3fcd48f809afc9cda2ccc82ac78c3c9383587cb7f9df67606 |
| Receiver bootstrap (`client-a`) | `e5c971ebc10f5d5e0b7d436166abb62cdd26e31017937ecefe3a4f8bdf3ca042` | https://preview.cexplorer.io/tx/e5c971ebc10f5d5e0b7d436166abb62cdd26e31017937ecefe3a4f8bdf3ca042 |
| First single-pair update / mint (USDC/USD) | `b29449f64b15cfde6526c8a4e29c49d81cac56aea5de1ab478790bcfa0a84fcc` | https://preview.cexplorer.io/tx/b29449f64b15cfde6526c8a4e29c49d81cac56aea5de1ab478790bcfa0a84fcc |
| Batch update (6 pairs) | `7a35c41fa54b7097f49e5b5af9ad1aba26173d81ceab6b34cbebde05a570b569` | https://preview.cexplorer.io/tx/7a35c41fa54b7097f49e5b5af9ad1aba26173d81ceab6b34cbebde05a570b569 |
| **Settle** | `bdc9013a867ee35fc4913d7289d7517f8ee010fa0c30d020c1bc324860ba6b0b` | https://preview.cexplorer.io/tx/bdc9013a867ee35fc4913d7289d7517f8ee010fa0c30d020c1bc324860ba6b0b |
| Receiver withdraw | `64f82cc3788ebd65433329fdd7431e7fcd2f15b595e44aecbdd54c272d51c710` | https://preview.cexplorer.io/tx/64f82cc3788ebd65433329fdd7431e7fcd2f15b595e44aecbdd54c272d51c710 |
| PaymentHook withdraw | `b3caf9f9bea4a1a10e9b1e3b8aa1efba4aedc95aa251ac7ce17248063a7b07a0` | https://preview.cexplorer.io/tx/b3caf9f9bea4a1a10e9b1e3b8aa1efba4aedc95aa251ac7ce17248063a7b07a0 |

## Notes

Each DIA `OracleIntent` signature is valid only for the exact payload it signs (`symbol`, `price`, `timestamp`, `nonce`, `expiry`). For single-pair updates, each intent is generated just-in-time immediately before its transaction by querying the live Blockfrost chain tip for the current slot, ensuring the signed timestamp and `validFrom`/`validTo` window are anchored to real network time rather than local system time. For the batch update, all intents are generated together at the start of step 25 with a 1-hour expiry, and each retry attempt derives a fresh `validFrom`/`validTo` from the chain tip at that moment.

Reference-script UTxOs live at the `reference_holder` script address derived from `contracts/aiken/plutus.json`. The deploy wallet funds those outputs but cannot spend them; updates and settles read them as `reference_input`s.

Single and batch oracle updates accrue protocol fees on the Receiver UTxO (`AccrueFee`) without touching the PaymentHook. A separate `Settle` transaction (Coordinator `ApplySettle` + admin signature) drains accrued lovelace from the Receiver into the PaymentHook in a single atomic transaction. The chain walk above demonstrates this end-to-end: 17 updates accrued 34 ADA on the Receiver, the Settle transaction transferred all of it to the PaymentHook, and a subsequent admin withdrawal moved 10 ADA from the PaymentHook to the configured withdraw address.

Mainnet evidence will be recorded after the final transaction flow is executed on Cardano mainnet (separate gate; see `docs/plans/work-plan.md` Workstream F).
