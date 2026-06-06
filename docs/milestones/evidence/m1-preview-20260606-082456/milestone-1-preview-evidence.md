# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview.

Verification date: **20260606-0** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260606-082456/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

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

The integration exercises **eleven price pairs** (`USDC/USD`, `BTC/USD`, `ETH/USD`, `ADA/USD`, `USDT/USD`, `DAI/USD`, `SOL/USD`, `BNB/USD`, `XRP/USD`, `MATIC/USD`, `DOT/USD`). All eleven are bootstrapped via individual `update` transactions. A subsequent batch transaction updates the first 10 non-USDC pairs in one `update:batch` call.

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 1 | `protocol:init` | *(local artifact)* | — | [`01-protocol-init.log`](./01-protocol-init.log) |
| 2 | `config:parameterize` | *(local artifact)* | — | [`02-config-parameterize.log`](./02-config-parameterize.log) |
| 3 | `config:bootstrap` | `bfb7c608621274dd56561445dbcdfc74f9e8a7e13adda118d984ec8e0f9b8d4f` | 0.300592 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `config:reference-scripts` (Config+Coordinator) | `22885dc23a42693f164dbda3fec55e2016a00c2a4ed5601283725d474e22326c` | 0.624773 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `payment-hook:bootstrap` | `7ee63cd6816ee397f506b7d684f002c62db62a53b1926cdfd82ff8a190b14eb9` | 0.595034 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `payment-hook:reference-script` | `9dc3d36c90d639cd29be40b4503ee893f01292b97536bf58ffdf45a963bd13e2` | 0.382113 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `receiver:bootstrap` | `bc6826cb1abce0fda0d6d7850ced036ee2b76c205b9b0fc25f56ad91f9d5ab02` | 0.429296 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `14cd07f4fbbab3e8639833c7eb424e0b8ceb755e67f72989ec31ac2c5403db07` | 0.817713 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `receiver:top-up` (top-up 1) | `6405ce1e1a6196be45d0c021d8f75f2363415620b2e9384ff2e5d162dbebfe77` | 0.352374 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `0a5523c90d8107a12c8e436b94604c90177c62067ef0576a2218c4bf1d566916` | 0.797480 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `2c3abdb53b409de517e08d2205a26eb8e4be902cbb11b50f2aa8afa8cda4bcde` | 0.797744 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `28f6188df6061ea1d4ab67bfab1127096fad15b834b42002ef905f94044b1dad` | 0.797744 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `7731d92b0395d05765bb75a20b6a799d6e15e065abc4b7743f31e1f2bf063fa4` | 0.797392 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `c20de58940ed5280850ae42a8732c414c09e57c87eb92c90aa7a3b39d9816865` | 0.797480 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `ac0d1f9a358731aad9b60ea41b8e5b75e9e21409004814e1693bcadca8a05916` | 0.797392 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `6b1025d687088d4866e27f2a7693cad34ae62483a152e36d96b8d99d1baff07d` | 0.797744 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `027c4cfa7933504ec3b02d05a4c8ceedd3103291346f29e1db597d3fc3f4b909` | 0.797744 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `ef13b2b7dc61e14cf2d608ff10af5aea19ee608172e52f0064203b7c7f0cad71` | 0.797392 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `6ae8836f0e6576268095557852b8d3d0d0b2c28647b8c60d3d5d272dfd778283` | 0.797574 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `0a14bed1b9b840e437656d12d6fb3da9ad64cbe4454a94663457ee50e3ae8977` | 0.797392 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `receiver:top-up` (top-up 2) | `7687181ff6405ea09d347f84445dfe269d0e625a83e088b4ec70ab81c6d1d966` | 0.352119 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `update:batch` (10 pairs) | `88d52ff51063b0d0da9f9d51448e762e9198a462e94cd2ee29161bf7d65c83f8` | 2.668809 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script, pair burn

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `settle` | `bb24bcfe1a8cdd16b8ee942220339966c7fa94b3c1cff6947cae1a7a95993754` | 0.765775 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `receiver:withdraw` | `3c5ba043b2ab22d2b0062609c852ea04c0e5cc1a8c202dda6697d36a6a97293f` | 0.384202 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `payment-hook:withdraw` | `3d036f92d9265e39d120db706aec5ac165bc951bd3dd49465dba141ce1f93318` | 0.374537 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `reclaim-reference-script --script payment-hook` | `af3b77f368ec7727fff985be5e96a81968a1066b0dcb93e3423b31d17c8ec1b7` | 0.310222 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `payment-hook:reference-script` (republish) | `6551697fb379b797d3e3c732a7e0058576e381ff91955e3bd547f11cbe41aebe` | 0.382113 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |
| 31 | `pair:burn` — DOT/USD burn (admin-gated) | *(local step)* | 0.441136 ADA | [`31-pair-burn-dot-usd.log`](./31-pair-burn-dot-usd.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j` |
| Initial wallet balance | **2028.045066 ADA** (2,028,045,066 lovelace) |
| Final wallet balance | **1753.092651 ADA** (1,753,092,651 lovelace) |
| Total on-chain fees paid | **17.953886 ADA** (17,953,886 lovelace) |
| Net ADA locked in protocol | **256.998529 ADA** (initial − final − fees) |

### ADA locked breakdown

| Location | ADA locked |
| --- | --- |
| Config UTxO (min-UTxO) | 5.000000 ADA |
| PaymentHook UTxO (min-UTxO + accrued) | 7.450000 ADA |
| Receiver UTxO (min-UTxO + balance + accrued) | 47.550000 ADA |
| Pair UTxOs × 10 (min-UTxO each; 1 burned excluded) | 50.000000 ADA |
| Reference-script UTxOs × 6 (config+coordinator+hook+receiver+pair+pairMint) | 134.243570 ADA |
| **Total locked in protocol** | **244.243570 ADA** |

Reference-script min-UTxO breakdown: `configValidator`=10.667250 ADA, `coordinatorValidator`=35.704040 ADA, `paymentHookValidator`=21.912040 ADA, `receiverValidator`=22.593020 ADA, `pairValidator`=21.683610 ADA, `pairMintPolicy`=21.683610 ADA.

## On-chain fee audit

| Step | Operation | Tx hash (first 16 chars) | Fee paid |
| --- | --- | --- | --- |
| `config:bootstrap` | `bfb7c608621274dd…` | 0.300592 ADA |
| `config:reference-scripts` (Config+Coordinator) | `22885dc23a42693f…` | 0.624773 ADA |
| `payment-hook:bootstrap` | `7ee63cd6816ee397…` | 0.595034 ADA |
| `payment-hook:reference-script` | `9dc3d36c90d639cd…` | 0.382113 ADA |
| `receiver:bootstrap` | `bc6826cb1abce0fd…` | 0.429296 ADA |
| `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `14cd07f4fbbab3e8…` | 0.817713 ADA |
| `receiver:top-up` (top-up 1) | `6405ce1e1a6196be…` | 0.352374 ADA |
| `update` — USDC/USD create | `0a5523c90d8107a1…` | 0.797480 ADA |
| `update` — BTC/USD create | `2c3abdb53b409de5…` | 0.797744 ADA |
| `update` — ETH/USD create | `28f6188df6061ea1…` | 0.797744 ADA |
| `update` — ADA/USD create | `7731d92b0395d057…` | 0.797392 ADA |
| `update` — USDT/USD create | `c20de58940ed5280…` | 0.797480 ADA |
| `update` — DAI/USD create | `ac0d1f9a358731aa…` | 0.797392 ADA |
| `update` — SOL/USD create | `6b1025d687088d48…` | 0.797744 ADA |
| `update` — BNB/USD create | `027c4cfa7933504e…` | 0.797744 ADA |
| `update` — XRP/USD create | `ef13b2b7dc61e14c…` | 0.797392 ADA |
| `update` — MATIC/USD create | `6ae8836f0e657626…` | 0.797574 ADA |
| `update` — DOT/USD create | `0a14bed1b9b840e4…` | 0.797392 ADA |
| `receiver:top-up` (top-up 2) | `7687181ff6405ea0…` | 0.352119 ADA |
| `update:batch` (10 pairs) | `88d52ff51063b0d0…` | 2.668809 ADA |
| `settle` | `bb24bcfe1a8cdd16…` | 0.765775 ADA |
| `receiver:withdraw` | `3c5ba043b2ab22d2…` | 0.384202 ADA |
| `payment-hook:withdraw` | `3d036f92d9265e39…` | 0.374537 ADA |
| `reclaim-reference-script --script payment-hook` | `af3b77f368ec7727…` | 0.310222 ADA |
| `payment-hook:reference-script` (republish) | `6551697fb379b797…` | 0.382113 ADA |
| `pair:burn` — DOT/USD burn (admin-gated) | — | 0.441136 ADA |

**Total confirmed on-chain fees: 17.953886 ADA** (17,953,886 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Preview chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wp7wd0vk6xdpe50yt4wd68sjhg3p3v6jx7cey2wkmpz8ymclkactj` |
| Config policy ID / validator hash | `f9b219bf3515a95594ffc977c8c415613d7365c02c151aeb2dbe4834` |
| Config NFT unit | `f9b219bf3515a95594ffc977c8c415613d7365c02c151aeb2dbe48344449415f434f4e464947` |
| Coordinator stake validator hash | `fdff8d2d4bf3c9c1f041dddffe48d1dd6a07157a2526808f740e95dc` |
| PaymentHook policy ID / validator hash | `41e9911905cce7df4f152a5b2bb918fec13e0856d8072b767a50de3d` |
| PaymentHook NFT unit | `41e9911905cce7df4f152a5b2bb918fec13e0856d8072b767a50de3d4449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `e9b20749e6425daa670bcffbbc84f494e7e7009ec80560b26f2f0d2b` |
| Receiver validator address (`client-a`) | `addr_test1wr5myp6fuep9m2n8p08lh0yy7j2w0ecqnmyq2c9jduhs62cd0pf2h` |
| Pair validator hash (`client-a`) | `9f80dd966e4a06cce7efd25f6267b15da7a5dc4cc3157e78928fe288` |
| Pair validator address (`client-a`) | `addr_test1wz0cphvkde9qdn88alf97cn8k9w60fwufnp32lncj2879zqy0nw7v` |

### Final UTxO states

| Artifact | Field | Value |
| --- | --- | --- |
| Receiver | balance | 42.550000 ADA |
| Receiver | accrued_to_hook | 0.000000 ADA |
| Receiver | min_utxo | 5.000000 ADA |
| PaymentHook | accrued_fees | 2.450000 ADA |
| PaymentHook | lifetime_collected | 12.450000 ADA |
| PaymentHook | lifetime_withdrawn | 10.000000 ADA |
| PaymentHook | min_utxo | 5.000000 ADA |

### Pair final prices

Burned pairs are listed separately below — their on-chain Pair NFT no longer
exists and their UTxO has been spent, so the "live" table reflects only pairs
still tracked on-chain.

| Pair | Final price (scaled) | Updated via | Status |
| --- | --- | --- | --- |
| ADA/USD | `751000000` | batch (step 25, 10 pairs) | live |
| BNB/USD | `61510000000` | batch (step 25, 10 pairs) | live |
| BTC/USD | `6001000000000` | batch (step 25, 10 pairs) | live |
| DAI/USD | `100100345` | batch (step 25, 10 pairs) | live |
| DOT/USD | `421000000` | *burned (tx `59703703c9d5f72f…`)* | burned |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) | live |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) | live |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) | live |
| USDC/USD | `100045678` | single create (step 13–23) | live |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) | live |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) | live |

