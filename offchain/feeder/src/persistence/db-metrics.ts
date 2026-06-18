// Wrap a Db so every data operation emits `db_operations_total{table,operation}`
// and `db_operation_duration_seconds{table,operation}`. The mapping is explicit
// (a method's name does not always reveal its table/op), so it is reliable; any
// method NOT in the map (migrate/close, and future methods) passes through
// un-instrumented rather than being mislabelled.

import type { Db } from "./db.js";
import type { FeederMetrics } from "../api/metrics.js";

type Op = { table: string; operation: "insert" | "update" | "select" | "delete" };

const DB_OP: Record<string, Op> = {
  initialiseChainState: { table: "chain_state", operation: "insert" },
  setLastProcessedBlock: { table: "chain_state", operation: "update" },
  setLastScanBlock: { table: "chain_state", operation: "update" },
  setChainHealth: { table: "chain_state", operation: "update" },
  getChainState: { table: "chain_state", operation: "select" },
  listChainStates: { table: "chain_state", operation: "select" },
  getLastProcessedBlock: { table: "chain_state", operation: "select" },
  upsertProcessedEvent: { table: "processed_events", operation: "insert" },
  hasProcessedEvent: { table: "processed_events", operation: "select" },
  getProcessedEvent: { table: "processed_events", operation: "select" },
  listProcessedEvents: { table: "processed_events", operation: "select" },
  insertTransactionLog: { table: "transaction_log", operation: "insert" },
  updateTransactionLog: { table: "transaction_log", operation: "update" },
  getTransactionLog: { table: "transaction_log", operation: "select" },
  getTransactionsByHash: { table: "transaction_log", operation: "select" },
  listTransactions: { table: "transaction_log", operation: "select" },
  listSymbolUpdates: { table: "transaction_log", operation: "select" },
  upsertContractSymbolUpdate: { table: "contract_symbol_updates", operation: "insert" },
  getContractSymbolUpdate: { table: "contract_symbol_updates", operation: "select" },
  listContractSymbolUpdates: { table: "contract_symbol_updates", operation: "select" },
  recordPerformanceMetric: { table: "performance_metrics", operation: "insert" },
  queryPerformanceMetrics: { table: "performance_metrics", operation: "select" },
  recordAlert: { table: "alert_log", operation: "insert" },
  resolveAlert: { table: "alert_log", operation: "update" },
  acknowledgeAlert: { table: "alert_log", operation: "update" },
  listAlerts: { table: "alert_log", operation: "select" },
  getAlertById: { table: "alert_log", operation: "select" },
  pruneOldRows: { table: "all", operation: "delete" },
};

export function instrumentDb(db: Db, metrics: FeederMetrics): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      const mapping = DB_OP[String(prop)];
      if (typeof original !== "function" || !mapping) return original;
      return async (...args: unknown[]): Promise<unknown> => {
        const startMs = Date.now();
        try {
          return await (original as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } finally {
          const labels = { table: mapping.table, operation: mapping.operation };
          metrics.bridgeDbOperations.inc(labels);
          metrics.bridgeDbOperationDuration.observe(labels, (Date.now() - startMs) / 1000);
        }
      };
    },
  }) as Db;
}
