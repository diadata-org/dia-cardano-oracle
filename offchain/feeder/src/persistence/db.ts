import * as nodePath from "node:path";

// Pluggable database adapter — 6-table schema.
//
// Tables:
//   processed_events       — one row per decoded IntentRegistered log;
//                            dedup check + audit trail.
//   chain_state            — one row per (chainId, contractId); tracks
//                            last processed and last scan block numbers.
//   transaction_log        — one row per Cardano submission attempt.
//   contract_symbol_updates — latest known price per (chainId, contract, symbol).
//   performance_metrics    — time-series metric samples.
//   alert_log              — fired / resolved alert events.
//
// Both SQLite (default, via better-sqlite3) and Postgres (opt-in via
// DATABASE_DRIVER=postgres + DATABASE_DSN) are supported through the
// same Db interface.

// ---------------------------------------------------------------------------
// Row / query types
// ---------------------------------------------------------------------------

export type ChainStateRow = {
  id: number;
  chainId: number;
  chainName: string;
  contractId: string;
  lastProcessedBlock: bigint;
  lastScanBlock: bigint;
  isHealthy: boolean;
  errorCount: number;
  lastError?: string;
  lastHealthCheckMs?: number;
  updatedAtMs: number;
};

export type ProcessedEventRow = {
  intentHash: string;
  eventId?: string;
  eventName?: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  routerId: string;
  destinationIndex: number;
  status: "processed" | "filtered" | "duplicate" | "error";
  filterReason?: string;
  processedAtMs: number;
};

export type TransactionLogInsert = {
  intentHash: string;
  cardanoTxHash?: string;
  routerId: string;
  destinationIndex: number;
  destinationChainName: string;
  destinationContractAddress: string;
  symbol: string;
  price: string;
  timestamp: number;
  status: "pending" | "submitted" | "confirmed" | "failed";
  errorCode?: string;
  errorMessage?: string;
  retryCount?: number;
  maxRetries?: number;
  feePaidLovelace?: string;
  confirmedAtDepth?: number;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  failedAtMs?: number;
  createdAtMs: number;
};

export type TransactionLogPatch = {
  status?: "pending" | "submitted" | "confirmed" | "failed";
  cardanoTxHash?: string;
  errorCode?: string;
  errorMessage?: string;
  retryCount?: number;
  feePaidLovelace?: string;
  confirmedAtDepth?: number;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  failedAtMs?: number;
};

export type TransactionLogRow = {
  id: number;
  intentHash: string;
  cardanoTxHash: string;
  routerId: string;
  destinationIndex: number;
  destinationChainName: string;
  destinationContractAddress: string;
  symbol: string;
  price: string;
  timestamp: number;
  status: "pending" | "submitted" | "confirmed" | "failed";
  errorCode?: string;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
  feePaidLovelace?: string;
  confirmedAtDepth?: number;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  failedAtMs?: number;
  createdAtMs: number;
};

// Backward-compat alias — some callers still reference TransactionViewRow.
export type TransactionViewRow = TransactionLogRow;

export type ContractSymbolUpdateRow = {
  id?: number;
  chainId: number;
  contractAddress: string;
  symbol: string;
  lastIntentHash?: string;
  lastCardanoTxHash?: string;
  lastPrice: string;
  lastTimestamp: number;
  lastUpdateMs: number;
  lastConfirmedAtDepth?: number;
  updateCount: number;
  totalFeePaidLovelace?: string;
};

export type PerformanceMetricRow = {
  id: number;
  metricName: string;
  metricValue: number;
  labelsJson: string;
  recordedAtMs: number;
};

export type AlertLogRow = {
  id: number;
  alertName: string;
  severity: "info" | "warning" | "critical";
  message: string;
  labelsJson: string;
  firedAtMs: number;
  resolvedAtMs?: number;
  acknowledged: boolean;
};

