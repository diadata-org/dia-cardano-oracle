// Tests for the non-interactive parts of init-cmd:
//   - buildRouterYaml (pure)
//   - loadExistingPairsFromYaml (filesystem)
//   - findConfigClientCandidates (filesystem)

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import {
  buildRouterFileStem,
  buildRouterYaml,
  loadExistingPairsFromYaml,
  findConfigClientCandidates,
} from "../init-cmd.js";

// ---------------------------------------------------------------------------
// buildRouterYaml — pure function
// ---------------------------------------------------------------------------

describe("buildRouterYaml", () => {
  const BASE_OPTS = {
    routerId: "client_a_router_default",
    clientId: "client-a",
    customerId: "client-a",
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
    assert.ok(yaml.includes("client_a_router_default"));
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

  it("includes the customer_id label", () => {
    const yaml = buildRouterYaml({ ...BASE_OPTS, customerId: "acme-corp" });
    assert.ok(yaml.includes("customer_id: acme-corp"));
  });

  it("round-trips into a router object with the shape the config validator requires", () => {
    // Generate → parse → assert the router carries every field validateModularConfig
    // requires, so the wizard output can never drift from the validator's schema.
    const parsed = parseYaml(buildRouterYaml(BASE_OPTS)) as {
      routers: Record<string, {
        customer_id?: string;
        type?: string;
        enabled?: boolean;
        triggers?: { events?: string[] };
        processing?: unknown;
        destinations?: Array<{
          cardano?: { network?: string; client_state_path?: string; protocol_state_path?: string };
        }>;
      }>;
    };
    const [routerId, router] = Object.entries(parsed.routers)[0]!;
    assert.equal(routerId, "client_a_router_default");
    assert.equal(router.customer_id, "client-a"); // required by the validator
    assert.equal(typeof router.type, "string");
    assert.equal(router.enabled, true);
    assert.ok(router.triggers?.events?.includes("IntentRegistered"));
    assert.ok(router.processing);
    const cardano = router.destinations?.[0]?.cardano;
    assert.equal(cardano?.network, "Preview");
    assert.ok(cardano?.client_state_path);
    assert.ok(cardano?.protocol_state_path);
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

describe("buildRouterFileStem", () => {
  it("uses the client-router-name filename convention", () => {
    assert.equal(buildRouterFileStem("client-a", "Majors"), "client-a-router-majors");
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
