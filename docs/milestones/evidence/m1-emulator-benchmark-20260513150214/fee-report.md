# DIA Oracle — Emulator Protocol-Flow Report

| Field        | Value |
|--------------|-------|
| Run id       | `20260513150214` |
| Source       | lucid-emulator |
| Generated    | 2026-05-13T15:02:19.926Z |

> Exec-units (CPU steps + memory) are captured from the same Plutus VM
> that runs on Cardano, so they are directly comparable to Preview /
> mainnet evidence. Fees are reported for reference but may differ from
> real-network fees because emulator protocol parameters can diverge
> from Preview/mainnet.

## Per-transaction resources

| Step                                             | ok   |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    |
|--------------------------------------------------|------|----------------|------------|-----------------|--------------|
| config:bootstrap                                 |   ok |         301032 |   0.301032 |        62435057 |       192880 |
| config:reference-scripts                         |   ok |         629041 |   0.629041 |               0 |            0 |
| payment-hook:bootstrap                           |   ok |         606151 |   0.606151 |       309385123 |       933989 |
| payment-hook:reference-script                    |   ok |         394257 |   0.394257 |               0 |            0 |
| receiver:bootstrap                               |   ok |         441397 |   0.441397 |        94318163 |       298004 |
| reference-scripts:publish-client                 |   ok |         815645 |   0.815645 |               0 |            0 |
| receiver:top-up:1                                |   ok |         360305 |   0.360305 |        76281672 |       245076 |
| update:usdc-usd                                  |   ok |         784208 |   0.784208 |       640498922 |      1717350 |
| update:btc-usd                                   |   ok |         784472 |   0.784472 |       640498922 |      1717350 |
| update:eth-usd                                   |   ok |         784472 |   0.784472 |       640498922 |      1717350 |
| update:ada-usd                                   |   ok |         784120 |   0.784120 |       640498922 |      1717350 |
| update:usdt-usd                                  |   ok |         784208 |   0.784208 |       640498922 |      1717350 |
| update:dai-usd                                   |   ok |         784120 |   0.784120 |       640498922 |      1717350 |
| update:sol-usd                                   |   ok |         784472 |   0.784472 |       640498922 |      1717350 |
| update:bnb-usd                                   |   ok |         784472 |   0.784472 |       640498922 |      1717350 |
| update:xrp-usd                                   |   ok |         784120 |   0.784120 |       640498922 |      1717350 |
| update:matic-usd                                 |   ok |         784301 |   0.784301 |       640580243 |      1717350 |
| update:dot-usd                                   |   ok |         784120 |   0.784120 |       640498922 |      1717350 |
| receiver:top-up:2                                |   ok |         360481 |   0.360481 |        76281672 |       245076 |
| update:batch:8                                   |   ok |        2481217 |   2.481217 |      4724128121 |     12373835 |
| settle                                           |   ok |         781556 |   0.781556 |       562697377 |      1746517 |
| receiver:withdraw                                |   ok |         391316 |   0.391316 |       162946105 |       504947 |
| payment-hook:withdraw                            |   ok |         383890 |   0.383890 |       151585769 |       466172 |
| reclaim:payment-hook-reference-script            |   ok |         314478 |   0.314478 |        39155379 |       129894 |
| republish:payment-hook-reference-script          |   ok |         394257 |   0.394257 |               0 |            0 |

## Batch attempts

| size |  ok  |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    | note |
|------|------|----------------|------------|-----------------|--------------|------|
|   10 | fail |              — |          — |               — |            — | { Complete: "failed script execution Withdraw[0] execution went over budget Mem -1493 CPU 4950113234" } |
|    9 | fail |              — |          — |               — |            — | { Complete: "failed script execution Withdraw[0] execution went over budget Mem -796 CPU 4641091157" } |
|    8 |   ok |        2481217 |   2.481217 |      4724128121 |     12373835 |  |

## Steps that did not submit a tx (init / parameterize / intent-sign)

- `protocol:init` (84ms)
- `config:parameterize` (102ms)
- `payment-hook:parameterize` (64ms)
- `client:init` (6ms)
- `receiver:parameterize` (94ms)
- `intent:create-and-sign:usdc-usd` (38ms)
- `intent:create-and-sign:btc-usd` (29ms)
- `intent:create-and-sign:eth-usd` (34ms)
- `intent:create-and-sign:ada-usd` (31ms)
- `intent:create-and-sign:usdt-usd` (29ms)
- `intent:create-and-sign:dai-usd` (28ms)
- `intent:create-and-sign:sol-usd` (34ms)
- `intent:create-and-sign:bnb-usd` (30ms)
- `intent:create-and-sign:xrp-usd` (32ms)
- `intent:create-and-sign:matic-usd` (35ms)
- `intent:create-and-sign:dot-usd` (23ms)
- `intent:create-and-sign:btc-usd:batch` (23ms)
- `intent:create-and-sign:eth-usd:batch` (24ms)
- `intent:create-and-sign:ada-usd:batch` (23ms)
- `intent:create-and-sign:usdt-usd:batch` (25ms)
- `intent:create-and-sign:dai-usd:batch` (26ms)
- `intent:create-and-sign:sol-usd:batch` (23ms)
- `intent:create-and-sign:bnb-usd:batch` (24ms)
- `intent:create-and-sign:xrp-usd:batch` (25ms)
- `intent:create-and-sign:matic-usd:batch` (23ms)
- `intent:create-and-sign:dot-usd:batch` (22ms)
- `update:batch:10` (952ms FAILED: { Complete: "failed script execution Withdraw[0] execution went over budget Mem -1493 CPU 4950113234" })
- `update:batch:9` (1007ms FAILED: { Complete: "failed script execution Withdraw[0] execution went over budget Mem -796 CPU 4641091157" })
