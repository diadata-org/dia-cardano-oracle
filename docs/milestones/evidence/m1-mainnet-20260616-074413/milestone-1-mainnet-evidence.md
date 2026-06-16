# Milestone 1 Mainnet Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Mainnet.

Verification date: **20260616-0** (chain walk + local tooling, current bytecode).

Network: Cardano Mainnet.

Evidence pack location: [`docs/milestones/evidence/m1-mainnet-20260616-074413/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | `aiken check` — unit tests passed; `offchain/cli` `npm run test` + typecheck + build green. End-to-end Mainnet chain walk captured below. |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Complete (captured in this evidence pack) |

## Mainnet transactions executed end-to-end

All transactions below were submitted on Cardano Mainnet and confirmed. The chain walk demonstrates every Milestone 1 protocol surface including **Settle**, **reclaim**, and **republish** of a reference-script UTxO.

The integration exercises **eleven price pairs** (`USDC/USD`, `BTC/USD`, `ETH/USD`, `ADA/USD`, `USDT/USD`, `DAI/USD`, `SOL/USD`, `BNB/USD`, `XRP/USD`, `MATIC/USD`, `DOT/USD`). All eleven are bootstrapped via individual `update` transactions. A subsequent batch transaction updates the first 10 non-USDC pairs in one `update:batch` call.

### Protocol bootstrap (one-time)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 1 | `protocol:init` | *(local artifact)* | — | [`01-protocol-init.log`](./01-protocol-init.log) |
| 2 | `config:parameterize` | *(local artifact)* | — | [`02-config-parameterize.log`](./02-config-parameterize.log) |
| 3 | `config:bootstrap` | `72cab164921f6ee939bfa47a8f468616329462bba039116eb6eb15719ad49f7d` | 0.320292 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `config:reference-scripts` (Config+Coordinator) | `03155f255ae286a7c0d20b56667c98584617d9e5b1bd3e511571b37e8013b401` | 0.640569 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `payment-hook:bootstrap` | `001bc63d2dce7918a65a27d1cf0e11f9d57a905e76db47226b75bff9eb22c829` | 0.640360 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `payment-hook:reference-script` | `dbb582ca12c02b2a0ed2b0675190cf8fbc04aca941f0ba1733715bae5034a541` | 0.395269 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `receiver:bootstrap` | `5fd5a6cd82c4e7d7fc22f4094c1e14032be015dd1a5703178d1482e7dbc4228a` | 0.449233 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `76d166a79e796478a83871073e9418ae230468a4f4a214075598431ab54e9bc7` | 0.871833 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `receiver:top-up` (top-up 1) | `714881e62842999f4ab0dfeea6240306b446b82efcd118cf99c3b5a177d358c8` | 0.363712 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `3eb459969fdfb2cb33d987259e7539ac8c81a051c85cf9c73ff580cc999ac8df` | 0.808575 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `3087baff9a28312fc2d95fc0de3fd8df80a935f2a4ba36fe14d308eed5801037` | 0.808839 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `6e4de0d97af67e7ac72a42d40b7e83538481eb5ca8984ddbd6850e363c2fac02` | 0.810542 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `e191d1b521f03392154a6014f1f733cac5e3d640f8f030b97f1e1270c6a32d89` | 0.810190 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `a2c752b107bbaccdc5297f825f53da9050403657bdb841a2ceb11c03cba3b11e` | 0.810278 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `e3bcfbb1c423254a0b2fb37b28e820b022e64cce1f1612efbb605597bddfe4a0` | 0.808487 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `c1cc547fdedf347e2758a6f39ba6d6a828025cf48954083acf515c060e328016` | 0.810542 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `b4628b22514d886d1c8005f44f348bb10bcfdc1308caa46c8486b62edf93dab0` | 0.808839 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `a7fa5facd54ad829a5d0428f5388bc719cefeefb4ddfbc949dcbae81118d3892` | 0.808487 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `37419510a870d3bebc8f981d284474a871c44e1dc4ce2bd3af0b2bc4ebce4a0c` | 0.810372 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `eaf3cbc9455e19c857638ee3d38f59fe0764105c69e584a82c058db52efa7e57` | 0.808487 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `receiver:top-up` (top-up 2) | `179badb2482c0f33bae20004609cebbe16dda8f8a5f43e8740f1e07b152ecdc8` | 0.368350 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `update:batch` (10 pairs) | `1a9dd51d5dc4b9d0f5cb12f60b7d66b7eba29ef5e834f3c438c0272be94840e1` | 2.629210 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script, pair burn

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `settle` | `de0c48ab053a49a10b19d03f40e3499fb42b7c4f09adb58c5439008338d909fc` | 0.785544 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `receiver:withdraw` | `c254f57d77f34dec01d9bda428da3ab1c3f5d2f5936461e320811f3caae66ddd` | 0.397832 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `payment-hook:withdraw` | `e052e8dd20576b63194cc8483d66b7a439dc3bfed0fad56615033c01b497361a` | 0.383756 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `reclaim-reference-script --script payment-hook` | `b1e689fba526d0aecc59b7d1a8d4f75c96d2845f4f600c2d1de0dd7cb4e070fa` | 0.315156 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `payment-hook:reference-script` (republish) | `8a48aec06e21ab31313c4984feb73690ff9cd3fcadbaf42c2144f6ca350fa130` | 0.396853 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |
| 31 | `pair:burn` — DOT/USD burn (admin-gated) | *(local step)* | 0.441495 ADA | [`31-pair-burn-dot-usd.log`](./31-pair-burn-dot-usd.log) |

### Side-deposit fold riding on an update

A fresh side deposit is funded, then absorbed into the Receiver balance by an
`update --fold-deposits` on an already-bootstrapped pair (same tx).

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 36 | `deposit:fund` (fresh deposit for fold) | `1f27b6f1049f2168188220cdb17c47a4a8de4d7db4da5228eafb7030c406bf6f` | 0.167085 ADA | [`36-deposit-fund-fold.log`](./36-deposit-fund-fold.log) |
| 37 | `update --fold-deposits` — USDC/USD fold | `ea967e7cbf79406bd55db0b54fdb6e7b148354730390393d0c6597de9297e782` | 0.920533 ADA | [`37-update-usdc-fold-deposits.log`](./37-update-usdc-fold-deposits.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr1qxp3wp7xa70jddcj95luvrud8p587fm7dsktwz8s5ts28hv8n5a536xf3tq74m47tnr8afr68v8wyhdst8c7aeanxvlqulrq72` |
| Initial wallet balance | **403.665097 ADA** (403,665,097 lovelace) |
| Final wallet balance | **113.585405 ADA** (113,585,405 lovelace) |
| Total on-chain fees paid | **19.390720 ADA** (19,390,720 lovelace) |
| Net ADA locked in protocol | **270.688972 ADA** (initial − final − fees) |

### ADA locked breakdown

| Location | ADA locked |
| --- | --- |
| Config UTxO (min-UTxO) | 5.000000 ADA |
| PaymentHook UTxO (min-UTxO + accrued) | 7.450000 ADA |
| Receiver UTxO (min-UTxO + balance + accrued) | 47.550000 ADA |
| Pair UTxOs × 10 (min-UTxO each; 1 burned excluded) | 50.000000 ADA |
| Reference-script UTxOs × 6 (config+coordinator+hook+receiver+pair+pairMint) | 138.751830 ADA |
| **Total locked in protocol** | **248.751830 ADA** |

Reference-script min-UTxO breakdown: `configValidator`=11.999040 ADA, `coordinatorValidator`=35.919540 ADA, `paymentHookValidator`=23.200730 ADA, `receiverValidator`=24.265300 ADA, `pairValidator`=21.683610 ADA, `pairMintPolicy`=21.683610 ADA.

## On-chain fee audit

| Step | Operation | Tx hash (first 16 chars) | Fee paid |
| --- | --- | --- | --- |
| `config:bootstrap` | `72cab164921f6ee9…` | 0.320292 ADA |
| `config:reference-scripts` (Config+Coordinator) | `03155f255ae286a7…` | 0.640569 ADA |
| `payment-hook:bootstrap` | `001bc63d2dce7918…` | 0.640360 ADA |
| `payment-hook:reference-script` | `dbb582ca12c02b2a…` | 0.395269 ADA |
| `receiver:bootstrap` | `5fd5a6cd82c4e7d7…` | 0.449233 ADA |
| `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `76d166a79e796478…` | 0.871833 ADA |
| `receiver:top-up` (top-up 1) | `714881e62842999f…` | 0.363712 ADA |
| `update` — USDC/USD create | `3eb459969fdfb2cb…` | 0.808575 ADA |
| `update` — BTC/USD create | `3087baff9a28312f…` | 0.808839 ADA |
| `update` — ETH/USD create | `6e4de0d97af67e7a…` | 0.810542 ADA |
| `update` — ADA/USD create | `e191d1b521f03392…` | 0.810190 ADA |
| `update` — USDT/USD create | `a2c752b107bbaccd…` | 0.810278 ADA |
| `update` — DAI/USD create | `e3bcfbb1c423254a…` | 0.808487 ADA |
| `update` — SOL/USD create | `c1cc547fdedf347e…` | 0.810542 ADA |
| `update` — BNB/USD create | `b4628b22514d886d…` | 0.808839 ADA |
| `update` — XRP/USD create | `a7fa5facd54ad829…` | 0.808487 ADA |
| `update` — MATIC/USD create | `37419510a870d3be…` | 0.810372 ADA |
| `update` — DOT/USD create | `eaf3cbc9455e19c8…` | 0.808487 ADA |
| `receiver:top-up` (top-up 2) | `179badb2482c0f33…` | 0.368350 ADA |
| `update:batch` (10 pairs) | `1a9dd51d5dc4b9d0…` | 2.629210 ADA |
| `settle` | `de0c48ab053a49a1…` | 0.785544 ADA |
| `receiver:withdraw` | `c254f57d77f34dec…` | 0.397832 ADA |
| `payment-hook:withdraw` | `e052e8dd20576b63…` | 0.383756 ADA |
| `reclaim-reference-script --script payment-hook` | `b1e689fba526d0ae…` | 0.315156 ADA |
| `payment-hook:reference-script` (republish) | `8a48aec06e21ab31…` | 0.396853 ADA |
| `pair:burn` — DOT/USD burn (admin-gated) | — | 0.441495 ADA |
| `deposit:fund` (fresh deposit for fold) | `1f27b6f1049f2168…` | 0.167085 ADA |
| `update --fold-deposits` — USDC/USD fold | `ea967e7cbf79406b…` | 0.920533 ADA |

**Total confirmed on-chain fees: 19.390720 ADA** (19,390,720 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Mainnet chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr1wye397fm64fnr4qkl5yp3vpg0na8k858naqg44zum5wxadq599ccf` |
| Config policy ID / validator hash | `8331c70441c186d0d4b8407a9b8433392638fe035e489f749702633c` |
| Config NFT unit | `8331c70441c186d0d4b8407a9b8433392638fe035e489f749702633c4449415f434f4e464947` |
| Coordinator stake validator hash | `8cb366f15b3d258e1ba0855f199a0b65fa325ee38a414fbd83d9a3fa` |
| PaymentHook policy ID / validator hash | `b1b08f07c9085b0fd8ab1e030ca1896ffe408536797a68580f3f4769` |
| PaymentHook NFT unit | `b1b08f07c9085b0fd8ab1e030ca1896ffe408536797a68580f3f47694449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `6ec4b5aa572382beb11bb8db28a87884d147afe4e2b3d8f5a7331a25` |
| Receiver validator address (`client-a`) | `addr1w9hvfdd22u3c9043rwudk29g0zzdz3a0un3t8k845ue35fg7fc477` |
| Pair validator hash (`client-a`) | `b1b933a7b08ebdee6d957b4ae3d027ac4a13f9d319dbd8a2b95e052f` |
| Pair validator address (`client-a`) | `addr1wxcmjva8kz8tmmndj4a54c7sy7ky5yle6vvahk9zh90q2tcgwmdlu` |

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
| DOT/USD | `421000000` | *burned (tx `f31e8be36ff74b6b…`)* | burned |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) | live |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) | live |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) | live |
| USDC/USD | `100045678` | single create (step 13–23) | live |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) | live |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) | live |

## Key transaction explorer links (Mainnet CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `72cab164921f6ee939bfa47a8f468616329462bba039116eb6eb15719ad49f7d` | [CExplorer](https://cexplorer.io/tx/72cab164921f6ee939bfa47a8f468616329462bba039116eb6eb15719ad49f7d) |
| PaymentHook bootstrap | `001bc63d2dce7918a65a27d1cf0e11f9d57a905e76db47226b75bff9eb22c829` | [CExplorer](https://cexplorer.io/tx/001bc63d2dce7918a65a27d1cf0e11f9d57a905e76db47226b75bff9eb22c829) |
| Receiver bootstrap (`client-a`) | `5fd5a6cd82c4e7d7fc22f4094c1e14032be015dd1a5703178d1482e7dbc4228a` | [CExplorer](https://cexplorer.io/tx/5fd5a6cd82c4e7d7fc22f4094c1e14032be015dd1a5703178d1482e7dbc4228a) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `76d166a79e796478a83871073e9418ae230468a4f4a214075598431ab54e9bc7` | [CExplorer](https://cexplorer.io/tx/76d166a79e796478a83871073e9418ae230468a4f4a214075598431ab54e9bc7) |
| First single-pair update (USDC/USD) | `3eb459969fdfb2cb33d987259e7539ac8c81a051c85cf9c73ff580cc999ac8df` | [CExplorer](https://cexplorer.io/tx/3eb459969fdfb2cb33d987259e7539ac8c81a051c85cf9c73ff580cc999ac8df) |
| Batch update (10 pairs) | `1a9dd51d5dc4b9d0f5cb12f60b7d66b7eba29ef5e834f3c438c0272be94840e1` | [CExplorer](https://cexplorer.io/tx/1a9dd51d5dc4b9d0f5cb12f60b7d66b7eba29ef5e834f3c438c0272be94840e1) |
| **Settle** | `de0c48ab053a49a10b19d03f40e3499fb42b7c4f09adb58c5439008338d909fc` | [CExplorer](https://cexplorer.io/tx/de0c48ab053a49a10b19d03f40e3499fb42b7c4f09adb58c5439008338d909fc) |
| Receiver withdraw | `c254f57d77f34dec01d9bda428da3ab1c3f5d2f5936461e320811f3caae66ddd` | [CExplorer](https://cexplorer.io/tx/c254f57d77f34dec01d9bda428da3ab1c3f5d2f5936461e320811f3caae66ddd) |
| PaymentHook withdraw | `e052e8dd20576b63194cc8483d66b7a439dc3bfed0fad56615033c01b497361a` | [CExplorer](https://cexplorer.io/tx/e052e8dd20576b63194cc8483d66b7a439dc3bfed0fad56615033c01b497361a) |
| Reclaim payment-hook ref script | `b1e689fba526d0aecc59b7d1a8d4f75c96d2845f4f600c2d1de0dd7cb4e070fa` | [CExplorer](https://cexplorer.io/tx/b1e689fba526d0aecc59b7d1a8d4f75c96d2845f4f600c2d1de0dd7cb4e070fa) |
| Republish payment-hook ref script | `8a48aec06e21ab31313c4984feb73690ff9cd3fcadbaf42c2144f6ca350fa130` | [CExplorer](https://cexplorer.io/tx/8a48aec06e21ab31313c4984feb73690ff9cd3fcadbaf42c2144f6ca350fa130) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
