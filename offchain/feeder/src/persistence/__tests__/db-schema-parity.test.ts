// Schema parity test: verifies that every column defined in the SQLite
// schema has an equivalent column name in the Postgres schema and vice
// versa. Catches drift between the two DDL strings maintained in db.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a map of { tableName -> Set<columnName> } from a SQL DDL string.
 * Only column definitions inside CREATE TABLE blocks are parsed; index
 * definitions and constraints are skipped.
 */
function extractTableColumns(schema: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  // Match each CREATE TABLE block (non-greedy up to the closing parenthesis
  // that is followed by a semicolon or end of string).
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^;]+)\)/gi;

  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(schema)) !== null) {
    const tableName = tableMatch[1]!.toLowerCase();
    const body = tableMatch[2]!;

    const columns = new Set<string>();

    // Split the table body into lines and pick out column definitions.
    // A column definition starts with a bare identifier (not a constraint
    // keyword like PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY, etc.).
    const constraintKeywords = new Set([
      "primary", "unique", "check", "foreign", "constraint",
    ]);

    for (const rawLine of body.split(",")) {
      const line = rawLine.trim();
      if (!line) continue;

      // First token
      const firstToken = line.split(/\s+/)[0]?.toLowerCase() ?? "";

      // Skip if it starts with a constraint keyword
      if (constraintKeywords.has(firstToken)) continue;

      // Also skip lines that start with a parenthesis (can happen in nested
      // CHECK expressions after splitting on comma).
      if (firstToken.startsWith("(")) continue;

      // The first token is the column name (strip any surrounding backticks
      // or double-quotes, though our schemas don't use them).
      const colName = firstToken.replace(/["`]/g, "");
      if (colName) {
        columns.add(colName);
      }
    }

    result.set(tableName, columns);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("db-schema-parity", () => {
  const sqliteTables = extractTableColumns(SQLITE_SCHEMA);
  const postgresTables = extractTableColumns(POSTGRES_SCHEMA);

  it("both schemas define the same set of tables", () => {
    const sqliteTableNames = Array.from(sqliteTables.keys()).sort();
    const postgresTableNames = Array.from(postgresTables.keys()).sort();
    assert.deepEqual(
      sqliteTableNames,
      postgresTableNames,
      `table name mismatch: sqlite=${JSON.stringify(sqliteTableNames)} postgres=${JSON.stringify(postgresTableNames)}`,
    );
  });

  for (const [tableName, sqliteCols] of sqliteTables) {
    it(`table '${tableName}': every SQLite column appears in Postgres`, () => {
      const pgCols = postgresTables.get(tableName);
      assert.ok(pgCols, `Table '${tableName}' not found in Postgres schema`);

      const missingInPg = Array.from(sqliteCols).filter((c) => !pgCols.has(c));
      assert.deepEqual(
        missingInPg,
        [],
        `Columns in SQLite but missing from Postgres for '${tableName}': ${JSON.stringify(missingInPg)}`,
      );
    });

    it(`table '${tableName}': no extra columns in Postgres vs SQLite`, () => {
      const pgCols = postgresTables.get(tableName);
      assert.ok(pgCols, `Table '${tableName}' not found in Postgres schema`);

      const missingInSqlite = Array.from(pgCols).filter((c) => !sqliteCols.has(c));
      assert.deepEqual(
        missingInSqlite,
        [],
        `Columns in Postgres but missing from SQLite for '${tableName}': ${JSON.stringify(missingInSqlite)}`,
      );
    });
  }
});
