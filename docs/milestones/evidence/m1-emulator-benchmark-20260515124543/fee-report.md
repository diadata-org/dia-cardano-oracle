# DIA Oracle — Emulator Protocol-Flow Report

| Field        | Value |
|--------------|-------|
| Run id       | `20260515124543` |
| Source       | lucid-emulator |
| Generated    | 2026-05-15T12:46:01.853Z |

> Exec-units (CPU steps + memory) are captured from the same Plutus VM
> that runs on Cardano, so they are directly comparable to Preview /
> mainnet evidence. Fees are reported for reference but may differ from
> real-network fees because emulator protocol parameters can diverge
> from Preview/mainnet.

## Per-transaction resources

| Step                                             | ok   |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    |
|--------------------------------------------------|------|----------------|------------|-----------------|--------------|
| config:bootstrap                                 |   ok |         301032 |   0.301032 |        62435057 |       192880 |
| config:reference-scripts                         |   ok |         624949 |   0.624949 |               0 |            0 |
| payment-hook:bootstrap                           |   ok |         594183 |   0.594183 |       309385123 |       933989 |
| payment-hook:reference-script                    |   ok |         382289 |   0.382289 |               0 |            0 |
| receiver:bootstrap                               |   ok |         429649 |   0.429649 |        94318163 |       298004 |
| reference-scripts:publish-client                 |   ok |         817889 |   0.817889 |               0 |            0 |
| receiver:top-up                                  |   ok |         352295 |   0.352295 |        76281672 |       245076 |
| update:pair-1                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:1                                   |   ok |         852891 |   0.852891 |       648187488 |      1746491 |
| update:pair-2                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:2                                   |   ok |        1022940 |   1.022940 |       993815989 |      2568433 |
| update:pair-3                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:3                                   |   ok |        1196577 |   1.196577 |      1353965334 |      3434415 |
| update:pair-4                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:4                                   |   ok |        1373802 |   1.373802 |      1728635523 |      4344437 |
| update:pair-5                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:5                                   |   ok |        1565226 |   1.565226 |      2117826556 |      5298499 |
| update:pair-6                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:6                                   |   ok |        1764090 |   1.764090 |      2521538433 |      6296601 |
| update:pair-7                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:7                                   |   ok |        1973847 |   1.973847 |      2960372112 |      7439591 |
| update:pair-8                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:8                                   |   ok |        2172583 |   2.172583 |      3372524719 |      8424925 |
| update:pair-9                                    |   ok |         782457 |   0.782457 |       645226107 |      1733224 |
| update:batch:9                                   |   ok |        2391950 |   2.391950 |      3847267072 |      9689611 |
| update:pair-10                                   |   ok |         782545 |   0.782545 |       645226107 |      1733224 |
| update:batch:10                                  |   ok |        2613824 |   2.613824 |      4312495818 |     10880681 |
| update:pair-11                                   |   ok |         782545 |   0.782545 |       645226107 |      1733224 |
| update:batch:11                                  |   ok |        2837115 |   2.837115 |      4757910478 |     11947711 |
| update:pair-12                                   |   ok |         782545 |   0.782545 |       645226107 |      1733224 |
| update:batch:12                                  |   ok |        3088342 |   3.088342 |      5286515842 |     13394941 |
| update:pair-13                                   |   ok |         782545 |   0.782545 |       645226107 |      1733224 |
| settle                                           |   ok |         760029 |   0.760029 |       548427494 |      1695687 |
| receiver:withdraw                                |   ok |         383244 |   0.383244 |       162802105 |       504047 |
| payment-hook:withdraw                            |   ok |         374890 |   0.374890 |       149604079 |       454090 |
| reclaim:payment-hook-reference-script            |   ok |         310398 |   0.310398 |        39155379 |       129894 |
| republish:payment-hook-reference-script          |   ok |         382289 |   0.382289 |               0 |            0 |
| pair:burn:pair-13                                |   ok |         436227 |   0.436227 |       140241544 |       447965 |

## Batch attempts

