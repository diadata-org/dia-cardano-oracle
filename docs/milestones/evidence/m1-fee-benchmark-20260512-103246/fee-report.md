# DIA Oracle — Fee Benchmark Report

| Field        | Value |
|--------------|-------|
| Bench run    | `20260512-103246` |
| Base state   | `20260511-135140` |
| Cycles       | 3 |
| Generated    | 2026-05-12T11:44:18.486Z |

## Network Fee Summary (lovelace / ADA)

> On-chain transaction fees paid to Cardano. Protocol fees are separate and currently use 0.6 ADA + 0.4 ADA × N pairs.

| Operation  | Samples | Avg (lovelace) | Avg (ADA)  | Min (lovelace) | Max (lovelace) |
|------------|---------|----------------|------------|----------------|----------------|
| update-1   |       3 |         854724 |   0.854724 |         853525 |         855324 |
| batch-1    |       3 |         865920 |   0.865920 |         865920 |         865920 |
| batch-2    |       3 |        1082379 |   1.082379 |        1082379 |        1082379 |
| batch-3    |       3 |        1317708 |   1.317708 |        1316694 |        1319735 |
| batch-4    |       3 |        1575986 |   1.575986 |        1574765 |        1578427 |
| batch-5    |       3 |        1859723 |   1.859723 |        1856868 |        1861151 |
| batch-6    |       3 |        2173798 |   2.173798 |        2170528 |        2175433 |
| batch-7    |       3 |        2505438 |   2.505438 |        2505438 |        2505438 |

## Execution Units

> CPU steps and memory units consumed per transaction (Plutus budget).

| Operation  |       Avg CPU |       Min CPU |       Max CPU |    Avg Mem |    Min Mem |    Max Mem |
|------------|---------------|---------------|---------------|------------|------------|------------|
| update-1   |       755004963 |       750511736 |       757251577 |      2079447 |      2064274 |      2087034 |
| batch-1    |       795889084 |       795889084 |       795889084 |      2220870 |      2220870 |      2220870 |
| batch-2    |      1353331545 |      1353331545 |      1353331545 |      3721103 |      3721103 |      3721103 |
| batch-3    |      1984229621 |      1979663073 |      1993362716 |      5462671 |      5450808 |      5486396 |
| batch-4    |      2704529568 |      2698803053 |      2715982597 |      7488748 |      7474747 |      7516749 |
| batch-5    |      3514304706 |      3500531743 |      3521191188 |      9796023 |      9763746 |      9812162 |
| batch-6    |      4400942040 |      4384849143 |      4408988489 |     12354358 |     12317805 |     12372635 |
| batch-7    |      5351755253 |      5351755253 |      5351755253 |     15136924 |     15136924 |     15136924 |

## Cardano Budget Limits & Utilization

> Per-tx execution unit limits on Cardano Preview.

| Resource | Limit            | batch-7 avg    | batch-7 % used |
|----------|-----------------|----------------|----------------|
| CPU      | 10,000,000,000  |  5,351,755,253 |         53.5% |
| Memory   | 16,000,000      |     15,136,924 |        **94.6%** |

Memory is the binding constraint. batch-7 sits at ~94.6% of the memory limit — the preview run showed batch-8 and above fail.

## Fee Estimation Model

Linear regression over batch-1 … batch-7 data (least squares):

```
fee (lovelace) ≈ 533,935 + 272,979 × N
fee (ADA)      ≈ 0.5339  +  0.2730 × N
```

where N = number of pairs in the batch.

### Predicted fees for N = 1 … 10

| N  | Predicted (lovelace) | Predicted (ADA) | Actual avg (ADA) | Error     |
|----|----------------------|-----------------|------------------|-----------|
|  1 |              806,914 |        0.806914 |         0.865920 |   +59,006 |
|  2 |            1,079,893 |        1.079893 |         1.082379 |    +2,486 |
|  3 |            1,352,871 |        1.352871 |         1.317708 |   -35,163 |
|  4 |            1,625,850 |        1.625850 |         1.575986 |   -49,864 |
|  5 |            1,898,829 |        1.898829 |         1.859723 |   -39,106 |
|  6 |            2,171,808 |        2.171808 |         2.173798 |    +1,990 |
|  7 |            2,444,787 |        2.444787 |         2.505438 |   +60,651 |
|  8 |            2,717,766 |        2.717766 |    *(mem limit)* |         — |
|  9 |            2,990,744 |        2.990744 |    *(mem limit)* |         — |
| 10 |            3,263,723 |        3.263723 |    *(mem limit)* |         — |

The model fits with max ~61K lovelace (~0.061 ADA) error — acceptable for fee estimation.

## Protocol Fee Design Options

> Two separate fee flows:
> - **Network fee** (measured in this benchmark): paid by the DIA oracle wallet to the Cardano network for each submitted transaction.
> - **Protocol fee** (`PROTOCOL_FEE_LOVELACE = 2,000,000` = 2 ADA × N pairs): charged by the DIA protocol to the client, deducted from the client's receiver and accumulated in the payment hook.
>
> The table below compares options for the **protocol fee** design, using the measured network fees as the cost baseline.

| Model | Formula | Example: 1 pair | Example: 7 pairs | Notes |
|-------|---------|-----------------|------------------|-------|
| **Flat per-pair** | 2 ADA × N | 2 ADA | 14 ADA | Simple; over-collects at scale |
| **Base + per-pair** (current) | 0.6 + 0.40 × N ADA | 1.00 ADA | 3.40 ADA | Tracks real cost closely |

## Notes

- `update-1` — single oracle price update (1 pair: BTC/USD).
- `batch-N` — N simultaneous price updates in one transaction (pairs: BTC/USD … up to BNB/USD).
- Data collected on Cardano **preview** testnet.
