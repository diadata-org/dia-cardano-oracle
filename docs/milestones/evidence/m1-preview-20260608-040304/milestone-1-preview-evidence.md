# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Preview.

Verification date: **20260608-0** (chain walk + local tooling, current bytecode).

Network: Cardano Preview.

Evidence pack location: [`docs/milestones/evidence/m1-preview-20260608-040304/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

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
| 3 | `config:bootstrap` | `7d6c090cf6789db01530c650621cc981cd8bcebda931eca379de1719fedcd8a8` | 0.314490 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `config:reference-scripts` (Config+Coordinator) | `520df26361e5ed836564151b1e2dff623935c314d86cca22c0faf1b600eefd15` | 0.640569 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `payment-hook:bootstrap` | `6f1bf7dd60c4c809e3e8ac359239145e64e68e4a4b10cb17e0553d103fdc129c` | 0.622250 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `payment-hook:reference-script` | `5a9eb329bfadeceb04267511265d3025db8027414f88c8406971ac85d73f8510` | 0.395269 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `receiver:bootstrap` | `fc5f072d6b55129b51c99ebf9b62dfc158eae6dcab5f44959d2f046696e2124f` | 0.446511 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `4b394a180e86884457af6d2cf16fb9e1ab69b37b21c5bda611a05338864e4efe` | 0.870249 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `receiver:top-up` (top-up 1) | `0a2616d9a5795feb8803b3ab27a79c6237065b06210f004ff063286fbaf09f54` | 0.364143 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `26f31aa8ced1919755934cda200856db7c8367b43936137b97649a48096f1ed6` | 0.815651 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `7b24281e523319021ae17d58a8558a66f08f622f3239a11d24de55a0d4118e2d` | 0.815915 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `5e80ff5d7d487019f808376d0c1d5b2a4fedb2671ee4927b6bbdc52c2960d06b` | 0.815915 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `cc12dbc8167d077c87d9985ffba37140b24025c2ce98e631e04e341c4ceed9fb` | 0.815563 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `1ce0986677b198b27b12182dd9e849e25a63602dae1dbe539f9d67effbfcc1ce` | 0.815651 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `87ec26247ebe10561a5fb1af1509f1a0cf4253252bc76d8f92dc2ec56cd8089c` | 0.815563 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `08dff997c7f2c281c7c39a8e0b0f652bb94137ca5844bc75a13e71488066a23c` | 0.815915 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `5c60c1496ad02a1ff6251ebad32db4edb2fd999a8d33e45e40ff909bc8bfebcf` | 0.815915 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `228a98327b45c167c83d84f5f078f370d9e5f3f6270846dff8dff0b9e67849d5` | 0.815563 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `f761aff0112020337fecca5a89d3d68f79e876a3342341d15ffdf24e9bff370e` | 0.815745 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `ed9734eb1a45aeb07f9ac661381c488c5354b101e79a62abad28f2bfbb856844` | 0.815563 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `receiver:top-up` (top-up 2) | `6d956cd8784ef48ed2a65f429378a9d3dc46ca730fed9524162c4e80cd61435b` | 0.363888 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `update:batch` (10 pairs) | `1d5ff45dc5342d31346e62c7e2dd013f93117f0ee6f5de5f4ab78677656a32ee` | 2.687932 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script, pair burn

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `settle` | `c8da8dd3b182e1b4d679550a9f8982ec96b35351d551ec17fb0627dd334d5b3b` | 0.792872 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `receiver:withdraw` | `e090d92b1a97a6ecf7a5470c1500d0fa2e9e8aa11c93c4267c72884a5f03cdf2` | 0.395911 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `payment-hook:withdraw` | `50105f5cba135d987b57f76846d1f309cbfb9b0b6752945718983f9410f64dc0` | 0.384578 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `reclaim-reference-script --script payment-hook` | `955e49d6b82d23637d9273e3a7264628542e40adb4904c922a3194c0b034b54e` | 0.314707 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `payment-hook:reference-script` (republish) | `b989c9e78d2245c7c93393ce39baa639f4dccc09f1d84576a7f20df50be5ea3a` | 0.395269 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |
| 31 | `pair:burn` — DOT/USD burn (admin-gated) | *(local step)* | 0.441136 ADA | [`31-pair-burn-dot-usd.log`](./31-pair-burn-dot-usd.log) |

### Side-deposit fold riding on an update

A fresh side deposit is funded, then absorbed into the Receiver balance by an
`update --fold-deposits` on an already-bootstrapped pair (same tx).

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 36 | `deposit:fund` (fresh deposit for fold) | `3b6b4325945d9d8c4902b39f40a41f7d99db99a88b12009e5674c60bba9bad52` | 0.167085 ADA | [`36-deposit-fund-fold.log`](./36-deposit-fund-fold.log) |
| 37 | `update --fold-deposits` — USDC/USD fold | `196074d53db562af55a937fa86bfe41518b5041a2f9f29ad7290925e3cfc7f97` | 0.936746 ADA | [`37-update-usdc-fold-deposits.log`](./37-update-usdc-fold-deposits.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j` |
| Initial wallet balance | **1975.957893 ADA** (1,975,957,893 lovelace) |
| Final wallet balance | **1685.759037 ADA** (1,685,759,037 lovelace) |
| Total on-chain fees paid | **19.506564 ADA** (19,506,564 lovelace) |
| Net ADA locked in protocol | **270.692292 ADA** (initial − final − fees) |

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
| `config:bootstrap` | `7d6c090cf6789db0…` | 0.314490 ADA |
| `config:reference-scripts` (Config+Coordinator) | `520df26361e5ed83…` | 0.640569 ADA |
| `payment-hook:bootstrap` | `6f1bf7dd60c4c809…` | 0.622250 ADA |
| `payment-hook:reference-script` | `5a9eb329bfadeceb…` | 0.395269 ADA |
| `receiver:bootstrap` | `fc5f072d6b55129b…` | 0.446511 ADA |
| `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `4b394a180e868844…` | 0.870249 ADA |
| `receiver:top-up` (top-up 1) | `0a2616d9a5795feb…` | 0.364143 ADA |
| `update` — USDC/USD create | `26f31aa8ced19197…` | 0.815651 ADA |
| `update` — BTC/USD create | `7b24281e52331902…` | 0.815915 ADA |
| `update` — ETH/USD create | `5e80ff5d7d487019…` | 0.815915 ADA |
| `update` — ADA/USD create | `cc12dbc8167d077c…` | 0.815563 ADA |
| `update` — USDT/USD create | `1ce0986677b198b2…` | 0.815651 ADA |
| `update` — DAI/USD create | `87ec26247ebe1056…` | 0.815563 ADA |
| `update` — SOL/USD create | `08dff997c7f2c281…` | 0.815915 ADA |
| `update` — BNB/USD create | `5c60c1496ad02a1f…` | 0.815915 ADA |
| `update` — XRP/USD create | `228a98327b45c167…` | 0.815563 ADA |
| `update` — MATIC/USD create | `f761aff011202033…` | 0.815745 ADA |
| `update` — DOT/USD create | `ed9734eb1a45aeb0…` | 0.815563 ADA |
| `receiver:top-up` (top-up 2) | `6d956cd8784ef48e…` | 0.363888 ADA |
| `update:batch` (10 pairs) | `1d5ff45dc5342d31…` | 2.687932 ADA |
| `settle` | `c8da8dd3b182e1b4…` | 0.792872 ADA |
| `receiver:withdraw` | `e090d92b1a97a6ec…` | 0.395911 ADA |
| `payment-hook:withdraw` | `50105f5cba135d98…` | 0.384578 ADA |
| `reclaim-reference-script --script payment-hook` | `955e49d6b82d2363…` | 0.314707 ADA |
| `payment-hook:reference-script` (republish) | `b989c9e78d2245c7…` | 0.395269 ADA |
| `pair:burn` — DOT/USD burn (admin-gated) | — | 0.441136 ADA |
| `deposit:fund` (fresh deposit for fold) | `3b6b4325945d9d8c…` | 0.167085 ADA |
| `update --fold-deposits` — USDC/USD fold | `196074d53db562af…` | 0.936746 ADA |

**Total confirmed on-chain fees: 19.506564 ADA** (19,506,564 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Preview chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr_test1wqe3a98ltqqfv4e5e05u5mzh5ey8ftrva3kmp72w4w7cuwswst5jh` |
| Config policy ID / validator hash | `0e73aac631bf11fc78ac53a8d85dee490b4a61ed6577de0857027691` |
| Config NFT unit | `0e73aac631bf11fc78ac53a8d85dee490b4a61ed6577de08570276914449415f434f4e464947` |
| Coordinator stake validator hash | `583b9e5278b1bf6af1ab6da98f2ab123e3a402526f5087fee46970ee` |
| PaymentHook policy ID / validator hash | `70bf934df3daefb7c19d20d06641528765bd02b761bb1e818f633bf6` |
| PaymentHook NFT unit | `70bf934df3daefb7c19d20d06641528765bd02b761bb1e818f633bf64449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `e6721fde8af7e40aecbd6f146b0470cc20722e05a61c9230a052900d` |
| Receiver validator address (`client-a`) | `addr_test1wrn8y8773tm7gzhvh4h3g6cywrxzqu3wqknpey3s5pffqrgn9jphd` |
| Pair validator hash (`client-a`) | `def5c14be6bceefb95769110a0c8c7d5362e58bf8f17b6ee1c1bd902` |
| Pair validator address (`client-a`) | `addr_test1wr00ts2tu67wa7u4w6g3pgxgcl2nvtjch7830dhwrsdajqszug5ju` |

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
| DOT/USD | `421000000` | *burned (tx `b068192bab20e744…`)* | burned |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) | live |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) | live |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) | live |
| USDC/USD | `100045678` | single create (step 13–23) | live |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) | live |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) | live |

## Key transaction explorer links (Preview CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `7d6c090cf6789db01530c650621cc981cd8bcebda931eca379de1719fedcd8a8` | [CExplorer](https://preview.cexplorer.io/tx/7d6c090cf6789db01530c650621cc981cd8bcebda931eca379de1719fedcd8a8) |
| PaymentHook bootstrap | `6f1bf7dd60c4c809e3e8ac359239145e64e68e4a4b10cb17e0553d103fdc129c` | [CExplorer](https://preview.cexplorer.io/tx/6f1bf7dd60c4c809e3e8ac359239145e64e68e4a4b10cb17e0553d103fdc129c) |
| Receiver bootstrap (`client-a`) | `fc5f072d6b55129b51c99ebf9b62dfc158eae6dcab5f44959d2f046696e2124f` | [CExplorer](https://preview.cexplorer.io/tx/fc5f072d6b55129b51c99ebf9b62dfc158eae6dcab5f44959d2f046696e2124f) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `4b394a180e86884457af6d2cf16fb9e1ab69b37b21c5bda611a05338864e4efe` | [CExplorer](https://preview.cexplorer.io/tx/4b394a180e86884457af6d2cf16fb9e1ab69b37b21c5bda611a05338864e4efe) |
| First single-pair update (USDC/USD) | `26f31aa8ced1919755934cda200856db7c8367b43936137b97649a48096f1ed6` | [CExplorer](https://preview.cexplorer.io/tx/26f31aa8ced1919755934cda200856db7c8367b43936137b97649a48096f1ed6) |
| Batch update (10 pairs) | `1d5ff45dc5342d31346e62c7e2dd013f93117f0ee6f5de5f4ab78677656a32ee` | [CExplorer](https://preview.cexplorer.io/tx/1d5ff45dc5342d31346e62c7e2dd013f93117f0ee6f5de5f4ab78677656a32ee) |
| **Settle** | `c8da8dd3b182e1b4d679550a9f8982ec96b35351d551ec17fb0627dd334d5b3b` | [CExplorer](https://preview.cexplorer.io/tx/c8da8dd3b182e1b4d679550a9f8982ec96b35351d551ec17fb0627dd334d5b3b) |
| Receiver withdraw | `e090d92b1a97a6ecf7a5470c1500d0fa2e9e8aa11c93c4267c72884a5f03cdf2` | [CExplorer](https://preview.cexplorer.io/tx/e090d92b1a97a6ecf7a5470c1500d0fa2e9e8aa11c93c4267c72884a5f03cdf2) |
| PaymentHook withdraw | `50105f5cba135d987b57f76846d1f309cbfb9b0b6752945718983f9410f64dc0` | [CExplorer](https://preview.cexplorer.io/tx/50105f5cba135d987b57f76846d1f309cbfb9b0b6752945718983f9410f64dc0) |
| Reclaim payment-hook ref script | `955e49d6b82d23637d9273e3a7264628542e40adb4904c922a3194c0b034b54e` | [CExplorer](https://preview.cexplorer.io/tx/955e49d6b82d23637d9273e3a7264628542e40adb4904c922a3194c0b034b54e) |
| Republish payment-hook ref script | `b989c9e78d2245c7c93393ce39baa639f4dccc09f1d84576a7f20df50be5ea3a` | [CExplorer](https://preview.cexplorer.io/tx/b989c9e78d2245c7c93393ce39baa639f4dccc09f1d84576a7f20df50be5ea3a) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
