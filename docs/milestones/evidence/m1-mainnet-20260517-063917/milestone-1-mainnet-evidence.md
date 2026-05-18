# Milestone 1 Mainnet Evidence

Source of truth: [`final-cardano-milestones.md`](../../final-cardano-milestones.md).

Scope: Milestone 1 validation on Cardano Mainnet.

Verification date: **20260517-0** (chain walk + local tooling, current bytecode).

Network: Cardano Mainnet.

Evidence pack location: [`docs/milestones/evidence/m1-mainnet-20260517-063917/`](./) — captured logs for every CLI step plus `SUMMARY.json` with the final on-chain state.

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
| 3 | `config:bootstrap` | `26cfc9e2b942ccde422bc358cd1f8f01ac41907df437eaffe27ad5ef00cde505` | 0.300680 ADA | [`03-config-bootstrap.log`](./03-config-bootstrap.log) |
| 4 | `config:reference-scripts` (Config+Coordinator) | `6bb730faa7af29ffd3b7ee7f7877d79adf14690174d5a1c816191da886a34f46` | 0.624773 ADA | [`04-config-reference-scripts.log`](./04-config-reference-scripts.log) |
| 5 | `payment-hook:parameterize` | *(local artifact)* | — | [`05-payment-hook-parameterize.log`](./05-payment-hook-parameterize.log) |
| 6 | `payment-hook:bootstrap` | `dac54903163af14916b291655157862cf47dd5303fbb25ae0a905269331217f6` | 0.593870 ADA | [`06-payment-hook-bootstrap.log`](./06-payment-hook-bootstrap.log) |
| 7 | `payment-hook:reference-script` | `fd8bfc316b02f0c2f504bfa16c012292e085e2bb30f8deffdc19afb7545d5672` | 0.382113 ADA | [`07-payment-hook-reference-script.log`](./07-payment-hook-reference-script.log) |

