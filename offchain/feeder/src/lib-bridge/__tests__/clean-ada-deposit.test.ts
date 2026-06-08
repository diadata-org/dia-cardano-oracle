// Classification table for `isCleanAdaDepositUtxo` — the read-only predicate
// the daemon's `snapshotBalances` deposit-pending probe applies to every UTxO
// at a client's side-deposit address before summing it into the
// `depositPendingLovelace` gauge.
//
// This MUST mirror the CLI's `isCleanAdaDeposit` selection in
// `cli/src/transactions/deposit.ts` (which decides what the `deposit:merge`
// sweep actually folds in): otherwise the gauge would advertise a pending
// amount the sweep then skips, or trigger an auto-merge that no-ops/throws.
// A UTxO counts ONLY when it is pure ADA (a single `lovelace` asset key), has
// neither an inline datum nor a datum hash, and holds >= the configured floor.
// Dust, native-token "junk", and datum-bearing UTxOs a griefer might park at
// the address are rejected — they stay harmlessly at the address and must
// never inflate the gauge.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isCleanAdaDepositUtxo } from "../index.js";

const FLOOR = 1_000_000n; // configState.depositMinLovelace (1 ADA)
const TOKEN_UNIT = `${"aa".repeat(28)}4449415f5245434549564552`;

describe("isCleanAdaDepositUtxo (deposit-pending probe classification)", () => {
  it("accepts a pure-ADA UTxO at exactly the floor", () => {
    assert.equal(isCleanAdaDepositUtxo({ assets: { lovelace: FLOOR } }, FLOOR), true);
  });

  it("accepts a pure-ADA UTxO above the floor", () => {
    assert.equal(
      isCleanAdaDepositUtxo({ assets: { lovelace: 5_000_000n } }, FLOOR),
      true,
    );
  });

  it("rejects dust strictly below the floor", () => {
    assert.equal(
      isCleanAdaDepositUtxo({ assets: { lovelace: FLOOR - 1n } }, FLOOR),
      false,
    );
  });

  it("rejects a UTxO carrying a native token even when its ADA clears the floor", () => {
    // Token-wrapped "junk": multiple asset keys → not pure ADA, never swept.
    assert.equal(
      isCleanAdaDepositUtxo(
        { assets: { lovelace: 5_000_000n, [TOKEN_UNIT]: 1n } },
        FLOOR,
      ),
      false,
    );
  });

  it("rejects a UTxO with an inline datum (the Receiver-spend path expects Some datum, deposits must be datum-less)", () => {
    assert.equal(
      isCleanAdaDepositUtxo(
        { assets: { lovelace: 5_000_000n }, datum: "d8799f00ff" },
        FLOOR,
      ),
      false,
    );
  });

  it("rejects a UTxO with a datum hash", () => {
    assert.equal(
      isCleanAdaDepositUtxo(
        { assets: { lovelace: 5_000_000n }, datumHash: `${"00".repeat(32)}` },
        FLOOR,
      ),
      false,
    );
  });

  it("coerces a string-encoded lovelace amount before comparing to the floor", () => {
    // Some providers surface asset quantities as decimal strings; the probe
    // must compare numerically, not lexically (a naive string compare would
    // pass dust like "900000" as >= "1000000" on length, or reject "9000000").
    assert.equal(
      isCleanAdaDepositUtxo(
        { assets: { lovelace: "5000000" as unknown as bigint } },
        FLOOR,
      ),
      true,
    );
    assert.equal(
      isCleanAdaDepositUtxo(
        { assets: { lovelace: "900000" as unknown as bigint } },
        FLOOR,
      ),
      false,
    );
  });

  it("rejects a UTxO with no assets at all (treated as zero lovelace)", () => {
    assert.equal(isCleanAdaDepositUtxo({}, FLOOR), false);
  });

  it("honours a non-default floor (a higher floor excludes what a lower one accepts)", () => {
    const utxo = { assets: { lovelace: 2_000_000n } };
    assert.equal(isCleanAdaDepositUtxo(utxo, 1_000_000n), true);
    assert.equal(isCleanAdaDepositUtxo(utxo, 3_000_000n), false);
  });
});
