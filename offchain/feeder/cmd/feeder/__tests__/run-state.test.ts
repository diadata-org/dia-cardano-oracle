import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveRunStateDir, latestRunDir } from "../run-state.js";

const savedRunId = process.env.RUN_ID;
afterEach(() => {
  if (savedRunId === undefined) delete process.env.RUN_ID;
  else process.env.RUN_ID = savedRunId;
});

describe("resolveRunStateDir — per-run state selection", () => {
  it("uses state/<network>_run_<RUN_ID> when RUN_ID is set", async () => {
    process.env.RUN_ID = "20260517-063917";
    const base = await mkdtemp(path.join(tmpdir(), "feeder-runstate-"));
    try {
      assert.equal(
        resolveRunStateDir("Mainnet", base),
        path.join(base, "mainnet_run_20260517-063917"),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("picks the newest <network>_run_* dir when RUN_ID is unset", async () => {
    delete process.env.RUN_ID;
    const base = await mkdtemp(path.join(tmpdir(), "feeder-runstate-"));
    try {
      await mkdir(path.join(base, "mainnet_run_20260101-000000"));
      await mkdir(path.join(base, "mainnet_run_20260517-063917")); // newest (lexically last)
      await mkdir(path.join(base, "preview_run_20260601-000000")); // other network, ignored
      assert.equal(
        resolveRunStateDir("Mainnet", base),
        path.join(base, "mainnet_run_20260517-063917"),
      );
      assert.equal(latestRunDir("Mainnet", base), path.join(base, "mainnet_run_20260517-063917"));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("falls back to the flat state/<network> when no run dirs exist", async () => {
    delete process.env.RUN_ID;
    const base = await mkdtemp(path.join(tmpdir(), "feeder-runstate-"));
    try {
      assert.equal(resolveRunStateDir("Preview", base), path.join(base, "preview"));
      assert.equal(latestRunDir("Preview", base), null);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
