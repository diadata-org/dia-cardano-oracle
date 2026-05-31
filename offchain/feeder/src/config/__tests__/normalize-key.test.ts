// Tests that compact Spectra config key spellings are accepted alongside snake_case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfigKey } from "../loader.js";

test("normalizeConfigKey maps compact spellings to snake_case", () => {
  assert.equal(normalizeConfigKey("enablecors"), "enable_cors");
  assert.equal(normalizeConfigKey("scaninterval"), "scan_interval");
  assert.equal(normalizeConfigKey("headtrackerinterval"), "head_tracker_interval");
  assert.equal(normalizeConfigKey("gapdetectioninterval"), "gap_detection_interval");
  assert.equal(normalizeConfigKey("backfillchunkblocks"), "backfill_chunk_blocks");
  assert.equal(normalizeConfigKey("maxretries"), "max_retries");
  // Already snake_case: pass through unchanged
  assert.equal(normalizeConfigKey("scan_interval"), "scan_interval");
  assert.equal(normalizeConfigKey("enable_cors"), "enable_cors");
});
