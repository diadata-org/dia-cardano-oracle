# Fee audit and compression plan for DIA Cardano Oracle

## Contents

- [Executive summary](#executive-summary)
- [Current architecture and cost paths](#current-architecture-and-cost-paths)
- [On-chain audit findings](#on-chain-audit-findings)
- [Priority improvement backlog](#priority-improvement-backlog)
- [High-impact structural redesigns](#high-impact-structural-redesigns)
- [Implementation and validation plan](#implementation-and-validation-plan)
- [Appendix — `aiken bench` baseline (2026-05-23)](#appendix--aiken-bench-baseline-2026-05-23)

## Executive summary

Yes: there is real room to aggressively lower fees without sacrificing security, but the biggest return will not come from "making the script a bit shorter", but from compressing the hot paths that execute many times: `update`, `update:batch` and `settle`. In this repository there is already a correct foundation for that: reference inputs, inline datums and reference scripts are used; the batch coordinator has already been optimized to avoid repeated full sweeps of inputs and outputs; and `pair_state.spend(ApplyUpdate)` already avoids decoding the continuation datum and uses a fingerprint of the coordinator's redeemer to avoid paying for the full batch decoding in each pair. fileciteturn17file0L1-L3 fileciteturn18file0L1-L3 fileciteturn20file0L1-L3 fileciteturn23file0L1-L3

The main bottleneck that remains is in three places. First, there is still full decoding/validation of `ConfigDatum` in repeated paths where it is not needed. Second, the batch redeemer repeats too much data per witness. Third, the hot datums still carry fields that serve more for traceability than for on-chain security. The runbook itself gives a clear signal of budget sensitivity: the batch step tries sizes from 10 to 5 and only falls to the next when the node returns an explicit "over budget Mem/CPU" error. In the committed mainnet evidence, the batch of 10 pairs cost 2.663187 ADA, consumed `cpu=4500351790` and `mem=11506037`, and a single-receiver `settle` cost 0.767491 ADA with `cpu=575724580` and `mem=1792419`. fileciteturn16file0L1-L3 fileciteturn43file0L1-L3 fileciteturn44file0L1-L3

My reading is this: if you want to push the protocol toward batches of 11 or more and lower the cost per repeated operation, the priority should be to extend the fingerprint/partial deserialization pattern to every hot path, redesign the batch redeemer schema to eliminate repetition, slim down `PairDatum` and `PaymentHookDatum`, and enable multi-receiver `settle` from the CLI to amortize the hook cost. All of that is compatible with the optimization philosophy that Aiken recommends: benchmark first, avoid retraversals, validate while iterating, use simpler structures, rely on ledger invariants and move work off-chain when it can be cheaply verified on-chain. citeturn8view0turn9view0turn9view2turn9view3turn10view0turn10view2turn10view3

## Current architecture and cost paths

The protocol flow in this snapshot is clear. The runbook `run-all-cli.sh` initializes `Config`, publishes reference scripts, bootstraps `PaymentHook`, bootstraps a `Receiver` per client, creates 11 individual pairs with `update`, then runs an `update:batch`, then `settle`, and ends with withdrawals and administrative operations such as `reclaim-reference-script`, `republish` and `pair:burn`. In the batch step, the script generates manifests of sizes 10 to 5 and only attempts the next smaller size if the failure was an explicit rejection due to execution budget. fileciteturn15file0L1-L3 fileciteturn16file0L1-L3

The mainnet evidence of that flow documents eleven pairs bootstrapped individually and a subsequent batch of the ten non-USDC ones in a single transaction. That batch of 10 pairs was successful on mainnet with a total fee of 2.663187 ADA. `settle` was also successful, with a fee of 0.767491 ADA. The evidence itself summarizes that the integration exercised `Settle`, reclaim and republish of reference scripts, and makes clear that the most expensive repeated path today is `update:batch`, not `settle`. fileciteturn35file0L1-L3 fileciteturn43file0L1-L3 fileciteturn44file0L1-L3

There is an important detail for proper prioritization. Since the protocol already publishes and reuses reference scripts, the compiled bytecode size matters more for the one-shot cost of publishing those scripts and for the ADA locked in the reference UTxOs than for the recurring cost of `update` and `settle`. CIP-33 exists exactly for that: so that normal transactions do not have to reload the full script. Your builders already read reference scripts and only attach the validator when the reference UTxO is missing. Therefore, for recurring fees the main lever is not "reducing bytes in plutus.json", but reducing ex-units and reducing the size of datums and redeemers that do travel in every transaction. citeturn6view1 fileciteturn29file0L1-L3 fileciteturn38file0L1-L3

You are also using inline datums and reference inputs, which are the correct foundation in Cardano to avoid churn and not spend UTxOs that you only want to observe. CIP-31 defines reference inputs as a way to observe an output without spending it, and CIP-32 defines inline datums, with the trade-off that the data travels in the output and its size influences the min-UTxO. That second part matters a lot here: every byte you remove from `PairDatum` or `PaymentHookDatum` gets multiplied across every pair output in a batch or settle. citeturn5view0turn6view2

## On-chain audit findings

The best part of the current design is that it already contains the right pattern in the right place: `pair_state.spend(ApplyUpdate)` is deliberately minimal. It does not re-decode the continuation datum, does not recalculate all pair properties, and only enforces NFT continuity, exact lovelace and a defense against cross-script redeemer confusion via `coordinator_in_update_mode`. That helper decodes only the outer tag of the coordinator's redeemer, not the full witness list, using `CoordinatorRedeemerFingerprint`. That is exactly the pattern I would extend to the rest of the protocol. fileciteturn20file0L1-L3 fileciteturn23file0L1-L3

The second current strength is `update_coordinator.valid_batch_update`. The contract's own comment makes explicit that previously a full scan of `tx.inputs` and `tx.outputs` was done for each witness, and now a single linear pass is done to filter pair inputs and pair outputs, reducing the number of asset lookups from `2 × N × M` to `M_in + M_out`. This improvement is already in the direction of Aiken's official recommendations: avoid retraversals, validate while iterating and build local caches when the same collection is queried many times. fileciteturn18file0L1-L3 citeturn9view2turn9view3

Where you are still paying expensively is in `receiver.ak` and `payment_hook.ak`. In `receiver.spend`, the `AccrueFee` and `Settle` branches look up `Config` again, fully decode the `ConfigDatum` again and call `valid_config_state` again, even though in those paths the receiver only needs a small part of the config to bind to the coordinator and, in the case of `Settle`, to locate the correct authorization. Similarly, `payment_hook.spend(ApplySettle)` does full config decoding even though its actual need is much smaller than `update_coordinator`'s. In architecture terms, this is not a bug: it is defense and clarity. In fee terms, it is the next obvious place to apply fingerprints and partial views. fileciteturn19file0L1-L3 fileciteturn21file0L1-L3

The third finding is hot data size. `PairDatum` today carries `pair_id`, `price`, `timestamp`, `nonce`, `intent_hash`, `signer` and `min_utxo_lovelace`. In the mainnet batch log, each pair output carries an inline datum of 91–95 bytes. `PaymentHookDatum` carries `withdraw_address`, `accrued_fees_lovelace`, `lifetime_collected_lovelace`, `lifetime_withdrawn_lovelace` and `min_utxo_lovelace`; in `settle`, the hook output carries an inline datum of 100 bytes. In contrast, the receiver datum is already compact: 15–19 bytes depending on its integer values. This, by itself, tells you where to fight for bytes first. fileciteturn24file0L1-L3 fileciteturn45file0L1-L3 fileciteturn43file0L1-L3 fileciteturn44file0L1-L3 fileciteturn26file0L1-L3

I also saw semantic redundancy in the batch redeemer. `UpdateWitness` repeats `receiver_policy_id`, `receiver_asset_name`, `pair_policy_id`, `pair_token_name`, complete `intent` and `signer_public_key` for each element; the off-chain builder serializes it exactly in that form. In a batch, however, the coordinator itself requires that all witnesses share the same receiver and the same pair policy. That is: you are today paying bytes and decoding cost for repeated information that the validator then forces to be equal across all elements. That is the point with the highest return if you redesign the redeemer schema. fileciteturn24file0L1-L3 fileciteturn41file0L1-L3 fileciteturn18file0L1-L3

There are also two fields that smell like hot metadata, not hot security. The first is `PairDatum.intent_hash`: today it is recalculated and copied to the next datum, but it is not the main anti-replay anchor; the main freshness anchor is `timestamp` and strictly increasing `nonce` relative to the previous datum. The second is `signer`: the EIP-712 struct hash that is signed does not include `signer`; the contract checks it by length and persists it, but the actual authorization is based on `signer_public_key` and `verify_ecdsa_signature`. That makes `signer` more valuable as an audit trail than as a security datum for the hot path. If you need that data, I would move it to transaction metadata, to CLI JSON artifacts or to an indexer. If you do not need it on-chain, it is a clear candidate to be removed from the hot datum. fileciteturn24file0L1-L3

Finally, there is an important constraint that you should not break while pursuing larger batches: you must not design new optimizations assuming positional order in `tx.inputs`. The contract already correctly documents that positional alignment works for outputs because the builder emits them in canonical order, but not for inputs, whose order in the ledger remains lexicographic. CIP-128, which would allow preserving input order, is still in Proposed state, not Active. In other words: index-alignment tricks work today for outputs, not for inputs. fileciteturn18file0L1-L3 citeturn6view0

## Priority improvement backlog

The following table is the backlog I would leave for an implementing agent. It is ordered by impact/risk ratio for lowering fees in repeated operations.

| Priority | Change | Target paths | Expected impact | Risk |
| --- | --- | --- | --- | --- |
| P0 | Extend fingerprints and partial views to `receiver.AccrueFee`, `receiver.Settle` and `payment_hook.ApplySettle` | `update`, `update:batch`, `settle` | Lowers memory and CPU without touching the economic model | Low |
| P0 | Redesign `ApplyBatch` to move receiver/pair policy to the batch header | `update:batch` | Strong reduction in redeemer bytes and decoding cost | Medium |
| P0 | Remove `receiver_asset_name` from the witness and manifest where the policy ID already identifies a unique NFT | `update`, `update:batch`, `settle` | Lowers bytes; low migration cost | Low/Medium |
| P0 | Move `settle` off-chain to real multi-receiver | `settle` | Amortizes hook and coordinator cost across multiple clients | Low |
| P1 | Compact `OracleIntent` on-chain for hot path: 64-byte normalized signature off-chain and elimination of duplicates | `update`, `update:batch` | Lowers bytes per witness | Medium |
| P1 | Slim down `PairDatum`: first remove `signer` and `intent_hash`; then evaluate removing `pair_id` | `update`, `update:batch` | High size reduction per pair and per batch | Medium |
| P1 | Move `withdraw_address` out of `PaymentHookDatum` into `Config` or a cold piece | `settle`, `payment-hook:withdraw` | Lowers bytes and decode cost of settle | Medium |
| P1 | Replace full `valid_config_state` with path-specific validations in hot paths | `update`, `update:batch`, `settle` | Lowers CPU and memory | Medium |
| P2 | Batch intent signed once by DIA instead of N signatures per batch | `update:batch` | Greater potential CPU gain | High |
| P2 | Hot/cold config split | `update`, `update:batch`, `settle` | Can lower recurring decode cost | High |

The justification for this backlog comes from the current shape of the validators, datum/redeemer structures and mainnet evidence. It is also aligned with Aiken's recommendations on avoiding retraversals, using simple structures, validating while iterating, relying on ledger invariants, using `ByteArray` only when the benefit justifies it, and moving work off-chain when it can be cheaply verified on-chain. fileciteturn19file0L1-L3 fileciteturn21file0L1-L3 fileciteturn23file0L1-L3 fileciteturn24file0L1-L3 fileciteturn41file0L1-L3 fileciteturn43file0L1-L3 fileciteturn44file0L1-L3 citeturn9view0turn9view2turn9view3turn10view0turn10view2turn10view3

My concrete recommendation for P0 is this. In `receiver.ak`, create hot-path helpers that do not load a full `ConfigDatum`. For `AccrueFee`, the receiver only needs to prove that the coordinator is running in `ApplySingle` or `ApplyBatch` and that the named receiver is this receiver. That can be resolved with a redeemer fingerprint or with a witness fingerprint that decodes only the necessary fields from the batch and leaves the rest as raw `Data`. For `payment_hook.ApplySettle`, the hook does not even need the full manifest list: it only needs to know that the coordinator is in `ApplySettle` mode and that the expected `payment_hook_ref` matches. In both cases there is a clear opportunity to not pay full `valid_config_state` on every hot execution. fileciteturn19file0L1-L3 fileciteturn21file0L1-L3 fileciteturn23file0L1-L3

My concrete recommendation for P0 in batch is to redraw the redeemer. A simple form would be something like `ApplyBatchV2 { receiver_policy_id, pair_policy_id, witnesses }`, where each witness carries only what actually varies per pair. Then test two variants. The conservative variant keeps `pair_token_name`, `intent` and `signer_public_key`. The aggressive variant removes `pair_token_name` and derives it from `intent.symbol` with `blake2b_256`, and also removes `receiver_asset_name` because the current receiver policy already corresponds to a unique NFT bootstrapped by a one-shot policy. The first variant is more likely to win without increasing CPU. The second has more byte savings, but needs benchmarking because it introduces an additional hash per witness. fileciteturn19file0L1-L3 fileciteturn24file0L1-L3 fileciteturn41file0L1-L3

My concrete recommendation for `settle` is to enable multi-receiver all at once. On-chain it already exists: `SettleManifest` is a list of `SettleReceiver`, `valid_settle` already sums the drains of multiple receivers and compares against the hook delta, and the `PaymentHook` already models the settle as a global accumulation. However, the current CLI builds a single-receiver manifest and even validates it with a specific "single client receiver" preflight. That is wasting a capability already built on the on-chain side. If your protocol reaches multiple clients, this single improvement can amortize a lot of operational cost. fileciteturn23file0L1-L3 fileciteturn17file0L1-L3 fileciteturn37file0L1-L3 fileciteturn38file0L1-L3

## High-impact structural redesigns

The redesign with the best upside is a single DIA-signed `ApplyBatch`. Right now each witness carries a full `OracleIntent`, a signature and a public key, and the coordinator verifies the signature N times in `next_pair_matches_witness` / `initial_pair_matches_witness`. That is correct, but expensive. A single EIP-712 batch intent, signing the complete list of updates, would reduce the cryptographic verification from N signatures to 1 signature per batch. The coordinator would still validate canonical order, input/output correspondence, NFT continuity and `timestamp/nonce` monotonicity, but the expensive cryptographic part would collapse to the batch. This requires coordination with DIA and changing the way intents are generated, so it is not a P0. But if the economic survival of the protocol depends on fees, this is the option with the greatest CPU reduction potential for `update:batch`. fileciteturn24file0L1-L3 fileciteturn18file0L1-L3 citeturn10view2turn10view3

The second structural redesign that I do see as reasonable is separating hot and cold state. `PaymentHookDatum` mixes a cold datum, `withdraw_address`, with hot counters that change on every `settle`. `ConfigDatum` mixes very hot data for updates with administrative or invariant data that matters much less in the repeated paths. A hot/cold architecture would allow `update` and `settle` to read only the minimum to operate, maintaining security but reducing bytes and decoding cost. If you do this, my order would be: first remove `withdraw_address` from the hot hook datum; then evaluate a partial config split to avoid dragging full administrative lists and fields in every update. fileciteturn21file0L1-L3 fileciteturn25file0L1-L3 fileciteturn45file0L1-L3

The third redesign, more surgical, is to slim down `PairDatum` to leave only what is strictly necessary for on-chain price enforcement. My proposal would be a `PairDatumV2` centered on `price`, `timestamp`, `nonce` and `min_utxo_lovelace`, and then measuring whether any additional field needs to be kept for auditability. I would first keep pair identity outside the datum and in the NFT unit, because the UTxO is already located by NFT and the pairing between witness and pair can be done with `blake2b_256(intent.symbol)` against the token name. I would do the same with `signer` and `intent_hash`: if downstream needs them, move them to transaction metadata, to CLI JSON artifacts or to an indexer. If downstream does not need them, they are unnecessary in the hot datum. The strong signal here is empirical: in the mainnet batch, each of those fields is replicated across ten pair outputs, and those outputs weigh 91–95 bytes each. fileciteturn24file0L1-L3 fileciteturn43file0L1-L3

I do not recommend, however, pursuing optimizations that break your main guarantees. I would not touch the defense against cross-script redeemer confusion; I would not base new logic on the positional order of `tx.inputs` while CIP-128 is not Active; and I would not remove exact locked lovelace verification in `pair_state`, `receiver` or `payment_hook`. The way to lower fees here is not "verify less", but "verify once, in the right place, with the minimum decoding possible". fileciteturn20file0L1-L3 fileciteturn23file0L1-L3 citeturn6view0turn10view3

## Implementation and validation plan

I would execute this in three waves. The first wave should be benchmarking and not blind refactoring. Aiken insists on benchmarking before optimizing, and also has built-in support for `aiken bench` and for measuring memory/CPU against input growth. In this repo I would add specific benches for `update_coordinator.valid_batch_update`, `receiver.spend.AccrueFee`, `receiver.spend.Settle`, `payment_hook.spend.ApplySettle`, `pair_state.spend.ApplyUpdate`, `pair_state.mint.MintPairs` and `valid_settle` with a variable number of receivers. The goal is not "to have more tests"; it is to be able to see the memory and CPU curve as N increases. citeturn8view0turn8view1

The second wave would be pure P0: fingerprints and partial decode in receiver/hook, plus multi-receiver `settle` off-chain. This is the part with the lowest risk/benefit ratio. Here you do not change the economic model or the fundamental format of DIA intents, and you can still lower the cost of the most repeated paths. Additionally, this phase prepares the ground for larger batches without compromising traceability. fileciteturn19file0L1-L3 fileciteturn21file0L1-L3 fileciteturn37file0L1-L3

The third wave would be schema v2: more compact batch redeemer and smaller hot datums. Here you do need to version CLI artifacts, regenerate serializers in `offchain/cli/src/core/chain-helpers.ts`, touch redeemer constructors in the `update` and `update:batch` builders, and update the contracts that consume those types. The only valid criterion for accepting or rejecting each change must be: actual reduction of fee, CPU or memory measured in `aiken bench`, in Lucid's `buildOnly` and in a run of `run-all-cli.sh` or `fee-benchmark.sh`. The benchmark script in the repo is already designed exactly to discover the maximum batch size and then measure cycles; reuse it as an acceptance harness. fileciteturn31file0L1-L3 fileciteturn41file0L1-L3

There remain some limitations and open questions. I did not find, in the reviewed snapshot, committed evidence of a successful batch of 11 pairs; I did find a runbook that automates 10→5 and mainnet evidence of success for 10. I also did not find a committed benchmark that explicitly compares "full decode versus fieldwise decode" for `receiver` and `payment_hook`; that measurement needs to be built. And the single-DIA-signed batch redesign, while the most powerful, depends on external coordination with the intent emitter and is therefore not an autonomous refactor of the repository. fileciteturn16file0L1-L3 fileciteturn35file0L1-L3

## Appendix — `aiken bench` baseline (2026-05-23)

Aiken benches were added for these paths:

- `update_coordinator_valid_batch_update_create_path`
- `update_coordinator_valid_settle_receivers`
- `receiver_spend_accrue_fee_decodes_batch_redeemer`
- `receiver_spend_settle_scans_manifest`
- `payment_hook_spend_apply_settle_decodes_manifest`
- `pair_state_spend_apply_update_fingerprint_stays_hot`

The reference run used for this baseline was:

```sh
cd contracts/aiken
aiken bench --max-size 30 > /tmp/dia-aiken-bench-30.json
```

In these samplers, the logical size modeled is `N = size + 1`. Therefore:

- `size = 0` corresponds to `N = 1`
- `size = 30` corresponds to `N = 31`

Results measured in the previous run:

| Module | Bench | size=0 mem | size=0 cpu | size=30 mem | size=30 cpu |
| --- | --- | ---: | ---: | ---: | ---: |
| `pair_state` | `pair_state_spend_apply_update_fingerprint_stays_hot` | 357,138 | 158,122,336 | 357,138 | 158,122,336 |
| `payment_hook` | `payment_hook_spend_apply_settle_decodes_manifest` | 396,538 | 132,331,529 | 632,038 | 205,716,209 |
| `receiver` | `receiver_spend_accrue_fee_decodes_batch_redeemer` | 447,256 | 145,509,149 | 1,308,856 | 412,082,789 |
| `receiver` | `receiver_spend_settle_scans_manifest` | 432,137 | 140,934,918 | 812,447 | 258,882,408 |
| `update_coordinator` | `update_coordinator_valid_batch_update_create_path` | 401,011 | 175,326,385 | 11,268,451 | 4,624,493,875 |
| `update_coordinator` | `update_coordinator_valid_settle_receivers` | 452,228 | 146,535,001 | 30,244,463 | 9,297,575,191 |

The JSON emitted by `aiken bench` for this run contains intermediate measurements for all sizes `size = 0..30`.

My final verdict is favorable to going "all the way", but in this order: first squeeze the decoding and current schema; then slim down hot datums; and only then, if still needed, negotiate a single-signed batch intent. With that order, the most likely outcome is that you lower fees without losing a single comma of security, and with a measurable basis for deciding whether it is worth fighting for batch-11, batch-12 or more.