| size |  ok  |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    | note |
|------|------|----------------|------------|-----------------|--------------|------|
|    1 |   ok |         852891 |   0.852891 |       648187488 |      1746491 |  |
|    2 |   ok |        1022940 |   1.022940 |       993815989 |      2568433 |  |
|    3 |   ok |        1196577 |   1.196577 |      1353965334 |      3434415 |  |
|    4 |   ok |        1373802 |   1.373802 |      1728635523 |      4344437 |  |
|    5 |   ok |        1565226 |   1.565226 |      2117826556 |      5298499 |  |
|    6 |   ok |        1764090 |   1.764090 |      2521538433 |      6296601 |  |
|    7 |   ok |        1973847 |   1.973847 |      2960372112 |      7439591 |  |
|    8 |   ok |        2172583 |   2.172583 |      3372524719 |      8424925 |  |
|    9 |   ok |        2391950 |   2.391950 |      3847267072 |      9689611 |  |
|   10 |   ok |        2613824 |   2.613824 |      4312495818 |     10880681 |  |
|   11 |   ok |        2837115 |   2.837115 |      4757910478 |     11947711 |  |
|   12 |   ok |        3088342 |   3.088342 |      5286515842 |     13394941 |  |
|   13 | fail |              — |          — |               — |            — | { Complete: "failed script execution Withdraw[0] execution went over budget Mem -1215 CPU 4400532576" } |

## Steps that did not submit a tx (init / parameterize / intent-sign)

