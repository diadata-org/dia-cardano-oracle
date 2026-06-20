import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recoverSubmittedTx } from "../recover-submitted-tx.js";

describe("recoverSubmittedTx", () => {
  it("confirms a submitted tx that is still on-chain", async () => {
    assert.equal(await recoverSubmittedTx("0xabc", async () => true), true);
  });

  it("fails a submitted tx that is not on-chain", async () => {
    assert.equal(await recoverSubmittedTx("0xabc", async () => false), false);
  });

  it("fails (conservatively) when the on-chain check throws — re-process instead of false-confirm", async () => {
    assert.equal(
      await recoverSubmittedTx("0xabc", async () => {
        throw new Error("provider unreachable");
      }),
      false,
    );
  });

  it("fails when the row has no Cardano tx hash", async () => {
    let called = false;
    const result = await recoverSubmittedTx(undefined, async () => {
      called = true;
      return true;
    });
    assert.equal(result, false);
    assert.equal(called, false, "must not query the chain without a tx hash");
  });
});
