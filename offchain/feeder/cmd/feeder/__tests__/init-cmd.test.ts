// Tests for the non-interactive parts of init-cmd:
//   - buildRouterYaml (pure)
//   - loadExistingPairsFromYaml (filesystem)
//   - findConfigClientCandidates (filesystem)

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildRouterYaml,
  loadExistingPairsFromYaml,
  findConfigClientCandidates,
} from "../init-cmd.js";

// ---------------------------------------------------------------------------
// buildRouterYaml — pure function
// ---------------------------------------------------------------------------

describe("buildRouterYaml", () => {
  const BASE_OPTS = {
    routerId: "client_a_preview",
    clientId: "client-a",
    customer: "client-a",
    network: "Preview" as const,
    keyEnv: "CARDANO_WALLET_SEED_TESTNET",
    pairs: ["BTC/USD", "ETH/USD"],
    clientStatePath: "state/preview/clients/client-a.json",
    protocolStatePath: "state/preview/config-bootstrap.json",
    timeThreshold: "5m",
    priceDeviation: "0.1%",
  };

  it("includes all provided pairs", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("- BTC/USD"), "missing BTC/USD");
    assert.ok(yaml.includes("- ETH/USD"), "missing ETH/USD");
  });

  it("includes the routerId", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("client_a_preview"));
  });

  it("includes the network", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("network: Preview"));
  });

  it("includes client and protocol state paths", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("state/preview/clients/client-a.json"));
    assert.ok(yaml.includes("state/preview/config-bootstrap.json"));
  });

  it("includes the key env var", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("CARDANO_WALLET_SEED_TESTNET"));
  });

  it("enables the cron liveness heartbeat on the destination", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("cron: true"), "destination must set cron: true so a flat pair still updates within time_threshold");
  });

  it("includes the customer label", () => {
    const yaml = buildRouterYaml({ ...BASE_OPTS, customer: "acme-corp" });
    assert.ok(yaml.includes("customer: acme-corp"));
  });

  it("includes time_threshold and price_deviation", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("time_threshold: 5m"));
    assert.ok(yaml.includes('price_deviation: "0.1%"'));
  });

  it("produces a routers: block at the top level", () => {
    const yaml = buildRouterYaml(BASE_OPTS);
    assert.ok(yaml.includes("routers:"));
  });

  it("uses mainnet network correctly", () => {
    const yaml = buildRouterYaml({ ...BASE_OPTS, network: "Mainnet" });
    assert.ok(yaml.includes("network: Mainnet"));
  });

  it("handles a single pair", () => {
    const yaml = buildRouterYaml({ ...BASE_OPTS, pairs: ["ADA/USD"] });
    assert.ok(yaml.includes("- ADA/USD"));
    assert.ok(!yaml.includes("BTC/USD"));
  });
});

// ---------------------------------------------------------------------------
// loadExistingPairsFromYaml — filesystem
// ---------------------------------------------------------------------------

describe("loadExistingPairsFromYaml", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "feeder-test-yaml-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when file does not exist", async () => {
    const pairs = await loadExistingPairsFromYaml(join(tmpDir, "nonexistent.yaml"));
    assert.deepEqual(pairs, []);
  });

  it("extracts pairs from a router YAML file", async () => {
    const yaml = `
routers:
  test:
    triggers:
      conditions:
        - field: symbol
          operator: in
          value:
            - BTC/USD
            - ETH/USD
            - USDC/USD
`;
    const yamlPath = join(tmpDir, "router.yaml");
    await writeFile(yamlPath, yaml, "utf8");
    const pairs = await loadExistingPairsFromYaml(yamlPath);
    assert.deepEqual(pairs, ["BTC/USD", "ETH/USD", "USDC/USD"]);
  });

  it("returns empty array for a YAML with no pairs", async () => {
    const yaml = `routers:\n  test:\n    id: test\n`;
    const yamlPath = join(tmpDir, "no-pairs.yaml");
    await writeFile(yamlPath, yaml, "utf8");
    const pairs = await loadExistingPairsFromYaml(yamlPath);
    assert.deepEqual(pairs, []);
  });
});

// ---------------------------------------------------------------------------
// findConfigClientCandidates — filesystem
// ---------------------------------------------------------------------------

describe("findConfigClientCandidates", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "feeder-test-cli-clients-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when stateDir does not exist", async () => {
    const hits = await findConfigClientCandidates("preview", join(tmpDir, "nonexistent"));
    assert.deepEqual(hits, []);
  });

  it("finds client JSON files", async () => {
    const clientsDir = join(tmpDir, "preview_run_20260601", "clients");
    await mkdir(clientsDir, { recursive: true });
    await writeFile(join(clientsDir, "client-a.json"), '{"clientId":"client-a"}', "utf8");
    const hits = await findConfigClientCandidates("preview", tmpDir);
    assert.equal(hits.length, 1);
    assert.ok(hits[0].endsWith("client-a.json"));
  });

  it("does not return clients from wrong-network run dirs", async () => {
    const clientsDir = join(tmpDir, "mainnet_run_20260601", "clients");
    await mkdir(clientsDir, { recursive: true });
    await writeFile(join(clientsDir, "client-m.json"), '{"clientId":"client-m"}', "utf8");
    const hits = await findConfigClientCandidates("preview", tmpDir);
    assert.ok(!hits.some(h => h.includes("client-m.json")));
  });

  it("ignores non-JSON files in clients dir", async () => {
    const clientsDir = join(tmpDir, "preview_run_20260602", "clients");
    await mkdir(clientsDir, { recursive: true });
    await writeFile(join(clientsDir, "README.md"), "# docs", "utf8");
    await writeFile(join(clientsDir, "client-b.json"), '{"clientId":"client-b"}', "utf8");
    const hits = await findConfigClientCandidates("preview", tmpDir);
    assert.ok(hits.every(h => h.endsWith(".json")));
  });
});
