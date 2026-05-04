# Milestone 1 Preview Evidence

Source of truth: [`final-cardano-milestones.md`](./final-cardano-milestones.md)

Scope: Milestone 1 validation on Cardano Preview. Cardano mainnet deployment and final mainnet evidence are not included in this Preview evidence file.

Verification date: 2026-04-27 (on-chain steps); **local tool verification refreshed 2026-05-04** (counts below).

Network: Cardano Preview

> **Note (re-deploy pending).** The Preview transaction hashes captured
> in this document predate the security and architecture changes
> documented in `docs/architecture/cardano-oracle-architecture.md`
> §5.11 and §7.4 (decoupled fee settlement, security hardening, and
> the related off-chain dedup pass). A fresh evidence pack will be
> regenerated after the re-deploy on Preview and will be added under
> `docs/milestones/evidence/m1-preview-<DATE>/`. Until then, the
> hashes below remain valid as historical Preview proof of the
> preceding contract version, but they should not be used to verify
> the current contract behaviour.

## Official Milestone 1 Outputs

| Official output | Repository status |
| --- | --- |
| Aiken oracle smart contract ported to Cardano UTxO model | Complete |
| Compiled contract | Complete: `contracts/aiken/plutus.json` |
| Unit/integration test coverage | **Repository:** `aiken check` — 78/78 tests; `offchain/cli` `npm run test` + `npm run typecheck` green (2026-05-04). **Preview tx table below** still reflects the **2026-04-27** chain walk (pre–current bytecode); replace after the next Preview re-bootstrap (see note at top of this file). |
| Deployment scripts | Complete: `offchain/cli` runbook and CLI commands |
| Documentation for Cardano developers | Complete in repository: root README, Aiken README, CLI runbook, architecture document |
| Verified Cardano mainnet deployment and execution hashes | Pending: mainnet not executed yet |

## Current verification (tooling)

These counts are for **current** `main` branch sources. They do not re-verify the historical Preview transaction hashes in the tables further down until a new evidence pack is captured.

- `aiken check`: **78/78** tests passed (`contracts/aiken`).
- `npm run test`: passed in `offchain/cli` (`CLI tests passed`).
- `npm run typecheck`: passed in `offchain/cli`.
- `npm run build`: passed in `offchain/cli`.
- Preview CLI flow: last **end-to-end** hash capture **2026-04-27** (see [`./evidence/m1-preview-20260427/`](./evidence/m1-preview-20260427/)). **Pending:** new folder `m1-preview-<DATE>/` after re-bootstrap on current contracts + runbook including **Settle** (`preview:settle`).

## Reproducible Local Test Evidence

The local verification logs are committed under [`docs/milestones/evidence/m1-preview-20260427/`](./evidence/m1-preview-20260427/). Each command was run on 2026-04-27 and exited with status `0`.

| Area | Working directory | Command | Captured output |
| --- | --- | --- | --- |
| Aiken contracts | `contracts/aiken` | `aiken check` | *(Re-run and save to new evidence folder when refreshing)* |
| CLI tests | `offchain/cli` | `npm run test` | *(ibid.)* |
| CLI typecheck | `offchain/cli` | `npm run typecheck` | *(ibid.)* |
| CLI build | `offchain/cli` | `npm run build` | *(ibid.)* |

### Historical pack (2026-04-27)

| Area | Working directory | Command | Captured output |
| --- | --- | --- | --- |
| Aiken contracts | `contracts/aiken` | `aiken check` | [`aiken-check.log`](./evidence/m1-preview-20260427/aiken-check.log) |
| CLI tests | `offchain/cli` | `npm run test` | [`npm-test.log`](./evidence/m1-preview-20260427/npm-test.log) |
| CLI typecheck | `offchain/cli` | `npm run typecheck` | [`npm-typecheck.log`](./evidence/m1-preview-20260427/npm-typecheck.log) |
| CLI build | `offchain/cli` | `npm run build` | [`npm-build.log`](./evidence/m1-preview-20260427/npm-build.log) |

Summary from the **2026-04-27** captured logs:

- `aiken check` collected **24** Aiken unit tests and passed 24/24 (older contract revision).
- `npm run test` printed `CLI tests passed`.
- `npm run typecheck` completed TypeScript checking with exit code `0`.
- `npm run build` completed TypeScript compilation with exit code `0`.

## Milestone 1 Coverage

