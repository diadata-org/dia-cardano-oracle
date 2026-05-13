# DIA Oracle — Emulator Protocol-Flow Report

| Field        | Value |
|--------------|-------|
| Run id       | `20260513163243` |
| Source       | lucid-emulator |
| Generated    | 2026-05-13T16:32:46.879Z |

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
| payment-hook:bootstrap                           |   ok |         595515 |   0.595515 |       314213248 |       951027 |
| payment-hook:reference-script                    |   ok |         382289 |   0.382289 |               0 |            0 |
| receiver:bootstrap                               |   ok |         429649 |   0.429649 |        94318163 |       298004 |
| reference-scripts:publish-client                 |   ok |         791753 |   0.791753 |               0 |            0 |
| receiver:top-up:1                                |   ok |         352295 |   0.352295 |        76281672 |       245076 |
| update:usdc-usd                                  |   ok |         774518 |   0.774518 |       654416423 |      1766778 |
| update:btc-usd                                   |   ok |         774782 |   0.774782 |       654416423 |      1766778 |
| update:eth-usd                                   |   ok |         774782 |   0.774782 |       654416423 |      1766778 |
| update:ada-usd                                   |   ok |         774430 |   0.774430 |       654416423 |      1766778 |
| update:usdt-usd                                  |   ok |         774518 |   0.774518 |       654416423 |      1766778 |
| update:dai-usd                                   |   ok |         774430 |   0.774430 |       654416423 |      1766778 |
| update:sol-usd                                   |   ok |         774782 |   0.774782 |       654416423 |      1766778 |
| update:bnb-usd                                   |   ok |         774782 |   0.774782 |       654416423 |      1766778 |
| update:xrp-usd                                   |   ok |         774430 |   0.774430 |       654416423 |      1766778 |
| update:matic-usd                                 |   ok |         774612 |   0.774612 |       654497744 |      1766778 |
| update:dot-usd                                   |   ok |         774430 |   0.774430 |       654416423 |      1766778 |
| receiver:top-up:2                                |   ok |         352471 |   0.352471 |        76281672 |       245076 |
| update:batch:10                                  |   ok |        2549875 |   2.549875 |      4340560764 |     10948717 |
| settle                                           |   ok |         761895 |   0.761895 |       553885986 |      1721195 |
| receiver:withdraw                                |   ok |         383244 |   0.383244 |       162802105 |       504047 |
| payment-hook:withdraw                            |   ok |         374420 |   0.374420 |       146805644 |       449434 |
| reclaim:payment-hook-reference-script            |   ok |         310398 |   0.310398 |        39155379 |       129894 |
| republish:payment-hook-reference-script          |   ok |         382289 |   0.382289 |               0 |            0 |

## Batch attempts

| size |  ok  |  fee (lovelace) | fee (ADA)  |         cpu     |      mem    | note |
|------|------|----------------|------------|-----------------|--------------|------|
|   10 |   ok |        2549875 |   2.549875 |      4340560764 |     10948717 |  |

## Steps that did not submit a tx (init / parameterize / intent-sign)

- `protocol:init` (105ms)
- `config:parameterize` (117ms)
- `payment-hook:parameterize` (65ms)
- `client:init` (4ms)
- `receiver:parameterize` (89ms)
- `intent:create-and-sign:usdc-usd` (44ms)
- `intent:create-and-sign:btc-usd` (28ms)
- `intent:create-and-sign:eth-usd` (36ms)
- `intent:create-and-sign:ada-usd` (30ms)
- `intent:create-and-sign:usdt-usd` (30ms)
- `intent:create-and-sign:dai-usd` (30ms)
- `intent:create-and-sign:sol-usd` (36ms)
- `intent:create-and-sign:bnb-usd` (31ms)
- `intent:create-and-sign:xrp-usd` (26ms)
- `intent:create-and-sign:matic-usd` (28ms)
- `intent:create-and-sign:dot-usd` (24ms)
- `intent:create-and-sign:btc-usd:batch` (27ms)
- `intent:create-and-sign:eth-usd:batch` (25ms)
- `intent:create-and-sign:ada-usd:batch` (28ms)
- `intent:create-and-sign:usdt-usd:batch` (23ms)
- `intent:create-and-sign:dai-usd:batch` (26ms)
- `intent:create-and-sign:sol-usd:batch` (27ms)
- `intent:create-and-sign:bnb-usd:batch` (27ms)
- `intent:create-and-sign:xrp-usd:batch` (24ms)
- `intent:create-and-sign:matic-usd:batch` (26ms)
- `intent:create-and-sign:dot-usd:batch` (24ms)
