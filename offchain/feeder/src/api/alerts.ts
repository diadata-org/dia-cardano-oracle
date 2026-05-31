// Alerts API builders.
//
//   GET /api/v1/alerts       — list alerts (optionally filtered by active status)
//   GET /api/v1/alerts/:id   — single alert by id
//   POST /api/v1/alerts/:id/ack — acknowledge an alert

import type { AlertLogRow } from "../persistence/index.js";

export type AlertEntry = {
  id: number;
  alertName: string;
  severity: string;
  message: string;
  labels: Record<string, string>;
  firedAtMs: number;
  resolvedAtMs?: number;
  acknowledged: boolean;
};

export type AlertsResponse = {
  count: number;
  alerts: AlertEntry[];
};

function toAlertEntry(row: AlertLogRow): AlertEntry {
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(row.labelsJson) as Record<string, string>;
  } catch {
    labels = {};
  }
  return {
    id: row.id,
    alertName: row.alertName,
    severity: row.severity,
    message: row.message,
    labels,
    firedAtMs: row.firedAtMs,
    resolvedAtMs: row.resolvedAtMs,
    acknowledged: row.acknowledged,
  };
}

export function buildAlertsResponse(rows: AlertLogRow[]): AlertsResponse {
  return {
    count: rows.length,
    alerts: rows.map(toAlertEntry),
  };
}

export function buildAlertResponse(row: AlertLogRow | null): AlertEntry | null {
  if (!row) return null;
  return toAlertEntry(row);
}
