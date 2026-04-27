# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](./final-cardano-milestones.md)

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included in this Preview evidence file.

Verification date: 2026-04-27

Network: Cardano Preview

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | Complete for current repository scope: `aiken check` passes 24/24 tests; CLI tests pass |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending: mainnet not executed yet |

## Current Verification

- `aiken check`: 24/24 tests passed.
- `npm run test`: passed in `offchain/cli`.
- `npm run typecheck`: passed in `offchain/cli`.
- `npm run build`: passed in `offchain/cli`.
- Preview CLI flow regenerated end-to-end on 2026-04-27 using the clarified init + parameterize + bootstrap + reference-script + update flow.

## Milestone 1 Coverage

| Official requirement | Evidence |
| --- | --- |
| Cardano UTxO oracle contracts | `contracts/aiken/validators/`, `contracts/aiken/lib/dia_cardano_oracle/`, `aiken check` |
| DIA signed price updates | `real_dia_signature_is_accepted`, `next_pair_matches_witness_requires_fresh_data`, single and batch update CLI commands |
| Reject stale or replayed updates | `stale_timestamp_is_rejected`, `stale_nonce_is_rejected` |
| Reject invalid signer or pair mismatch | `unauthorized_dia_signer_is_rejected`, `wrong_pair_symbol_is_rejected`, `wrong_pair_nft_is_rejected` |
| Reject invalid price state | `negative_price_pair_state_is_rejected`, `negative_price_intent_signature_is_rejected` |
| Protocol fee accounting | `fee_charge_transition_increments_balances`, `fee_charge_transition_rejects_wrong_fee_amount`, update, batch update, and PaymentHook withdraw CLI commands |
| Receiver balance accounting | `pay_fee_transition_decrements_balance`, `pay_fee_transition_rejects_wrong_fee_amount`, `pay_fee_transition_rejects_balance_underflow`, update, batch update, Receiver top-up, and Receiver withdraw CLI commands |
| PaymentHook withdrawal accounting | `withdraw_transition_decrements_accrued_balance`, `withdraw_transition_rejects_above_accrued_fees`, PaymentHook withdraw CLI command |
| Protocol and client deployment flow | CLI runbook steps 6-27: initialize protocol/client artifacts, parameterize with existing wallet UTxOs, bootstrap Config, PaymentHook, and Receiver, publish reference scripts at ReferenceHolder, top up the Receiver, create and sign intents, create/update pairs through real oracle updates, generate Config-update and batch payloads, and submit maintenance transactions |
| CLI signer, intent, generated payload, and state artifact checks | `npm run test` in `offchain/cli` |
| Developer documentation | `README.md`, `contracts/aiken/README.md`, `offchain/cli/README.md`, `docs/architecture/cardano-oracle-architecture.md` |
| Mainnet deployment hashes | Pending |

## Required Preview Transaction Evidence

