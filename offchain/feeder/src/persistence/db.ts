// Pluggable database adapter.
//
// The feeder needs three tables:
//
//   processed_events  — one row per decoded IntentRegistered log that
//                       passed the dedup check; used to resume on
//                       restart and to answer audit queries.
//
//   chain_state       — one row per (chainId, contractId); holds the
//                       last processed block number so a restart
//                       resumes from where it left off.
//
//   transaction_log   — one row per Cardano submission attempt; holds
//                       the intentHash, Cardano txHash, status, and
//                       timestamps.
//
// Both SQLite (default) and Postgres (opt-in via DATABASE_DRIVER=postgres
// + DATABASE_DSN) are supported through the same `Db` interface.
//
// The concrete driver is resolved lazily so the feeder can start with
// SQLite without having `pg` installed, and switch to Postgres just by
// changing env vars.
//
// SQLite driver: `better-sqlite3` (synchronous) wrapped in tiny async
// shims so the Db interface is consistently async.
// Postgres driver: `pg` with parameterized queries.

// ---------------------------------------------------------------------------
// Abstract interface
// ---------------------------------------------------------------------------

export type ProcessedEventRow = {
  intentHash: string;
  chainId: number;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  symbol: string;
  price: string;
  timestamp: string;
  signer: string;
  routerId: string;
  destinationIndex: number;
  processedAtMs: number;
};

export type ChainStateRow = {
  chainId: number;
  contractId: string;
  lastProcessedBlock: bigint;
  updatedAtMs: number;
};

export type TransactionLogRow = {
  id?: number;
  intentHash: string;
  cardanoTxHash: string;
  routerId: string;
  destinationIndex: number;
  clientStatePath: string;
  status: "submitted" | "confirmed" | "failed";
  errorMessage?: string;
  submittedAtMs: number;
  confirmedAtMs?: number;
};

