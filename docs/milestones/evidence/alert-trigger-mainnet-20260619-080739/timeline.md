# Alert-trigger logs — Mainnet

Each alert below was fired by pushing a synthetic value for its metric to the
Pushgateway (`trigger-alert.sh`). The value crosses the real threshold from
`monitoring/alerts.yml`, so the genuine rule fires and flows through the live
pipeline (Prometheus → Alertmanager → feeder webhook → `alert_log`). Only the
input metric is synthetic; the rules, routing, and recording are production.

Run stamp: **20260619-080739** · Prometheus: http://localhost:9090 · feeder: http://localhost:8080

| Alert | Pushed at | Reached `firing` | Cleared at | Resolved | Prometheus | alert_log |
| --- | --- | --- | --- | --- | --- | --- |
| OraclePairStale | 2026-06-19T08:07:39Z | 325s | 2026-06-19T08:12:55Z | yes (120s) | [`OraclePairStale-prometheus.json`](OraclePairStale-prometheus.json) | [`OraclePairStale-alertlog.json`](OraclePairStale-alertlog.json) |
