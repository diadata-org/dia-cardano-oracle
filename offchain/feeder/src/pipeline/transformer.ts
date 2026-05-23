// Transformer — projects an `EnrichedIntent` through optional field
// transformations declared in `processing.transformations`.
//
// Spectra supports operations like sliding-window averages, decimal
// rescaling, and conditional rewrites. The Cardano feeder does not
// need any of those today: the on-chain Pair UTxO accepts the raw
// `OracleIntent` as-is.
//
// This file is the explicit no-op so the pipeline composition stays
// identical to Spectra's (extract → enrich → transform → route) and
// so DIA's existing router YAMLs can declare `transformations: []`
// without the loader erroring.
//
// TODO: implement real transformations when a router needs one.

import type { EnrichedIntent } from "../source/types.js";

export type Transformer = (input: EnrichedIntent) => EnrichedIntent;

/** Identity transformer. Returned by `createTransformer` when no
 *  pipeline-level transformations are configured. */
export const identityTransformer: Transformer = (input) => input;

/**
 * Build a transformer that applies the requested operations in order.
 *
 * The current build only supports the identity behaviour; any
 * non-empty `transformations` array is rejected loudly so an
 * operator cannot silently expect transformations that the feeder
 * does not yet implement.
 */
export function createTransformer(transformationsCount = 0): Transformer {
  if (transformationsCount > 0) {
    throw new Error(
      `Transformer received ${transformationsCount} transformation(s) but only the identity transformer is currently implemented. Open an issue if a transformation is required for your router.`,
    );
  }
  return identityTransformer;
}