export type Db = {
  /** Idempotent schema setup. Run once at startup. */
  migrate(): Promise<void>;

  // processed_events
  upsertProcessedEvent(row: ProcessedEventRow): Promise<void>;
  hasProcessedEvent(intentHash: string): Promise<boolean>;

  // chain_state
  getLastProcessedBlock(chainId: number, contractId: string): Promise<bigint | null>;
  setLastProcessedBlock(chainId: number, contractId: string, block: bigint): Promise<void>;

  // transaction_log
  insertTransactionLog(row: TransactionLogRow): Promise<void>;
  updateTransactionLog(
    intentHash: string,
    cardanoTxHash: string,
    update: Pick<TransactionLogRow, "status" | "errorMessage" | "confirmedAtMs">,
  ): Promise<void>;
  getTransactionLog(intentHash: string): Promise<TransactionLogRow[]>;

  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Driver-specific implementations
// ---------------------------------------------------------------------------

// ---  SQLite (better-sqlite3)  ---

async function createSqliteDb(filePath: string): Promise<Db> {
  // Dynamic import keeps better-sqlite3 optional — if the package is absent
  // and Postgres is configured, this code path is never reached.
  const mod = "better-sqlite3";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { default: Database } = (await import(mod)) as any as {
    default: (path: string) => BetterSqlite3Like;
  };
  const db = Database(filePath);

  // Enable WAL for concurrent reads alongside writes.
  db.pragma("journal_mode = WAL");

  return {
    async migrate() {
      db.exec(SQLITE_SCHEMA);
    },

    async upsertProcessedEvent(row) {
      db.prepare(`
        INSERT INTO processed_events
          (intent_hash, chain_id, block_number, tx_hash, log_index, symbol,
           price, timestamp, signer, router_id, destination_index, processed_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(intent_hash) DO NOTHING
      `).run(
        row.intentHash, row.chainId, String(row.blockNumber), row.txHash,
        row.logIndex, row.symbol, row.price, row.timestamp, row.signer,
        row.routerId, row.destinationIndex, row.processedAtMs,
      );
    },

    async hasProcessedEvent(intentHash) {
      const r = db.prepare(
        "SELECT 1 FROM processed_events WHERE intent_hash = ?",
      ).get(intentHash);
      return r !== undefined;
    },

    async getLastProcessedBlock(chainId, contractId) {
      const r = db.prepare(
        "SELECT last_processed_block FROM chain_state WHERE chain_id = ? AND contract_id = ?",
      ).get(chainId, contractId) as { last_processed_block: string } | undefined;
      return r ? BigInt(r.last_processed_block) : null;
    },

    async setLastProcessedBlock(chainId, contractId, block) {
      db.prepare(`
        INSERT INTO chain_state (chain_id, contract_id, last_processed_block, updated_at_ms)
        VALUES (?,?,?,?)
        ON CONFLICT(chain_id, contract_id)
        DO UPDATE SET last_processed_block = excluded.last_processed_block,
                      updated_at_ms = excluded.updated_at_ms
      `).run(chainId, contractId, String(block), Date.now());
    },

    async insertTransactionLog(row) {
      db.prepare(`
        INSERT INTO transaction_log
          (intent_hash, cardano_tx_hash, router_id, destination_index,
           client_state_path, status, error_message, submitted_at_ms, confirmed_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        row.intentHash, row.cardanoTxHash, row.routerId, row.destinationIndex,
        row.clientStatePath, row.status, row.errorMessage ?? null,
        row.submittedAtMs, row.confirmedAtMs ?? null,
      );
    },

    async updateTransactionLog(intentHash, cardanoTxHash, update) {
      db.prepare(`
        UPDATE transaction_log
        SET status = ?, error_message = ?, confirmed_at_ms = ?
        WHERE intent_hash = ? AND cardano_tx_hash = ?
      `).run(
        update.status, update.errorMessage ?? null, update.confirmedAtMs ?? null,
        intentHash, cardanoTxHash,
      );
    },

    async getTransactionLog(intentHash) {
      const rows = db.prepare(
        "SELECT * FROM transaction_log WHERE intent_hash = ? ORDER BY submitted_at_ms ASC",
      ).all(intentHash) as unknown as SqliteTransactionLogRow[];
      return rows.map(fromSqliteTransactionLogRow);
    },

    async close() {
      db.close();
    },
  };
}

// ---  Postgres (pg)  ---

async function createPostgresDb(dsn: string): Promise<Db> {
  const mod = "pg";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Pool } = (await import(mod)) as any as { Pool: new (opts: { connectionString: string }) => PgPoolLike };
  const pool = new Pool({ connectionString: dsn });

  return {
    async migrate() {
      await pool.query(POSTGRES_SCHEMA);
    },

    async upsertProcessedEvent(row) {
      await pool.query(
        `INSERT INTO processed_events
           (intent_hash, chain_id, block_number, tx_hash, log_index, symbol,
            price, timestamp, signer, router_id, destination_index, processed_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT(intent_hash) DO NOTHING`,
        [
          row.intentHash, row.chainId, String(row.blockNumber), row.txHash,
          row.logIndex, row.symbol, row.price, row.timestamp, row.signer,
          row.routerId, row.destinationIndex, row.processedAtMs,
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

    async getLastProcessedBlock(chainId, contractId) {
      const r = await pool.query(
        "SELECT last_processed_block FROM chain_state WHERE chain_id = $1 AND contract_id = $2",
        [chainId, contractId],
      );
      const first = r.rows[0] as { last_processed_block: string } | undefined;
      return first ? BigInt(first.last_processed_block) : null;
    },

    async setLastProcessedBlock(chainId, contractId, block) {
      await pool.query(
        `INSERT INTO chain_state (chain_id, contract_id, last_processed_block, updated_at_ms)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT(chain_id, contract_id)
         DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block,
                       updated_at_ms = EXCLUDED.updated_at_ms`,
        [chainId, contractId, String(block), Date.now()],
      );
    },

    async insertTransactionLog(row) {
      await pool.query(
        `INSERT INTO transaction_log
           (intent_hash, cardano_tx_hash, router_id, destination_index,
            client_state_path, status, error_message, submitted_at_ms, confirmed_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.intentHash, row.cardanoTxHash, row.routerId, row.destinationIndex,
          row.clientStatePath, row.status, row.errorMessage ?? null,
          row.submittedAtMs, row.confirmedAtMs ?? null,
        ],
      );
    },

    async updateTransactionLog(intentHash, cardanoTxHash, update) {
      await pool.query(
        `UPDATE transaction_log
         SET status = $1, error_message = $2, confirmed_at_ms = $3
         WHERE intent_hash = $4 AND cardano_tx_hash = $5`,
        [
          update.status, update.errorMessage ?? null, update.confirmedAtMs ?? null,
          intentHash, cardanoTxHash,
        ],
      );
    },

    async getTransactionLog(intentHash) {
      const r = await pool.query(
        "SELECT * FROM transaction_log WHERE intent_hash = $1 ORDER BY submitted_at_ms ASC",
        [intentHash],
      );
      return (r.rows as unknown as PgTransactionLogRow[]).map(fromPgTransactionLogRow);
    },

    async close() {
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export type DbConfig = {
  driver: "sqlite" | "postgres";
  /** SQLite file path. Defaults to `state/<network>/feeder.sqlite`. */
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
  const filePath = config.path ?? "state/feeder.sqlite";
  return createSqliteDb(filePath);
}

// ---------------------------------------------------------------------------
// SQL schemas
// ---------------------------------------------------------------------------

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
  intent_hash        TEXT    PRIMARY KEY,
  chain_id           INTEGER NOT NULL,
  block_number       TEXT    NOT NULL,
  tx_hash            TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,
  symbol             TEXT    NOT NULL,
  price              TEXT    NOT NULL,
  timestamp          TEXT    NOT NULL,
  signer             TEXT    NOT NULL,
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  processed_at_ms    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_state (
  chain_id              INTEGER NOT NULL,
  contract_id           TEXT    NOT NULL,
  last_processed_block  TEXT    NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  PRIMARY KEY (chain_id, contract_id)
);

CREATE TABLE IF NOT EXISTS transaction_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_hash        TEXT    NOT NULL,
  cardano_tx_hash    TEXT    NOT NULL,
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  client_state_path  TEXT    NOT NULL,
  status             TEXT    NOT NULL,
  error_message      TEXT,
  submitted_at_ms    INTEGER NOT NULL,
  confirmed_at_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS tx_log_intent_hash ON transaction_log(intent_hash);
`;

const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_events (
  intent_hash        TEXT    PRIMARY KEY,
  chain_id           INTEGER NOT NULL,
  block_number       TEXT    NOT NULL,
  tx_hash            TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,
  symbol             TEXT    NOT NULL,
  price              TEXT    NOT NULL,
  timestamp          TEXT    NOT NULL,
  signer             TEXT    NOT NULL,
  router_id          TEXT    NOT NULL,
  destination_index  INTEGER NOT NULL,
  processed_at_ms    BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_state (
  chain_id              INTEGER NOT NULL,
  contract_id           TEXT    NOT NULL,
  last_processed_block  TEXT    NOT NULL,
  updated_at_ms         BIGINT  NOT NULL,
  PRIMARY KEY (chain_id, contract_id)
);

CREATE TABLE IF NOT EXISTS transaction_log (
  id                 BIGSERIAL PRIMARY KEY,
  intent_hash        TEXT   NOT NULL,
  cardano_tx_hash    TEXT   NOT NULL,
  router_id          TEXT   NOT NULL,
  destination_index  INTEGER NOT NULL,
  client_state_path  TEXT   NOT NULL,
  status             TEXT   NOT NULL,
  error_message      TEXT,
  submitted_at_ms    BIGINT NOT NULL,
  confirmed_at_ms    BIGINT
);
CREATE INDEX IF NOT EXISTS tx_log_intent_hash ON transaction_log(intent_hash);
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type SqliteTransactionLogRow = {
  id: number;
  intent_hash: string;
  cardano_tx_hash: string;
  router_id: string;
  destination_index: number;
  client_state_path: string;
  status: string;
  error_message: string | null;
  submitted_at_ms: number;
  confirmed_at_ms: number | null;
};

function fromSqliteTransactionLogRow(r: SqliteTransactionLogRow): TransactionLogRow {
  return {
    id: r.id,
    intentHash: r.intent_hash,
    cardanoTxHash: r.cardano_tx_hash,
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    clientStatePath: r.client_state_path,
    status: r.status as TransactionLogRow["status"],
    errorMessage: r.error_message ?? undefined,
    submittedAtMs: r.submitted_at_ms,
    confirmedAtMs: r.confirmed_at_ms ?? undefined,
  };
}

type PgTransactionLogRow = {
  id: string;
  intent_hash: string;
  cardano_tx_hash: string;
  router_id: string;
  destination_index: number;
  client_state_path: string;
  status: string;
  error_message: string | null;
  submitted_at_ms: string;
  confirmed_at_ms: string | null;
};

function fromPgTransactionLogRow(r: PgTransactionLogRow): TransactionLogRow {
  return {
    id: Number(r.id),
    intentHash: r.intent_hash,
    cardanoTxHash: r.cardano_tx_hash,
    routerId: r.router_id,
    destinationIndex: r.destination_index,
    clientStatePath: r.client_state_path,
    status: r.status as TransactionLogRow["status"],
    errorMessage: r.error_message ?? undefined,
    submittedAtMs: Number(r.submitted_at_ms),
    confirmedAtMs: r.confirmed_at_ms ? Number(r.confirmed_at_ms) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Minimal structural types for dynamic imports (avoids adding @types/better-sqlite3
// and @types/pg as mandatory devDependencies when drivers may not be installed).
// ---------------------------------------------------------------------------

type BetterSqlite3Like = {
  pragma(s: string): void;
  exec(s: string): void;
  prepare(s: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
};

type PgPoolLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};
