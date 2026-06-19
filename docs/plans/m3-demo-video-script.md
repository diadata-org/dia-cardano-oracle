# Demo video script — Milestone 3 (~3-4 min)

**Before recording:** open Grafana at `http://localhost:3000` (admin / your pass),
dashboard **"DIA Cardano Oracle Feeder"**. Have a terminal ready.

## 1. Live dashboards (Grafana) — ~60s

Show the overview dashboard and point at these panels (exact titles):

- **"Confirmed oracle updates (selected range, per pair)"** → ARS/USDT with the count
  **climbing** = the oracle is live, confirming on mainnet (liveness).
- **"Cardano provider health — primary vs secondary"** → blockfrost + koios **green/UP**.
- **"Pair staleness (per symbol)"** → ARS/USDT with **low** staleness (the on-chain value
  is fresh).
- **"Symbol-update latency (p50/p95/p99)"** → this is "latency": the time from when the
  feeder receives the DIA price to when it is confirmed on Cardano (median / p95 / p99, in
  seconds). It is the oracle's speed.

## 2. Live mainnet logs (terminal) — ~30s

`docker logs` only carries high-level events (startup, cron, submit, confirm) — these are
rare, so it barely moves. The real-time activity (the scanner reading the DIA chain every
few seconds) goes to the **log file**, which is the one that moves:

```bash
tail -f offchain/state/mainnet_run_20260616-074413/logs/feeder.log \
  | grep --line-buffered -iE 'scanner-http|scanner-ws|ARS/USDT|submit:|Confirmed by Blockfrost|cron-service'
```

You see the `scanner-http`/`scanner-ws` lines streaming (the feeder scanning the DIA source
live) and, when due, the ARS/USDT cycle: `submit: … ARS/USDT` →
`Confirmed by Blockfrost … ARS/USDT`. (Proves it processes feeds in real time.)

## 3. Feed health / accuracy (terminal) — ~30s

```bash
cd offchain/feeder && CARDANO_NETWORK=Mainnet npm run sanity:feeds
```

The `CARDANO_NETWORK=Mainnet` is required (otherwise it defaults to Preview). Shows
ARS/USDT: on-chain value vs DIA source, deviation %, staleness → **PASS**. (Proves accuracy.)

## 4. Alert firing → resolving (terminal + Grafana) — ~60s

```bash
cd offchain/feeder && scripts/monitoring/trigger-alert-demo.sh OraclePairStale
```

(OraclePairStale is the fastest.) In Grafana/Alertmanager you see the alert go to
**firing (red)** → the script **resolves** it → it goes back to green. The script captures
the entry in the feeder's `alert_log`. (Proves "anomalies trigger automatic alerts".)

## 5. Real on-chain proof (browser) — ~20s

Open a confirmed ARS/USDT transaction on Cardanoscan **mainnet**:

```
https://cardanoscan.io/transaction/31dc1efb2789b6502cfe8c1312a56562e6522a8b97525c5ad53977f0532cd78e
```

Shows it is a real transaction on Cardano mainnet (not test).