export type ProcessedEventsQuery = {
  fromBlock?: bigint;
  routerId?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type TransactionQuery = {
  status?: string;
  symbol?: string;
  routerId?: string;
  chain?: string;
  limit?: number;
  offset?: number;
};

export type PerformanceMetricsQuery = {
  metricName?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export type AlertQuery = {
  active?: boolean;
  limit?: number;
  offset?: number;
};

// ---------------------------------------------------------------------------
// Abstract Db interface
// ---------------------------------------------------------------------------

export type Db = {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // chain_state
  initialiseChainState(args: { chainId: number; chainName: string; contractId: string }): Promise<void>;
  setLastProcessedBlock(chainId: number, contractId: string, block: bigint): Promise<void>;
  setLastScanBlock(chainId: number, contractId: string, block: bigint): Promise<void>;
  setChainHealth(chainId: number, contractId: string, args: { isHealthy: boolean; errorMsg?: string }): Promise<void>;
  getChainState(chainId: number, contractId: string): Promise<ChainStateRow | null>;
  listChainStates(): Promise<ChainStateRow[]>;

  // processed_events
  upsertProcessedEvent(row: ProcessedEventRow): Promise<void>;
  hasProcessedEvent(intentHash: string): Promise<boolean>;
  getProcessedEvent(intentHash: string): Promise<ProcessedEventRow | null>;
  listProcessedEvents(query: ProcessedEventsQuery): Promise<ProcessedEventRow[]>;

  // transaction_log
  insertTransactionLog(row: TransactionLogInsert): Promise<void>;
  updateTransactionLog(intentHash: string, patch: TransactionLogPatch): Promise<void>;
  getTransactionLog(intentHash: string): Promise<TransactionLogRow[]>;
  getTransactionsByHash(cardanoTxHash: string): Promise<TransactionLogRow[]>;
  listTransactions(query: TransactionQuery): Promise<TransactionLogRow[]>;
  listSymbolUpdates(symbol: string, limit: number): Promise<TransactionLogRow[]>;

  // contract_symbol_updates
  upsertContractSymbolUpdate(row: ContractSymbolUpdateRow): Promise<void>;
  getContractSymbolUpdate(chainId: number, contractAddress: string, symbol: string): Promise<ContractSymbolUpdateRow | null>;
  listContractSymbolUpdates(): Promise<ContractSymbolUpdateRow[]>;

  // performance_metrics
  recordPerformanceMetric(args: { name: string; value: number; labels?: Record<string, string> }): Promise<void>;
  queryPerformanceMetrics(filter: PerformanceMetricsQuery): Promise<PerformanceMetricRow[]>;

  // alert_log
  recordAlert(args: { name: string; severity: "info" | "warning" | "critical"; message: string; labels?: Record<string, string> }): Promise<number>;
  resolveAlert(id: number, resolvedAtMs: number): Promise<void>;
  acknowledgeAlert(id: number): Promise<void>;
  listAlerts(query: AlertQuery): Promise<AlertLogRow[]>;

  // cleanup
  pruneOldRows(maxAgeMs: number): Promise<{ processedEvents: number; transactionLog: number; alertLog: number; performanceMetrics: number }>;

  // Deprecated shim — kept for backward compatibility.
  getLastProcessedBlock(chainId: number, contractId: string): Promise<bigint | null>;
};

// ---------------------------------------------------------------------------
// SQL schemas (exported for parity tests)
// ---------------------------------------------------------------------------

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
  intent_hash        TEXT    PRIMARY KEY,
  event_id           TEXT,
  event_name         TEXT,
  tx_hash            TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,
  block_number       INTEGER NOT NULL,
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('processed','filtered','duplicate','error')),
  filter_reason      TEXT,
  processed_at_ms    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_events_tx_log ON processed_events(tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_processed_events_block ON processed_events(block_number);
CREATE INDEX IF NOT EXISTS idx_processed_events_router ON processed_events(router_id);

CREATE TABLE IF NOT EXISTS chain_state (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id               INTEGER NOT NULL,
  chain_name             TEXT    NOT NULL,
  contract_id            TEXT    NOT NULL,
  last_processed_block   INTEGER NOT NULL DEFAULT 0,
  last_scan_block        INTEGER NOT NULL DEFAULT 0,
  is_healthy             INTEGER NOT NULL DEFAULT 1,
  error_count            INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  last_health_check_ms   INTEGER,
  updated_at_ms          INTEGER NOT NULL,
  UNIQUE (chain_id, contract_id)
);
CREATE INDEX IF NOT EXISTS idx_chain_state_lookup ON chain_state(chain_id, contract_id);

CREATE TABLE IF NOT EXISTS transaction_log (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_hash                   TEXT    NOT NULL,
  cardano_tx_hash               TEXT    NOT NULL DEFAULT '',
  router_id                     TEXT    NOT NULL,
  destination_index             INTEGER NOT NULL,
  destination_chain_name        TEXT    NOT NULL,
  destination_contract_address  TEXT    NOT NULL,
  symbol                        TEXT    NOT NULL,
  price                         TEXT    NOT NULL,
  timestamp                     INTEGER NOT NULL,
  status                        TEXT    NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
  error_code                    TEXT,
  error_message                 TEXT,
  retry_count                   INTEGER NOT NULL DEFAULT 0,
  max_retries                   INTEGER NOT NULL DEFAULT 0,
  fee_paid_lovelace             TEXT,
  confirmed_at_depth            INTEGER,
  submitted_at_ms               INTEGER,
  confirmed_at_ms               INTEGER,
  failed_at_ms                  INTEGER,
  created_at_ms                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_log_intent_hash ON transaction_log(intent_hash);
CREATE INDEX IF NOT EXISTS idx_tx_log_tx_hash ON transaction_log(cardano_tx_hash);
CREATE INDEX IF NOT EXISTS idx_tx_log_status_created ON transaction_log(status, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_tx_log_router_symbol ON transaction_log(router_id, symbol);

CREATE TABLE IF NOT EXISTS contract_symbol_updates (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id                    INTEGER NOT NULL,
  contract_address            TEXT    NOT NULL,
  symbol                      TEXT    NOT NULL,
  last_intent_hash            TEXT,
  last_cardano_tx_hash        TEXT,
  last_price                  TEXT    NOT NULL,
  last_timestamp              INTEGER NOT NULL,
  last_update_ms              INTEGER NOT NULL,
  last_confirmed_at_depth     INTEGER,
  update_count                INTEGER NOT NULL DEFAULT 0,
  total_fee_paid_lovelace     TEXT,
  UNIQUE (chain_id, contract_address, symbol)
);
CREATE INDEX IF NOT EXISTS idx_contract_symbol_updates_lookup ON contract_symbol_updates(chain_id, contract_address, symbol);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name           TEXT    NOT NULL,
  metric_value          REAL    NOT NULL,
  labels_json           TEXT    NOT NULL DEFAULT '{}',
  recorded_at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_name_time ON performance_metrics(metric_name, recorded_at_ms);

CREATE TABLE IF NOT EXISTS alert_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_name      TEXT    NOT NULL,
  severity        TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
  message         TEXT    NOT NULL,
  labels_json     TEXT    NOT NULL DEFAULT '{}',
  fired_at_ms     INTEGER NOT NULL,
  resolved_at_ms  INTEGER,
  acknowledged    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alert_log_active ON alert_log(resolved_at_ms) WHERE resolved_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_log_name_time ON alert_log(alert_name, fired_at_ms);
`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
  intent_hash        TEXT    PRIMARY KEY,
  event_id           TEXT,
  event_name         TEXT,
  tx_hash            TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,
  block_number       BIGINT  NOT NULL,
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('processed','filtered','duplicate','error')),
  filter_reason      TEXT,
  processed_at_ms    BIGINT  NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_processed_events_tx_log ON processed_events(tx_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_processed_events_block ON processed_events(block_number);
CREATE INDEX IF NOT EXISTS idx_processed_events_router ON processed_events(router_id);

CREATE TABLE IF NOT EXISTS chain_state (
  id                     BIGSERIAL PRIMARY KEY,
  chain_id               INTEGER NOT NULL,
  chain_name             TEXT    NOT NULL,
  contract_id            TEXT    NOT NULL,
  last_processed_block   BIGINT  NOT NULL DEFAULT 0,
  last_scan_block        BIGINT  NOT NULL DEFAULT 0,
  is_healthy             BOOLEAN NOT NULL DEFAULT TRUE,
  error_count            INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  last_health_check_ms   BIGINT,
  updated_at_ms          BIGINT  NOT NULL,
  UNIQUE (chain_id, contract_id)
);
CREATE INDEX IF NOT EXISTS idx_chain_state_lookup ON chain_state(chain_id, contract_id);

CREATE TABLE IF NOT EXISTS transaction_log (
  id                            BIGSERIAL PRIMARY KEY,
  intent_hash                   TEXT    NOT NULL,
  cardano_tx_hash               TEXT    NOT NULL DEFAULT '',
  router_id                     TEXT    NOT NULL,
  destination_index             INTEGER NOT NULL,
  destination_chain_name        TEXT    NOT NULL,
  destination_contract_address  TEXT    NOT NULL,
  symbol                        TEXT    NOT NULL,
  price                         TEXT    NOT NULL,
  timestamp                     BIGINT  NOT NULL,
  status                        TEXT    NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
  error_code                    TEXT,
  error_message                 TEXT,
  retry_count                   INTEGER NOT NULL DEFAULT 0,
  max_retries                   INTEGER NOT NULL DEFAULT 0,
  fee_paid_lovelace             TEXT,
  confirmed_at_depth            INTEGER,
  submitted_at_ms               BIGINT,
  confirmed_at_ms               BIGINT,
  failed_at_ms                  BIGINT,
  created_at_ms                 BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_log_intent_hash ON transaction_log(intent_hash);
CREATE INDEX IF NOT EXISTS idx_tx_log_tx_hash ON transaction_log(cardano_tx_hash);
CREATE INDEX IF NOT EXISTS idx_tx_log_status_created ON transaction_log(status, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_tx_log_router_symbol ON transaction_log(router_id, symbol);

CREATE TABLE IF NOT EXISTS contract_symbol_updates (
  id                          BIGSERIAL PRIMARY KEY,
  chain_id                    INTEGER NOT NULL,
  contract_address            TEXT    NOT NULL,
  symbol                      TEXT    NOT NULL,
  last_intent_hash            TEXT,
  last_cardano_tx_hash        TEXT,
  last_price                  TEXT    NOT NULL,
  last_timestamp              BIGINT  NOT NULL,
  last_update_ms              BIGINT  NOT NULL,
  last_confirmed_at_depth     INTEGER,
  update_count                INTEGER NOT NULL DEFAULT 0,
  total_fee_paid_lovelace     TEXT,
  UNIQUE (chain_id, contract_address, symbol)
);
CREATE INDEX IF NOT EXISTS idx_contract_symbol_updates_lookup ON contract_symbol_updates(chain_id, contract_address, symbol);

CREATE TABLE IF NOT EXISTS performance_metrics (
  id                    BIGSERIAL PRIMARY KEY,
  metric_name           TEXT              NOT NULL,
  metric_value          DOUBLE PRECISION  NOT NULL,
  labels_json           JSONB             NOT NULL DEFAULT '{}',
  recorded_at_ms        BIGINT            NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_name_time ON performance_metrics(metric_name, recorded_at_ms);

CREATE TABLE IF NOT EXISTS alert_log (
  id              BIGSERIAL PRIMARY KEY,
  alert_name      TEXT    NOT NULL,
  severity        TEXT    NOT NULL CHECK (severity IN ('info','warning','critical')),
  message         TEXT    NOT NULL,
  labels_json     JSONB   NOT NULL DEFAULT '{}',
  fired_at_ms     BIGINT  NOT NULL,
  resolved_at_ms  BIGINT,
  acknowledged    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_alert_log_active ON alert_log(resolved_at_ms) WHERE resolved_at_ms IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_log_name_time ON alert_log(alert_name, fired_at_ms);
`;


// ---------------------------------------------------------------------------
// SQLite implementation
// ---------------------------------------------------------------------------

async function createSqliteDb(filePath: string): Promise<Db> {
  const mod = "better-sqlite3";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: Database } = (await import(mod)) as any as {
    default: (path: string) => BetterSqlite3Like;
  };
  const db = Database(filePath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");

  const impl: Db = {
    async migrate() {
      try {
        db.exec(SQLITE_SCHEMA);
      } catch (err) {
        db.close();
        throw err;
      }
    },

    async close() {
      db.close();
    },

    async initialiseChainState({ chainId, chainName, contractId }) {
      db.prepare(`
        INSERT INTO chain_state
          (chain_id, chain_name, contract_id, last_processed_block, last_scan_block,
           is_healthy, error_count, updated_at_ms)
        VALUES (?,?,?,0,0,1,0,?)
        ON CONFLICT(chain_id, contract_id) DO NOTHING
      `).run(chainId, chainName, contractId, Date.now());
    },

    async setLastProcessedBlock(chainId, contractId, block) {
      const result = db.prepare(`
        UPDATE chain_state
        SET last_processed_block = ?, updated_at_ms = ?
        WHERE chain_id = ? AND contract_id = ?
      `).run(String(block), Date.now(), chainId, contractId);
      if (result.changes === 0) {
        throw new Error(
          `setLastProcessedBlock: no chain_state row for chain_id=${chainId} contract_id=${contractId}. ` +
          `Call initialiseChainState first.`,
        );
      }
    },

    async setLastScanBlock(chainId, contractId, block) {
      const result = db.prepare(`
        UPDATE chain_state
        SET last_scan_block = ?, updated_at_ms = ?
        WHERE chain_id = ? AND contract_id = ?
      `).run(String(block), Date.now(), chainId, contractId);
      if (result.changes === 0) {
        throw new Error(
          `setLastScanBlock: no chain_state row for chain_id=${chainId} contract_id=${contractId}. ` +
          `Call initialiseChainState first.`,
        );
      }
    },

    async setChainHealth(chainId, contractId, { isHealthy, errorMsg }) {
      if (isHealthy) {
        db.prepare(`
          UPDATE chain_state
          SET is_healthy = 1, last_health_check_ms = ?, updated_at_ms = ?
          WHERE chain_id = ? AND contract_id = ?
        `).run(Date.now(), Date.now(), chainId, contractId);
      } else {
        db.prepare(`
          UPDATE chain_state
          SET is_healthy = 0,
              error_count = error_count + 1,
              last_error = ?,
              last_health_check_ms = ?,
              updated_at_ms = ?
          WHERE chain_id = ? AND contract_id = ?
        `).run(errorMsg ?? null, Date.now(), Date.now(), chainId, contractId);
      }
    },

    async getChainState(chainId, contractId) {
      const r = db.prepare(
        "SELECT * FROM chain_state WHERE chain_id = ? AND contract_id = ?",
      ).get(chainId, contractId) as SqliteChainStateRow | undefined;
      return r ? fromSqliteChainStateRow(r) : null;
    },

    async listChainStates() {
      const rows = db.prepare(
        "SELECT * FROM chain_state ORDER BY chain_id ASC, contract_id ASC",
      ).all() as unknown as SqliteChainStateRow[];
      return rows.map(fromSqliteChainStateRow);
    },

    async upsertProcessedEvent(row) {
      db.prepare(`
        INSERT INTO processed_events
          (intent_hash, event_id, event_name, tx_hash, log_index, block_number,
           router_id, destination_index, status, filter_reason, processed_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(intent_hash) DO NOTHING
      `).run(
        row.intentHash, row.eventId ?? null, row.eventName ?? null,
        row.txHash, row.logIndex, String(row.blockNumber),
        row.routerId, row.destinationIndex, row.status,
        row.filterReason ?? null, row.processedAtMs,
      );
    },

    async hasProcessedEvent(intentHash) {
      const r = db.prepare(
        "SELECT 1 FROM processed_events WHERE intent_hash = ?",
      ).get(intentHash);
      return r !== undefined;
    },

    async getProcessedEvent(intentHash) {
      const r = db.prepare(
        "SELECT * FROM processed_events WHERE intent_hash = ?",
      ).get(intentHash) as SqliteProcessedEventRow | undefined;
      return r ? fromSqliteProcessedEventRow(r) : null;
    },

    async listProcessedEvents(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.fromBlock !== undefined) {
        conditions.push("block_number >= ?");
        params.push(String(query.fromBlock));
      }
      if (query.routerId !== undefined) {
        conditions.push("router_id = ?");
        params.push(query.routerId);
      }
      if (query.status !== undefined) {
        conditions.push("status = ?");
        params.push(query.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(query.limit ?? 100, 1000);
      const offset = query.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM processed_events ${where} ORDER BY block_number DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as unknown as SqliteProcessedEventRow[];
      return rows.map(fromSqliteProcessedEventRow);
    },

    async insertTransactionLog(row) {
      db.prepare(`
        INSERT INTO transaction_log
          (intent_hash, cardano_tx_hash, router_id, destination_index,
           destination_chain_name, destination_contract_address,
           symbol, price, timestamp, status, error_code, error_message,
           retry_count, max_retries, fee_paid_lovelace, confirmed_at_depth,
           submitted_at_ms, confirmed_at_ms, failed_at_ms, created_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        row.intentHash,
        row.cardanoTxHash ?? "",
        row.routerId,
        row.destinationIndex,
        row.destinationChainName,
        row.destinationContractAddress,
        row.symbol,
        row.price,
        row.timestamp,
        row.status,
        row.errorCode ?? null,
        row.errorMessage ?? null,
        row.retryCount ?? 0,
        row.maxRetries ?? 0,
        row.feePaidLovelace ?? null,
        row.confirmedAtDepth ?? null,
        row.submittedAtMs ?? null,
        row.confirmedAtMs ?? null,
        row.failedAtMs ?? null,
        row.createdAtMs,
      );
    },

    async updateTransactionLog(intentHash, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];

      if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
      if (patch.cardanoTxHash !== undefined) { sets.push("cardano_tx_hash = ?"); params.push(patch.cardanoTxHash); }
      if (patch.errorCode !== undefined) { sets.push("error_code = ?"); params.push(patch.errorCode); }
      if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(patch.errorMessage); }
      if (patch.retryCount !== undefined) { sets.push("retry_count = ?"); params.push(patch.retryCount); }
      if (patch.feePaidLovelace !== undefined) { sets.push("fee_paid_lovelace = ?"); params.push(patch.feePaidLovelace); }
      if (patch.confirmedAtDepth !== undefined) { sets.push("confirmed_at_depth = ?"); params.push(patch.confirmedAtDepth); }
      if (patch.submittedAtMs !== undefined) { sets.push("submitted_at_ms = ?"); params.push(patch.submittedAtMs); }
      if (patch.confirmedAtMs !== undefined) { sets.push("confirmed_at_ms = ?"); params.push(patch.confirmedAtMs); }
      if (patch.failedAtMs !== undefined) { sets.push("failed_at_ms = ?"); params.push(patch.failedAtMs); }

      if (sets.length === 0) return;

      params.push(intentHash);
      db.prepare(
        `UPDATE transaction_log SET ${sets.join(", ")} WHERE intent_hash = ?`,
      ).run(...params);
    },

    async getTransactionLog(intentHash) {
      const rows = db.prepare(
        "SELECT * FROM transaction_log WHERE intent_hash = ? ORDER BY created_at_ms ASC",
      ).all(intentHash) as unknown as SqliteTransactionLogRow[];
      return rows.map(fromSqliteTransactionLogRow);
    },

    async getTransactionsByHash(cardanoTxHash) {
      const rows = db.prepare(
        "SELECT * FROM transaction_log WHERE cardano_tx_hash = ? ORDER BY created_at_ms ASC",
      ).all(cardanoTxHash) as unknown as SqliteTransactionLogRow[];
      return rows.map(fromSqliteTransactionLogRow);
    },

    async listTransactions(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.status !== undefined) { conditions.push("status = ?"); params.push(query.status); }
      if (query.symbol !== undefined) { conditions.push("symbol = ?"); params.push(query.symbol); }
      if (query.routerId !== undefined) { conditions.push("router_id = ?"); params.push(query.routerId); }
      if (query.chain !== undefined) { conditions.push("destination_chain_name = ?"); params.push(query.chain); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(query.limit ?? 100, 1000);
      const offset = query.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM transaction_log ${where} ORDER BY created_at_ms DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as unknown as SqliteTransactionLogRow[];
      return rows.map(fromSqliteTransactionLogRow);
    },

    async listSymbolUpdates(symbol, limit) {
      const rows = db.prepare(
        "SELECT * FROM transaction_log WHERE symbol = ? ORDER BY created_at_ms DESC LIMIT ?",
      ).all(symbol, limit) as unknown as SqliteTransactionLogRow[];
      return rows.map(fromSqliteTransactionLogRow);
    },

    async upsertContractSymbolUpdate(row) {
      db.prepare(`
        INSERT INTO contract_symbol_updates
          (chain_id, contract_address, symbol, last_intent_hash, last_cardano_tx_hash,
           last_price, last_timestamp, last_update_ms, last_confirmed_at_depth,
           update_count, total_fee_paid_lovelace)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chain_id, contract_address, symbol)
        DO UPDATE SET
          last_intent_hash        = excluded.last_intent_hash,
          last_cardano_tx_hash    = excluded.last_cardano_tx_hash,
          last_price              = excluded.last_price,
          last_timestamp          = excluded.last_timestamp,
          last_update_ms          = excluded.last_update_ms,
          last_confirmed_at_depth = excluded.last_confirmed_at_depth,
          update_count            = update_count + 1,
          total_fee_paid_lovelace = excluded.total_fee_paid_lovelace
      `).run(
        row.chainId, row.contractAddress, row.symbol,
        row.lastIntentHash ?? null, row.lastCardanoTxHash ?? null,
        row.lastPrice, row.lastTimestamp, row.lastUpdateMs,
        row.lastConfirmedAtDepth ?? null, row.updateCount,
        row.totalFeePaidLovelace ?? null,
      );
    },

    async getContractSymbolUpdate(chainId, contractAddress, symbol) {
      const r = db.prepare(
        "SELECT * FROM contract_symbol_updates WHERE chain_id = ? AND contract_address = ? AND symbol = ?",
      ).get(chainId, contractAddress, symbol) as SqliteContractSymbolUpdateRow | undefined;
      return r ? fromSqliteContractSymbolUpdateRow(r) : null;
    },

    async listContractSymbolUpdates() {
      const rows = db.prepare(
        "SELECT * FROM contract_symbol_updates ORDER BY chain_id ASC, contract_address ASC, symbol ASC",
      ).all() as unknown as SqliteContractSymbolUpdateRow[];
      return rows.map(fromSqliteContractSymbolUpdateRow);
    },

    async recordPerformanceMetric({ name, value, labels }) {
      db.prepare(`
        INSERT INTO performance_metrics (metric_name, metric_value, labels_json, recorded_at_ms)
        VALUES (?,?,?,?)
      `).run(name, value, JSON.stringify(labels ?? {}), Date.now());
    },

    async queryPerformanceMetrics(filter) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter.metricName !== undefined) { conditions.push("metric_name = ?"); params.push(filter.metricName); }
      if (filter.since !== undefined) { conditions.push("recorded_at_ms >= ?"); params.push(filter.since); }
      if (filter.until !== undefined) { conditions.push("recorded_at_ms <= ?"); params.push(filter.until); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filter.limit ?? 1000;

      const rows = db.prepare(
        `SELECT * FROM performance_metrics ${where} ORDER BY recorded_at_ms DESC LIMIT ?`,
      ).all(...params, limit) as unknown as SqlitePerformanceMetricRow[];
      return rows.map(fromSqlitePerformanceMetricRow);
    },

    async recordAlert({ name, severity, message, labels }) {
      const r = db.prepare(`
        INSERT INTO alert_log (alert_name, severity, message, labels_json, fired_at_ms, acknowledged)
        VALUES (?,?,?,?,?,0)
      `).run(name, severity, message, JSON.stringify(labels ?? {}), Date.now()) as { lastInsertRowid: number | bigint };
      return Number(r.lastInsertRowid);
    },

    async resolveAlert(id, resolvedAtMs) {
      db.prepare(
        "UPDATE alert_log SET resolved_at_ms = ? WHERE id = ?",
      ).run(resolvedAtMs, id);
    },

    async acknowledgeAlert(id) {
      db.prepare(
        "UPDATE alert_log SET acknowledged = 1 WHERE id = ?",
      ).run(id);
    },

    async listAlerts(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query.active === true) {
        conditions.push("resolved_at_ms IS NULL");
      } else if (query.active === false) {
        conditions.push("resolved_at_ms IS NOT NULL");
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM alert_log ${where} ORDER BY fired_at_ms DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as unknown as SqliteAlertLogRow[];
      return rows.map(fromSqliteAlertLogRow);
    },

    async pruneOldRows(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      const pe = db.prepare(
        "DELETE FROM processed_events WHERE processed_at_ms < ?",
      ).run(cutoff) as { changes: number };
      const tl = db.prepare(
        "DELETE FROM transaction_log WHERE created_at_ms < ? AND status IN ('confirmed','failed')",
      ).run(cutoff) as { changes: number };
      const al = db.prepare(
        "DELETE FROM alert_log WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms < ?",
      ).run(cutoff) as { changes: number };
      const pm = db.prepare(
        "DELETE FROM performance_metrics WHERE recorded_at_ms < ?",
      ).run(cutoff) as { changes: number };
      return {
        processedEvents: pe.changes,
        transactionLog: tl.changes,
        alertLog: al.changes,
        performanceMetrics: pm.changes,
      };
    },

    async getLastProcessedBlock(chainId, contractId) {
      const row = await impl.getChainState(chainId, contractId);
      return row ? row.lastProcessedBlock : null;
    },
  };

  return impl;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

async function createPostgresDb(dsn: string): Promise<Db> {
  const mod = "pg";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Pool } = (await import(mod)) as any as {
    Pool: new (opts: { connectionString: string }) => PgPoolLike;
  };
  const pool = new Pool({ connectionString: dsn });

  const impl: Db = {
    async migrate() {
      await pool.query(POSTGRES_SCHEMA);
    },

    async close() {
      await pool.end();
    },

    async initialiseChainState({ chainId, chainName, contractId }) {
      await pool.query(
        `INSERT INTO chain_state
           (chain_id, chain_name, contract_id, last_processed_block, last_scan_block,
            is_healthy, error_count, updated_at_ms)
         VALUES ($1,$2,$3,0,0,TRUE,0,$4)
         ON CONFLICT(chain_id, contract_id) DO NOTHING`,
        [chainId, chainName, contractId, Date.now()],
      );
    },

    async setLastProcessedBlock(chainId, contractId, block) {
      const result = await pool.query(
        `UPDATE chain_state
         SET last_processed_block = $1, updated_at_ms = $2
         WHERE chain_id = $3 AND contract_id = $4`,
        [String(block), Date.now(), chainId, contractId],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `setLastProcessedBlock: no chain_state row for chain_id=${chainId} contract_id=${contractId}. ` +
          `Call initialiseChainState first.`,
        );
      }
    },

    async setLastScanBlock(chainId, contractId, block) {
      const result = await pool.query(
        `UPDATE chain_state
         SET last_scan_block = $1, updated_at_ms = $2
         WHERE chain_id = $3 AND contract_id = $4`,
        [String(block), Date.now(), chainId, contractId],
      );
      if (result.rowCount === 0) {
        throw new Error(
          `setLastScanBlock: no chain_state row for chain_id=${chainId} contract_id=${contractId}. ` +
          `Call initialiseChainState first.`,
        );
      }
    },

    async setChainHealth(chainId, contractId, { isHealthy, errorMsg }) {
      if (isHealthy) {
        await pool.query(
          `UPDATE chain_state
           SET is_healthy = TRUE, last_health_check_ms = $1, updated_at_ms = $1
           WHERE chain_id = $2 AND contract_id = $3`,
          [Date.now(), chainId, contractId],
        );
      } else {
        await pool.query(
          `UPDATE chain_state
           SET is_healthy = FALSE,
               error_count = error_count + 1,
               last_error = $1,
               last_health_check_ms = $2,
               updated_at_ms = $2
           WHERE chain_id = $3 AND contract_id = $4`,
          [errorMsg ?? null, Date.now(), chainId, contractId],
        );
      }
    },

    async getChainState(chainId, contractId) {
      const r = await pool.query(
        "SELECT * FROM chain_state WHERE chain_id = $1 AND contract_id = $2",
        [chainId, contractId],
      );
      const first = r.rows[0] as PgChainStateRow | undefined;
      return first ? fromPgChainStateRow(first) : null;
    },

    async listChainStates() {
      const r = await pool.query(
        "SELECT * FROM chain_state ORDER BY chain_id ASC, contract_id ASC",
      );
      return (r.rows as PgChainStateRow[]).map(fromPgChainStateRow);
    },

    async upsertProcessedEvent(row) {
      await pool.query(
        `INSERT INTO processed_events
           (intent_hash, event_id, event_name, tx_hash, log_index, block_number,
            router_id, destination_index, status, filter_reason, processed_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(intent_hash) DO NOTHING`,
        [
          row.intentHash, row.eventId ?? null, row.eventName ?? null,
          row.txHash, row.logIndex, String(row.blockNumber),
          row.routerId, row.destinationIndex, row.status,
          row.filterReason ?? null, row.processedAtMs,
        ],
      );
    },

    async hasProcessedEvent(intentHash) {
      const r = await pool.query(
        "SELECT 1 FROM processed_events WHERE intent_hash = $1",
        [intentHash],
      );
      return r.rowCount !== null && r.rowCount > 0;
    },

    async getProcessedEvent(intentHash) {
      const r = await pool.query(
        "SELECT * FROM processed_events WHERE intent_hash = $1",
        [intentHash],
      );
      const first = r.rows[0] as PgProcessedEventRow | undefined;
      return first ? fromPgProcessedEventRow(first) : null;
    },

    async listProcessedEvents(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (query.fromBlock !== undefined) {
        conditions.push(`block_number >= $${idx++}`);
        params.push(String(query.fromBlock));
      }
      if (query.routerId !== undefined) {
        conditions.push(`router_id = $${idx++}`);
        params.push(query.routerId);
      }
      if (query.status !== undefined) {
        conditions.push(`status = $${idx++}`);
        params.push(query.status);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(query.limit ?? 100, 1000);
      const offset = query.offset ?? 0;

      const r = await pool.query(
        `SELECT * FROM processed_events ${where} ORDER BY block_number DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset],
      );
      return (r.rows as PgProcessedEventRow[]).map(fromPgProcessedEventRow);
    },

    async insertTransactionLog(row) {
      await pool.query(
        `INSERT INTO transaction_log
           (intent_hash, cardano_tx_hash, router_id, destination_index,
            destination_chain_name, destination_contract_address,
            symbol, price, timestamp, status, error_code, error_message,
            retry_count, max_retries, fee_paid_lovelace, confirmed_at_depth,
            submitted_at_ms, confirmed_at_ms, failed_at_ms, created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          row.intentHash,
          row.cardanoTxHash ?? "",
          row.routerId,
          row.destinationIndex,
          row.destinationChainName,
          row.destinationContractAddress,
          row.symbol,
          row.price,
          row.timestamp,
          row.status,
          row.errorCode ?? null,
          row.errorMessage ?? null,
          row.retryCount ?? 0,
          row.maxRetries ?? 0,
          row.feePaidLovelace ?? null,
          row.confirmedAtDepth ?? null,
          row.submittedAtMs ?? null,
          row.confirmedAtMs ?? null,
          row.failedAtMs ?? null,
          row.createdAtMs,
        ],
      );
    },

    async updateTransactionLog(intentHash, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (patch.status !== undefined) { sets.push(`status = $${idx++}`); params.push(patch.status); }
      if (patch.cardanoTxHash !== undefined) { sets.push(`cardano_tx_hash = $${idx++}`); params.push(patch.cardanoTxHash); }
      if (patch.errorCode !== undefined) { sets.push(`error_code = $${idx++}`); params.push(patch.errorCode); }
      if (patch.errorMessage !== undefined) { sets.push(`error_message = $${idx++}`); params.push(patch.errorMessage); }
      if (patch.retryCount !== undefined) { sets.push(`retry_count = $${idx++}`); params.push(patch.retryCount); }
      if (patch.feePaidLovelace !== undefined) { sets.push(`fee_paid_lovelace = $${idx++}`); params.push(patch.feePaidLovelace); }
      if (patch.confirmedAtDepth !== undefined) { sets.push(`confirmed_at_depth = $${idx++}`); params.push(patch.confirmedAtDepth); }
      if (patch.submittedAtMs !== undefined) { sets.push(`submitted_at_ms = $${idx++}`); params.push(patch.submittedAtMs); }
      if (patch.confirmedAtMs !== undefined) { sets.push(`confirmed_at_ms = $${idx++}`); params.push(patch.confirmedAtMs); }
      if (patch.failedAtMs !== undefined) { sets.push(`failed_at_ms = $${idx++}`); params.push(patch.failedAtMs); }

      if (sets.length === 0) return;

      params.push(intentHash);
      await pool.query(
        `UPDATE transaction_log SET ${sets.join(", ")} WHERE intent_hash = $${idx}`,
        params,
      );
    },

    async getTransactionLog(intentHash) {
      const r = await pool.query(
        "SELECT * FROM transaction_log WHERE intent_hash = $1 ORDER BY created_at_ms ASC",
        [intentHash],
      );
      return (r.rows as PgTransactionLogRow[]).map(fromPgTransactionLogRow);
    },

    async getTransactionsByHash(cardanoTxHash) {
      const r = await pool.query(
        "SELECT * FROM transaction_log WHERE cardano_tx_hash = $1 ORDER BY created_at_ms ASC",
        [cardanoTxHash],
      );
      return (r.rows as PgTransactionLogRow[]).map(fromPgTransactionLogRow);
    },

    async listTransactions(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (query.status !== undefined) { conditions.push(`status = $${idx++}`); params.push(query.status); }
      if (query.symbol !== undefined) { conditions.push(`symbol = $${idx++}`); params.push(query.symbol); }
      if (query.routerId !== undefined) { conditions.push(`router_id = $${idx++}`); params.push(query.routerId); }
      if (query.chain !== undefined) { conditions.push(`destination_chain_name = $${idx++}`); params.push(query.chain); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = Math.min(query.limit ?? 100, 1000);
      const offset = query.offset ?? 0;

      const r = await pool.query(
        `SELECT * FROM transaction_log ${where} ORDER BY created_at_ms DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset],
      );
      return (r.rows as PgTransactionLogRow[]).map(fromPgTransactionLogRow);
    },

    async listSymbolUpdates(symbol, limit) {
      const r = await pool.query(
        "SELECT * FROM transaction_log WHERE symbol = $1 ORDER BY created_at_ms DESC LIMIT $2",
        [symbol, limit],
      );
      return (r.rows as PgTransactionLogRow[]).map(fromPgTransactionLogRow);
    },

    async upsertContractSymbolUpdate(row) {
      await pool.query(
        `INSERT INTO contract_symbol_updates
           (chain_id, contract_address, symbol, last_intent_hash, last_cardano_tx_hash,
            last_price, last_timestamp, last_update_ms, last_confirmed_at_depth,
            update_count, total_fee_paid_lovelace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(chain_id, contract_address, symbol)
         DO UPDATE SET
           last_intent_hash        = EXCLUDED.last_intent_hash,
           last_cardano_tx_hash    = EXCLUDED.last_cardano_tx_hash,
           last_price              = EXCLUDED.last_price,
           last_timestamp          = EXCLUDED.last_timestamp,
           last_update_ms          = EXCLUDED.last_update_ms,
           last_confirmed_at_depth = EXCLUDED.last_confirmed_at_depth,
           update_count            = contract_symbol_updates.update_count + 1,
           total_fee_paid_lovelace = EXCLUDED.total_fee_paid_lovelace`,
        [
          row.chainId, row.contractAddress, row.symbol,
          row.lastIntentHash ?? null, row.lastCardanoTxHash ?? null,
          row.lastPrice, row.lastTimestamp, row.lastUpdateMs,
          row.lastConfirmedAtDepth ?? null, row.updateCount,
          row.totalFeePaidLovelace ?? null,
        ],
      );
    },

    async getContractSymbolUpdate(chainId, contractAddress, symbol) {
      const r = await pool.query(
        "SELECT * FROM contract_symbol_updates WHERE chain_id = $1 AND contract_address = $2 AND symbol = $3",
        [chainId, contractAddress, symbol],
      );
      const first = r.rows[0] as PgContractSymbolUpdateRow | undefined;
      return first ? fromPgContractSymbolUpdateRow(first) : null;
    },

    async listContractSymbolUpdates() {
      const r = await pool.query(
        "SELECT * FROM contract_symbol_updates ORDER BY chain_id ASC, contract_address ASC, symbol ASC",
      );
      return (r.rows as PgContractSymbolUpdateRow[]).map(fromPgContractSymbolUpdateRow);
    },

    async recordPerformanceMetric({ name, value, labels }) {
      await pool.query(
        `INSERT INTO performance_metrics (metric_name, metric_value, labels_json, recorded_at_ms)
         VALUES ($1,$2,$3,$4)`,
        [name, value, JSON.stringify(labels ?? {}), Date.now()],
      );
    },

    async queryPerformanceMetrics(filter) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (filter.metricName !== undefined) { conditions.push(`metric_name = $${idx++}`); params.push(filter.metricName); }
      if (filter.since !== undefined) { conditions.push(`recorded_at_ms >= $${idx++}`); params.push(filter.since); }
      if (filter.until !== undefined) { conditions.push(`recorded_at_ms <= $${idx++}`); params.push(filter.until); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = filter.limit ?? 1000;

      const r = await pool.query(
        `SELECT * FROM performance_metrics ${where} ORDER BY recorded_at_ms DESC LIMIT $${idx}`,
        [...params, limit],
      );
      return (r.rows as PgPerformanceMetricRow[]).map(fromPgPerformanceMetricRow);
    },

    async recordAlert({ name, severity, message, labels }) {
      const r = await pool.query(
        `INSERT INTO alert_log (alert_name, severity, message, labels_json, fired_at_ms, acknowledged)
         VALUES ($1,$2,$3,$4,$5,FALSE)
         RETURNING id`,
        [name, severity, message, JSON.stringify(labels ?? {}), Date.now()],
      );
      return Number((r.rows[0] as { id: string | number }).id);
    },

    async resolveAlert(id, resolvedAtMs) {
      await pool.query(
        "UPDATE alert_log SET resolved_at_ms = $1 WHERE id = $2",
        [resolvedAtMs, id],
      );
    },

    async acknowledgeAlert(id) {
      await pool.query(
        "UPDATE alert_log SET acknowledged = TRUE WHERE id = $1",
        [id],
      );
    },

    async listAlerts(query) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (query.active === true) {
        conditions.push("resolved_at_ms IS NULL");
      } else if (query.active === false) {
        conditions.push("resolved_at_ms IS NOT NULL");
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;

      const r = await pool.query(
        `SELECT * FROM alert_log ${where} ORDER BY fired_at_ms DESC LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset],
      );
      return (r.rows as PgAlertLogRow[]).map(fromPgAlertLogRow);
    },

    async pruneOldRows(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      const pe = await pool.query(
        "DELETE FROM processed_events WHERE processed_at_ms < $1",
        [cutoff],
      );
      const tl = await pool.query(
        "DELETE FROM transaction_log WHERE created_at_ms < $1 AND status IN ('confirmed','failed')",
        [cutoff],
      );
      const al = await pool.query(
        "DELETE FROM alert_log WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms < $1",
        [cutoff],
      );
      const pm = await pool.query(
        "DELETE FROM performance_metrics WHERE recorded_at_ms < $1",
        [cutoff],
      );
      return {
        processedEvents: pe.rowCount ?? 0,
        transactionLog: tl.rowCount ?? 0,
        alertLog: al.rowCount ?? 0,
        performanceMetrics: pm.rowCount ?? 0,
      };
    },

    async getLastProcessedBlock(chainId, contractId) {
      const row = await impl.getChainState(chainId, contractId);
      return row ? row.lastProcessedBlock : null;
    },
  };

  return impl;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export type DbConfig = {
  driver: "sqlite" | "postgres";
  /** SQLite file path. Must be set when driver = "sqlite". */
  path?: string;
  /** Postgres DSN. Required when driver = "postgres". */
  dsn?: string;
};

export async function createDb(config: DbConfig): Promise<Db> {
  if (config.driver === "postgres") {
    if (!config.dsn) {
      throw new Error("DATABASE_DSN is required when DATABASE_DRIVER=postgres.");
    }
    return createPostgresDb(config.dsn);
  }
  if (!config.path) {
    throw new Error("DATABASE_PATH is required when DATABASE_DRIVER=sqlite.");
  }
  if (config.path !== ":memory:") {
    validateSqlitePath(config.path);
  }
  return createSqliteDb(config.path);
}

/**
 * Reject sqlite paths that escape the feeder's working directory. The check
 * resolves the path against process.cwd() and requires the result to stay
 * inside `cwd/state/`. Operators can override the base via the
 * FEEDER_STATE_ROOT env var (useful in Docker where /app/state is the root).
 *
 * Rejecting an escape early prevents an operator typo or hostile env var
 * (e.g. `DATABASE_PATH_TESTNET=../../etc/feeder.sqlite`) from writing the
 * SQLite file outside the intended directory.
 */
function validateSqlitePath(rawPath: string): void {
  const stateRoot = nodePath.resolve(
    process.env["FEEDER_STATE_ROOT"] ?? nodePath.join(process.cwd(), "state"),
  );
  const resolved = nodePath.resolve(stateRoot, rawPath);
  const rootWithSep = stateRoot.endsWith(nodePath.sep) ? stateRoot : stateRoot + nodePath.sep;
  if (resolved !== stateRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `db.path "${rawPath}" resolves outside the feeder state root "${stateRoot}". ` +
      `Set FEEDER_STATE_ROOT if your deployment uses a different base directory.`,
    );
  }
}

// ---------------------------------------------------------------------------
// SQLite row types + mappers
// ---------------------------------------------------------------------------

type SqliteChainStateRow = {
  id: number;
  chain_id: number;
  chain_name: string;
  contract_id: string;
  last_processed_block: string | number;
  last_scan_block: string | number;
  is_healthy: number;
  error_count: number;
  last_error: string | null;
  last_health_check_ms: number | null;
  updated_at_ms: number;
};

function fromSqliteChainStateRow(r: SqliteChainStateRow): ChainStateRow {
  return {
    id: r.id,
    chainId: r.chain_id,
    chainName: r.chain_name,
    contractId: r.contract_id,
    lastProcessedBlock: BigInt(r.last_processed_block),
    lastScanBlock: BigInt(r.last_scan_block),
    isHealthy: r.is_healthy !== 0,
    errorCount: r.error_count,
    lastError: r.last_error ?? undefined,
    lastHealthCheckMs: r.last_health_check_ms ?? undefined,
    updatedAtMs: r.updated_at_ms,
  };
}

type SqliteProcessedEventRow = {
  intent_hash: string;
  event_id: string | null;
  event_name: string | null;
  tx_hash: string;
  log_index: number;
  block_number: string | number;
  router_id: string;
  destination_index: number;
  status: string;
  filter_reason: string | null;
  processed_at_ms: number;
};

function fromSqliteProcessedEventRow(r: SqliteProcessedEventRow): ProcessedEventRow {
  return {
    intentHash: r.intent_hash,
    eventId: r.event_id ?? undefined,
    eventName: r.event_name ?? undefined,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockNumber: BigInt(r.block_number),
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    status: r.status as ProcessedEventRow["status"],
    filterReason: r.filter_reason ?? undefined,
    processedAtMs: r.processed_at_ms,
  };
}

type SqliteTransactionLogRow = {
  id: number;
  intent_hash: string;
  cardano_tx_hash: string;
  router_id: string;
  destination_index: number;
  destination_chain_name: string;
  destination_contract_address: string;
  symbol: string;
  price: string;
  timestamp: number;
  status: string;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  fee_paid_lovelace: string | null;
  confirmed_at_depth: number | null;
  submitted_at_ms: number | null;
  confirmed_at_ms: number | null;
  failed_at_ms: number | null;
  created_at_ms: number;
};

function fromSqliteTransactionLogRow(r: SqliteTransactionLogRow): TransactionLogRow {
  return {
    id: r.id,
    intentHash: r.intent_hash,
    cardanoTxHash: r.cardano_tx_hash,
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    destinationChainName: r.destination_chain_name,
    destinationContractAddress: r.destination_contract_address,
    symbol: r.symbol,
    price: r.price,
    timestamp: r.timestamp,
    status: r.status as TransactionLogRow["status"],
    errorCode: r.error_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    feePaidLovelace: r.fee_paid_lovelace ?? undefined,
    confirmedAtDepth: r.confirmed_at_depth ?? undefined,
    submittedAtMs: r.submitted_at_ms ?? undefined,
    confirmedAtMs: r.confirmed_at_ms ?? undefined,
    failedAtMs: r.failed_at_ms ?? undefined,
    createdAtMs: r.created_at_ms,
  };
}

type SqliteContractSymbolUpdateRow = {
  id: number;
  chain_id: number;
  contract_address: string;
  symbol: string;
  last_intent_hash: string | null;
  last_cardano_tx_hash: string | null;
  last_price: string;
  last_timestamp: number;
  last_update_ms: number;
  last_confirmed_at_depth: number | null;
  update_count: number;
  total_fee_paid_lovelace: string | null;
};

function fromSqliteContractSymbolUpdateRow(r: SqliteContractSymbolUpdateRow): ContractSymbolUpdateRow {
  return {
    id: r.id,
    chainId: r.chain_id,
    contractAddress: r.contract_address,
    symbol: r.symbol,
    lastIntentHash: r.last_intent_hash ?? undefined,
    lastCardanoTxHash: r.last_cardano_tx_hash ?? undefined,
    lastPrice: r.last_price,
    lastTimestamp: r.last_timestamp,
    lastUpdateMs: r.last_update_ms,
    lastConfirmedAtDepth: r.last_confirmed_at_depth ?? undefined,
    updateCount: r.update_count,
    totalFeePaidLovelace: r.total_fee_paid_lovelace ?? undefined,
  };
}

type SqlitePerformanceMetricRow = {
  id: number;
  metric_name: string;
  metric_value: number;
  labels_json: string;
  recorded_at_ms: number;
};

function fromSqlitePerformanceMetricRow(r: SqlitePerformanceMetricRow): PerformanceMetricRow {
  return {
    id: r.id,
    metricName: r.metric_name,
    metricValue: r.metric_value,
    labelsJson: r.labels_json,
    recordedAtMs: r.recorded_at_ms,
  };
}

type SqliteAlertLogRow = {
  id: number;
  alert_name: string;
  severity: string;
  message: string;
  labels_json: string;
  fired_at_ms: number;
  resolved_at_ms: number | null;
  acknowledged: number;
};

function fromSqliteAlertLogRow(r: SqliteAlertLogRow): AlertLogRow {
  return {
    id: r.id,
    alertName: r.alert_name,
    severity: r.severity as AlertLogRow["severity"],
    message: r.message,
    labelsJson: r.labels_json,
    firedAtMs: r.fired_at_ms,
    resolvedAtMs: r.resolved_at_ms ?? undefined,
    acknowledged: r.acknowledged !== 0,
  };
}

// ---------------------------------------------------------------------------
// Postgres row types + mappers
// ---------------------------------------------------------------------------

type PgChainStateRow = {
  id: string;
  chain_id: number;
  chain_name: string;
  contract_id: string;
  last_processed_block: string;
  last_scan_block: string;
  is_healthy: boolean;
  error_count: number;
  last_error: string | null;
  last_health_check_ms: string | null;
  updated_at_ms: string;
};

function fromPgChainStateRow(r: PgChainStateRow): ChainStateRow {
  return {
    id: Number(r.id),
    chainId: r.chain_id,
    chainName: r.chain_name,
    contractId: r.contract_id,
    lastProcessedBlock: BigInt(r.last_processed_block),
    lastScanBlock: BigInt(r.last_scan_block),
    isHealthy: r.is_healthy,
    errorCount: r.error_count,
    lastError: r.last_error ?? undefined,
    lastHealthCheckMs: r.last_health_check_ms ? Number(r.last_health_check_ms) : undefined,
    updatedAtMs: Number(r.updated_at_ms),
  };
}

type PgProcessedEventRow = {
  intent_hash: string;
  event_id: string | null;
  event_name: string | null;
  tx_hash: string;
  log_index: number;
  block_number: string;
  router_id: string;
  destination_index: number;
  status: string;
  filter_reason: string | null;
  processed_at_ms: string;
};

function fromPgProcessedEventRow(r: PgProcessedEventRow): ProcessedEventRow {
  return {
    intentHash: r.intent_hash,
    eventId: r.event_id ?? undefined,
    eventName: r.event_name ?? undefined,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockNumber: BigInt(r.block_number),
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    status: r.status as ProcessedEventRow["status"],
    filterReason: r.filter_reason ?? undefined,
    processedAtMs: Number(r.processed_at_ms),
  };
}

type PgTransactionLogRow = {
  id: string;
  intent_hash: string;
  cardano_tx_hash: string;
  router_id: string;
  destination_index: number;
  destination_chain_name: string;
  destination_contract_address: string;
  symbol: string;
  price: string;
  timestamp: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  fee_paid_lovelace: string | null;
  confirmed_at_depth: number | null;
  submitted_at_ms: string | null;
  confirmed_at_ms: string | null;
  failed_at_ms: string | null;
  created_at_ms: string;
};

function fromPgTransactionLogRow(r: PgTransactionLogRow): TransactionLogRow {
  return {
    id: Number(r.id),
    intentHash: r.intent_hash,
    cardanoTxHash: r.cardano_tx_hash,
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    destinationChainName: r.destination_chain_name,
    destinationContractAddress: r.destination_contract_address,
    symbol: r.symbol,
    price: r.price,
    timestamp: Number(r.timestamp),
    status: r.status as TransactionLogRow["status"],
    errorCode: r.error_code ?? undefined,
    errorMessage: r.error_message ?? undefined,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
    feePaidLovelace: r.fee_paid_lovelace ?? undefined,
    confirmedAtDepth: r.confirmed_at_depth ?? undefined,
    submittedAtMs: r.submitted_at_ms ? Number(r.submitted_at_ms) : undefined,
    confirmedAtMs: r.confirmed_at_ms ? Number(r.confirmed_at_ms) : undefined,
    failedAtMs: r.failed_at_ms ? Number(r.failed_at_ms) : undefined,
    createdAtMs: Number(r.created_at_ms),
  };
}

type PgContractSymbolUpdateRow = {
  id: string;
  chain_id: number;
  contract_address: string;
  symbol: string;
  last_intent_hash: string | null;
  last_cardano_tx_hash: string | null;
  last_price: string;
  last_timestamp: string;
  last_update_ms: string;
  last_confirmed_at_depth: number | null;
  update_count: number;
  total_fee_paid_lovelace: string | null;
};

function fromPgContractSymbolUpdateRow(r: PgContractSymbolUpdateRow): ContractSymbolUpdateRow {
  return {
    id: Number(r.id),
    chainId: r.chain_id,
    contractAddress: r.contract_address,
    symbol: r.symbol,
    lastIntentHash: r.last_intent_hash ?? undefined,
    lastCardanoTxHash: r.last_cardano_tx_hash ?? undefined,
    lastPrice: r.last_price,
    lastTimestamp: Number(r.last_timestamp),
    lastUpdateMs: Number(r.last_update_ms),
    lastConfirmedAtDepth: r.last_confirmed_at_depth ?? undefined,
    updateCount: r.update_count,
    totalFeePaidLovelace: r.total_fee_paid_lovelace ?? undefined,
  };
}

type PgPerformanceMetricRow = {
  id: string;
  metric_name: string;
  metric_value: number;
  labels_json: string;
  recorded_at_ms: string;
};

function fromPgPerformanceMetricRow(r: PgPerformanceMetricRow): PerformanceMetricRow {
  return {
    id: Number(r.id),
    metricName: r.metric_name,
    metricValue: r.metric_value,
    labelsJson: typeof r.labels_json === "string" ? r.labels_json : JSON.stringify(r.labels_json),
    recordedAtMs: Number(r.recorded_at_ms),
  };
}

type PgAlertLogRow = {
  id: string;
  alert_name: string;
  severity: string;
  message: string;
  labels_json: string;
  fired_at_ms: string;
  resolved_at_ms: string | null;
  acknowledged: boolean;
};

function fromPgAlertLogRow(r: PgAlertLogRow): AlertLogRow {
  return {
    id: Number(r.id),
    alertName: r.alert_name,
    severity: r.severity as AlertLogRow["severity"],
    message: r.message,
    labelsJson: typeof r.labels_json === "string" ? r.labels_json : JSON.stringify(r.labels_json),
    firedAtMs: Number(r.fired_at_ms),
    resolvedAtMs: r.resolved_at_ms ? Number(r.resolved_at_ms) : undefined,
    acknowledged: r.acknowledged,
  };
}

// ---------------------------------------------------------------------------
// Minimal structural types for dynamic imports.
// ---------------------------------------------------------------------------

type BetterSqlite3Like = {
  pragma(s: string): void;
  exec(s: string): void;
  prepare(s: string): {
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
};

type PgPoolLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};
