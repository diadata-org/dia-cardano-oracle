import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createInflightTable,
  makeInflightEntry,
} from "../inflight.js";

function entry(
  txHash: string,
  receiverUnit: string,
  now: number,
  timeoutMs = 60_000,
) {
  return makeInflightEntry(txHash, `intent-${txHash}`, receiverUnit, {
    timeoutMs,
    now: () => now,
  });
}

describe("createInflightTable", () => {
  it("isLocked returns false when empty", () => {
    const t = createInflightTable();
    assert.equal(t.isLocked("recv-a"), false);
  });

  it("isLocked returns true after add", () => {
    let now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now, 60_000));
    assert.equal(t.isLocked("recv-a"), true);
  });

  it("isLocked returns false after remove", () => {
    let now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now, 60_000));
    t.remove("tx1");
    assert.equal(t.isLocked("recv-a"), false);
  });

  it("isLocked auto-expires when timeout passes", () => {
    let now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now, 500));
    now = 2000;
    assert.equal(t.isLocked("recv-a"), false);
  });

  it("evictExpired removes timed-out entries and returns count", () => {
    let now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now, 500));
    t.add(entry("tx2", "recv-b", now, 9_000));
    now = 2000;
    const evicted = t.evictExpired();
    assert.equal(evicted, 1);
    assert.equal(t.all().length, 1);
    assert.equal(t.all()[0].txHash, "tx2");
  });

  it("remove is a no-op for unknown txHash", () => {
    const t = createInflightTable();
    assert.doesNotThrow(() => t.remove("unknown"));
  });

  it("all() returns a snapshot", () => {
    let now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now));
    t.add(entry("tx2", "recv-b", now));
    assert.equal(t.all().length, 2);
  });

  it("second add for same receiverUnit: last write wins in the lock index", () => {
    const now = 1000;
    const t = createInflightTable({ now: () => now });
    t.add(entry("tx1", "recv-a", now));
    t.add(entry("tx2", "recv-a", now));
    // byReceiverUnit is keyed by receiver, so tx2 overwrote tx1's slot;
    // byTxHash still holds both entries.
    assert.equal(t.all().length, 2);
    assert.equal(t.isLocked("recv-a"), true);
    // Removing tx1 clears it from byTxHash but byReceiverUnit still
    // points to tx2's entry — lock must still be held.
    t.remove("tx1");
    assert.equal(t.all().length, 1); // only tx2 remains in byTxHash
    assert.equal(t.isLocked("recv-a"), true); // tx2 still holds the lock
    t.remove("tx2");
    assert.equal(t.isLocked("recv-a"), false);
  });
});
