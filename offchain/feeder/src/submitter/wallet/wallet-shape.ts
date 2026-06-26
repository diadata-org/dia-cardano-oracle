// wallet-shape.ts — pure planner that keeps a wallet's UTxOs in a shape the
// arbiter can parallelise.
//
// The arbiter hands each concurrent lane a disjoint UTxO subset, so a single
// wallet can back many lanes — but only over the UTxOs it actually holds. Left
// alone a wallet drifts toward a few large UTxOs (change accumulates), which
// starves the arbiter and caps the wallet at one lane. This planner reshapes the
// wallet toward a target PROFILE — N working UTxOs of a working size plus M
// collateral-sized UTxOs — by splitting large UTxOs (and, when funded, topping
// up the missing pieces). It subsumes the old "merge dust into one collateral +
// working" consolidation: merging is the degenerate case of reshaping toward the
// profile.
//
// Pure (no chain) so the decision is fully unit-tested. Token-bearing UTxOs are
// never touched — collateral and clean fee inputs must be pure ADA.

import type { WalletUtxo } from "./wallet-pool.js";

/** The target UTxO shape for a wallet. All lovelace except the counts.
 *  Sourced from `infrastructure.<network>.yaml::wallet_shape` with `DEFAULT_*`
 *  fallbacks. */
export type WalletShapeProfile = {
  /** How many working UTxOs to keep. */
  workingCount: number;
  /** Target size of each working UTxO (lovelace). */
  workingLovelace: bigint;
  /** How many collateral-sized UTxOs to keep. */
  collateralCount: number;
  /** Target size of each collateral UTxO (lovelace). */
  collateralLovelace: bigint;
  /** A pure-ADA UTxO larger than this is split. */
  splitAboveLovelace: bigint;
  /** Headroom reserved on the consumed inputs for the tx fee + change min-UTxO. */
  feeBufferLovelace: bigint;
};

export type ReshapePlan =
  | { act: true; consumeOutRefs: string[]; outputLovelaces: bigint[] }
  | { act: false; reason: "already_shaped" | "insufficient" };

/**
 * Decide whether to reshape a wallet toward `profile`, and if so which UTxOs to
 * consume and which outputs to create (the tx balancer adds the change). Returns
 * `already_shaped` when the wallet already holds the profile and has no oversized
 * UTxO, or `insufficient` when it cannot fund even the missing pieces.
 */
export function planWalletReshape(utxos: WalletUtxo[], profile: WalletShapeProfile): ReshapePlan {
  const pure = utxos.filter((u) => u.hasOnlyAda);

  const isCollateral = (x: bigint) => x >= profile.collateralLovelace && x < profile.workingLovelace;
  const isWorking = (x: bigint) => x >= profile.workingLovelace && x <= profile.splitAboveLovelace;
  const isOversized = (x: bigint) => x > profile.splitAboveLovelace;

  const currentCollateral = pure.filter((u) => isCollateral(u.lovelace)).length;
  const currentWorking = pure.filter((u) => isWorking(u.lovelace)).length;
  const oversized = pure.filter((u) => isOversized(u.lovelace));

  const missingCollateral = Math.max(0, profile.collateralCount - currentCollateral);
  const missingWorking = Math.max(0, profile.workingCount - currentWorking);

  if (missingCollateral === 0 && missingWorking === 0 && oversized.length === 0) {
    return { act: false, reason: "already_shaped" };
  }

  // The pieces we must create to reach the target counts.
  const outputs: bigint[] = [
    ...Array.from({ length: missingCollateral }, () => profile.collateralLovelace),
    ...Array.from({ length: missingWorking }, () => profile.workingLovelace),
  ];
  const outputsTotal = outputs.reduce((acc, v) => acc + v, 0n);
  const target = outputsTotal + profile.feeBufferLovelace;

  // Always consume every oversized UTxO (the point is to break them up), then
  // top up from the LARGEST remaining UTxOs — this breaks big UTxOs first and
  // leaves the small collateral-sized pieces untouched.
  const consume: WalletUtxo[] = [...oversized];
  let consumedTotal = oversized.reduce((acc, u) => acc + u.lovelace, 0n);
  const rest = pure
    .filter((u) => !isOversized(u.lovelace))
    .sort((a, b) => (a.lovelace > b.lovelace ? -1 : a.lovelace < b.lovelace ? 1 : 0));
  for (const u of rest) {
    if (consumedTotal >= target) break;
    consume.push(u);
    consumedTotal += u.lovelace;
  }
  if (consumedTotal < target) {
    return { act: false, reason: "insufficient" };
  }

  // Split the leftover into extra working-sized pieces so a consumed oversized
  // UTxO becomes many usable UTxOs rather than one large change output.
  let leftover = consumedTotal - target;
  while (leftover >= profile.workingLovelace) {
    outputs.push(profile.workingLovelace);
    leftover -= profile.workingLovelace;
  }

  return { act: true, consumeOutRefs: consume.map((u) => u.outRef), outputLovelaces: outputs };
}
