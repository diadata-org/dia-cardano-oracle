// split-plan.ts — pure planner + target profile for splitting a wallet's UTxOs.
//
// A wallet drifts toward a few large UTxOs as change accumulates. The arbiter
// hands each concurrent lane a disjoint UTxO subset, so a wallet starved of
// usable UTxOs caps at one lane. This planner decides how to break the wallet
// toward a target PROFILE — N working UTxOs of a working size plus M
// collateral-sized UTxOs — by consuming oversized UTxOs (and topping up the
// missing pieces) and paying the profile back to the wallet.
//
// It lives in the CLI beside its executor `transactions/split-wallet.ts`: the
// CLI owns "how to split a wallet" (plan + execute), and the feeder's bridge
// orchestrates "when to split" (arbiter reservation) by importing this planner.
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

export type SplitPlan =
  | { act: true; consumeOutRefs: string[]; outputLovelaces: bigint[] }
  | { act: false; reason: "already_shaped" | "insufficient" };

/**
 * Decide whether to split a wallet toward `profile`, and if so which UTxOs to
 * consume and which outputs to create (the tx balancer adds the change). Returns
 * `already_shaped` when the wallet already holds the profile and has no oversized
 * UTxO, or `insufficient` when it cannot fund even the missing pieces.
 */
export function planWalletSplit(utxos: SplitUtxo[], profile: WalletShapeProfile): SplitPlan {
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
  const consume: SplitUtxo[] = [...oversized];
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
