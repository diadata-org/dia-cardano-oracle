// R10.C.3 — checkpoint-db tests (against a real in-memory SQLite Db).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createDb, type Db } from "../../persistence/db.js";
import { createDbCheckpoint } from "../checkpoint-db.js";

const CHAIN_ID = 10050;
const CONTRACT = "intent-registry-testnet";

let db: Db;

beforeEach(async () => {
  db = await createDb({ driver: "sqlite", path: ":memory:" });
  await db.migrate();
});

afterEach(async () => {
  await db.close();
});

describe("createDbCheckpoint", () => {
  it("load() returns null when the chain_state row does not exist", async () => {
    const cp = createDbCheckpoint({ db, chainId: CHAIN_ID, contractId: CONTRACT });
    assert.equal(await cp.load(), null);
  });

  it("save() persists the block and load() returns it as bigint", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    const cp = createDbCheckpoint({ db, chainId: CHAIN_ID, contractId: CONTRACT });
    await cp.save(9_342_084n);
    const loaded = await cp.load();
    assert.equal(loaded, 9_342_084n);
    assert.equal(typeof loaded, "bigint");
  });

  it("save() propagates the error when the chain_state row is missing (no silent swallow)", async () => {
    // No initialiseChainState → setLastScanBlock throws (R10.A.5 sibling guard).
    const cp = createDbCheckpoint({ db, chainId: CHAIN_ID, contractId: CONTRACT });
    await assert.rejects(() => cp.save(1n), /no chain_state row/);
  });

  it("uses the configured chainId/contractId for both load and save", async () => {
    await db.initialiseChainState({ chainId: CHAIN_ID, chainName: "Preview", contractId: CONTRACT });
    await db.initialiseChainState({ chainId: 999, chainName: "Other", contractId: "other" });
    const cp = createDbCheckpoint({ db, chainId: CHAIN_ID, contractId: CONTRACT });
    await cp.save(42n);
    // The other row must be untouched.
    assert.equal((await db.getChainState(999, "other"))?.lastScanBlock, 0n);
    assert.equal((await db.getChainState(CHAIN_ID, CONTRACT))?.lastScanBlock, 42n);
  });
});
