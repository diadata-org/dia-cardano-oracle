// Parse Alertmanager's webhook payload into normalized alert events the feeder
// can record in `alert_log`. Pure: no I/O, so it is fully unit-tested.

export type AlertmanagerAlert = {
  status?: string;
  fingerprint?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
};

export type AlertmanagerWebhook = {
  alerts?: AlertmanagerAlert[];
};

export type AlertSeverity = "info" | "warning" | "critical";

export type NormalizedAlert = {
  fingerprint: string;
  name: string;
  severity: AlertSeverity;
  message: string;
  labels: Record<string, string>;
  status: "firing" | "resolved";
};

export type AlertIngestDeps = {
  /** Active (unresolved) alerts with the fingerprint they were recorded under. */
  listActiveFingerprints: () => Promise<Array<{ id: number; fingerprint: string }>>;
  record: (alert: NormalizedAlert) => Promise<number>;
  resolve: (id: number, resolvedAtMs: number) => Promise<void>;
  nowMs: number;
};

/**
 * Apply a batch of normalized alerts to the alert log: record each firing alert
 * not already active, resolve each active alert that has cleared, and skip the
 * rest. Dedup/match is by fingerprint, so Alertmanager re-sending the same
 * firing alert does not create duplicate rows.
 */
export async function ingestNormalizedAlerts(
  alerts: NormalizedAlert[],
  deps: AlertIngestDeps,
): Promise<{ recorded: number; resolved: number; skipped: number }> {
  const activeByFingerprint = new Map(
    (await deps.listActiveFingerprints()).map((a) => [a.fingerprint, a.id]),
  );

  let recorded = 0;
  let resolved = 0;
  let skipped = 0;

  for (const alert of alerts) {
    const activeId = activeByFingerprint.get(alert.fingerprint);
    if (alert.status === "firing") {
      if (activeId !== undefined) {
        skipped++;
        continue;
      }
      await deps.record(alert);
      recorded++;
    } else {
      if (activeId === undefined) {
        skipped++;
        continue;
      }
      await deps.resolve(activeId, deps.nowMs);
      resolved++;
    }
  }

  return { recorded, resolved, skipped };
}

function toSeverity(raw: string | undefined): AlertSeverity {
  return raw === "info" || raw === "warning" || raw === "critical" ? raw : "warning";
}

export function normalizeAlertmanagerWebhook(payload: AlertmanagerWebhook): NormalizedAlert[] {
  const alerts = payload.alerts ?? [];
  return alerts.map((alert) => {
    const labels = alert.labels ?? {};
    const annotations = alert.annotations ?? {};
    const name = labels.alertname ?? "unknown";
    return {
      fingerprint: alert.fingerprint ?? name,
      name,
      severity: toSeverity(labels.severity),
      message: annotations.summary ?? annotations.description ?? name,
      labels,
      status: alert.status === "resolved" ? "resolved" : "firing",
    };
  });
}