### Client onboarding (`client-a`)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 8 | `client:init` | *(local artifact)* | — | [`08-client-init.log`](./08-client-init.log) |
| 9 | `receiver:parameterize` | *(local artifact)* | — | [`09-receiver-parameterize.log`](./09-receiver-parameterize.log) |
| 10 | `receiver:bootstrap` | `0878b515ef5926222c0ffa9aca0181ef75a992d2b8e6042fccdc3364f7c9d096` | 0.429297 ADA | [`10-receiver-bootstrap.log`](./10-receiver-bootstrap.log) |
| 11 | `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `52b58e52c60df799656e9bf3d9a241434fd4f9630cca408dfe96154e0d60d250` | 0.817713 ADA | [`11-client-reference-scripts.log`](./11-client-reference-scripts.log) |
| 12 | `receiver:top-up` (top-up 1) | `8ba3c7c54a4f269d3d8cc3fffdcb7783ec7b410ccc88ec987122d7039a690557` | 0.351943 ADA | [`12-receiver-top-up.log`](./12-receiver-top-up.log) |

### Single-pair pair-create updates — 11 pairs via `update`

| Step | Pair | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 13 | USDC/USD | `786bc7681899ed58bafe916ce173915184736b60aa572757575e67ec0e04ed0a` | 0.797531 ADA | [`13-update-usdc-bootstrap.log`](./13-update-usdc-bootstrap.log) |
| 14 | BTC/USD | `d07f2a161464b2b7fdf589d68210f2fbc59ca397c6abeea2e4e02fc7a6d6e81c` | 0.797795 ADA | [`14-bootstrap-btc-usd.log`](./14-bootstrap-btc-usd.log) |
| 15 | ETH/USD | `ef0b89ff5a05493b9fe7a18285b4fa12c96bf13ae4216949b448af8c3fa12668` | 0.797795 ADA | [`15-bootstrap-eth-usd.log`](./15-bootstrap-eth-usd.log) |
| 16 | ADA/USD | `851f8334f5c6690c2b604de487f7cf1bad7c916c870dac26de13acfc19e4d1a6` | 0.797443 ADA | [`16-bootstrap-ada-usd.log`](./16-bootstrap-ada-usd.log) |
| 17 | USDT/USD | `4aa6582771f007fff0267a51ed5f7322341d320ff3a3b3d323c3795f78e63431` | 0.797531 ADA | [`17-bootstrap-usdt-usd.log`](./17-bootstrap-usdt-usd.log) |
| 18 | DAI/USD | `a7bdf474e3bc5ed31bd886d7eef5358b18a11267cb89559480ed6781d53e4472` | 0.797443 ADA | [`18-bootstrap-dai-usd.log`](./18-bootstrap-dai-usd.log) |
| 19 | SOL/USD | `d82b0cb78c3a3abb9bffe89db7addb7367d3dd4cbce341fc4210f029b3ae94e6` | 0.797795 ADA | [`19-bootstrap-sol-usd.log`](./19-bootstrap-sol-usd.log) |
| 20 | BNB/USD | `0f5c65e9d32a94f9dc87adf1828071878df713e2b30c642d62d6b67b16c521b3` | 0.797795 ADA | [`20-bootstrap-bnb-usd.log`](./20-bootstrap-bnb-usd.log) |
| 21 | XRP/USD | `4c8d67e7962f83976c1f702a7ea99666e01b411c230064c56efbc98a4a4f23ee` | 0.797443 ADA | [`21-bootstrap-xrp-usd.log`](./21-bootstrap-xrp-usd.log) |
| 22 | MATIC/USD | `fbd96e64ad49abc7fd04e1cb4235101aaa49108a90a5bb93479b44f28de10962` | 0.805052 ADA | [`22-bootstrap-matic-usd.log`](./22-bootstrap-matic-usd.log) |
| 23 | DOT/USD | `f084c6e3516ea508587be87948d271e7bb36eeba264201ae995e5f372af9fb14` | 0.799146 ADA | [`23-bootstrap-dot-usd.log`](./23-bootstrap-dot-usd.log) |

### Second top-up (replenish before batch)

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 24 | `receiver:top-up` (top-up 2) | `17e28c6c19808211d20e06023d2503f0c48f43b50f598685f81c042e3de3d401` | 0.352119 ADA | [`24-receiver-top-up-2.log`](./24-receiver-top-up-2.log) |

### Batch update — coordinator `ApplyBatch`

Batch size **10** succeeded.

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |

| 25 | `update:batch` (10 pairs) | `9877cce1b34b77929a32c26c72fe9b4a850f35ac4d947be68ae9750dab3569b4` | 2.663187 ADA | [`25-update-batch-10.log`](./25-update-batch-10.log) |

### Settle, withdrawals, reclaim + republish reference script, pair burn

| Step | Operation | Tx hash | Fee | Log |
| --- | --- | --- | --- | --- |
| 26 | `settle` | `0a2169dbbc1b6f590d1c28d459fcf35f10a6cffc1d44453f7d40c0b4970ac833` | 0.767491 ADA | [`26-settle.log`](./26-settle.log) |
| 27 | `receiver:withdraw` | `40b75a78e304a1544b33ae73974cd8c834835034b07b721359d58bec02819131` | 0.384163 ADA | [`27-receiver-withdraw.log`](./27-receiver-withdraw.log) |
| 28 | `payment-hook:withdraw` | `4981daaa754e920bc014e0221bb9c4551266674ad713980883272a642c74dea3` | 0.374068 ADA | [`28-payment-hook-withdraw.log`](./28-payment-hook-withdraw.log) |
| 29 | `reclaim-reference-script --script payment-hook` | `5143fe6dc88edfe6d6039d397c7d8b45312960cba511058bba9dae899777790e` | 0.310222 ADA | [`29-reclaim-payment-hook-reference-script.log`](./29-reclaim-payment-hook-reference-script.log) |
| 30 | `payment-hook:reference-script` (republish) | `f32157880e43b1ddfc73bf78c98e14690305136348582b659d2ed0657a0c90ab` | 0.382113 ADA | [`30-republish-payment-hook-reference-script.log`](./30-republish-payment-hook-reference-script.log) |
| 31 | `pair:burn` — DOT/USD burn (admin-gated) | `bc0b5dab76964ee9c4a053b3337f585dfcc9162e576741247d7d3bd48e47e8ee` | 0.441137 ADA | [`31-pair-burn-dot-usd.log`](./31-pair-burn-dot-usd.log) |

## ADA flow summary

Single wallet used for all operations (DIA admin = updater = funder).

| Item | Value |
| --- | --- |
| Wallet address | `addr1qxp3wp7xa70jddcj95luvrud8p587fm7dsktwz8s5ts28hv8n5a536xf3tq74m47tnr8afr68v8wyhdst8c7aeanxvlqulrq72` |
| Initial wallet balance | **245.000000 ADA** (245,000,000 lovelace) |
| Final wallet balance | **80.798772 ADA** (80,798,772 lovelace) |
| Total on-chain fees paid | **17.957658 ADA** (17,957,658 lovelace) |
| Net ADA locked in protocol | **146.243570 ADA** (initial − final − fees) |

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
| `config:bootstrap` | `26cfc9e2b942ccde…` | 0.300680 ADA |
| `config:reference-scripts` (Config+Coordinator) | `6bb730faa7af29ff…` | 0.624773 ADA |
| `payment-hook:bootstrap` | `dac54903163af149…` | 0.593870 ADA |
| `payment-hook:reference-script` | `fd8bfc316b02f0c2…` | 0.382113 ADA |
| `receiver:bootstrap` | `0878b515ef592622…` | 0.429297 ADA |
| `reference-scripts:publish-client` (Receiver+Pair+PairMint) | `52b58e52c60df799…` | 0.817713 ADA |
| `receiver:top-up` (top-up 1) | `8ba3c7c54a4f269d…` | 0.351943 ADA |
| `update` — USDC/USD create | `786bc7681899ed58…` | 0.797531 ADA |
| `update` — BTC/USD create | `d07f2a161464b2b7…` | 0.797795 ADA |
| `update` — ETH/USD create | `ef0b89ff5a05493b…` | 0.797795 ADA |
| `update` — ADA/USD create | `851f8334f5c6690c…` | 0.797443 ADA |
| `update` — USDT/USD create | `4aa6582771f007ff…` | 0.797531 ADA |
| `update` — DAI/USD create | `a7bdf474e3bc5ed3…` | 0.797443 ADA |
| `update` — SOL/USD create | `d82b0cb78c3a3abb…` | 0.797795 ADA |
| `update` — BNB/USD create | `0f5c65e9d32a94f9…` | 0.797795 ADA |
| `update` — XRP/USD create | `4c8d67e7962f8397…` | 0.797443 ADA |
| `update` — MATIC/USD create | `fbd96e64ad49abc7…` | 0.805052 ADA |
| `update` — DOT/USD create | `f084c6e3516ea508…` | 0.799146 ADA |
| `receiver:top-up` (top-up 2) | `17e28c6c19808211…` | 0.352119 ADA |
| `update:batch` (10 pairs) | `9877cce1b34b7792…` | 2.663187 ADA |
| `settle` | `0a2169dbbc1b6f59…` | 0.767491 ADA |
| `receiver:withdraw` | `40b75a78e304a154…` | 0.384163 ADA |
| `payment-hook:withdraw` | `4981daaa754e920b…` | 0.374068 ADA |
| `reclaim-reference-script --script payment-hook` | `5143fe6dc88edfe6…` | 0.310222 ADA |
| `payment-hook:reference-script` (republish) | `f32157880e43b1dd…` | 0.382113 ADA |
| `pair:burn` — DOT/USD burn (admin-gated) | `bc0b5dab76964ee9…` | 0.441137 ADA |

**Total confirmed on-chain fees: 17.957658 ADA** (17,957,658 lovelace).

## Final on-chain state

Snapshot from [`SUMMARY.json`](./SUMMARY.json) at the end of the Mainnet chain walk.

### Script identities (current bytecode)

| Item | Value |
| --- | --- |
| Reference-holder address | `addr1wymd9rcnu3xq4gvxypnyeu6js43avr5veglww8zr2ehjvwcyufgpq` |
| Config policy ID / validator hash | `211186b23b3c371426cdfe10559a6266cfbd025ca415f4d0c53af475` |
| Config NFT unit | `211186b23b3c371426cdfe10559a6266cfbd025ca415f4d0c53af4754449415f434f4e464947` |
| Coordinator stake validator hash | `98f950517112e513c21817e4f8f618ba3557fc082d8c4b15d6f27c78` |
| PaymentHook policy ID / validator hash | `c0c8f244c75bcde4c032b7b96bc843ba19e3351beaae3005dc083385` |
| PaymentHook NFT unit | `c0c8f244c75bcde4c032b7b96bc843ba19e3351beaae3005dc0833854449415f5041594d454e545f484f4f4b` |
| Receiver validator hash (`client-a`) | `d276c806b1beb5e04c71356bec048e0bbd39c07e267961cb7325726f` |
| Receiver validator address (`client-a`) | `addr1w8f8djqxkxlttczvwy6khmqy3c9m6wwq0cn8jcwtwvjhymce9mxgw` |
| Pair validator hash (`client-a`) | `71d73275dfbbcb8fbb931245efab810ad4f6c8d1a13da6fe7cf6c561` |
| Pair validator address (`client-a`) | `addr1w9cawvn4m7auhramjvfytmatsy9dfakg6xsnmfh70nmv2cg0rwvyu` |

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
| DOT/USD | `421000000` | *burned (tx `bc0b5dab76964ee9…`)* | burned |
| ETH/USD | `250100000000` | batch (step 25, 10 pairs) | live |
| MATIC/USD | `981000000` | batch (step 25, 10 pairs) | live |
| SOL/USD | `18510000000` | batch (step 25, 10 pairs) | live |
| USDC/USD | `100045678` | single create (step 13–23) | live |
| USDT/USD | `100101234` | batch (step 25, 10 pairs) | live |
| XRP/USD | `521000000` | batch (step 25, 10 pairs) | live |

## Key transaction explorer links (Mainnet CExplorer)

| Operation | Tx hash | Explorer |
| --- | --- | --- |
| Config bootstrap | `26cfc9e2b942ccde422bc358cd1f8f01ac41907df437eaffe27ad5ef00cde505` | [CExplorer](https://cexplorer.io/tx/26cfc9e2b942ccde422bc358cd1f8f01ac41907df437eaffe27ad5ef00cde505) |
| PaymentHook bootstrap | `dac54903163af14916b291655157862cf47dd5303fbb25ae0a905269331217f6` | [CExplorer](https://cexplorer.io/tx/dac54903163af14916b291655157862cf47dd5303fbb25ae0a905269331217f6) |
| Receiver bootstrap (`client-a`) | `0878b515ef5926222c0ffa9aca0181ef75a992d2b8e6042fccdc3364f7c9d096` | [CExplorer](https://cexplorer.io/tx/0878b515ef5926222c0ffa9aca0181ef75a992d2b8e6042fccdc3364f7c9d096) |
| Publish client reference scripts (Receiver+Pair+PairMint) | `52b58e52c60df799656e9bf3d9a241434fd4f9630cca408dfe96154e0d60d250` | [CExplorer](https://cexplorer.io/tx/52b58e52c60df799656e9bf3d9a241434fd4f9630cca408dfe96154e0d60d250) |
| First single-pair update (USDC/USD) | `786bc7681899ed58bafe916ce173915184736b60aa572757575e67ec0e04ed0a` | [CExplorer](https://cexplorer.io/tx/786bc7681899ed58bafe916ce173915184736b60aa572757575e67ec0e04ed0a) |
| Batch update (10 pairs) | `9877cce1b34b77929a32c26c72fe9b4a850f35ac4d947be68ae9750dab3569b4` | [CExplorer](https://cexplorer.io/tx/9877cce1b34b77929a32c26c72fe9b4a850f35ac4d947be68ae9750dab3569b4) |
| **Settle** | `0a2169dbbc1b6f590d1c28d459fcf35f10a6cffc1d44453f7d40c0b4970ac833` | [CExplorer](https://cexplorer.io/tx/0a2169dbbc1b6f590d1c28d459fcf35f10a6cffc1d44453f7d40c0b4970ac833) |
| Receiver withdraw | `40b75a78e304a1544b33ae73974cd8c834835034b07b721359d58bec02819131` | [CExplorer](https://cexplorer.io/tx/40b75a78e304a1544b33ae73974cd8c834835034b07b721359d58bec02819131) |
| PaymentHook withdraw | `4981daaa754e920bc014e0221bb9c4551266674ad713980883272a642c74dea3` | [CExplorer](https://cexplorer.io/tx/4981daaa754e920bc014e0221bb9c4551266674ad713980883272a642c74dea3) |
| Reclaim payment-hook ref script | `5143fe6dc88edfe6d6039d397c7d8b45312960cba511058bba9dae899777790e` | [CExplorer](https://cexplorer.io/tx/5143fe6dc88edfe6d6039d397c7d8b45312960cba511058bba9dae899777790e) |
| Republish payment-hook ref script | `f32157880e43b1ddfc73bf78c98e14690305136348582b659d2ed0657a0c90ab` | [CExplorer](https://cexplorer.io/tx/f32157880e43b1ddfc73bf78c98e14690305136348582b659d2ed0657a0c90ab) |

## Notes

Each DIA `OracleIntent` is generated just-in-time from the live chain tip immediately before its transaction so the signed `timestamp` and `validFrom`/`validTo` window are anchored to real network time. For the batch update, all intents are generated at the start of step 25 with a 1-hour expiry; each retry derives a fresh validity window from the chain tip at that moment.

Step 29–30 demonstrates the full reclaim + republish round-trip for the `payment-hook` reference-script UTxO: step 29 spends it back to the admin wallet; step 30 republishes it at a new outRef. This validates that `reference_holder` correctly enforces the admin-gated spend (Config signer + Config NFT as reference input).
