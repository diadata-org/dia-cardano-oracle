// Maps the feeder's existing submit-pipeline signals to the numeric phase codes
// published by the `dia_bridge_submission_state` gauge (one per client lane).
//
// Two signal sources, both already emitted by the feeder:
//   - lane events (coalescer `onLaneEvent`): idle / accumulating / flush.
//   - Cardano pipeline steps (write-client `onStep`): building / signing /
//     submitting / submitted / waiting_confirm.
// No new hot-path instrumentation — these functions just translate the existing
// callbacks into a phase code.

/** Phase codes, in increasing pipeline order. A state-timeline panel reads the
 *  history; a point-in-time read is mostly `idle` because lanes flip fast. */
export const SUBMISSION_STATE = {
  idle: 0,
  accumulating: 1,
  building: 2,
  submitting: 3,
  awaiting: 4,
} as const;

/** Cardano pipeline step (`onStep`) -> phase, or null when the step does not
 *  move the phase. Steps come from `cardano-write-client` in order:
 *  tx_start, connecting, building, signing, submitting, submitted,
 *  waiting_confirm, waiting_utxo. */
export function submissionStateForStep(step: string): number | null {
  switch (step) {
    case "tx_start":
    case "connecting":
    case "building":
      return SUBMISSION_STATE.building;
    case "signing":
    case "submitting":
      return SUBMISSION_STATE.submitting;
    case "submitted":
    case "waiting_confirm":
    case "waiting_utxo":
      return SUBMISSION_STATE.awaiting;
    default:
      return null;
  }
}

/** Lane event kind (`onLaneEvent`) -> phase, or null when the event does not
 *  move the phase (e.g. a supersede). The finer building/submitting/awaiting
 *  phases come from `submissionStateForStep`; lane events own idle/accumulating
 *  and the hand-off to the submit pipeline. */
export function submissionStateForLaneEvent(kind: string): number | null {
  switch (kind) {
    case "lane_idle":
    case "flush_empty":
      return SUBMISSION_STATE.idle;
    case "intent_buffered":
    case "tx_confirmed_reflush":
      return SUBMISSION_STATE.accumulating;
    case "flush_triggered":
      return SUBMISSION_STATE.building;
    default:
      return null;
  }
}
