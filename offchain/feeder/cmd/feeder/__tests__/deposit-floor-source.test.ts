// The daemon sources the deposit dust floor it passes to the bridge from the
// CLI-produced protocol state (config-bootstrap.json::configState.
// depositMinLovelace, set at the CLI's protocol:init) — NOT from the feeder's
// infrastructure.<network>.yaml. These tests cover `readDepositMinLovelace`,
// the helper runDaemon uses to read that floor before constructing the bridge.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readDepositMinLovelace, readDepositMaxPerUpdateFold } from "../daemon-cmd.js";

async function withTempBootstrap(
  contents: unknown,
  fn: (bootstrapPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dia-deposit-floor-"));
  try {
    const bootstrapPath = path.join(dir, "config-bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify(contents), "utf8");
    await fn(bootstrapPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("readDepositMinLovelace (daemon → bridge floor source)", () => {
  it("reads configState.depositMinLovelace from the protocol state", async () => {
    await withTempBootstrap(
      { configState: { depositMinLovelace: "1000000", depositMaxPerMerge: "20" } },
      async (bootstrapPath) => {
        const floor = await readDepositMinLovelace(bootstrapPath);
        assert.equal(floor, 1_000_000n);
        assert.equal(typeof floor, "bigint");
      },
    );
  });

  it("honours a non-default floor set at protocol:init", async () => {
    await withTempBootstrap(
      { configState: { depositMinLovelace: "3000000", depositMaxPerMerge: "5" } },
      async (bootstrapPath) => {
        assert.equal(await readDepositMinLovelace(bootstrapPath), 3_000_000n);
      },
    );
  });

  it("throws a clear error when the field is absent (no hardcoded fallback)", async () => {
    await withTempBootstrap({ configState: {} }, async (bootstrapPath) => {
      await assert.rejects(
        readDepositMinLovelace(bootstrapPath),
        /configState\.depositMinLovelace/,
      );
    });
  });

  it("throws when the protocol state file is missing", async () => {
    await assert.rejects(
      readDepositMinLovelace("/nonexistent/config-bootstrap.json"),
      /cannot read configState\.depositMinLovelace/,
    );
  });
});

describe("readDepositMaxPerUpdateFold (daemon → bridge fold-cap source)", () => {
  it("reads configState.depositMaxPerUpdateFold from the protocol state", async () => {
    await withTempBootstrap(
      { configState: { depositMinLovelace: "1000000", depositMaxPerUpdateFold: "3" } },
      async (bootstrapPath) => {
        const cap = await readDepositMaxPerUpdateFold(bootstrapPath);
        assert.equal(cap, 3);
        assert.equal(typeof cap, "number");
      },
    );
  });

  it("honours a non-default cap set at protocol:init", async () => {
    await withTempBootstrap(
      { configState: { depositMaxPerUpdateFold: "5" } },
      async (bootstrapPath) => {
        assert.equal(await readDepositMaxPerUpdateFold(bootstrapPath), 5);
      },
    );
  });

  it("throws a clear error when the field is absent (no hardcoded fallback)", async () => {
    await withTempBootstrap({ configState: {} }, async (bootstrapPath) => {
      await assert.rejects(
        readDepositMaxPerUpdateFold(bootstrapPath),
        /configState\.depositMaxPerUpdateFold/,
      );
    });
  });

  it("throws when the protocol state file is missing", async () => {
    await assert.rejects(
      readDepositMaxPerUpdateFold("/nonexistent/config-bootstrap.json"),
      /cannot read configState\.depositMaxPerUpdateFold/,
    );
  });
});
