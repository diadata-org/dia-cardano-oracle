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
      lastConfirmedMs: 0,
      maxStalenessMs: 300_000,
      now: clock,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.checks.registry.ok, true);
  });

  it("degraded when registry never polled", () => {
    const r = readinessResult({
      lastRegistryPollMs: 0,
      lastConfirmedMs: 0,
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
      lastConfirmedMs: 0,
      maxStalenessMs: 300_000,
      now: clock,
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.checks.registry.ok, false);
    assert.match(r.checks.registry.detail ?? "", /stale/);
  });

  it("confirmation check skipped when maxLastConfirmedAgeMs = 0", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: 0,
      maxStalenessMs: 300_000,
      maxLastConfirmedAgeMs: 0,
      now: clock,
    });
    assert.equal(r.checks.confirmation, undefined);
  });

  it("confirmation check passes when last confirmed is recent", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: now - 5_000,
      maxStalenessMs: 300_000,
      maxLastConfirmedAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.confirmation?.ok, true);
  });

  it("confirmation check fails when last confirmed is older than max_last_confirmed_age", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: now - 120_000,
      maxStalenessMs: 300_000,
      maxLastConfirmedAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.confirmation?.ok, false);
    assert.match(r.checks.confirmation?.detail ?? "", /older than max_last_confirmed_age/);
  });

  it("confirmation check passes when lastConfirmedMs = 0 (no submissions yet)", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: 0,
      maxStalenessMs: 300_000,
      maxLastConfirmedAgeMs: 60_000,
      now: clock,
    });
    assert.equal(r.checks.confirmation?.ok, true);
  });

  it("skips the cardano_provider check when primaryProviderHealthy is undefined", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: 0,
      now: clock,
    });
    assert.equal(r.checks.cardano_provider, undefined);
  });

  it("degraded when the primary Cardano provider is unreachable", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: 0,
      primaryProviderHealthy: false,
      now: clock,
    });
    assert.equal(r.status, "degraded");
    assert.equal(r.checks.cardano_provider?.ok, false);
    assert.match(r.checks.cardano_provider?.detail ?? "", /unreachable/);
  });

  it("ok when the primary Cardano provider is reachable", () => {
    const r = readinessResult({
      lastRegistryPollMs: now - 10_000,
      lastConfirmedMs: 0,
      primaryProviderHealthy: true,
      now: clock,
    });
    assert.equal(r.checks.cardano_provider?.ok, true);
  });
});
