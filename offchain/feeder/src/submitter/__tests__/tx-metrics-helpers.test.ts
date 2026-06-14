// Tx-level metric helpers: a batch of N pairs must count as ONE transaction,
// and intents the feeder declined to submit (no tx, no fee) must not count as
// failed transactions. These two helpers encode exactly that.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNoTransactionFailure,
  isTransactionRepresentative,
  routerIdsForTransaction,
  type BatchSubmissionInfo,
  type SubmitResultErr,
  type SubmitResultOk,
} from "../types.js";

const batchOf = (...intentHashes: string[]): BatchSubmissionInfo => ({
  size: intentHashes.length,
  members: intentHashes.map((intentHash) => ({ intentHash, symbol: `${intentHash}/USD` })),
});

const ok = (intentHash: string, batch?: BatchSubmissionInfo): SubmitResultOk => ({
  ok: true,
  cardanoTxHash: "0xtx",
  intentHash,
  receiverUnit: "r",
  pairUnit: "p",
  ...(batch ? { batch } : {}),
});

const err = (
  intentHash: string,
  code: SubmitResultErr["code"],
  batch?: BatchSubmissionInfo,
): SubmitResultErr => ({
  ok: false,
  intentHash,
  error: new Error("boom"),
  code,
  remediation: "fix it",
  ...(batch ? { batch } : {}),
});

describe("isTransactionRepresentative — one tx counts once", () => {
  it("a single (non-batch) result is its own representative", () => {
    assert.equal(isTransactionRepresentative(ok("a")), true);
    assert.equal(isTransactionRepresentative(err("a", "BuilderError")), true);
  });

  it("only the first batch member represents the tx", () => {
    const batch = batchOf("a", "b", "c");
    assert.equal(isTransactionRepresentative(ok("a", batch)), true);
    assert.equal(isTransactionRepresentative(ok("b", batch)), false);
    assert.equal(isTransactionRepresentative(ok("c", batch)), false);
    // A 3-pair batch fires three results → exactly one is the representative.
    const reps = ["a", "b", "c"].filter((h) => isTransactionRepresentative(ok(h, batch)));
    assert.deepEqual(reps, ["a"]);
  });

  it("a superseded member excluded from batch.members is never the representative", () => {
    // Partial skip: built members are [a, b]; the skipped 'c' carries the same
    // batch (built members only) and is not in it → not a representative.
    const builtBatch = batchOf("a", "b");
    assert.equal(isTransactionRepresentative(err("c", "NonMonotonicNonce", builtBatch)), false);
  });
});

describe("isNoTransactionFailure — condemned intents are not failed txs", () => {
  it("NonMonotonicNonce means no tx was broadcast", () => {
    assert.equal(isNoTransactionFailure(err("a", "NonMonotonicNonce")), true);
  });

  it("real submission failures count as failed txs", () => {
    for (const code of ["BuilderError", "ProviderLag", "TxDroppedFromChain", "WalletInsufficientFunds"] as const) {
      assert.equal(isNoTransactionFailure(err("a", code)), false);
    }
  });
});

describe("routerIdsForTransaction — a mixed-router batch credits every router once", () => {
  // A lane is shared by all routers targeting one client, so one coalesced
  // batch can carry symbols from several routers. The router-membership metric
  // must fire once per distinct contributing router.
  const ownedBy = (routers: Record<string, string>) => (intentHash: string) => routers[intentHash];

  it("a single (non-batch) result resolves to its own router", () => {
    assert.deepEqual(routerIdsForTransaction(ok("a"), "router_majors", ownedBy({ a: "router_majors" })), [
      "router_majors",
    ]);
  });

  it("a batch mixing two routers returns both, deduped and sorted", () => {
    // batch [a, b, c]: a,c from router_majors; b from router_stables.
    const batch = batchOf("a", "b", "c");
    const owners = ownedBy({ a: "router_majors", b: "router_stables", c: "router_majors" });
    assert.deepEqual(routerIdsForTransaction(ok("a", batch), "router_majors", owners), [
      "router_majors",
      "router_stables",
    ]);
    // The representative emits for the whole tx, so the emission set does not
    // depend on which member's result we pass.
    assert.deepEqual(routerIdsForTransaction(ok("b", batch), "router_stables", owners), [
      "router_majors",
      "router_stables",
    ]);
  });

  it("members whose router cannot be resolved are skipped, not invented", () => {
    const batch = batchOf("a", "b");
    // Only 'a' resolves; 'b' is unknown (e.g. evicted runtime entry).
    assert.deepEqual(routerIdsForTransaction(ok("a", batch), "router_fallback", ownedBy({ a: "router_majors" })), [
      "router_majors",
    ]);
  });

  it("falls back to the caller's router only when nothing resolves", () => {
    const batch = batchOf("a", "b");
    assert.deepEqual(routerIdsForTransaction(ok("a", batch), "router_fallback", ownedBy({})), ["router_fallback"]);
  });
});