- `protocol:init` (130ms)
- `config:parameterize` (150ms)
- `payment-hook:parameterize` (94ms)
- `client:init` (5ms)
- `receiver:parameterize` (123ms)
- `intent:create-and-sign:pair-1` (58ms)
- `intent:create-and-sign:pair-1:batch-1` (40ms)
- `intent:create-and-sign:pair-2` (39ms)
- `intent:create-and-sign:pair-1:batch-2` (43ms)
- `intent:create-and-sign:pair-2:batch-2` (38ms)
- `intent:create-and-sign:pair-3` (37ms)
- `intent:create-and-sign:pair-1:batch-3` (41ms)
- `intent:create-and-sign:pair-2:batch-3` (36ms)
- `intent:create-and-sign:pair-3:batch-3` (36ms)
- `intent:create-and-sign:pair-4` (36ms)
- `intent:create-and-sign:pair-1:batch-4` (36ms)
- `intent:create-and-sign:pair-2:batch-4` (36ms)
- `intent:create-and-sign:pair-3:batch-4` (36ms)
- `intent:create-and-sign:pair-4:batch-4` (36ms)
- `intent:create-and-sign:pair-5` (39ms)
- `intent:create-and-sign:pair-1:batch-5` (39ms)
- `intent:create-and-sign:pair-2:batch-5` (38ms)
- `intent:create-and-sign:pair-3:batch-5` (38ms)
- `intent:create-and-sign:pair-4:batch-5` (39ms)
- `intent:create-and-sign:pair-5:batch-5` (40ms)
- `intent:create-and-sign:pair-6` (43ms)
- `intent:create-and-sign:pair-1:batch-6` (41ms)
- `intent:create-and-sign:pair-2:batch-6` (40ms)
- `intent:create-and-sign:pair-3:batch-6` (42ms)
- `intent:create-and-sign:pair-4:batch-6` (39ms)
- `intent:create-and-sign:pair-5:batch-6` (40ms)
- `intent:create-and-sign:pair-6:batch-6` (41ms)
- `intent:create-and-sign:pair-7` (42ms)
- `intent:create-and-sign:pair-1:batch-7` (40ms)
- `intent:create-and-sign:pair-2:batch-7` (41ms)
- `intent:create-and-sign:pair-3:batch-7` (39ms)
- `intent:create-and-sign:pair-4:batch-7` (39ms)
- `intent:create-and-sign:pair-5:batch-7` (40ms)
- `intent:create-and-sign:pair-6:batch-7` (40ms)
- `intent:create-and-sign:pair-7:batch-7` (38ms)
- `intent:create-and-sign:pair-8` (43ms)
- `intent:create-and-sign:pair-1:batch-8` (41ms)
- `intent:create-and-sign:pair-2:batch-8` (39ms)
- `intent:create-and-sign:pair-3:batch-8` (40ms)
- `intent:create-and-sign:pair-4:batch-8` (40ms)
- `intent:create-and-sign:pair-5:batch-8` (40ms)
- `intent:create-and-sign:pair-6:batch-8` (41ms)
- `intent:create-and-sign:pair-7:batch-8` (40ms)
- `intent:create-and-sign:pair-8:batch-8` (40ms)
- `intent:create-and-sign:pair-9` (43ms)
- `intent:create-and-sign:pair-1:batch-9` (42ms)
- `intent:create-and-sign:pair-2:batch-9` (46ms)
- `intent:create-and-sign:pair-3:batch-9` (39ms)
- `intent:create-and-sign:pair-4:batch-9` (39ms)
- `intent:create-and-sign:pair-5:batch-9` (41ms)
- `intent:create-and-sign:pair-6:batch-9` (40ms)
- `intent:create-and-sign:pair-7:batch-9` (39ms)
- `intent:create-and-sign:pair-8:batch-9` (39ms)
- `intent:create-and-sign:pair-9:batch-9` (39ms)
- `intent:create-and-sign:pair-10` (40ms)
- `intent:create-and-sign:pair-1:batch-10` (39ms)
- `intent:create-and-sign:pair-2:batch-10` (39ms)
- `intent:create-and-sign:pair-3:batch-10` (38ms)
- `intent:create-and-sign:pair-4:batch-10` (38ms)
- `intent:create-and-sign:pair-5:batch-10` (38ms)
- `intent:create-and-sign:pair-6:batch-10` (38ms)
- `intent:create-and-sign:pair-7:batch-10` (39ms)
- `intent:create-and-sign:pair-8:batch-10` (37ms)
- `intent:create-and-sign:pair-9:batch-10` (37ms)
- `intent:create-and-sign:pair-10:batch-10` (37ms)
- `intent:create-and-sign:pair-11` (40ms)
- `intent:create-and-sign:pair-1:batch-11` (38ms)
- `intent:create-and-sign:pair-2:batch-11` (42ms)
- `intent:create-and-sign:pair-3:batch-11` (39ms)
- `intent:create-and-sign:pair-4:batch-11` (40ms)
- `intent:create-and-sign:pair-5:batch-11` (38ms)
- `intent:create-and-sign:pair-6:batch-11` (38ms)
- `intent:create-and-sign:pair-7:batch-11` (38ms)
- `intent:create-and-sign:pair-8:batch-11` (38ms)
- `intent:create-and-sign:pair-9:batch-11` (39ms)
- `intent:create-and-sign:pair-10:batch-11` (40ms)
- `intent:create-and-sign:pair-11:batch-11` (40ms)
- `intent:create-and-sign:pair-12` (63ms)
- `intent:create-and-sign:pair-1:batch-12` (41ms)
- `intent:create-and-sign:pair-2:batch-12` (41ms)
- `intent:create-and-sign:pair-3:batch-12` (40ms)
- `intent:create-and-sign:pair-4:batch-12` (40ms)
- `intent:create-and-sign:pair-5:batch-12` (41ms)
- `intent:create-and-sign:pair-6:batch-12` (40ms)
- `intent:create-and-sign:pair-7:batch-12` (40ms)
- `intent:create-and-sign:pair-8:batch-12` (40ms)
- `intent:create-and-sign:pair-9:batch-12` (40ms)
- `intent:create-and-sign:pair-10:batch-12` (40ms)
- `intent:create-and-sign:pair-11:batch-12` (39ms)
- `intent:create-and-sign:pair-12:batch-12` (39ms)
- `intent:create-and-sign:pair-13` (43ms)
- `intent:create-and-sign:pair-1:batch-13` (41ms)
- `intent:create-and-sign:pair-2:batch-13` (41ms)
- `intent:create-and-sign:pair-3:batch-13` (40ms)
- `intent:create-and-sign:pair-4:batch-13` (42ms)
- `intent:create-and-sign:pair-5:batch-13` (41ms)
- `intent:create-and-sign:pair-6:batch-13` (42ms)
- `intent:create-and-sign:pair-7:batch-13` (44ms)
- `intent:create-and-sign:pair-8:batch-13` (40ms)
- `intent:create-and-sign:pair-9:batch-13` (45ms)
- `intent:create-and-sign:pair-10:batch-13` (40ms)
- `intent:create-and-sign:pair-11:batch-13` (44ms)
- `intent:create-and-sign:pair-12:batch-13` (42ms)
- `intent:create-and-sign:pair-13:batch-13` (39ms)
- `update:batch:13` (1745ms FAILED: { Complete: "failed script execution Withdraw[0] execution went over budget Mem -1215 CPU 4400532576" })
