# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included here.

Verification date: **20260515-1** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260515-130925/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | `aiken check` — unit tests passed; `offchain/cli` `npm run test` + typecheck + build green. End-to-end Preview chain walk captured below. |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending (mainnet not executed yet — separate gate) |

## Preview transactions executed end-to-end

All transactions below were submitted on Cardano Preview and confirmed. The chain walk demonstrates every Milestone 1 protocol surface including **Settle**, **reclaim**, and **republish** of a reference-script UTxO.

The integration exercises **eleven price pairs** (`USDC/USD`, `BTC/USD`, `ETH/USD`, `ADA/USD`, `USDT/USD`, `DAI/USD`, `SOL/USD`, `BNB/USD`, `XRP/USD`, `MATIC/USD`, `DOT/USD`). All eleven are bootstrapped via individual `preview:update` transactions. A subsequent batch transaction updates the first 10 non-USDC pairs in one `preview:update:batch` call.

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 1 | `preview:protocol:init` | *(local artifact)* | — | [`01-protocol-init.log`](./01-protocol-init.log) |
| 2 | `preview:config:parameterize` | *(local artifact)* | — | [`02-config-parameterize.log`](./02-config-parameterize.log) |
| 3 | `preview:config:bootstrap` | `708d5aaad4ee49448223a3f87b688046941d5216b343b6304d8acc6c1a001544` | 0.300680 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `preview:config:reference-scripts` (Config+Coordinator) | `bc7fff7af050828b2ee2382dc621cd0aa475981273694940292b0e305475860f` | 0.624773 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `preview:payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `preview:payment-hook:bootstrap` | `abeadee683b048966d0a7a76ade298dffb74abf400dbc1e230e6e8516394314f` | 0.593830 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `preview:payment-hook:reference-script` | `9274b27395937d1f96198da2ddcae10e489798ef9b905177e534ce44e0bcf6c8` | 0.382113 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `preview:client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `preview:receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `preview:receiver:bootstrap` | `e3b8228fa9ca539489518cd71157f8b95ffc7a1707cdffd2ba8a0d0fcb62e3d1` | 0.429296 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `preview:reference-scripts:publish-client` (Receiver+Pair+PairMint) | `44cd9be42e94fbca9a5f51271813650bb89ecea726302c13f6354aa2064d788d` | 0.817713 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `preview:receiver:top-up` (top-up 1) | `1881c41c218bcf90d27910fbba09a5d3cf8b7b6174b6438406f44ab47018045c` | 0.352374 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `preview:update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `6fb78aa0beec55d3f25b4776fa4b3061cf1db2d74a4929f520b369f18306f66e` | 0.793754 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `b0ab1a24a7e591b965a75a0a5bc29e19c9bca2941e4d77a653bbabe6e51f4f23` | 0.794018 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `0c66e1f1485e26091a903fe8ad54f241612ef7ea3021e5d846e28d1a574964ff` | 0.794018 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `ae87ab59f40a8e55311207690fd4e29278371faa12d3d839e62e6ede0c10c4b2` | 0.793666 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `470139c3bb15b82c24d7450973247d4e8310ca14856d89f40ba73546a0eb551a` | 0.793754 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `d8de87dff77061b58352a2a9eb89e3159d9d8b5dd0e8d601adbb87336d06434c` | 0.793666 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `d0f99bd411701ed4a643dddf053a1967d07e1141df88351650862357ee2468b1` | 0.794018 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `33ff8a871bcf04d47b4e36927c07f2a53def4b24ba6cd9907377c834ea158b7a` | 0.794018 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `8d628e4b0bc82d024d56748de812e2d332ca1799a8167613195e3264e1c67af9` | 0.793666 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `2bdb79d0d30957ddb9ee6463abd9bbb4b5cf05150c8b9941cd9441fd97e2fec8` | 0.793848 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `44bcfcc3b28980a0f1929b6f12b00e9d73cb85e4dbf61be285208f35a8b67757` | 0.793666 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `preview:receiver:top-up` (top-up 2) | `73b1ebf8bdfc01f517e70afff853ced72cbbbf181563ba50be6a42e0ae6d1650` | 0.352119 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `preview:update:batch` (10 pairs) | `318ebdac0b1a04c36ccbc7a33de296b801ccbecd622ec68a85b8939757825362` | 2.652315 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `preview:settle` | `27decb1375b1e4fe5b0f92fe8d9b9529a10cc00fb54886235ffe5d7fa94a1df9` | 0.767763 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `preview:receiver:withdraw` | `48d1fefe7682a4286c16eee3c2837456eed47b511de9fb4d07a1ea2c5712e890` | 0.384202 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `preview:payment-hook:withdraw` | `356565cb5ecd784c0af71a49c6269ba076cb1d7380a2b923ea2a26a449438567` | 0.375377 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `preview:reclaim-reference-script --script payment-hook` | `667fb88de42c9ca93a983018d69ae1b0da28508a110111b753508ccf1fb5b149` | 0.310222 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `preview:payment-hook:reference-script` (republish) | `2720bdea72a3ac9c57d745c4d13be0de6ed435466a10b15ee366028165c50061` | 0.382113 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j` |
| Initial wallet balance | **3663.360327 ADA** (3,663,360,327 lovelace) |
| Final wallet balance | **3399.218639 ADA** (3,399,218,639 lovelace) |
| Total on-chain fees paid | **17.898118 ADA** (17,898,118 lovelace) |
| Net ADA locked in protocol | **246.243570 ADA** (initial − final − fees) |

### ADA locked breakdown

| Location | ADA locked |
| --- | --- |
| Config UTxO (min-UTxO) | 5.000000 ADA |
| PaymentHook UTxO (min-UTxO + accrued) | 10.600000 ADA |
| Receiver UTxO (min-UTxO + balance + accrued) | 44.400000 ADA |
| Pair UTxOs × 10 (min-UTxO each; 1 burned excluded) | 50.000000 ADA |
| Reference-script UTxOs × 6 (config+coordinator+hook+receiver+pair+pairMint) | 134.243570 ADA |
| **Total locked in protocol** | **244.243570 ADA** |

Reference-script min-UTxO breakdown: `configValidator`=10.667250 ADA, `coordinatorValidator`=35.704040 ADA, `paymentHookValidator`=21.912040 ADA, `receiverValidator`=22.593020 ADA, `pairValidator`=21.683610 ADA, `pairMintPolicy`=21.683610 ADA.

## On-chain fee audit

| Step | Operation | Tx hash (first 16 chars) | Fee paid |
| --- | --- | --- | --- |
| `preview:config:bootstrap` | `708d5aaad4ee4944…` | 0.300680 ADA |
| `preview:config:reference-scripts` (Config+Coordinator) | `bc7fff7af050828b…` | 0.624773 ADA |
| `preview:payment-hook:bootstrap` | `abeadee683b04896…` | 0.593830 ADA |
| `preview:payment-hook:reference-script` | `9274b27395937d1f…` | 0.382113 ADA |
| `preview:receiver:bootstrap` | `e3b8228fa9ca5394…` | 0.429296 ADA |
| `preview:reference-scripts:publish-client` (Receiver+Pair+PairMint) | `44cd9be42e94fbca…` | 0.817713 ADA |
| `preview:receiver:top-up` (top-up 1) | `1881c41c218bcf90…` | 0.352374 ADA |
| `preview:update` — USDC/USD create | `6fb78aa0beec55d3…` | 0.793754 ADA |
| `preview:update` — BTC/USD create | `b0ab1a24a7e591b9…` | 0.794018 ADA |
| `preview:update` — ETH/USD create | `0c66e1f1485e2609…` | 0.794018 ADA |
| `preview:update` — ADA/USD create | `ae87ab59f40a8e55…` | 0.793666 ADA |
| `preview:update` — USDT/USD create | `470139c3bb15b82c…` | 0.793754 ADA |
| `preview:update` — DAI/USD create | `d8de87dff77061b5…` | 0.793666 ADA |
| `preview:update` — SOL/USD create | `d0f99bd411701ed4…` | 0.794018 ADA |
| `preview:update` — BNB/USD create | `33ff8a871bcf04d4…` | 0.794018 ADA |
| `preview:update` — XRP/USD create | `8d628e4b0bc82d02…` | 0.793666 ADA |
| `preview:update` — MATIC/USD create | `2bdb79d0d30957dd…` | 0.793848 ADA |
| `preview:update` — DOT/USD create | `44bcfcc3b28980a0…` | 0.793666 ADA |
| `preview:receiver:top-up` (top-up 2) | `73b1ebf8bdfc01f5…` | 0.352119 ADA |
| `preview:update:batch` (10 pairs) | `318ebdac0b1a04c3…` | 2.652315 ADA |
| `preview:settle` | `27decb1375b1e4fe…` | 0.767763 ADA |
| `preview:receiver:withdraw` | `48d1fefe7682a428…` | 0.384202 ADA |
| `preview:payment-hook:withdraw` | `356565cb5ecd784c…` | 0.375377 ADA |
| `preview:reclaim-reference-script --script payment-hook` | `667fb88de42c9ca9…` | 0.310222 ADA |
| `preview:payment-hook:reference-script` (republish) | `2720bdea72a3ac9c…` | 0.382113 ADA |
| `preview:pair:burn` — DOT/USD burn (admin-gated) | `5f3dad1cf758baa4…` | 0.441136 ADA |

**Total confirmed on-chain fees: 17.898118 ADA** (17,898,118 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Preview chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wzsf4g55drjj8erzemldd882j7h0syyhxwjhu8fzugl50scdtrw0r` |
| Config policy ID / validator hash | `bea7f4badfe2b8b9c2ed91a31f8409ce7901967652d7356db4557a4e` |
| Config NFT unit | `bea7f4badfe2b8b9c2ed91a31f8409ce7901967652d7356db4557a4e4449415f434f4e464947` |
| Coordinator stake validator hash | `ecb5e9b7e9b1e1d81aed81fe9a5cfc35603ca1b2e0da49a03d3285cf` |
| PaymentHook policy ID / validator hash | `b18f08dc412ac0f01e3e5e2f9c8f8d6fd06f4586096225f6900be422` |
| PaymentHook NFT unit | `b18f08dc412ac0f01e3e5e2f9c8f8d6fd06f4586096225f6900be4224449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `08615fb5721bd6528d1eefe5a5d06bc9bd48b0520d8e2a3781a1344e` |
| Receiver validator address (`client-a`) | `addr_test1wqyxzha4wgdav55drmh7tfwsd0ym6j9s2gxcu23hsxsngnswuk7r3` |
| Pair validator hash (`client-a`) | `26c5e6803e580f29201ba19557c516ff22a2f4c84a1afa164ae499d2` |
| Pair validator address (`client-a`) | `addr_test1wqnvte5q8evq72fqrwse2479zmlj9gh5ep9p47skftjfn5sj2r5ux` |

### Final UTxO states

| Artifact | Field | Value |
| --- | --- | --- |
| Receiver | balance | 39.400000 ADA |
| Receiver | accrued_to_hook | 0.000000 ADA |
| Receiver | min_utxo | 5.000000 ADA |
| PaymentHook | accrued_fees | 5.600000 ADA |
| PaymentHook | lifetime_collected | 15.600000 ADA |
| PaymentHook | lifetime_withdrawn | 10.000000 ADA |
| PaymentHook | min_utxo | 5.000000 ADA |

### Pair final prices

| Pair | Final price (scaled) | Updated via |
| --- | --- | --- |
| ADA/USD | `751000000` | batch (step 25, 10 pairs) |
| BNB/USD | `61510000000` | batch (step 25, 10 pairs) |
| BTC/USD | `6001000000000` | batch (step 25, 10 pairs) |
| DAI/USD | `100100345` | batch (step 25, 10 pairs) |
| DOT/USD | `421000000` | single create (step 13–23) |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) |
| USDC/USD | `100045678` | single create (step 13–23) |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) |

## Key transaction explorer links (Preview CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `708d5aaad4ee49448223a3f87b688046941d5216b343b6304d8acc6c1a001544` | [CExplorer](https://preview.cexplorer.io/tx/708d5aaad4ee49448223a3f87b688046941d5216b343b6304d8acc6c1a001544) |
| PaymentHook bootstrap | `abeadee683b048966d0a7a76ade298dffb74abf400dbc1e230e6e8516394314f` | [CExplorer](https://preview.cexplorer.io/tx/abeadee683b048966d0a7a76ade298dffb74abf400dbc1e230e6e8516394314f) |
| Receiver bootstrap (`client-a`) | `e3b8228fa9ca539489518cd71157f8b95ffc7a1707cdffd2ba8a0d0fcb62e3d1` | [CExplorer](https://preview.cexplorer.io/tx/e3b8228fa9ca539489518cd71157f8b95ffc7a1707cdffd2ba8a0d0fcb62e3d1) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `44cd9be42e94fbca9a5f51271813650bb89ecea726302c13f6354aa2064d788d` | [CExplorer](https://preview.cexplorer.io/tx/44cd9be42e94fbca9a5f51271813650bb89ecea726302c13f6354aa2064d788d) |
| First single-pair update (USDC/USD) | `6fb78aa0beec55d3f25b4776fa4b3061cf1db2d74a4929f520b369f18306f66e` | [CExplorer](https://preview.cexplorer.io/tx/6fb78aa0beec55d3f25b4776fa4b3061cf1db2d74a4929f520b369f18306f66e) |
| Batch update (10 pairs) | `318ebdac0b1a04c36ccbc7a33de296b801ccbecd622ec68a85b8939757825362` | [CExplorer](https://preview.cexplorer.io/tx/318ebdac0b1a04c36ccbc7a33de296b801ccbecd622ec68a85b8939757825362) |
| **Settle** | `27decb1375b1e4fe5b0f92fe8d9b9529a10cc00fb54886235ffe5d7fa94a1df9` | [CExplorer](https://preview.cexplorer.io/tx/27decb1375b1e4fe5b0f92fe8d9b9529a10cc00fb54886235ffe5d7fa94a1df9) |
| Receiver withdraw | `48d1fefe7682a4286c16eee3c2837456eed47b511de9fb4d07a1ea2c5712e890` | [CExplorer](https://preview.cexplorer.io/tx/48d1fefe7682a4286c16eee3c2837456eed47b511de9fb4d07a1ea2c5712e890) |
| PaymentHook withdraw | `356565cb5ecd784c0af71a49c6269ba076cb1d7380a2b923ea2a26a449438567` | [CExplorer](https://preview.cexplorer.io/tx/356565cb5ecd784c0af71a49c6269ba076cb1d7380a2b923ea2a26a449438567) |
| Reclaim payment-hook ref script | `667fb88de42c9ca93a983018d69ae1b0da28508a110111b753508ccf1fb5b149` | [CExplorer](https://preview.cexplorer.io/tx/667fb88de42c9ca93a983018d69ae1b0da28508a110111b753508ccf1fb5b149) |
| Republish payment-hook ref script | `2720bdea72a3ac9c57d745c4d13be0de6ed435466a10b15ee366028165c50061` | [CExplorer](https://preview.cexplorer.io/tx/2720bdea72a3ac9c57d745c4d13be0de6ed435466a10b15ee366028165c50061) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
