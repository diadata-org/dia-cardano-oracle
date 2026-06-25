import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRegistry } from "../registry-config.js";

/** Run async `fn` with a freshly-written temp file, cleaning up afterwards. */
async function withTempFile(
  name: string,
  content: string,
  fn: (file: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "indexer-registry-"));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, content);
    await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadRegistry (from the shared state tree)", () => {
  it("derives the Preview registry from offchain/state (same source as CLI/feeder)", async () => {
    const registry = await loadRegistry("Preview");
    assert.equal(registry.network, "Preview");
    assert.ok(registry.clients.length >= 1, "expected at least one bootstrapped Preview client");
    for (const client of registry.clients) {
      assert.match(client.pairValidatorAddress, /^addr_test1/);
      assert.match(client.receiverValidatorAddress, /^addr_test1/);
      assert.match(client.pairPolicyId, /^[0-9a-f]{56}$/);
      assert.match(client.receiverUnit, /^[0-9a-f]+$/);
    }
  });

  it("derives the Mainnet registry (addr1 addresses)", async () => {
    const registry = await loadRegistry("Mainnet");
    assert.equal(registry.network, "Mainnet");
    assert.ok(registry.clients.length >= 1);
    assert.match(registry.clients[0]!.pairValidatorAddress, /^addr1/);
  });

  it("returns an empty registry with no Config for a not-yet-bootstrapped deployment", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "indexer-empty-state-"));
    try {
      const registry = await loadRegistry("Preview", { stateDir: dir });
      assert.equal(registry.network, "Preview");
      assert.deepEqual(registry.clients, []);
      assert.equal(registry.config, undefined, "no config-bootstrap.json → no fee source");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRegistry (explicit file override — running from a published registry JSON)", () => {
  const validRegistry = JSON.stringify({
    network: "Preview",
    clients: [
      {
        clientId: "c1",
        pairPolicyId: "ab".repeat(28),
        pairValidatorAddress: "addr_test1xxx",
        receiverValidatorAddress: "addr_test1yyy",
        receiverUnit: "cd".repeat(20),
      },
    ],
  });

  it("loads a published registry JSON via the override", async () => {
    await withTempFile("custom.json", validRegistry, async (file) => {
      const registry = await loadRegistry("Preview", { registryFile: file });
      assert.equal(registry.clients[0]!.clientId, "c1");
    });
  });

  it("throws when the override file cannot be read", async () => {
    await assert.rejects(
      loadRegistry("Mainnet", { registryFile: "/no/such/registry.json" }),
      /Cannot read registry file/,
    );
  });

  it("throws on invalid JSON in the override file", async () => {
    await withTempFile("bad.json", "{ not json", async (file) => {
      await assert.rejects(loadRegistry("Preview", { registryFile: file }), /invalid JSON/);
    });
  });

  it("throws on a structurally invalid override file", async () => {
    await withTempFile(
      "incomplete.json",
      JSON.stringify({ network: "Preview", clients: [{ clientId: "c1" }] }),
      async (file) => {
        await assert.rejects(loadRegistry("Preview", { registryFile: file }), /pairPolicyId is missing/);
      },
    );
  });
});
