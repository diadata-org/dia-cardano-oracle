// Auto-merge trigger-decision tests.
//
// `shouldAutoMergeDeposits` is the PURE core of the daemon's deposit
// auto-merge: given one balance snapshot plus the lane-lock facts, it decides
// whether to submit a `deposit:merge` on this tick. The live submission path
// (Lucid build/sign/submit/confirm via the CLI's `depositMerge`) is exercised
// only against a real network, so we isolate and test the decision here.
//
// Coverage:
//   - merges when the Receiver balance is LOW and deposits are pending,
//   - merges when pending deposits reach the configured threshold,
//   - skips when neither arm is met,
//   - skips (dedup) when a merge is already enqueued/running for the lane,
//   - skips when there is nothing clean to merge,
//   - tolerates an undefined pending-merge threshold (arm disabled).
//
// Mutual exclusion against an in-flight oracle update is NOT a concern of this
// decision: the merge is dispatched onto the same serial lane queue as the
// client's updates, so the queue serializes them by construction. The lane
// serialization itself is proven in queue.test.ts ("serializes an update and a
// merge task on the same lane").

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldAutoMergeDeposits } from "../../../cmd/feeder/daemon-cmd.js";

const LOW = 10_000_000n; // receiver_balance_low_lovelace
const MERGE_AT = 5_000_000n; // deposit_pending_merge_lovelace

// Baseline: lane idle, no merge running, thresholds configured. Individual
// tests override only the fields under test.
function base(overrides: Partial<Parameters<typeof shouldAutoMergeDeposits>[0]> = {}) {
  return {
    receiverBalanceLowLovelace: LOW,
    depositPendingMergeLovelace: MERGE_AT,
    mergeInProgress: false,
    ...overrides,
  };
}

describe("shouldAutoMergeDeposits", () => {
  it("merges when the Receiver balance is low and deposits are pending (lane idle)", () => {
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: LOW - 1n, depositPendingLovelace: 1_000_000n }),
    );
    assert.deepEqual(d, { merge: true, reason: "receiver_balance_low" });
  });

  it("merges when pending deposits reach the threshold (Receiver balance healthy)", () => {
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: LOW * 10n, depositPendingLovelace: MERGE_AT }),
    );
    assert.deepEqual(d, { merge: true, reason: "deposit_pending_high" });
  });

  it("skips when balance is healthy and pending is below the threshold", () => {
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: LOW * 10n, depositPendingLovelace: MERGE_AT - 1n }),
    );
    assert.deepEqual(d, { merge: false, reason: "below_threshold" });
  });

  it("does NOT enqueue a second merge while one is already enqueued/running for the lane", () => {
    // Dedup guard: both arms are satisfied, but a merge is already in flight on
    // this lane, so we must not stack another task. (Safety against an
    // in-flight UPDATE is the lane queue's job, not this decision's.)
    const d = shouldAutoMergeDeposits(
      base({
        receiverBalanceLovelace: LOW - 1n,
        depositPendingLovelace: MERGE_AT,
        mergeInProgress: true,
      }),
    );
    assert.deepEqual(d, { merge: false, reason: "merge_in_progress" });
  });

  it("skips when there are no pending deposits even though the Receiver is low", () => {
    // No clean deposits to fold in → a merge would be a guaranteed no-op /
    // throw, so we never attempt it.
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: LOW - 1n, depositPendingLovelace: 0n }),
    );
    assert.deepEqual(d, { merge: false, reason: "no_pending" });
  });

  it("treats an undefined pending value as nothing to merge", () => {
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: LOW - 1n, depositPendingLovelace: undefined }),
    );
    assert.deepEqual(d, { merge: false, reason: "no_pending" });
  });

  it("disables the pending-high arm when the threshold is undefined", () => {
    // Receiver balance healthy + no threshold → pending pile alone must not
    // trigger a merge.
    const d = shouldAutoMergeDeposits(
      base({
        receiverBalanceLovelace: LOW * 10n,
        depositPendingLovelace: 100_000_000n,
        depositPendingMergeLovelace: undefined,
      }),
    );
    assert.deepEqual(d, { merge: false, reason: "below_threshold" });
  });

  it("still merges on the low-balance arm when the pending threshold is undefined", () => {
    const d = shouldAutoMergeDeposits(
      base({
        receiverBalanceLovelace: LOW - 1n,
        depositPendingLovelace: 1_000_000n,
        depositPendingMergeLovelace: undefined,
      }),
    );
    assert.deepEqual(d, { merge: true, reason: "receiver_balance_low" });
  });

  it("does not evaluate the low-balance arm when the receiver balance is unknown", () => {
    // Receiver query failed (undefined balance) but pending is high → fall
    // through to the pending-high arm rather than the low-balance arm.
    const d = shouldAutoMergeDeposits(
      base({ receiverBalanceLovelace: undefined, depositPendingLovelace: MERGE_AT }),
    );
    assert.deepEqual(d, { merge: true, reason: "deposit_pending_high" });
  });
});
