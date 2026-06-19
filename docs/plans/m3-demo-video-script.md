# Guion del video demo — Milestone 3 (~3-4 min)

**Antes de grabar:** abrí Grafana en `http://localhost:3000` (admin / tu pass), dashboard **"DIA Cardano Oracle Feeder"**. Tené una terminal lista.

## 1. Dashboards en vivo (Grafana) — ~60s

Mostrá el dashboard overview y señalá estos panels (nombres exactos):

- **"Confirmed oracle updates (selected range, per pair)"** → ARS/USDT con el número **subiendo** = el oráculo está vivo confirmando en mainnet (liveness).
- **"Cardano provider health — primary vs secondary"** → blockfrost + koios en **verde/UP**.
- **"Pair staleness (per symbol)"** → ARS/USDT con staleness **baja** (el valor on-chain está fresco).
- **"Symbol-update latency (p50/p95/p99)"** → **eso es "latencia"**: el tiempo desde que el feeder recibe el precio de DIA hasta que se confirma en Cardano (mediana / p95 / p99, en segundos). Es la velocidad del oráculo.

## 2. Logs mainnet en vivo (terminal) — ~30s

```bash
docker logs -f --tail 30 dia-feeder-mainnet-feeder-sqlite-1 2>&1 \
  | grep --line-buffered -iE 'ARS/USDT|submit:|Confirmed by Blockfrost|cron-service'
```

Se ve el ciclo real: `cron-service: resubmitting ARS/USDT` → `submit: … ARS/USDT` → `Confirmed by Blockfrost … ARS/USDT`. (Prueba que procesa feeds en vivo.)

## 3. Feed health / accuracy (terminal) — ~30s

```bash
cd offchain/feeder && CARDANO_NETWORK=Mainnet npm run sanity:feeds
```

El `CARDANO_NETWORK=Mainnet` es obligatorio (si no, default Preview). Muestra ARS/USDT: valor on-chain vs fuente DIA, deviation %, staleness → **PASS**. (Prueba accuracy.)

## 4. Alerta firing→resolving (terminal + Grafana) — ~60s

```bash
cd offchain/feeder && scripts/monitoring/trigger-alert-demo.sh OraclePairStale
```

(OraclePairStale es la más rápida.) En Grafana/Alertmanager se ve la alerta ponerse en **firing (rojo)** → el script la **resuelve** → vuelve a verde. El script captura la entrada en el `alert_log` del feeder. (Prueba "anomalies trigger automatic alerts".)

## 5. Prueba on-chain real (browser) — ~20s

Abrí en Cardanoscan **mainnet** una tx confirmada de ARS/USDT:

```
https://cardanoscan.io/transaction/31dc1efb2789b6502cfe8c1312a56562e6522a8b97525c5ad53977f0532cd78e
```

Muestra que es una tx real en Cardano mainnet (no test).
