import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { livenessResult, readinessResult } from "../health.js";

describe("livenessResult", () => {
  it("always returns ok", () => {
    const r = livenessResult();
    assert.equal(r.status, "ok");
    assert.equal(r.checks.process.ok, true);
  });
});

describe("readinessResult", () => {
  const now = 1_700_000_000_000;
  const clock = () => now;

  it("ok when registry polled recently", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 30_000,
      lastSubmitMs: 0,
      maxStalenessMs: 300_000,
      now: clock,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.checks.registry.ok, true);
  });

  it("degraded when registry never polled", () => {
    const r = readinessResult({
      lastRegistryPollMs: 0,
      lastSubmitMs: 0,
      maxStalenessMs: 300_000,
      now: clock,
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.checks.registry.ok, false);
    assert.match(r.checks.registry.detail ?? "", /never polled/);
  });

  it("degraded when registry poll is stale", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 400_000,
      lastSubmitMs: 0,
      maxStalenessMs: 300_000,
      now: clock,
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.checks.registry.ok, false);
    assert.match(r.checks.registry.detail ?? "", /stale/);
  });

  it("submission check skipped when maxLastSubmitAgeMs = 0", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastSubmitMs: 0,
      maxStalenessMs: 300_000,
      maxLastSubmitAgeMs: 0,
      now: clock,
    });
    assert.equal(r.checks.submission, undefined);
  });

  it("submission check passes when recent", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastSubmitMs: now - 5_000,
      maxStalenessMs: 300_000,
      maxLastSubmitAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.submission?.ok, true);
  });

  it("submission check fails when too old", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastSubmitMs: now - 120_000,
      maxStalenessMs: 300_000,
      maxLastSubmitAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.submission?.ok, false);
    assert.match(r.checks.submission?.detail ?? "", /too old/);
  });

  it("submission check passes when lastSubmitMs = 0 (no submissions yet)", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastSubmitMs: 0,
      maxStalenessMs: 300_000,
      maxLastSubmitAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.submission?.ok, true);
  });
});
