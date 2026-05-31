// Performance API builder.
//
//   GET /api/v1/performance — query performance_metrics table

import type { PerformanceMetricRow } from "../persistence/index.js";

export type PerformanceEntry = {
  id: number;
  metricName: string;
  metricValue: number;
  labels: Record<string, string>;
  recordedAtMs: number;
};

export type PerformanceResponse = {
  count: number;
  metrics: PerformanceEntry[];
};

function toPerformanceEntry(row: PerformanceMetricRow): PerformanceEntry {
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(row.labelsJson) as Record<string, string>;
  } catch {
    labels = {};
  }
  return {
    id: row.id,
    metricName: row.metricName,
    metricValue: row.metricValue,
    labels,
    recordedAtMs: row.recordedAtMs,
  };
}

export function buildPerformanceResponse(rows: PerformanceMetricRow[]): PerformanceResponse {
  return {
    count: rows.length,
    metrics: rows.map(toPerformanceEntry),
  };
}