| Official requirement | Evidence |
| --- | --- |
| Cardano UTxO oracle contracts | `contracts/aiken/validators/`, `contracts/aiken/lib/dia_cardano_oracle/`, `aiken check` |
| DIA signed price updates | `real_dia_signature_is_accepted`, `next_pair_matches_witness_requires_fresh_data`, single and batch update CLI commands |
| Reject stale or replayed updates | `stale_timestamp_is_rejected`, `stale_nonce_is_rejected` |
| Reject invalid signer or pair mismatch | `unauthorized_dia_signer_is_rejected`, `wrong_pair_symbol_is_rejected`, `wrong_pair_nft_is_rejected` |
| Reject invalid price state | `negative_price_pair_state_is_rejected`, `negative_price_intent_signature_is_rejected` |
| Protocol fee accounting | `apply_settle_transition_*` in `payment_hook_logic.ak`; `accrue_fee_transition_*` / `settle_transition_*` in `receiver_logic.ak`; coordinator `ApplySettle`; CLI `preview:update`, `preview:update:batch`, **`preview:settle`**, `preview:payment-hook:withdraw` |
| Receiver balance accounting | `accrue_fee_transition_*`, `settle_transition_*`, `withdraw_transition_*`, `top_up_transition_*` in `receiver_logic.ak`; CLI receiver top-up / withdraw / update / batch / settle |
| PaymentHook withdrawal accounting | `withdraw_transition_decrements_accrued_balance`, `withdraw_transition_rejects_above_accrued_fees`, PaymentHook withdraw CLI command |
| Protocol and client deployment flow | CLI runbook steps 6-27: initialize protocol/client artifacts, parameterize with existing wallet UTxOs, bootstrap Config, PaymentHook, and Receiver, publish reference scripts at ReferenceHolder, top up the Receiver, create and sign intents, create/update pairs through real oracle updates, generate Config-update and batch payloads, and submit maintenance transactions |
| CLI signer, intent, generated payload, and state artifact checks | `npm run test` in `offchain/cli` |
| Developer documentation | `README.md`, `contracts/aiken/README.md`, `offchain/cli/README.md`, `docs/architecture/cardano-oracle-architecture.md` |
| Mainnet deployment hashes | Pending |

## Required Preview Transaction Evidence

The step numbers match the historical **2026-04-27** runbook. The **current** protocol adds a **Settle** transaction between batch updates and maintenance withdraws; capture a `preview:settle` hash when regenerating evidence.

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
| — | **Settle** — move accrued fees from Receiver(s) to PaymentHook (`preview:settle`) | **Pending** in next evidence pack (not part of Apr 27 capture) |
| 26 | Receiver withdraw | `bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7` |
| 27 | PaymentHook withdraw | `3e890f1272082c1150e73dfa0efe3ca3259671a1692e965a7fa43bf45ffeb70c` |

## Final Preview State

| Artifact | Final state |
| --- | --- |
| Config UTxO | `27fbf81d8b0039ff2eb88573bd67bdf377d083d68106b2c1adcd8754711f48c4#0` |
| PaymentHook UTxO | `3e890f1272082c1150e73dfa0efe3ca3259671a1692e965a7fa43bf45ffeb70c#0`; accrued fees `6000000`, lifetime collected `8000000`, lifetime withdrawn `2000000` |
| Receiver UTxO | `bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7#0`; balance `1000000` |
| USDC/USD Pair UTxO | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#0`; price `100065678`, nonce `1777274633040` |
| USDT/USD Pair UTxO | `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#1`; price `100001234`, nonce `1777274633040` |

## Final Explorer Verification

Preview explorer links use CExplorer's Preview instance:

