import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isStaleInputError,
  withStaleInputReconcile,
} from "../reconcile-retry.js";

describe("isStaleInputError", () => {
  it("classifies stale-input ledger rejections as reconcilable", () => {
    for (const message of [
      "BadInputsUTxO",
      "transaction submit error ... BadInputsUTxO [ ... ]",
      "TranslationLogicMissingInput",
      "UtxoNotFound",
      "the UTxO was not found",
      "missing input for transaction",
    ]) {
      assert.equal(isStaleInputError(new Error(message)), true, message);
    }
  });

  it("does NOT classify unrelated errors as stale-input", () => {
    for (const message of [
      "NonMonotonicNonce",
      "ScriptExecutionFailure",
      "fetch failed",
      "amount exceeds balance",
      "ValueNotConservedUTxO",
    ]) {
      assert.equal(isStaleInputError(new Error(message)), false, message);
    }
  });

  it("inspects a nested cause", () => {
    const wrapped = new Error("submit failed");
    (wrapped as Error & { cause?: unknown }).cause = new Error("BadInputsUTxO");
    assert.equal(isStaleInputError(wrapped), true);
  });
});

describe("withStaleInputReconcile", () => {
  const opts = { maxAttempts: 3, isRetriable: isStaleInputError, sleep: async () => {} };

  it("returns the result on the first try with no reconcile", async () => {
    let ops = 0;
    let reconciles = 0;
    const result = await withStaleInputReconcile(
      async () => {
        ops += 1;
        return "ok";
      },
      async () => {
        reconciles += 1;
      },
      opts,
    );
    assert.equal(result, "ok");
    assert.equal(ops, 1);
    assert.equal(reconciles, 0);
  });

  it("reconciles + rebuilds on a stale-input error, then succeeds", async () => {
    let ops = 0;
    const reconcileAttempts: number[] = [];
    const result = await withStaleInputReconcile(
      async () => {
        ops += 1;
        if (ops < 3) throw new Error("BadInputsUTxO");
        return "recovered";
      },
      async (attempt) => {
        reconcileAttempts.push(attempt);
      },
      opts,
    );
    assert.equal(result, "recovered");
    assert.equal(ops, 3, "two failures then success");
    assert.deepEqual(reconcileAttempts, [1, 2], "reconcile ran before each rebuild");
  });

  it("rethrows a non-stale error immediately without reconciling", async () => {
    let ops = 0;
    let reconciles = 0;
    await assert.rejects(
      withStaleInputReconcile(
        async () => {
          ops += 1;
          throw new Error("NonMonotonicNonce");
        },
        async () => {
          reconciles += 1;
        },
        opts,
      ),
      /NonMonotonicNonce/,
    );
    assert.equal(ops, 1, "non-stale errors are not retried");
    assert.equal(reconciles, 0);
  });

  it("rethrows the last stale error after exhausting attempts", async () => {
    let ops = 0;
    await assert.rejects(
      withStaleInputReconcile(
        async () => {
          ops += 1;
          throw new Error("BadInputsUTxO");
        },
        async () => {},
        opts,
      ),
      /BadInputsUTxO/,
    );
    assert.equal(ops, 3, "exactly maxAttempts build attempts");
  });
});
