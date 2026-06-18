import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { instrumentDb } from "../db-metrics.js";

describe("instrumentDb", () => {
  it("counts + times each mapped db operation and passes the result through", async () => {
    const ops: Array<[string, Record<string, string>]> = [];
    const metrics = {
      bridgeDbOperations: { inc: (l: Record<string, string>) => ops.push(["inc", l]) },
      bridgeDbOperationDuration: { observe: (l: Record<string, string>) => ops.push(["observe", l]) },
    };
    const fakeDb = {
      insertTransactionLog: async (x: string) => `ok-${x}`,
      migrate: async () => "migrated",
    };

    const wrapped = instrumentDb(fakeDb as never, metrics as never);

    const result = await (wrapped as unknown as { insertTransactionLog: (x: string) => Promise<string> })
      .insertTransactionLog("row");

    assert.equal(result, "ok-row"); // underlying method ran, result passed through
    assert.deepEqual(ops[0], ["inc", { table: "transaction_log", operation: "insert" }]);
    assert.equal(ops[1]?.[0], "observe");
    assert.deepEqual(ops[1]?.[1], { table: "transaction_log", operation: "insert" });
  });

  it("leaves unmapped methods (migrate/close) un-instrumented", async () => {
    const ops: string[] = [];
    const metrics = {
      bridgeDbOperations: { inc: () => ops.push("inc") },
      bridgeDbOperationDuration: { observe: () => ops.push("observe") },
    };
    const fakeDb = { migrate: async () => "migrated" };

    const wrapped = instrumentDb(fakeDb as never, metrics as never);
    const result = await (wrapped as unknown as { migrate: () => Promise<string> }).migrate();

    assert.equal(result, "migrated");
    assert.deepEqual(ops, []); // no metric for migrate
  });
});
