import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAutoSettle,
  shouldAutoWithdraw,
  shouldAutoConsolidate,
  shouldAutoSplit,
} from "../auto-remediation.js";

describe("shouldAutoSettle", () => {
  it("acts when accrued reaches the threshold", () => {
    const d = shouldAutoSettle({
      receiverAccruedLovelace: 30_000_000n,
      autoSettleLovelace: 30_000_000n,
      inProgress: false,
    });
    assert.deepEqual(d, { act: true, reason: "accrued_high" });
  });

  it("does NOT act below the threshold", () => {
    const d = shouldAutoSettle({
      receiverAccruedLovelace: 29_999_999n,
      autoSettleLovelace: 30_000_000n,
      inProgress: false,
    });
    assert.equal(d.act, false);
  });

  it("is disabled when the threshold is undefined", () => {
    assert.deepEqual(
      shouldAutoSettle({ receiverAccruedLovelace: 999_000_000n, inProgress: false }),
      { act: false, reason: "disabled" },
    );
  });

  it("skips while one is already in progress (dedup)", () => {
    assert.deepEqual(
      shouldAutoSettle({ receiverAccruedLovelace: 99_000_000n, autoSettleLovelace: 30_000_000n, inProgress: true }),
      { act: false, reason: "in_progress" },
    );
  });
});

describe("shouldAutoWithdraw", () => {
  it("acts when hook accrued reaches the threshold and returns the full drain amount", () => {
    const d = shouldAutoWithdraw({
      paymentHookAccruedLovelace: 120_000_000n,
      autoWithdrawLovelace: 100_000_000n,
      inProgress: false,
    });
    assert.deepEqual(d, { act: true, reason: "accrued_high", amountLovelace: 120_000_000n });
  });

  it("does NOT act below the threshold", () => {
    assert.equal(
      shouldAutoWithdraw({ paymentHookAccruedLovelace: 50_000_000n, autoWithdrawLovelace: 100_000_000n, inProgress: false }).act,
      false,
    );
  });

  it("is disabled when undefined and skips when in progress", () => {
    assert.equal(shouldAutoWithdraw({ paymentHookAccruedLovelace: 999_000_000n, inProgress: false }).reason, "disabled");
    assert.equal(
      shouldAutoWithdraw({ paymentHookAccruedLovelace: 999_000_000n, autoWithdrawLovelace: 1n, inProgress: true }).reason,
      "in_progress",
    );
  });
});

describe("shouldAutoConsolidate", () => {
  it("acts when the largest UTxO falls BELOW the floor (the real outage shape)", () => {
    // Last night: 34 UTxOs all ~2 ADA, largest 2 ADA, floor 7 ADA → fragmented.
    const d = shouldAutoConsolidate({
      adminWalletMaxUtxoLovelace: 2_000_000n,
      autoConsolidateBelowLovelace: 7_000_000n,
      inProgress: false,
    });
    assert.deepEqual(d, { act: true, reason: "fragmented" });
  });

  it("does NOT act when a fat UTxO is present (healthy)", () => {
    assert.deepEqual(
      shouldAutoConsolidate({
        adminWalletMaxUtxoLovelace: 45_000_000n,
        autoConsolidateBelowLovelace: 7_000_000n,
        inProgress: false,
      }),
      { act: false, reason: "healthy" },
    );
  });

  it("does not act blind when the wallet reading is unknown", () => {
    assert.deepEqual(
      shouldAutoConsolidate({ autoConsolidateBelowLovelace: 7_000_000n, inProgress: false }),
      { act: false, reason: "unknown" },
    );
  });

  it("is disabled when the threshold is undefined and skips when in progress", () => {
    assert.equal(shouldAutoConsolidate({ adminWalletMaxUtxoLovelace: 1n, inProgress: false }).reason, "disabled");
    assert.equal(
      shouldAutoConsolidate({ adminWalletMaxUtxoLovelace: 1n, autoConsolidateBelowLovelace: 7_000_000n, inProgress: true }).reason,
      "in_progress",
    );
  });
});

describe("shouldAutoSplit", () => {
  const base = {
    splitAboveLovelace: 550_000_000n,
    minUsableUtxos: 5,
    enabled: true,
    inProgress: false,
  };

  it("acts when a big UTxO exists AND usable UTxOs are too few (concentrated)", () => {
    const d = shouldAutoSplit({ ...base, maxUtxoLovelace: 600_000_000n, usableUtxoCount: 1 });
    assert.deepEqual(d, { act: true, reason: "concentrated" });
  });

  it("does NOT act when there is a big UTxO but plenty of usable UTxOs", () => {
    // A lone fat UTxO in an otherwise healthy wallet is left alone — splitting is
    // for parallelism, and parallelism is already covered.
    assert.deepEqual(
      shouldAutoSplit({ ...base, maxUtxoLovelace: 600_000_000n, usableUtxoCount: 6 }),
      { act: false, reason: "healthy" },
    );
  });

  it("does NOT act when usable UTxOs are few but nothing is big enough to split", () => {
    assert.deepEqual(
      shouldAutoSplit({ ...base, maxUtxoLovelace: 100_000_000n, usableUtxoCount: 1 }),
      { act: false, reason: "healthy" },
    );
  });

  it("does not act blind when a wallet reading is unknown", () => {
    assert.equal(
      shouldAutoSplit({ ...base, usableUtxoCount: 1 }).reason,
      "unknown",
      "missing maxUtxoLovelace",
    );
    assert.equal(
      shouldAutoSplit({ ...base, maxUtxoLovelace: 600_000_000n }).reason,
      "unknown",
      "missing usableUtxoCount",
    );
  });

  it("is disabled when not enabled and skips when in progress", () => {
    assert.equal(
      shouldAutoSplit({ ...base, enabled: false, maxUtxoLovelace: 600_000_000n, usableUtxoCount: 1 }).reason,
      "disabled",
    );
    assert.equal(
      shouldAutoSplit({ ...base, inProgress: true, maxUtxoLovelace: 600_000_000n, usableUtxoCount: 1 }).reason,
      "in_progress",
    );
  });
});