| CLI step | Operation | Evidence status |
| --- | --- | --- |
| 6 | Initialize protocol artifact | N/A: local artifact init |
| 7 | Parameterize Config scripts from an existing wallet UTxO | Complete: selected wallet UTxO `02e6bd83a5e44ce7cdc29e5ff1560cd9f7bc742e865fdb3ebf4a8ab1b02d715b#2` |
| 8 | Bootstrap Config | `14427401adfee8c76ce506a07edda2a54be2c0761df5a30cfa0e628061fb866e` |
| 9 | Publish Config and Coordinator reference scripts at ReferenceHolder | `f82d630f914b5b069969010a9a5de7bec9cbee4f2accdc5c0009d45c02b07e92` |
| 10 | Parameterize PaymentHook scripts from an existing wallet UTxO | Complete: selected wallet UTxO `f82d630f914b5b069969010a9a5de7bec9cbee4f2accdc5c0009d45c02b07e92#2` |
| 11 | Bootstrap PaymentHook | `b76a5137f613f42d3b34b77fd4aef0280c8851fbf3855f71cc4249bdedd4371d` |
| 12 | Publish PaymentHook reference script at ReferenceHolder | `855989fa8de4140c9307045dafeb245bb70f8ca74aac0e235d9ea5cb6fd3c7b1` |
| 13 | Initialize client artifact | N/A: local artifact init |
| 14 | Parameterize client Receiver and Pair scripts from an existing wallet UTxO | Complete: selected wallet UTxO `855989fa8de4140c9307045dafeb245bb70f8ca74aac0e235d9ea5cb6fd3c7b1#1` |
| 15 | Bootstrap Receiver | `16fa9ad337b76a75aa2437627a7513c3f9e1316d0c96c0cfc94316f3a0a18ad9` |
| 16 | Publish client Receiver and Pair reference scripts at ReferenceHolder | `5849abf24670559fe46a40453e779ce95e6adad5f8c8756b1026ecc4a777ec7d` |
| 17 | Receiver top-up | `c4e0bbdd223ba9d19d4c0a86167828dca9626e43d0ab799b5b5d08cbfb993d26` |
| 18 | Create and sign first intent | N/A: local prompt workflow, output `offchain/cli/state/preview/intents/usdc-usd.signed.json` |
| 19 | First oracle update/create pair | `f2c66b166d200264192262038a0ff773e3c2ca20617fc3cfc79bf34d80ba57c0` |
| 20 | Sign subsequent intent | N/A: local generated unsigned intent signed with `preview:intent:sign` |
| 21 | Subsequent oracle update | `904065f9673ff7fe4411a696ffae436accfdf75cc52979eaca14ca509505a8bc` |
| 22 | Create Config update draft | N/A: local prompt workflow |
| 23 | Config update | `27fbf81d8b0039ff2eb88573bd67bdf377d083d68106b2c1adcd8754711f48c4` |
| 24 | Create batch manifest | N/A: local generated manifest with USDC/USD and USDT/USD updates |
| 25 | Batch oracle update/create pairs | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687` |
| 26 | Receiver withdraw | `bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7` |
| 27 | PaymentHook withdraw | `3e890f1272082c1150e73dfa0efe3ca3259671a1692e965a7fa43bf45ffeb70c` |

## Final Preview State

| Artifact | Final state |
| --- | --- |
| Config UTxO | `27fbf81d8b0039ff2eb88573bd67bdf377d083d68106b2c1adcd8754711f48c4#0` |
| PaymentHook UTxO | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#3`; accrued fees `6000000`, lifetime collected `8000000`, lifetime withdrawn `2000000` |
| Receiver UTxO | `bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7#0`; balance `1000000` |
| USDC/USD Pair UTxO | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#0`; price `100065678`, nonce `1777274633040` |
| USDT/USD Pair UTxO | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#1`; price `100001234`, nonce `1777274633040` |

## Local State Artifacts

- `offchain/cli/state/preview/config-bootstrap.json`
- `offchain/cli/state/preview/clients/client-a.json`
- `offchain/cli/state/preview/clients/client-a/pairs/usdc-usd.json`
- `offchain/cli/state/preview/clients/client-a/pairs/usdt-usd.json`
- `offchain/cli/state/preview/intents/*.signed.json`
- `offchain/cli/state/preview/update-batches/update-batch.manifest.json`
- `offchain/cli/state/preview/update-batches/update-batch.result.json`

## Notes

Each DIA `OracleIntent` signature is valid only for the exact payload it signs, including `symbol`, `price`, `timestamp`, and `nonce`. The Preview flow used fresh signed intents for the first USDC/USD create/update, the subsequent USDC/USD update, and the USDC/USD + USDT/USD batch update/create transaction.

Reference-script UTxOs must be created at the `reference_holder` script address derived from `contracts/aiken/plutus.json`. The deploy wallet funds those outputs but cannot spend them.

Single and batch oracle updates read the current Receiver and PaymentHook inline datums from chain before computing the next accounting state. This avoids treating generated JSON artifacts as the source of truth for mutable fee balances after earlier update transactions.

Mainnet evidence must be recorded after the final transaction flow is executed on Cardano mainnet.