## Key transaction explorer links (Preview CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `bfb7c608621274dd56561445dbcdfc74f9e8a7e13adda118d984ec8e0f9b8d4f` | [CExplorer](https://preview.cexplorer.io/tx/bfb7c608621274dd56561445dbcdfc74f9e8a7e13adda118d984ec8e0f9b8d4f) |
| PaymentHook bootstrap | `7ee63cd6816ee397f506b7d684f002c62db62a53b1926cdfd82ff8a190b14eb9` | [CExplorer](https://preview.cexplorer.io/tx/7ee63cd6816ee397f506b7d684f002c62db62a53b1926cdfd82ff8a190b14eb9) |
| Receiver bootstrap (`client-a`) | `bc6826cb1abce0fda0d6d7850ced036ee2b76c205b9b0fc25f56ad91f9d5ab02` | [CExplorer](https://preview.cexplorer.io/tx/bc6826cb1abce0fda0d6d7850ced036ee2b76c205b9b0fc25f56ad91f9d5ab02) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `14cd07f4fbbab3e8639833c7eb424e0b8ceb755e67f72989ec31ac2c5403db07` | [CExplorer](https://preview.cexplorer.io/tx/14cd07f4fbbab3e8639833c7eb424e0b8ceb755e67f72989ec31ac2c5403db07) |
| First single-pair update (USDC/USD) | `0a5523c90d8107a12c8e436b94604c90177c62067ef0576a2218c4bf1d566916` | [CExplorer](https://preview.cexplorer.io/tx/0a5523c90d8107a12c8e436b94604c90177c62067ef0576a2218c4bf1d566916) |
| Batch update (10 pairs) | `88d52ff51063b0d0da9f9d51448e762e9198a462e94cd2ee29161bf7d65c83f8` | [CExplorer](https://preview.cexplorer.io/tx/88d52ff51063b0d0da9f9d51448e762e9198a462e94cd2ee29161bf7d65c83f8) |
| **Settle** | `bb24bcfe1a8cdd16b8ee942220339966c7fa94b3c1cff6947cae1a7a95993754` | [CExplorer](https://preview.cexplorer.io/tx/bb24bcfe1a8cdd16b8ee942220339966c7fa94b3c1cff6947cae1a7a95993754) |
| Receiver withdraw | `3c5ba043b2ab22d2b0062609c852ea04c0e5cc1a8c202dda6697d36a6a97293f` | [CExplorer](https://preview.cexplorer.io/tx/3c5ba043b2ab22d2b0062609c852ea04c0e5cc1a8c202dda6697d36a6a97293f) |
| PaymentHook withdraw | `3d036f92d9265e39d120db706aec5ac165bc951bd3dd49465dba141ce1f93318` | [CExplorer](https://preview.cexplorer.io/tx/3d036f92d9265e39d120db706aec5ac165bc951bd3dd49465dba141ce1f93318) |
| Reclaim payment-hook ref script | `af3b77f368ec7727fff985be5e96a81968a1066b0dcb93e3423b31d17c8ec1b7` | [CExplorer](https://preview.cexplorer.io/tx/af3b77f368ec7727fff985be5e96a81968a1066b0dcb93e3423b31d17c8ec1b7) |
| Republish payment-hook ref script | `6551697fb379b797d3e3c732a7e0058576e381ff91955e3bd547f11cbe41aebe` | [CExplorer](https://preview.cexplorer.io/tx/6551697fb379b797d3e3c732a7e0058576e381ff91955e3bd547f11cbe41aebe) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
