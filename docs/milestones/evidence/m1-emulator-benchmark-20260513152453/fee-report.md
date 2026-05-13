# DIA Oracle — Emulator Protocol-Flow Report

| Field        | Value |
|--------------|-------|
| Run id       | `20260513152453` |
| Source       | lucid-emulator |
| Generated    | 2026-05-13T15:24:59.020Z |

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
| payment-hook:bootstrap                           |   ok |         607443 |   0.607443 |       314040290 |       950565 |
| payment-hook:reference-script                    |   ok |         394257 |   0.394257 |               0 |            0 |
| receiver:bootstrap                               |   ok |         441397 |   0.441397 |        94318163 |       298004 |
| reference-scripts:publish-client                 |   ok |         815645 |   0.815645 |               0 |            0 |
| receiver:top-up:1                                |   ok |         360737 |   0.360737 |        78907149 |       249270 |
| update:usdc-usd                                  |   ok |         782813 |   0.782813 |       640498922 |      1717350 |
| update:btc-usd                                   |   ok |         783077 |   0.783077 |       640498922 |      1717350 |
| update:eth-usd                                   |   ok |         783077 |   0.783077 |       640498922 |      1717350 |
| update:ada-usd                                   |   ok |         782725 |   0.782725 |       640498922 |      1717350 |
| update:usdt-usd                                  |   ok |         782813 |   0.782813 |       640498922 |      1717350 |
| update:dai-usd                                   |   ok |         782725 |   0.782725 |       640498922 |      1717350 |
| update:sol-usd                                   |   ok |         783077 |   0.783077 |       640498922 |      1717350 |
| update:bnb-usd                                   |   ok |         783077 |   0.783077 |       640498922 |      1717350 |
| update:xrp-usd                                   |   ok |         782725 |   0.782725 |       640498922 |      1717350 |
| update:matic-usd                                 |   ok |         782906 |   0.782906 |       640580243 |      1717350 |
| update:dot-usd                                   |   ok |         782725 |   0.782725 |       640498922 |      1717350 |
| receiver:top-up:2                                |   ok |         360481 |   0.360481 |        76281672 |       245076 |
| update:batch:9                                   |   ok |        2698997 |   2.698997 |      5180605635 |     13706074 |
| settle                                           |   ok |         778291 |   0.778291 |       554680284 |      1724121 |
| receiver:withdraw                                |   ok |         391316 |   0.391316 |       162946105 |       504947 |
| payment-hook:withdraw                            |   ok |         383890 |   0.383890 |       151585769 |       466172 |
| reclaim:payment-hook-reference-script            |   ok |         314478 |   0.314478 |        39155379 |       129894 |
| republish:payment-hook-reference-script          |   ok |         394257 |   0.394257 |               0 |            0 |

## Batch attempts

| size |  ok  |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    | note |
|------|------|----------------|------------|-----------------|--------------|------|
|   10 | fail |              — |          — |               — |            — | { Complete: "failed script execution Withdraw[0] execution went over budget Mem -6184 CPU 4923689148" } |
|    9 |   ok |        2698997 |   2.698997 |      5180605635 |     13706074 |  |

## Steps that did not submit a tx (init / parameterize / intent-sign)

- `protocol:init` (100ms)
- `config:parameterize` (104ms)
- `payment-hook:parameterize` (75ms)
- `client:init` (5ms)
- `receiver:parameterize` (108ms)
- `intent:create-and-sign:usdc-usd` (43ms)
- `intent:create-and-sign:btc-usd` (28ms)
- `intent:create-and-sign:eth-usd` (27ms)
- `intent:create-and-sign:ada-usd` (36ms)
- `intent:create-and-sign:usdt-usd` (33ms)
- `intent:create-and-sign:dai-usd` (33ms)
- `intent:create-and-sign:sol-usd` (39ms)
- `intent:create-and-sign:bnb-usd` (41ms)
- `intent:create-and-sign:xrp-usd` (29ms)
- `intent:create-and-sign:matic-usd` (29ms)
- `intent:create-and-sign:dot-usd` (29ms)
- `intent:create-and-sign:btc-usd:batch` (30ms)
- `intent:create-and-sign:eth-usd:batch` (29ms)
- `intent:create-and-sign:ada-usd:batch` (28ms)
- `intent:create-and-sign:usdt-usd:batch` (28ms)
- `intent:create-and-sign:dai-usd:batch` (29ms)
- `intent:create-and-sign:sol-usd:batch` (28ms)
- `intent:create-and-sign:bnb-usd:batch` (27ms)
- `intent:create-and-sign:xrp-usd:batch` (27ms)
- `intent:create-and-sign:matic-usd:batch` (26ms)
- `intent:create-and-sign:dot-usd:batch` (29ms)
- `update:batch:10` (1109ms FAILED: { Complete: "failed script execution Withdraw[0] execution went over budget Mem -6184 CPU 4923689148" })
