// R10.C.9 — construction-time validation for createEventWorkerPool (R10.A.7).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createEventWorkerPool } from "../event-worker-pool.js";

const ok = { onEvent: async () => {} };

describe("createEventWorkerPool — construction validation", () => {
  it("throws when processingTimeoutMs is 0", () => {
    assert.throws(
      () => createEventWorkerPool({ workerCount: 1, queueSize: 1, processingTimeoutMs: 0, ...ok }),
      /processingTimeoutMs must be a positive number/,
    );
  });

  it("throws when processingTimeoutMs is negative", () => {
    assert.throws(
      () => createEventWorkerPool({ workerCount: 1, queueSize: 1, processingTimeoutMs: -5, ...ok }),
      /processingTimeoutMs must be a positive number/,
    );
  });

  it("throws when workerCount < 1", () => {
    assert.throws(
      () => createEventWorkerPool({ workerCount: 0, queueSize: 1, processingTimeoutMs: 100, ...ok }),
      /workerCount must be a positive integer/,
    );
  });

  it("throws when queueSize < 1", () => {
    assert.throws(
      () => createEventWorkerPool({ workerCount: 1, queueSize: 0, processingTimeoutMs: 100, ...ok }),
      /queueSize must be a positive integer/,
    );
  });

  it("constructs successfully with valid positive options", () => {
    const pool = createEventWorkerPool({ workerCount: 2, queueSize: 8, processingTimeoutMs: 1000, ...ok });
    assert.equal(typeof pool.submit, "function");
  });
});
