import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWalletShapeProfile } from "../wallet-shape.js";
import {
  DEFAULT_COLLATERAL_UTXO_COUNT,
  DEFAULT_COLLATERAL_UTXO_LOVELACE,
  DEFAULT_WORKING_UTXO_COUNT,
  DEFAULT_WORKING_UTXO_LOVELACE,
  SPLIT_FEE_BUFFER_LOVELACE,
} from "../../../config/constants.js";

describe("resolveWalletShapeProfile", () => {
  it("falls back to the DEFAULT_* constants when no config is given", () => {
    assert.deepEqual(resolveWalletShapeProfile(undefined), {
      workingCount: DEFAULT_WORKING_UTXO_COUNT,
      workingLovelace: DEFAULT_WORKING_UTXO_LOVELACE,
      collateralCount: DEFAULT_COLLATERAL_UTXO_COUNT,
      collateralLovelace: DEFAULT_COLLATERAL_UTXO_LOVELACE,
      feeBufferLovelace: SPLIT_FEE_BUFFER_LOVELACE,
    });
  });

  it("overrides each field from config and widens lovelace numbers to bigint", () => {
    const profile = resolveWalletShapeProfile({
      working_utxo_count: 3,
      working_utxo_lovelace: 120_000_000,
      collateral_utxo_count: 2,
      collateral_utxo_lovelace: 8_000_000,
    });
    assert.deepEqual(profile, {
      workingCount: 3,
      workingLovelace: 120_000_000n,
      collateralCount: 2,
      collateralLovelace: 8_000_000n,
      feeBufferLovelace: SPLIT_FEE_BUFFER_LOVELACE,
    });
  });

  it("fills only the omitted fields from defaults (partial config)", () => {
    const profile = resolveWalletShapeProfile({ working_utxo_count: 7 });
    assert.equal(profile.workingCount, 7, "the provided field wins");
    assert.equal(profile.workingLovelace, DEFAULT_WORKING_UTXO_LOVELACE, "omitted fields keep the default");
    assert.equal(profile.collateralLovelace, DEFAULT_COLLATERAL_UTXO_LOVELACE, "omitted fields keep the default");
  });
});
