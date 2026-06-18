# Alert-trigger logs — Preview

Each alert below was fired by pushing a synthetic value for its metric to the
Pushgateway (`trigger-alert.sh`). The value crosses the real threshold from
`monitoring/alerts.yml`, so the genuine rule fires and flows through the live
pipeline (Prometheus → Alertmanager → feeder webhook → `alert_log`). Only the
input metric is synthetic; the rules, routing, and recording are production.

Run stamp: **20260618-063047** · Prometheus: http://localhost:9090 · feeder: http://localhost:8080

| Alert | Pushed at | Reached `firing` | Cleared at | Resolved | Prometheus | alert_log |
| --- | --- | --- | --- | --- | --- | --- |
| OraclePairStale | 2026-06-18T06:30:47Z | 0s | 2026-06-18T06:30:50Z | yes (15s) | [`OraclePairStale-prometheus.json`](OraclePairStale-prometheus.json) | [`OraclePairStale-alertlog.json`](OraclePairStale-alertlog.json) |
| ReceiverBalanceLow | 2026-06-18T06:31:05Z | 360s | 2026-06-18T06:37:14Z | yes (55s) | [`ReceiverBalanceLow-prometheus.json`](ReceiverBalanceLow-prometheus.json) | [`ReceiverBalanceLow-alertlog.json`](ReceiverBalanceLow-alertlog.json) |
| FeedAccuracyFail | 2026-06-18T06:38:09Z | 655s | 2026-06-18T06:49:16Z | yes (60s) | [`FeedAccuracyFail-prometheus.json`](FeedAccuracyFail-prometheus.json) | [`FeedAccuracyFail-alertlog.json`](FeedAccuracyFail-alertlog.json) |
| SettleOverdue | 2026-06-18T06:50:17Z | not within 720s | 2026-06-18T07:02:29Z | yes (0s) | [`SettleOverdue-prometheus.json`](SettleOverdue-prometheus.json) | [`SettleOverdue-alertlog.json`](SettleOverdue-alertlog.json) |
| ReceiverDepositsPending | 2026-06-18T07:02:30Z | 645s | 2026-06-18T07:13:26Z | yes (60s) | [`ReceiverDepositsPending-prometheus.json`](ReceiverDepositsPending-prometheus.json) | [`ReceiverDepositsPending-alertlog.json`](ReceiverDepositsPending-alertlog.json) |
