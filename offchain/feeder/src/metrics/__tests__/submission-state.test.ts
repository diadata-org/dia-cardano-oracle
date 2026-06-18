import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SUBMISSION_STATE,
  COALESCER_STATE,
  submissionStateForStep,
  submissionStateForLaneEvent,
  coalescerStateForLaneEvent,
} from "../submission-state.js";

describe("submission-state mapping", () => {
  it("maps Cardano pipeline steps to submit phases", () => {
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

  it("submit phase from lane events: only idle + entering build (no accumulating)", () => {
    assert.equal(submissionStateForLaneEvent("lane_idle"), SUBMISSION_STATE.idle);
    assert.equal(submissionStateForLaneEvent("flush_empty"), SUBMISSION_STATE.idle);
    assert.equal(submissionStateForLaneEvent("flush_triggered"), SUBMISSION_STATE.building);
    // accumulation is NOT a submit phase — it must not move submission_state.
    assert.equal(submissionStateForLaneEvent("intent_buffered"), null);
    assert.equal(submissionStateForLaneEvent("tx_confirmed_reflush"), null);
    assert.equal(submissionStateForLaneEvent("intent_superseded"), null);
  });

  it("coalescer state from lane events: idle / accumulating / in-flight", () => {
    assert.equal(coalescerStateForLaneEvent("lane_idle"), COALESCER_STATE.idle);
    assert.equal(coalescerStateForLaneEvent("flush_empty"), COALESCER_STATE.idle);
    assert.equal(coalescerStateForLaneEvent("intent_buffered"), COALESCER_STATE.accumulating);
    assert.equal(coalescerStateForLaneEvent("tx_confirmed_reflush"), COALESCER_STATE.accumulating);
    assert.equal(coalescerStateForLaneEvent("flush_triggered"), COALESCER_STATE.in_flight);
    assert.equal(coalescerStateForLaneEvent("intent_superseded"), null);
  });

  it("exposes the phase codes in increasing order", () => {
    assert.deepEqual(
      [SUBMISSION_STATE.idle, SUBMISSION_STATE.building, SUBMISSION_STATE.submitting, SUBMISSION_STATE.awaiting],
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      [COALESCER_STATE.idle, COALESCER_STATE.accumulating, COALESCER_STATE.in_flight],
      [0, 1, 2],
    );
  });
});
