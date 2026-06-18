// Maps the feeder's existing submit-pipeline signals to the numeric phase codes
// published by two per-client (= per serial lane) gauges. They are kept separate
// because both can be true at once: a lane can be ACCUMULATING the next batch in
// the coalescer WHILE the current batch is BUILDING/SUBMITTING on chain. Cramming
// both into one gauge makes it flip-flop, so each concern gets its own metric.
//
//   submission_state  — the submit pipeline (write-client `onStep`): serial and
//                        monotonic per batch (idle -> building -> submitting ->
//                        awaiting-confirmation -> idle).
//   coalescer_state   — the coalescer lane lifecycle (`onLaneEvent`):
//                        idle -> accumulating -> in-flight.
// These translate the coalescer/write-client callbacks that already fire into a phase code.

/** Submit-pipeline phase codes, in order. Driven by onStep (+ lane idle/flush). */
export const SUBMISSION_STATE = {
  idle: 0,
  building: 1,
  submitting: 2,
  awaiting: 3,
} as const;

/** Coalescer lane lifecycle codes, in order. Driven by onLaneEvent. */
export const COALESCER_STATE = {
  idle: 0,
  accumulating: 1,
  in_flight: 2,
} as const;

/** Cardano pipeline step (`onStep`) -> submit phase, or null when the step does
 *  not move the phase. Steps come from `cardano-write-client` in order:
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

/** Lane event kind (`onLaneEvent`) -> submit phase, or null. The submit pipeline
 *  only cares about entering (flush_triggered -> building) and returning to idle;
 *  the finer building/submitting/awaiting phases come from `submissionStateForStep`.
 *  Accumulation is NOT a submit phase — it belongs to `coalescerStateForLaneEvent`. */
export function submissionStateForLaneEvent(kind: string): number | null {
  switch (kind) {
    case "lane_idle":
    case "flush_empty":
      return SUBMISSION_STATE.idle;
    case "flush_triggered":
      return SUBMISSION_STATE.building;
    default:
      return null;
  }
}

/** Lane event kind (`onLaneEvent`) -> coalescer lane state, or null. Tracks the
 *  coalescer's own lifecycle independently of the submit pipeline. */
export function coalescerStateForLaneEvent(kind: string): number | null {
  switch (kind) {
    case "lane_idle":
    case "flush_empty":
      return COALESCER_STATE.idle;
    case "intent_buffered":
    case "tx_confirmed_reflush":
      return COALESCER_STATE.accumulating;
    case "flush_triggered":
      return COALESCER_STATE.in_flight;
    default:
      return null;
  }
}
