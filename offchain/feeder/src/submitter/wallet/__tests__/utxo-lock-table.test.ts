import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createUtxoLockTable, makeUtxoLockEntry } from "../utxo-lock-table.js";

describe("UtxoLockTable", () => {
  it("locks an outRef for a wallet and reports it locked", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });

    table.lock(makeUtxoLockEntry("w1", "tx#0", "res-1", { timeoutMs: 60_000, now: () => now }));

    assert.equal(table.isLocked("w1", "tx#0"), true);
    assert.equal(table.isLocked("w1", "tx#1"), false, "a different outRef is free");
  });

  it("keeps locks per (walletId, outRef): the same outRef on another wallet is independent", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });

    table.lock(makeUtxoLockEntry("w1", "tx#0", "res-1", { timeoutMs: 60_000, now: () => now }));

    assert.equal(table.isLocked("w1", "tx#0"), true);
    assert.equal(table.isLocked("w2", "tx#0"), false, "same outRef on a different wallet is not locked");
  });

  it("lockedOutRefs returns only the live locks for a wallet", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });

    table.lock(makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w1", "b#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w2", "c#0", "res-2", { timeoutMs: 60_000, now: () => now }));

    assert.deepEqual(table.lockedOutRefs("w1"), new Set(["a#0", "b#0"]));
    assert.deepEqual(table.lockedOutRefs("w2"), new Set(["c#0"]));
    assert.deepEqual(table.lockedOutRefs("w3"), new Set());
  });

  it("releases a single outRef without touching the rest", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });
    table.lock(makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w1", "b#0", "res-1", { timeoutMs: 60_000, now: () => now }));

    table.release("w1", "a#0");

    assert.equal(table.isLocked("w1", "a#0"), false);
    assert.equal(table.isLocked("w1", "b#0"), true);
  });

  it("releaseReservation frees every outRef locked under one reservation", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });
    table.lock(makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w1", "b#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w1", "c#0", "res-2", { timeoutMs: 60_000, now: () => now }));

    table.releaseReservation("res-1");

    assert.deepEqual(table.lockedOutRefs("w1"), new Set(["c#0"]), "only res-2 survives");
  });

  it("reads an expired lock as free (lazy expiry on isLocked / lockedOutRefs)", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });
    table.lock(makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 60_000, now: () => now }));

    now += 60_001;
    assert.equal(table.isLocked("w1", "a#0"), false, "expired lock reads as free");
    assert.deepEqual(table.lockedOutRefs("w1"), new Set(), "expired lock absent from lockedOutRefs");
  });

  it("evictExpired sweeps timed-out locks and returns the count", () => {
    let now = 1_000;
    const table = createUtxoLockTable({ now: () => now });
    table.lock(makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 60_000, now: () => now }));
    table.lock(makeUtxoLockEntry("w1", "b#0", "res-1", { timeoutMs: 120_000, now: () => now }));

    now += 60_001;
    const evicted = table.evictExpired();
    assert.equal(evicted, 1, "only the 60s lock expired");
    assert.equal(table.all().length, 1, "the 120s lock survives");
    assert.equal(table.isLocked("w1", "b#0"), true);
  });

  it("makeUtxoLockEntry rejects a non-positive timeout", () => {
    assert.throws(
      () => makeUtxoLockEntry("w1", "a#0", "res-1", { timeoutMs: 0 }),
      /positive number/,
    );
  });
});
