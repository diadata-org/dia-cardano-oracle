import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldFundPoolWallet } from "../pool-funding.js";

const BASE = {
  lowLovelace: 50_000_000n,
  targetLovelace: 200_000_000n,
  mainReserveLovelace: 100_000_000n,
  inProgress: false,
  nowMs: 1_000_000,
  minIntervalMs: 300_000,
};

describe("shouldFundPoolWallet", () => {
  it("funds a pool wallet below the low band up to the target, when the main can cover it", () => {
    const d = shouldFundPoolWallet({
      ...BASE,
      poolWalletSpendableLovelace: 20_000_000n, // below 50 ADA low
      mainWalletSpendableLovelace: 1_000_000_000n, // 1000 ADA
    });
    assert.deepEqual(d, { act: true, amountLovelace: 180_000_000n }, "amount = target - spendable = 200 - 20");
  });

  it("does nothing when the wallet is at or above the low band", () => {
    assert.deepEqual(
      shouldFundPoolWallet({ ...BASE, poolWalletSpendableLovelace: 50_000_000n, mainWalletSpendableLovelace: 1_000_000_000n }),
      { act: false, reason: "above_low" },
      "exactly at low is not topped up",
    );
    assert.deepEqual(
      shouldFundPoolWallet({ ...BASE, poolWalletSpendableLovelace: 120_000_000n, mainWalletSpendableLovelace: 1_000_000_000n }),
      { act: false, reason: "above_low" },
    );
  });

  it("refuses to fund when it would drop the main below its reserve", () => {
    // amount = 200-20 = 180; main 250 - 180 = 70 < 100 reserve → refuse.
    const d = shouldFundPoolWallet({
      ...BASE,
      poolWalletSpendableLovelace: 20_000_000n,
      mainWalletSpendableLovelace: 250_000_000n,
    });
    assert.deepEqual(d, { act: false, reason: "main_insufficient" });
  });

  it("funds when the main has exactly enough to keep its reserve", () => {
    // amount = 180; main 280 - 180 = 100 == reserve → allowed (not below).
    const d = shouldFundPoolWallet({
      ...BASE,
      poolWalletSpendableLovelace: 20_000_000n,
      mainWalletSpendableLovelace: 280_000_000n,
    });
    assert.deepEqual(d, { act: true, amountLovelace: 180_000_000n });
  });

  it("does not start a second funding while one is in progress", () => {
    const d = shouldFundPoolWallet({
      ...BASE,
      inProgress: true,
      poolWalletSpendableLovelace: 20_000_000n,
      mainWalletSpendableLovelace: 1_000_000_000n,
    });
    assert.deepEqual(d, { act: false, reason: "in_progress" });
  });

  it("respects the per-wallet cooldown after a recent funding", () => {
    const d = shouldFundPoolWallet({
      ...BASE,
      poolWalletSpendableLovelace: 20_000_000n,
      mainWalletSpendableLovelace: 1_000_000_000n,
      lastFundedAtMs: BASE.nowMs - 100_000, // 100s ago < 300s cooldown
    });
    assert.deepEqual(d, { act: false, reason: "cooldown" });
  });

  it("funds again once the cooldown has elapsed", () => {
    const d = shouldFundPoolWallet({
      ...BASE,
      poolWalletSpendableLovelace: 20_000_000n,
      mainWalletSpendableLovelace: 1_000_000_000n,
      lastFundedAtMs: BASE.nowMs - 300_001, // just past the cooldown
    });
    assert.deepEqual(d, { act: true, amountLovelace: 180_000_000n });
  });
});
