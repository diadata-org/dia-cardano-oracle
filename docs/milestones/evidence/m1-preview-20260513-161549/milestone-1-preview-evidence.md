# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included here.

Verification date: **20260513-1** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260513-161549/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

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
| 3 | `preview:config:bootstrap` | `75e095aecdeee31c52cfdbc057e8b7e46b1ad1b3a56d51e8ca60a5a9d721f35c` | 0.300680 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `preview:config:reference-scripts` (Config+Coordinator) | `b12df211a12df29c89123f614fc7267e52a205514f7cf7740917ece9d9790377` | 0.624773 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `preview:payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `preview:payment-hook:bootstrap` | `dcf00f353110b57a3970e4914019f1bcd3fcd36221edb7b7905fe2d0ac67deee` | 0.605798 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `preview:payment-hook:reference-script` | `fb5abe2c4f62d90085255fff438bc01716d631d0e242b0dd2594f84b8124e31c` | 0.394081 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `preview:client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `preview:receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `preview:receiver:bootstrap` | `dca872e424b538c8a7255c1d2a3ea164ca84da625b3a9ac5d1f5afd07d1984ea` | 0.429296 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `preview:reference-scripts:publish-client` (Receiver+Pair+PairMint) | `da75f89a0cf8332fa01914e3cd8c33f3c4c319424d5ef76d0e2147b4b53def70` | 0.791577 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `preview:receiver:top-up` (top-up 1) | `66d8a639cd101cd41a571b7f90ebf01d0167bb9c9947fc9f7545b4768f4b22f6` | 0.352374 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `preview:update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `a141d6f739f199165455baebb3c6ffa506db312f291c999c327eb0cba86d8efc` | 0.785909 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `b31701ba5e8422c5c28ac885e74fde98b31d9cee6fea5d2be595e02b5484423c` | 0.786173 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `bebef78112adaa5cae7d35ec46d3fac1519f1b98662cd894341c2ef4402f1655` | 0.786173 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `a9b927776db7870389a29a69280c41f0497ef62a1a830c00eb1cbed09542618f` | 0.785821 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `1fc861c5be93785394f58127c9d63baf9c3dea0c19949c8b017cd4d4a98fafc7` | 0.785909 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `d1059163f805924220550069130e45ac60d0b41abb52d0cbf2b15f07ec2506f1` | 0.785821 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `76cf01111d538e9e7fbf1d487d6bd76400c79f1ed12e57ffa2f8d092b00d4e46` | 0.786173 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `5df2374c12ac3696bf6c8994cd2fe281160b41533a5d2a8092eef487d70c03cf` | 0.786173 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `0c800d017eecfa772c5529426986228ab82fa1e7cdc5df7b6f25e0ede01e40cf` | 0.785821 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `c2825170cd323631feeab4b6a2bdebc1fb6f5cebb91acbfe3e153078b9798613` | 0.786002 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `7f2220e977dfb6239ebdc4a7f0fc0a49421aa86055026f09dad5888d5089ee72` | 0.785821 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `preview:receiver:top-up` (top-up 2) | `d06d436667c01b52c1cfeef91d71f6f4ce7bd49e446860925c5c73a6a513305e` | 0.352119 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `preview:update:batch` (10 pairs) | `fa28acd9dae75e30c8bd7a45c287e4646c956e68e68d6d856640cac6de9eaac1` | 2.601824 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `preview:settle` | `01f0123f5837ae0aba15425c4273f1659323ecbcbe4b1d04d3972929a294f854` | 0.774020 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `preview:receiver:withdraw` | `ebecad74e86f0d5d14cd7734da122c9961a11890e1e29f7b6de1934ded6cee65` | 0.384202 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `preview:payment-hook:withdraw` | `753dee846f97850da8729e757a6b8f9f5a156154a6d9236147e25933b694ede0` | 0.382266 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `preview:reclaim-reference-script --script payment-hook` | `b566b7dc8775b5eb6d841d333ee50988b19817561cf8cf2dfd1e953d71b6336c` | 0.314302 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `preview:payment-hook:reference-script` (republish) | `cb709efc50627b311485ef62ba63058f0c53e3b18fdd909e49d8fb1cde242089` | 0.394081 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j` |
| Initial wallet balance | **4018.178580 ADA** (4,018,178,580 lovelace) |
| Final wallet balance | **3750.975641 ADA** (3,750,975,641 lovelace) |
| Total on-chain fees paid | **17.347189 ADA** (17,347,189 lovelace) |
| Net ADA locked in protocol | **249.855750 ADA** (initial − final − fees) |

### ADA locked breakdown

| Location | ADA locked |
| --- | --- |
| Config UTxO (min-UTxO) | 5.000000 ADA |
| PaymentHook UTxO (min-UTxO + accrued) | 10.600000 ADA |
| Receiver UTxO (min-UTxO + balance + accrued) | 44.400000 ADA |
| Pair UTxOs × 11 (min-UTxO each) | 55.000000 ADA |
| Reference-script UTxOs × 6 (config+coordinator+hook+receiver+pair+pairMint) | 132.855750 ADA |
| **Total locked in protocol** | **247.855750 ADA** |

Reference-script min-UTxO breakdown: `configValidator`=10.667250 ADA, `coordinatorValidator`=35.704040 ADA, `paymentHookValidator`=23.084360 ADA, `receiverValidator`=22.593020 ADA, `pairValidator`=20.403540 ADA, `pairMintPolicy`=20.403540 ADA.

## On-chain fee audit

| Step | Operation | Tx hash (first 16 chars) | Fee paid |
| --- | --- | --- | --- |
| `preview:config:bootstrap` | `75e095aecdeee31c…` | 0.300680 ADA |
| `preview:config:reference-scripts` (Config+Coordinator) | `b12df211a12df29c…` | 0.624773 ADA |
| `preview:payment-hook:bootstrap` | `dcf00f353110b57a…` | 0.605798 ADA |
| `preview:payment-hook:reference-script` | `fb5abe2c4f62d900…` | 0.394081 ADA |
| `preview:receiver:bootstrap` | `dca872e424b538c8…` | 0.429296 ADA |
| `preview:reference-scripts:publish-client` (Receiver+Pair+PairMint) | `da75f89a0cf8332f…` | 0.791577 ADA |
| `preview:receiver:top-up` (top-up 1) | `66d8a639cd101cd4…` | 0.352374 ADA |
| `preview:update` — USDC/USD create | `a141d6f739f19916…` | 0.785909 ADA |
| `preview:update` — BTC/USD create | `b31701ba5e8422c5…` | 0.786173 ADA |
| `preview:update` — ETH/USD create | `bebef78112adaa5c…` | 0.786173 ADA |
| `preview:update` — ADA/USD create | `a9b927776db78703…` | 0.785821 ADA |
| `preview:update` — USDT/USD create | `1fc861c5be937853…` | 0.785909 ADA |
| `preview:update` — DAI/USD create | `d1059163f8059242…` | 0.785821 ADA |
| `preview:update` — SOL/USD create | `76cf01111d538e9e…` | 0.786173 ADA |
| `preview:update` — BNB/USD create | `5df2374c12ac3696…` | 0.786173 ADA |
| `preview:update` — XRP/USD create | `0c800d017eecfa77…` | 0.785821 ADA |
| `preview:update` — MATIC/USD create | `c2825170cd323631…` | 0.786002 ADA |
| `preview:update` — DOT/USD create | `7f2220e977dfb623…` | 0.785821 ADA |
| `preview:receiver:top-up` (top-up 2) | `d06d436667c01b52…` | 0.352119 ADA |
| `preview:update:batch` (10 pairs) | `fa28acd9dae75e30…` | 2.601824 ADA |
| `preview:settle` | `01f0123f5837ae0a…` | 0.774020 ADA |
| `preview:receiver:withdraw` | `ebecad74e86f0d5d…` | 0.384202 ADA |
| `preview:payment-hook:withdraw` | `753dee846f97850d…` | 0.382266 ADA |
| `preview:reclaim-reference-script --script payment-hook` | `b566b7dc8775b5eb…` | 0.314302 ADA |
| `preview:payment-hook:reference-script` (republish) | `cb709efc50627b31…` | 0.394081 ADA |

**Total confirmed on-chain fees: 17.347189 ADA** (17,347,189 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Preview chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wpfpes7pvu2wa4nktskeczvtz59wncfs0uc0d6evyvyg7scnwtaej` |
| Config policy ID / validator hash | `a4a4d147a29d0fcacc8b8f8be93547718cb05d147c95648f9730fdb9` |
| Config NFT unit | `a4a4d147a29d0fcacc8b8f8be93547718cb05d147c95648f9730fdb94449415f434f4e464947` |
| Coordinator stake validator hash | `6f7ef5df884dddfa17fd0c85f7bd212b9abd2d72b3619f31f936f002` |
| PaymentHook policy ID / validator hash | `30c194b294b139f60fade13556ea968e627dcf6b932bfaf2959d81e6` |
| PaymentHook NFT unit | `30c194b294b139f60fade13556ea968e627dcf6b932bfaf2959d81e64449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `7f822870de6f4d81f6105e9e2f8e6eba008c612e345939a89f2d8980` |
| Receiver validator address (`client-a`) | `addr_test1wplcy2rsmeh5mq0kzp0futuwd6aqprrp9c69jwdgnukcnqqwhskwl` |
| Pair validator hash (`client-a`) | `e48068e7cd0596c27f9613853aea5e857f320a27b4918639a7cd2a28` |
| Pair validator address (`client-a`) | `addr_test1wrjgq688e5zedsnljcfc2wh2t6zh7vs2y76frp3e5lxj52qcjxpl5` |

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
| DOT/USD | `421000000` | batch (step 25, 10 pairs) |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) |
| USDC/USD | `100045678` | single create (step 13–23) |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) |

## Key transaction explorer links (Preview CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `75e095aecdeee31c52cfdbc057e8b7e46b1ad1b3a56d51e8ca60a5a9d721f35c` | [CExplorer](https://preview.cexplorer.io/tx/75e095aecdeee31c52cfdbc057e8b7e46b1ad1b3a56d51e8ca60a5a9d721f35c) |
| PaymentHook bootstrap | `dcf00f353110b57a3970e4914019f1bcd3fcd36221edb7b7905fe2d0ac67deee` | [CExplorer](https://preview.cexplorer.io/tx/dcf00f353110b57a3970e4914019f1bcd3fcd36221edb7b7905fe2d0ac67deee) |
| Receiver bootstrap (`client-a`) | `dca872e424b538c8a7255c1d2a3ea164ca84da625b3a9ac5d1f5afd07d1984ea` | [CExplorer](https://preview.cexplorer.io/tx/dca872e424b538c8a7255c1d2a3ea164ca84da625b3a9ac5d1f5afd07d1984ea) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `da75f89a0cf8332fa01914e3cd8c33f3c4c319424d5ef76d0e2147b4b53def70` | [CExplorer](https://preview.cexplorer.io/tx/da75f89a0cf8332fa01914e3cd8c33f3c4c319424d5ef76d0e2147b4b53def70) |
| First single-pair update (USDC/USD) | `a141d6f739f199165455baebb3c6ffa506db312f291c999c327eb0cba86d8efc` | [CExplorer](https://preview.cexplorer.io/tx/a141d6f739f199165455baebb3c6ffa506db312f291c999c327eb0cba86d8efc) |
| Batch update (10 pairs) | `fa28acd9dae75e30c8bd7a45c287e4646c956e68e68d6d856640cac6de9eaac1` | [CExplorer](https://preview.cexplorer.io/tx/fa28acd9dae75e30c8bd7a45c287e4646c956e68e68d6d856640cac6de9eaac1) |
| **Settle** | `01f0123f5837ae0aba15425c4273f1659323ecbcbe4b1d04d3972929a294f854` | [CExplorer](https://preview.cexplorer.io/tx/01f0123f5837ae0aba15425c4273f1659323ecbcbe4b1d04d3972929a294f854) |
| Receiver withdraw | `ebecad74e86f0d5d14cd7734da122c9961a11890e1e29f7b6de1934ded6cee65` | [CExplorer](https://preview.cexplorer.io/tx/ebecad74e86f0d5d14cd7734da122c9961a11890e1e29f7b6de1934ded6cee65) |
| PaymentHook withdraw | `753dee846f97850da8729e757a6b8f9f5a156154a6d9236147e25933b694ede0` | [CExplorer](https://preview.cexplorer.io/tx/753dee846f97850da8729e757a6b8f9f5a156154a6d9236147e25933b694ede0) |
| Reclaim payment-hook ref script | `b566b7dc8775b5eb6d841d333ee50988b19817561cf8cf2dfd1e953d71b6336c` | [CExplorer](https://preview.cexplorer.io/tx/b566b7dc8775b5eb6d841d333ee50988b19817561cf8cf2dfd1e953d71b6336c) |
| Republish payment-hook ref script | `cb709efc50627b311485ef62ba63058f0c53e3b18fdd909e49d8fb1cde242089` | [CExplorer](https://preview.cexplorer.io/tx/cb709efc50627b311485ef62ba63058f0c53e3b18fdd909e49d8fb1cde242089) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
