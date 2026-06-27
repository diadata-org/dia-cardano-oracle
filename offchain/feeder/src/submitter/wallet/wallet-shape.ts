// wallet-shape.ts — resolve the feeder's `wallet_shape` config into the CLI's
// target UTxO profile.
//
// The pure split planner and the profile type live in the CLI (beside their
// `split-wallet` executor); this module is the feeder's config seam: it maps
// `infrastructure.<network>.yaml::wallet_shape` over the CLI's canonical
// `DEFAULT_*` constants and re-exports the planner for the bridge.

import type { WalletShapeProfile } from "@diadata-org/dia-cardano-oracle-cli/wallet/split-plan";
import {
  DEFAULT_COLLATERAL_UTXO_COUNT,
  DEFAULT_COLLATERAL_UTXO_LOVELACE,
  DEFAULT_SPLIT_ABOVE_LOVELACE,
  DEFAULT_WORKING_UTXO_COUNT,
  DEFAULT_WORKING_UTXO_LOVELACE,
  SPLIT_FEE_BUFFER_LOVELACE,
} from "../../config/constants.js";
import type { WalletShapeConfig } from "../../config/types.js";

export { planWalletSplit } from "@diadata-org/dia-cardano-oracle-cli/wallet/split-plan";
export type { SplitUtxo, SplitPlan, WalletShapeProfile } from "@diadata-org/dia-cardano-oracle-cli/wallet/split-plan";

/**
 * Resolve the `wallet_shape` config block into a concrete profile, filling each
 * omitted field from its `DEFAULT_*` constant and widening the config's lovelace
 * `number`s to `bigint`. `feeBufferLovelace` is a structural constant (not a
 * config knob), so it always comes from `SPLIT_FEE_BUFFER_LOVELACE`.
 */
export function resolveWalletShapeProfile(config: WalletShapeConfig | undefined): WalletShapeProfile {
  return {
    workingCount: config?.working_utxo_count ?? DEFAULT_WORKING_UTXO_COUNT,
    workingLovelace:
      config?.working_utxo_lovelace !== undefined
        ? BigInt(config.working_utxo_lovelace)
        : DEFAULT_WORKING_UTXO_LOVELACE,
    collateralCount: config?.collateral_utxo_count ?? DEFAULT_COLLATERAL_UTXO_COUNT,
    collateralLovelace:
      config?.collateral_utxo_lovelace !== undefined
        ? BigInt(config.collateral_utxo_lovelace)
        : DEFAULT_COLLATERAL_UTXO_LOVELACE,
    splitAboveLovelace:
      config?.split_above_lovelace !== undefined
        ? BigInt(config.split_above_lovelace)
        : DEFAULT_SPLIT_ABOVE_LOVELACE,
    feeBufferLovelace: SPLIT_FEE_BUFFER_LOVELACE,
  };
}
