// Tx-level metric helpers: a batch of N pairs must count as ONE transaction,
// and intents the feeder declined to submit (no tx, no fee) must not count as
// failed transactions. These two helpers encode exactly that.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNoTransactionFailure,
  isTransactionRepresentative,
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
