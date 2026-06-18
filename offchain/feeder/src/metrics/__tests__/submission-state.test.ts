import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUBMISSION_STATE,
  submissionStateForStep,
  submissionStateForLaneEvent,
} from "../submission-state.js";

describe("submission-state mapping", () => {
  it("maps Cardano pipeline steps to phases", () => {
    assert.equal(submissionStateForStep("tx_start"), SUBMISSION_STATE.building);
    assert.equal(submissionStateForStep("connecting"), SUBMISSION_STATE.building);
    assert.equal(submissionStateForStep("building"), SUBMISSION_STATE.building);
    assert.equal(submissionStateForStep("signing"), SUBMISSION_STATE.submitting);
    assert.equal(submissionStateForStep("submitting"), SUBMISSION_STATE.submitting);
    assert.equal(submissionStateForStep("submitted"), SUBMISSION_STATE.awaiting);
    assert.equal(submissionStateForStep("waiting_confirm"), SUBMISSION_STATE.awaiting);
    assert.equal(submissionStateForStep("waiting_utxo"), SUBMISSION_STATE.awaiting);
  });

  it("returns null for unknown steps (no state change)", () => {
    assert.equal(submissionStateForStep("nonsense"), null);
  });

  it("maps lane events to phases", () => {
    assert.equal(submissionStateForLaneEvent("intent_buffered"), SUBMISSION_STATE.accumulating);
    assert.equal(submissionStateForLaneEvent("tx_confirmed_reflush"), SUBMISSION_STATE.accumulating);
    assert.equal(submissionStateForLaneEvent("flush_triggered"), SUBMISSION_STATE.building);
    assert.equal(submissionStateForLaneEvent("lane_idle"), SUBMISSION_STATE.idle);
    assert.equal(submissionStateForLaneEvent("flush_empty"), SUBMISSION_STATE.idle);
  });

  it("returns null for lane events that do not change the phase", () => {
    assert.equal(submissionStateForLaneEvent("intent_superseded"), null);
  });

  it("exposes the phase codes in increasing pipeline order", () => {
    assert.deepEqual(
      [
        SUBMISSION_STATE.idle,
        SUBMISSION_STATE.accumulating,
        SUBMISSION_STATE.building,
        SUBMISSION_STATE.submitting,
        SUBMISSION_STATE.awaiting,
      ],
      [0, 1, 2, 3, 4],
    );
  });
});