| Evidence | Explorer link | What to verify |
| --- | --- | --- |
| Config update | [27fbf81d8b0039ff2eb88573bd67bdf377d083d68106b2c1adcd8754711f48c4](https://preview.cexplorer.io/tx/27fbf81d8b0039ff2eb88573bd67bdf377d083d68106b2c1adcd8754711f48c4) | Output `#0` is the current Config UTxO at `addr_test1wpr526vu6lh7pwr3y5adu2rzjckyeaex0rjzhhxewgaelmsa96l3h`. |
| Batch oracle update | [4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687](https://preview.cexplorer.io/tx/4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687) | Outputs `#0`, `#1`, and `#3` are the final USDC/USD Pair, USDT/USD Pair, and PaymentHook UTxOs. |
| Receiver withdraw | [bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7](https://preview.cexplorer.io/tx/bea7199aee9ac51ecec68e65bd6df2eaaed69b1cd391814df53ee808bf06d0e7) | Output `#0` is the final Receiver UTxO with remaining balance `1000000` lovelace in its inline datum. |
| PaymentHook withdraw | [3e890f1272082c1150e73dfa0efe3ca3259671a1692e965a7fa43bf45ffeb70c](https://preview.cexplorer.io/tx/3e890f1272082c1150e73dfa0efe3ca3259671a1692e965a7fa43bf45ffeb70c) | Consumes the previous PaymentHook state from `4dc69409ce41b4a02cf8a7867e5891a6a5007a7ef213a435ea6bfa23b91bb687#3`, creates the final PaymentHook UTxO at output `#0`, and pays `2000000` lovelace to the configured withdraw address. |
| Global reference scripts | [f82d630f914b5b069969010a9a5de7bec9cbee4f2accdc5c0009d45c02b07e92](https://preview.cexplorer.io/tx/f82d630f914b5b069969010a9a5de7bec9cbee4f2accdc5c0009d45c02b07e92) | Outputs `#0` and `#1` hold the Config and Coordinator reference scripts at the ReferenceHolder address. |
| PaymentHook reference script | [855989fa8de4140c9307045dafeb245bb70f8ca74aac0e235d9ea5cb6fd3c7b1](https://preview.cexplorer.io/tx/855989fa8de4140c9307045dafeb245bb70f8ca74aac0e235d9ea5cb6fd3c7b1) | Output `#0` holds the PaymentHook reference script; output `#1` was later used only as the Receiver script parameterization UTxO. |
| Client reference scripts | [5849abf24670559fe46a40453e779ce95e6adad5f8c8756b1026ecc4a777ec7d](https://preview.cexplorer.io/tx/5849abf24670559fe46a40453e779ce95e6adad5f8c8756b1026ecc4a777ec7d) | Outputs `#0` and `#1` hold the Receiver and Pair reference scripts at the ReferenceHolder address. |

Expected final script and asset identities:

| Item | Expected value |
| --- | --- |
| ReferenceHolder address | `addr_test1wzwyjd7eza9rrndl7hwkesadzpq7ajchxxd67mj4zrz80hcka7jtk` |
| Config policy / validator hash | `4745699cd7efe0b871253ade2862962c4cf72678e42bdcd9723b9fee` |
| Config NFT unit | `4745699cd7efe0b871253ade2862962c4cf72678e42bdcd9723b9fee4449415f434f4e464947` (`DIA_CONFIG`) |
| Coordinator stake validator hash | `6a7c3bab2ce7b8e7a6271ae9488341c87726ccb608982f98d6540d57` |
| PaymentHook policy / validator hash | `dd4596300d9f3118b48ec6d7a8e1571cbc693a9b5c04ec6bb7083301` |
| PaymentHook NFT unit | `dd4596300d9f3118b48ec6d7a8e1571cbc693a9b5c04ec6bb70833014449415f5041594d454e545f484f4f4b` (`DIA_PAYMENT_HOOK`) |
| Receiver policy / validator hash | `2946700041db0a710ced0da2ff7954f29550fc9ebc817557b68c9a1c` |
| Receiver NFT unit | `2946700041db0a710ced0da2ff7954f29550fc9ebc817557b68c9a1c4449415f52454345495645525f434c49454e545f41` (`DIA_RECEIVER_CLIENT_A`) |
| Pair policy / validator hash | `f07a8782f848ddd5902251ed731fc66a2c605fc8eb7f19d9a8955601` |
| USDC/USD Pair NFT unit | `f07a8782f848ddd5902251ed731fc66a2c605fc8eb7f19d9a89556010156dbaa55902bb40ff6c461c8b2b59c70ebbe3786e51e5e75a8bc1cbad4c1ac` |
| USDT/USD Pair NFT unit | `f07a8782f848ddd5902251ed731fc66a2c605fc8eb7f19d9a89556015ec9fa6a8337c83985882517e4865a68763912f37490cffe992a26abfd29d315` |

Inline datum verification guide:

| Datum | Fields expected in the final state |
| --- | --- |
| Config datum | Authorized Config signer `50186fd477be5e6bbcf42e0143bcf8d6612901d19c515f93f3f30d2d`; authorized DIA compressed public key `02d78ade9f8a9c064c8c588dba903df0cc0118596b9ec65f665dea1b448519f531`; EIP-712 domain `DIA Oracle`, version `1.0`, source chain `100640`, verifying contract `f8c614a483a0427a13512f52ac72a576678be317`; protocol fee `2000000`; PaymentHook NFT ref; Coordinator script credential. |
| PaymentHook datum | Withdraw address `addr_test1qpgpsm75w7l9u6au7shqzsaulrtxz2gp6xw9zhun70es6tt4t3wsjavx26kmh586erf8xxhqc2y7urq5az32sjv56nyqquxj3j`; accrued fees `6000000`; lifetime collected `8000000`; lifetime withdrawn `2000000`; min UTxO `3000000`. |
| Receiver datum | Client balance `1000000` lovelace after top-up, update fees, and withdraw; accrued-to-hook per current protocol (see architecture doc); min UTxO `3000000`. |
| USDC/USD Pair datum | Pair id `555344432f555344` (`USDC/USD`); price `100065678`; timestamp `1777274653`; nonce `1777274633040`; signer key hash `2b1c7eff297766569966b630a6862947a8e5285a`; intent hash `cfd4d7a1b5d316a2b6fddf383168d5c164445345ab13412997e8f2c925340bca`; min UTxO `5000000`. |
| USDT/USD Pair datum | Pair id `555344542f555344` (`USDT/USD`); price `100001234`; timestamp `1777274653`; nonce `1777274633040`; signer key hash `2b1c7eff297766569966b630a6862947a8e5285a`; intent hash `e7692f59032293d3d37782acde24bc4ca223d2b11666e5b55bbbc4a0496d7f51`; min UTxO `5000000`. |

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

Single and batch oracle updates read the current Receiver inline datum from chain before computing the next accounting state; fees accrue on the Receiver until a **Settle** transaction moves them to the PaymentHook. This avoids treating generated JSON artifacts as the source of truth for mutable balances after earlier update transactions.

Mainnet evidence must be recorded after the final transaction flow is executed on Cardano mainnet.
