// Opportunistic deposit-fold for oracle updates.
//
// Two pure cores are exercised here, isolated from the Lucid build/submit path:
//
//   - `selectFoldUtxos` — decides WHICH clean side-deposits an update may fold,
//     applying the SAME eligibility as the deposit sweep (`isCleanAdaDepositUtxo`,
//     >= floor) plus the `depositMaxPerUpdateFold` cap. 0 cap disables the fold.
//
//   - `runWithFoldFallback` — the best-effort orchestration: try the update WITH
//     the folded deposits first; if that throws (build OR submit failure), retry
//     the SAME update WITHOUT deposits so a bad/contended deposit never blocks a
//     price update. With no deposits selected it runs once and propagates errors
//     (nothing to fall back to).
//
// The live submission (Lucid build/sign/submit/confirm via the CLI builder) is
// covered by the CLI emulator flow's `update:absorb-deposit` step; here we only
// prove the decision + the fallback semantics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectFoldUtxos, runWithFoldFallback } from "../index.js";

const FLOOR = 1_000_000n; // configState.depositMinLovelace (1 ADA)
const TOKEN_UNIT = `${"aa".repeat(28)}4449415f5245434549564552`;

describe("selectFoldUtxos (which deposits an update folds)", () => {
  const clean = (lovelace: bigint) => ({ assets: { lovelace } });

  it("selects clean ADA deposits at/above the floor", () => {
    const selected = selectFoldUtxos([clean(2_000_000n), clean(FLOOR)], FLOOR, 3);
    assert.equal(selected.length, 2);
  });

  it("skips dust below the floor", () => {
    const selected = selectFoldUtxos([clean(FLOOR - 1n), clean(2_000_000n)], FLOOR, 3);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.assets.lovelace, 2_000_000n);
  });

  it("skips native-token junk and datum-bearing UTxOs (a griefer cannot force a fold)", () => {
    const tokenJunk = { assets: { lovelace: 5_000_000n, [TOKEN_UNIT]: 1n } };
    const datumBearing = { assets: { lovelace: 5_000_000n }, datum: "d8799f00ff" };
    const selected = selectFoldUtxos([tokenJunk, datumBearing, clean(2_000_000n)], FLOOR, 3);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.assets.lovelace, 2_000_000n);
  });

  it("caps the fold at depositMaxPerUpdateFold (smaller than the merge cap)", () => {
    const five = Array.from({ length: 5 }, () => clean(2_000_000n));
    assert.equal(selectFoldUtxos(five, FLOOR, 3).length, 3, "cap of 3 bounds the fold");
    assert.equal(selectFoldUtxos(five, FLOOR, 20).length, 5, "a cap above the count folds all clean deposits");
  });

  it("folds nothing when the cap is 0 (fold disabled)", () => {
    assert.equal(selectFoldUtxos([clean(5_000_000n)], FLOOR, 0).length, 0);
  });

  it("folds nothing when the cap is negative (defensive)", () => {
    assert.equal(selectFoldUtxos([clean(5_000_000n)], FLOOR, -1).length, 0);
  });
});

describe("runWithFoldFallback (best-effort fold + pure fallback)", () => {
  const foldOf = (n: number) => ({ utxos: Array.from({ length: n }, (_x, i) => i) });

  it("submits the folded tx when the folded attempt succeeds", async () => {
    const calls: Array<boolean> = [];
    const result = await runWithFoldFallback({
      fold: foldOf(2),
      attempt: async (fold) => {
        calls.push(Boolean(fold && fold.utxos.length > 0));
        return { txHash: "fold-ok" };
      },
    });
    assert.deepEqual(calls, [true], "exactly one attempt, with the fold");
    assert.equal(result.txHash, "fold-ok");
    assert.equal(result.foldedDeposits, 2, "reports the folded deposit count");
  });

  it("falls back to a pure update when the folded attempt fails (build/submit error)", async () => {
    const calls: Array<boolean> = [];
    let fellBack = false;
    const result = await runWithFoldFallback({
      fold: foldOf(3),
      attempt: async (fold) => {
        const folded = Boolean(fold && fold.utxos.length > 0);
        calls.push(folded);
        if (folded) throw new Error("combined tx over budget");
        return { txHash: "pure-ok" };
      },
      onFallback: () => {
        fellBack = true;
      },
    });
    assert.deepEqual(calls, [true, false], "folded attempt then a single pure retry");
    assert.equal(fellBack, true, "onFallback fired exactly when the fold failed");
    assert.equal(result.txHash, "pure-ok", "the pure update was the one that succeeded");
    assert.equal(result.foldedDeposits, 0, "the successful submission folded no deposits");
  });

  it("does not retry (no fold) when there are no deposits to fold", async () => {
    const calls: Array<boolean> = [];
    let fellBack = false;
    const result = await runWithFoldFallback({
      fold: foldOf(0),
      attempt: async (fold) => {
        calls.push(Boolean(fold && fold.utxos.length > 0));
        return { txHash: "pure-only" };
      },
      onFallback: () => {
        fellBack = true;
      },
    });
    assert.deepEqual(calls, [false], "single attempt, no fold");
    assert.equal(fellBack, false, "no fallback when nothing was folded");
    assert.equal(result.foldedDeposits, 0);
    assert.equal(result.txHash, "pure-only");
  });

  it("propagates the error when the pure fallback ALSO fails", async () => {
    // A genuine update failure (not deposit-related) must still surface so the
    // submitter queue can mark the request failed and retry it later.
    await assert.rejects(
      runWithFoldFallback({
        fold: foldOf(2),
        attempt: async () => {
          throw new Error("receiver UTxO contended");
        },
      }),
      /receiver UTxO contended/,
    );
  });

  it("propagates the error when there is no fold and the single attempt fails", async () => {
    await assert.rejects(
      runWithFoldFallback({
        fold: foldOf(0),
        attempt: async () => {
          throw new Error("pure update failed");
        },
      }),
      /pure update failed/,
    );
  });
});
