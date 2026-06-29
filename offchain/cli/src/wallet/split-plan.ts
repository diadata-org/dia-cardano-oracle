// split-plan.ts — pure planner + target profile for splitting a wallet's UTxOs.
//
// A wallet drifts toward a few large UTxOs as change accumulates. The arbiter
// hands each concurrent lane a disjoint UTxO subset, so a wallet starved of
// usable UTxOs caps at one lane. This planner breaks a BIG UTxO (one above
// `bigUtxoAboveLovelace`) into the missing profile pieces — up to `workingCount`
// working + `collateralCount` collateral UTxOs — minting as far as the big UTxO's
// value funds and leaving the rest as ONE change UTxO. It never fans a UTxO into
// pieces beyond the profile, and it never touches good small UTxOs.
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
  /** A pure-ADA UTxO larger than this is considered big and is a candidate to
   *  split (only split when the wallet is ALSO short on usable UTxOs). */
  bigUtxoAboveLovelace: bigint;
  /** Headroom reserved on the consumed inputs for the tx fee + change min-UTxO. */
  feeBufferLovelace: bigint;
};

export type SplitPlan =
  | { act: true; consumeOutRefs: string[]; outputLovelaces: bigint[] }
  | { act: false; reason: "already_shaped" | "insufficient" };

/**
 * Decide whether to split a wallet toward `profile`, and if so which UTxOs to
 * consume and which outputs to create. Split ONLY breaks a big UTxO (one above
 * `bigUtxoAboveLovelace`) into the missing profile pieces — `collateralCount`
 * collateral + `workingCount` working — minting as far as the big UTxO's value
 * funds. The balancer returns the rest as ONE change UTxO; a UTxO is never fanned
 * into pieces beyond the profile. Returns `already_shaped` when there is nothing
 * big to break or the profile counts are already met (a low/dust wallet is the
 * funding / consolidate path, not this one).
 */
export function planWalletSplit(utxos: SplitUtxo[], profile: WalletShapeProfile): SplitPlan {
  const pure = utxos.filter((u) => u.hasOnlyAda);

  const isCollateral = (x: bigint) => x >= profile.collateralLovelace && x < profile.workingLovelace;
  const isWorking = (x: bigint) => x >= profile.workingLovelace && x <= profile.bigUtxoAboveLovelace;
  const isOversized = (x: bigint) => x > profile.bigUtxoAboveLovelace;

  const currentCollateral = pure.filter((u) => isCollateral(u.lovelace)).length;
  const currentWorking = pure.filter((u) => isWorking(u.lovelace)).length;
  const oversized = pure.filter((u) => isOversized(u.lovelace));

  const missingCollateral = Math.max(0, profile.collateralCount - currentCollateral);
  const missingWorking = Math.max(0, profile.workingCount - currentWorking);

  if (oversized.length === 0 || (missingCollateral === 0 && missingWorking === 0)) {
    return { act: false, reason: "already_shaped" };
  }

  // Consume the big UTxO(s) and mint the missing pieces from their value —
  // collateral first (keep the wallet collateral-capable), then working — as far
  // as the value funds. Whatever is left over the balancer returns as a single
  // change UTxO; there is no leftover-into-many-pieces fan-out.
  const consume = [...oversized];
  let avail = oversized.reduce((acc, u) => acc + u.lovelace, 0n) - profile.feeBufferLovelace;
  const outputs: bigint[] = [];
  for (let i = 0; i < missingCollateral && avail >= profile.collateralLovelace; i += 1) {
    outputs.push(profile.collateralLovelace);
    avail -= profile.collateralLovelace;
  }
  for (let i = 0; i < missingWorking && avail >= profile.workingLovelace; i += 1) {
    outputs.push(profile.workingLovelace);
    avail -= profile.workingLovelace;
  }
  if (outputs.length === 0) {
    return { act: false, reason: "insufficient" };
  }

  return { act: true, consumeOutRefs: consume.map((u) => u.outRef), outputLovelaces: outputs };
}
