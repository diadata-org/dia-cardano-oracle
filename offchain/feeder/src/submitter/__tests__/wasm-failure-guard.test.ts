import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTransientWasmBuildError,
  nextWasmFailureCount,
  shouldExitOnWasmFailures,
} from "../wasm-failure-guard.js";

describe("isTransientWasmBuildError", () => {
  it("matches the detached-ArrayBuffer signature", () => {
    assert.equal(
      isTransientWasmBuildError(
        new Error(
          "Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer",
        ),
      ),
      true,
    );
  });

  it("matches a bare 'detached' message and the %TypedArray% form", () => {
    assert.equal(isTransientWasmBuildError(new Error("buffer is detached")), true);
    assert.equal(
      isTransientWasmBuildError("%TypedArray%.prototype.set failed"),
      true,
    );
  });

  it("does NOT match unrelated errors", () => {
    assert.equal(isTransientWasmBuildError(new Error("insufficient funds")), false);
    assert.equal(isTransientWasmBuildError(new Error("fee too small")), false);
    assert.equal(isTransientWasmBuildError(undefined), false);
    assert.equal(isTransientWasmBuildError(null), false);
  });
});

describe("nextWasmFailureCount", () => {
  it("increments on a WASM-signature failure", () => {
    const wasmErr = new Error("detached ArrayBuffer");
    assert.equal(nextWasmFailureCount(0, { ok: false, error: wasmErr }), 1);
    assert.equal(nextWasmFailureCount(4, { ok: false, error: wasmErr }), 5);
  });

  it("RESETS to 0 on any successful submission", () => {
    assert.equal(nextWasmFailureCount(4, { ok: true }), 0);
    assert.equal(nextWasmFailureCount(0, { ok: true }), 0);
  });

  it("leaves the WASM count UNCHANGED on a non-WASM failure", () => {
    const otherErr = new Error("insufficient funds");
    assert.equal(nextWasmFailureCount(0, { ok: false, error: otherErr }), 0);
    assert.equal(nextWasmFailureCount(3, { ok: false, error: otherErr }), 3);
  });
});

describe("shouldExitOnWasmFailures", () => {
  it("returns false below the threshold", () => {
    assert.equal(shouldExitOnWasmFailures(0, 5), false);
    assert.equal(shouldExitOnWasmFailures(4, 5), false);
  });

  it("returns true at or above the threshold", () => {
    assert.equal(shouldExitOnWasmFailures(5, 5), true);
    assert.equal(shouldExitOnWasmFailures(6, 5), true);
  });
});

describe("consecutive-WASM tracker — end-to-end counter transitions", () => {
  it("counts only consecutive WASM failures and triggers exit at threshold", () => {
    const threshold = 3;
    const wasmErr = new Error("Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer");
    const otherErr = new Error("balance too low");
    let count = 0;
    const exits: number[] = [];

    // Decision helper mirrors the daemon's onResult: update the counter, then
    // decide whether to "exit" (we record instead of calling process.exit).
    const step = (outcome: { ok: boolean; error?: unknown }) => {
      count = nextWasmFailureCount(count, outcome);
      if (shouldExitOnWasmFailures(count, threshold)) {
        exits.push(count);
      }
    };

    step({ ok: false, error: wasmErr }); // 1
    step({ ok: false, error: otherErr }); // unchanged → 1 (non-WASM)
    assert.equal(count, 1);
    assert.equal(exits.length, 0);

    step({ ok: false, error: wasmErr }); // 2
    step({ ok: true }); // reset → 0
    assert.equal(count, 0);
    assert.equal(exits.length, 0);

    // Now three consecutive WASM failures reach the threshold.
    step({ ok: false, error: wasmErr }); // 1
    step({ ok: false, error: wasmErr }); // 2
    step({ ok: false, error: wasmErr }); // 3 → exit
    assert.equal(count, 3);
    assert.deepEqual(exits, [3]);
  });
});
