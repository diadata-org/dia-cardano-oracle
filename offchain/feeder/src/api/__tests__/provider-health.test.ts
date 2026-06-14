import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveProviderRoles,
  createProviderHealthRecorder,
  probeProvider,
} from "../provider-health.js";
import { noopMetrics, type FeederMetrics } from "../metrics.js";

describe("resolveProviderRoles", () => {
  it("defaults to Blockfrost primary / Koios secondary", () => {
    assert.deepEqual(resolveProviderRoles(undefined), { primary: "Blockfrost", secondary: "Koios" });
    assert.deepEqual(resolveProviderRoles("Blockfrost"), { primary: "Blockfrost", secondary: "Koios" });
    assert.deepEqual(resolveProviderRoles("  "), { primary: "Blockfrost", secondary: "Koios" });
  });

  it("swaps to Koios primary / Blockfrost secondary when CARDANO_PROVIDER=Koios", () => {
    assert.deepEqual(resolveProviderRoles("Koios"), { primary: "Koios", secondary: "Blockfrost" });
    assert.deepEqual(resolveProviderRoles(" Koios "), { primary: "Koios", secondary: "Blockfrost" });
  });
});

type HealthCall = { labels: Record<string, string>; value: number };

function recordingMetrics(): {
  metrics: FeederMetrics;
  health: HealthCall[];
  lastOk: HealthCall[];
} {
  const health: HealthCall[] = [];
  const lastOk: HealthCall[] = [];
  const metrics: FeederMetrics = {
    ...noopMetrics,
    bridgeComponentHealth: { set: (labels, value) => health.push({ labels: labels ?? {}, value }) },
    bridgeProviderLastOkTimestampSeconds: { set: (labels, value) => lastOk.push({ labels: labels ?? {}, value }) },
  };
  return { metrics, health, lastOk };
}

describe("createProviderHealthRecorder", () => {
  it("on success sets health=1 and bumps the last-ok timestamp (seconds)", () => {
    const { metrics, health, lastOk } = recordingMetrics();
    const rec = createProviderHealthRecorder(metrics, () => 1_700_000_500_000);
    rec.record("primary", "Blockfrost", true);
    assert.deepEqual(health, [{ labels: { component: "blockfrost", role: "primary" }, value: 1 }]);
    assert.deepEqual(lastOk, [{ labels: { provider: "blockfrost", role: "primary" }, value: 1_700_000_500 }]);
  });

  it("on failure sets health=0 and does NOT touch the last-ok timestamp", () => {
    const { metrics, health, lastOk } = recordingMetrics();
    const rec = createProviderHealthRecorder(metrics, () => 1_700_000_500_000);
    rec.record("secondary", "Koios", false);
    assert.deepEqual(health, [{ labels: { component: "koios", role: "secondary" }, value: 0 }]);
    assert.equal(lastOk.length, 0);
  });

  it("uses the provided nowMs over the clock when bumping last-ok", () => {
    const { metrics, lastOk } = recordingMetrics();
    const rec = createProviderHealthRecorder(metrics, () => 0);
    rec.record("primary", "Koios", true, 1_700_000_900_000);
    assert.deepEqual(lastOk, [{ labels: { provider: "koios", role: "primary" }, value: 1_700_000_900 }]);
  });
});

const okFetch = (async () => ({ ok: true })) as unknown as typeof fetch;
const notOkFetch = (async () => ({ ok: false })) as unknown as typeof fetch;
const throwingFetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

describe("probeProvider", () => {
  it("Koios: hits /tip and returns true on 2xx", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return { ok: true };
    }) as unknown as typeof fetch;
    const ok = await probeProvider("Koios", { koiosApiUrl: "https://koios.example/api/v1", timeoutMs: 1000, fetchImpl });
    assert.equal(ok, true);
    assert.equal(url, "https://koios.example/api/v1/tip");
  });

  it("Blockfrost: hits /blocks/latest with the project_id header", async () => {
    let url = "";
    let header: string | undefined;
    const fetchImpl = (async (u: string, init?: { headers?: Record<string, string> }) => {
      url = u;
      header = init?.headers?.project_id;
      return { ok: true };
    }) as unknown as typeof fetch;
    const ok = await probeProvider("Blockfrost", {
      blockfrostApiUrl: "https://bf.example/api/v0/",
      blockfrostProjectId: "preview123",
      timeoutMs: 1000,
      fetchImpl,
    });
    assert.equal(ok, true);
    assert.equal(url, "https://bf.example/api/v0/blocks/latest");
    assert.equal(header, "preview123");
  });

  it("returns false on a non-2xx response", async () => {
    assert.equal(await probeProvider("Koios", { koiosApiUrl: "https://k/", timeoutMs: 1000, fetchImpl: notOkFetch }), false);
  });

  it("returns false (never throws) when the fetch throws", async () => {
    assert.equal(await probeProvider("Koios", { koiosApiUrl: "https://k/", timeoutMs: 1000, fetchImpl: throwingFetch }), false);
  });

  it("returns false when the required endpoint config is missing", async () => {
    assert.equal(await probeProvider("Koios", { timeoutMs: 1000, fetchImpl: okFetch }), false);
    assert.equal(
      await probeProvider("Blockfrost", { blockfrostApiUrl: "https://b/", timeoutMs: 1000, fetchImpl: okFetch }),
      false,
    );
  });
});
