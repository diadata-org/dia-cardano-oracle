import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planWalletReshape, type WalletShapeProfile } from "../wallet-shape.js";
import type { WalletUtxo } from "../wallet-pool.js";

const ADA = 1_000_000n;

const PROFILE: WalletShapeProfile = {
  workingCount: 5,
  workingLovelace: 100n * ADA,
  collateralCount: 5,
  collateralLovelace: 10n * ADA,
  splitAboveLovelace: 550n * ADA,
  feeBufferLovelace: 2n * ADA,
};

function utxo(outRef: string, ada: bigint, hasOnlyAda = true): WalletUtxo {
  return { outRef, lovelace: ada * ADA, hasOnlyAda };
}

function asPlan(p: ReturnType<typeof planWalletReshape>) {
  assert.ok(p.act, "expected a reshape plan");
  return p;
}

describe("planWalletReshape", () => {
  it("splits one fat UTxO into the target profile (the primary case)", () => {
    const plan = asPlan(planWalletReshape([utxo("fat#0", 600n)], PROFILE));

    assert.deepEqual(plan.consumeOutRefs, ["fat#0"], "consumes the oversized UTxO");
    // 5 collateral (10) + 5 working (100) = 550; leftover 600-550-2 = 48 < 100 → no extra.
    const counts = plan.outputLovelaces.reduce<Record<string, number>>((acc, v) => {
      const k = v.toString();
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(counts[(10n * ADA).toString()], 5, "5 collateral outputs of 10 ADA");
    assert.equal(counts[(100n * ADA).toString()], 5, "5 working outputs of 100 ADA");
  });

  it("does nothing when the wallet already holds the profile", () => {
    const shaped: WalletUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      ...Array.from({ length: 5 }, (_, i) => utxo(`w#${i}`, 100n)),
    ];
    assert.deepEqual(planWalletReshape(shaped, PROFILE), { act: false, reason: "already_shaped" });
  });

  it("breaks an oversized UTxO into working pieces even when the counts are already met", () => {
    const utxos: WalletUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      ...Array.from({ length: 5 }, (_, i) => utxo(`w#${i}`, 100n)),
      utxo("fat#0", 600n),
    ];
    const plan = asPlan(planWalletReshape(utxos, PROFILE));
    assert.deepEqual(plan.consumeOutRefs, ["fat#0"], "only the oversized UTxO is consumed");
    // No missing pieces; leftover 600-2 = 598 → 5 working pieces of 100, change 98.
    assert.deepEqual(
      plan.outputLovelaces,
      Array.from({ length: 5 }, () => 100n * ADA),
      "the fat UTxO is split into working-sized pieces",
    );
  });

  it("tops up only the missing pieces, preserving good UTxOs", () => {
    // Has 5 collateral + 2 working; missing 3 working. One medium UTxO funds them.
    const utxos: WalletUtxo[] = [
      ...Array.from({ length: 5 }, (_, i) => utxo(`c#${i}`, 10n)),
      utxo("w#0", 100n),
      utxo("w#1", 100n),
      utxo("med#0", 400n), // medium: not collateral, not working band start.. actually 400 is working
    ];
    // 400 is within [100,550] so it counts as a 3rd working UTxO → missing 2 working.
    const plan = asPlan(planWalletReshape(utxos, PROFILE));
    // Good collateral/working UTxOs are not consumed; only fund the missing pieces.
    assert.ok(!plan.consumeOutRefs.includes("c#0"), "good collateral preserved");
    assert.ok(!plan.consumeOutRefs.includes("w#0"), "good working preserved");
  });

  it("reports insufficient when the wallet cannot fund even the missing pieces", () => {
    // Only dust: 10 x 1 ADA = 10 ADA total; cannot fund 5x10 + 5x100 = 550.
    const dust = Array.from({ length: 10 }, (_, i) => utxo(`d#${i}`, 1n));
    assert.deepEqual(planWalletReshape(dust, PROFILE), { act: false, reason: "insufficient" });
  });

  it("ignores token-bearing UTxOs (collateral must be pure ADA)", () => {
    const utxos: WalletUtxo[] = [utxo("fat#0", 600n), utxo("nft#0", 5n, false)];
    const plan = asPlan(planWalletReshape(utxos, PROFILE));
    assert.ok(!plan.consumeOutRefs.includes("nft#0"), "the token UTxO is never consumed");
  });
});
