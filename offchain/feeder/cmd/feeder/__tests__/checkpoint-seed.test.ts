import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seedCheckpointIfNeeded, type SeedableCheckpoint } from "../checkpoint-seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects saves in order. */
function makeCheckpoint(): SeedableCheckpoint & { saved: bigint[] } {
  const saved: bigint[] = [];
  return {
    saved,
    async save(blockNumber: bigint) {
      saved.push(blockNumber);
    },
  };
}

function makeReport(): { lines: string[]; fn: (line: string) => void } {
  const lines: string[] = [];
  return { lines, fn: (line: string) => lines.push(line) };
}

// ---------------------------------------------------------------------------
// No-op when neither flag is set
// ---------------------------------------------------------------------------

describe("seedCheckpointIfNeeded — no flags", () => {
  it("does not save when both fromBlock and fromLatest are falsy", async () => {
    const checkpoint = makeCheckpoint();
    const { fn: report } = makeReport();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: undefined,
      fromLatest: false,
      getLatestBlock: async () => 999n,
      report,
    });
    assert.deepEqual(checkpoint.saved, []);
  });

  it("does not call getLatestBlock when neither flag is set", async () => {
    let called = false;
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: undefined,
      fromLatest: false,
      getLatestBlock: async () => { called = true; return 0n; },
      report: () => {},
    });
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// --from-latest
// ---------------------------------------------------------------------------

describe("seedCheckpointIfNeeded — fromLatest", () => {
  it("saves the chain tip block", async () => {
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: undefined,
      fromLatest: true,
      getLatestBlock: async () => 7_800_000n,
      report: () => {},
    });
    assert.deepEqual(checkpoint.saved, [7_800_000n]);
  });

  it("logs the tip block", async () => {
    const checkpoint = makeCheckpoint();
    const { lines, fn: report } = makeReport();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: undefined,
      fromLatest: true,
      getLatestBlock: async () => 42n,
      report,
    });
    assert.ok(lines.some((l) => l.includes("42")), "expected block number in log");
    assert.ok(lines.some((l) => l.includes("tip")), "expected 'tip' in log");
  });

  it("calls getLatestBlock exactly once", async () => {
    let calls = 0;
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: undefined,
      fromLatest: true,
      getLatestBlock: async () => { calls += 1; return 1n; },
      report: () => {},
    });
    assert.equal(calls, 1);
  });
});

// ---------------------------------------------------------------------------
// --from-block
// ---------------------------------------------------------------------------

describe("seedCheckpointIfNeeded — fromBlock", () => {
  it("saves N-1 for block N > 0", async () => {
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "7200000",
      fromLatest: false,
      getLatestBlock: async () => 0n,
      report: () => {},
    });
    assert.deepEqual(checkpoint.saved, [7_199_999n]);
  });

  it("saves 0 when fromBlock is '0' (clamps at 0)", async () => {
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "0",
      fromLatest: false,
      getLatestBlock: async () => 0n,
      report: () => {},
    });
    assert.deepEqual(checkpoint.saved, [0n]);
  });

  it("saves 0 when fromBlock is '1'", async () => {
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "1",
      fromLatest: false,
      getLatestBlock: async () => 0n,
      report: () => {},
    });
    assert.deepEqual(checkpoint.saved, [0n]);
  });

  it("logs both the save target and the scan-from block", async () => {
    const checkpoint = makeCheckpoint();
    const { lines, fn: report } = makeReport();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "5000",
      fromLatest: false,
      getLatestBlock: async () => 0n,
      report,
    });
    const joined = lines.join("\n");
    assert.ok(joined.includes("4999"), "expected save-to block in log");
    assert.ok(joined.includes("5000"), "expected scan-from block in log");
  });

  it("does not call getLatestBlock", async () => {
    let called = false;
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "100",
      fromLatest: false,
      getLatestBlock: async () => { called = true; return 0n; },
      report: () => {},
    });
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// fromLatest takes precedence ordering (contract: caller must enforce
// mutual exclusion; here we verify fromLatest wins if both somehow slip through)
// ---------------------------------------------------------------------------

describe("seedCheckpointIfNeeded — fromLatest checked first", () => {
  it("uses fromLatest when both are set (caller's responsibility to prevent this)", async () => {
    const checkpoint = makeCheckpoint();
    await seedCheckpointIfNeeded({
      checkpoint,
      fromBlock: "9999",
      fromLatest: true,
      getLatestBlock: async () => 1234n,
      report: () => {},
    });
    // fromLatest branch is checked first → saves tip, not 9998n
    assert.deepEqual(checkpoint.saved, [1234n]);
  });
});
