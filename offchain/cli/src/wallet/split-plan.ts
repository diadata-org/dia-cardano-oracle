// split-plan.ts — pure planner + target profile for shaping a wallet's UTxOs.
//
// A wallet needs MANY small pure-ADA UTxOs, not a few large ones: the arbiter
// hands each concurrent lane a disjoint UTxO subset (one fee input + one
// collateral), so a wallet holding its balance as one lump caps at a single
// lane. Two callers shape a wallet toward the same target profile, sharing one
// piece planner (`planShapeOutputs`):
//
//   • split  — re-shapes a wallet that has DRIFTED concentrated (change piled up
//     into a big UTxO). It consumes the wallet's largest pure-ADA UTxO and pays
//     the missing pieces back to itself; the balancer returns the rest as one
//     change UTxO (itself a usable lane). `planWalletSplit` is the split planner.
//   • fund   — the feeder's main→pool funding pays the missing pieces straight to
//     the pool address in ONE tx (so a freshly funded pool is usable immediately,
//     no second split tx). It calls `planShapeOutputs` with `absorbRemainder` so
//     the whole transfer lands in the pool as several UTxOs.
//
// The shape is working-first: fill up to `workingCount` working UTxOs (the lanes)
// before any collateral, so a small wallet becomes all-lanes and only a wallet
// with the lanes already full carves the dedicated small collateral UTxOs. The
// number of pieces follows the available value — 300 ADA yields 3 lanes, 500 ADA
// five — with no balance threshold: concentration is about UTxO COUNT, not size.
//
// Pure (no chain) so the decision is fully unit-tested. Token-bearing UTxOs are
// never touched — collateral and clean fee inputs must be pure ADA.

/** The minimal wallet-UTxO shape the planner needs. */
export type SplitUtxo = {
  /** `${txHash}#${index}`. */
  outRef: string;
  /** Lovelace held. */
  lovelace: bigint;
  /** True when the UTxO holds only ADA (no native tokens). */
  hasOnlyAda: boolean;
};

/** The target UTxO shape for a wallet. All lovelace except the counts. The
 *  feeder maps `infrastructure.<network>.yaml::wallet_shape` over these defaults. */
export type WalletShapeProfile = {
  /** How many working (lane) UTxOs to keep. */
  workingCount: number;
  /** Target size of each working UTxO (lovelace). */
  workingLovelace: bigint;
  /** How many collateral UTxOs to keep (minted only once the lanes are full). */
  collateralCount: number;
  /** Target size of each collateral UTxO (lovelace). */
  collateralLovelace: bigint;
  /** Headroom reserved on the consumed inputs for the tx fee + change min-UTxO. */
  feeBufferLovelace: bigint;
};

export type SplitPlan =
  | { act: true; consumeOutRefs: string[]; outputLovelaces: bigint[] }
  | { act: false; reason: "already_shaped" | "insufficient" };

/**
 * Plan the output pieces that move a wallet toward `profile`, working-first, from
 * `available` lovelace and given the wallet's `existing` pure-ADA UTxOs (which
 * already count toward the profile). Fills up to `workingCount` working UTxOs
 * first; only once the lanes are full does it carve up to `collateralCount`
 * collateral UTxOs from what remains. Each step keeps `feeBufferLovelace` in
 * reserve so the consuming tx can pay its fee and leave a valid change UTxO.
 *
 * With `absorbRemainder` (the funding path, where outputs are paid to ANOTHER
 * wallet and there is no self-change), the leftover above the fee buffer is
 * appended as a final output so the whole `available` amount lands as pieces.
 * Without it (the split path), the leftover is left for the balancer to return
 * as the wallet's own change UTxO.
 */
export function planShapeOutputs(
  existing: SplitUtxo[],
  profile: WalletShapeProfile,
  available: bigint,
  opts: { absorbRemainder?: boolean } = {},
): bigint[] {
  const pure = existing.filter((u) => u.hasOnlyAda);
  const isCollateral = (x: bigint) => x >= profile.collateralLovelace && x < profile.workingLovelace;
  const isWorking = (x: bigint) => x >= profile.workingLovelace;

  const haveWorking = pure.filter((u) => isWorking(u.lovelace)).length;
  const haveCollateral = pure.filter((u) => isCollateral(u.lovelace)).length;
  const missingWorking = Math.max(0, profile.workingCount - haveWorking);
  const missingCollateral = Math.max(0, profile.collateralCount - haveCollateral);

  const outputs: bigint[] = [];
  let remaining = available;

  // Working lanes first: each push must leave the fee buffer behind.
  let mintedWorking = 0;
  while (mintedWorking < missingWorking && remaining - profile.workingLovelace >= profile.feeBufferLovelace) {
    outputs.push(profile.workingLovelace);
    remaining -= profile.workingLovelace;
    mintedWorking += 1;
  }

  // Dedicated collateral only once the lanes are full — a small wallet stays
  // all-lanes; a well-funded one gets cheap collateral it never risks as a lane.
  const lanesFull = haveWorking + mintedWorking >= profile.workingCount;
  if (lanesFull) {
    let mintedCollateral = 0;
    while (
      mintedCollateral < missingCollateral &&
      remaining - profile.collateralLovelace >= profile.feeBufferLovelace
    ) {
      outputs.push(profile.collateralLovelace);
      remaining -= profile.collateralLovelace;
      mintedCollateral += 1;
    }
  }

  if (opts.absorbRemainder && remaining >= profile.feeBufferLovelace) {
    outputs.push(remaining);
  }
  return outputs;
}

/**
 * Decide whether to split a wallet toward `profile`. Picks the wallet's LARGEST
 * pure-ADA UTxO as the source to break, then plans the missing pieces from its
 * value via `planShapeOutputs` (working-first), leaving the rest as one change
 * UTxO. There is no balance gate: a wallet is split whenever a larger UTxO can be
 * carved into pieces the wallet still lacks. Returns `already_shaped` when the
 * wallet already holds the working lanes, or `insufficient` when the largest UTxO
 * cannot fund even one missing piece (so the decision self-terminates — it never
 * re-fires once a wallet is as shaped as its balance allows).
 */
export function planWalletSplit(utxos: SplitUtxo[], profile: WalletShapeProfile): SplitPlan {
  const pure = utxos.filter((u) => u.hasOnlyAda).sort((a, b) => (b.lovelace > a.lovelace ? 1 : -1));
  if (pure.length === 0) return { act: false, reason: "already_shaped" };

  const source = pure[0];
  const rest = pure.slice(1);
  const available = source.lovelace - profile.feeBufferLovelace;
  if (available <= 0n) return { act: false, reason: "insufficient" };

  const outputs = planShapeOutputs(rest, profile, source.lovelace);
  if (outputs.length === 0) {
    const totalWorking = pure.filter((u) => u.lovelace >= profile.workingLovelace).length;
    return { act: false, reason: totalWorking >= profile.workingCount ? "already_shaped" : "insufficient" };
  }
  return { act: true, consumeOutRefs: [source.outRef], outputLovelaces: outputs };
}
