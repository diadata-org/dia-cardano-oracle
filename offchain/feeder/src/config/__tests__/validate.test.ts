import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseAllAbis } from "../abi-parser.js";
import type { ContractConfig, EventDefinition, ModularConfig } from "../types.js";
import { validateModularConfig } from "../validate.js";

const INTENT_REGISTERED_ABI = JSON.stringify({
  type: "event",
  name: "IntentRegistered",
  anonymous: false,
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "symbol", type: "string", indexed: true },
    { name: "price", type: "uint256", indexed: true },
    { name: "timestamp", type: "uint256", indexed: false },
    { name: "signer", type: "address", indexed: false },
  ],
});

const REGISTRY_CONTRACT_ABI = JSON.stringify([
  {
    type: "function",
    name: "getIntent",
    stateMutability: "view",
    inputs: [{ name: "intentHash", type: "bytes32" }],
    outputs: [{ name: "intent", type: "bytes" }],
  },
]);

function makeConfig(includeTxMode = false): ModularConfig {
  const contracts: Record<string, ContractConfig> = {
    registry: {
      chain_id: 10050,
      address: "0x1111111111111111111111111111111111111111",
      type: "registry",
      enabled: true,
      abi: REGISTRY_CONTRACT_ABI,
    },
  };

  const eventDefinitions: Record<string, EventDefinition> = {
    IntentRegistered: {
      contract: "registry",
      abi: INTENT_REGISTERED_ABI,
      data_extraction: {},
    },
  };

  return {
    infrastructure: {
      database: { driver: "sqlite" },
      source: {
        chain_id: 10050,
        name: "DIA Testnet",
        rpc_urls: ["https://testnet-rpc.diadata.org"],
      },
      worker_pool: {
        task_timeout: "60s",
        retry_delay: "5s",
        max_retries: 3,
        inflight_timeout_ms: 900000,
      },
      alerting: {
        receiver_balance_low_lovelace: 2000000000,
        settle_overdue_lovelace: 10000000,
        payment_hook_withdraw_ready_lovelace: 50000000,
        admin_wallet_low_lovelace: 5000000000,
        oracle_pair_stale_seconds: 3600,
        price_deviation_high_percent: 5,
        price_age_high_seconds: 600,
        reorg_rate_high_per_hour: 3,
        deposit_pending_merge_lovelace: 5000000,
      },
    },
    chains: {
      "dia-testnet": {
        chain_id: 10050,
        name: "DIA Testnet",
        rpc_urls: ["https://testnet-rpc.diadata.org"],
        enabled: true,
      },
    },
    contracts,
    event_definitions: eventDefinitions,
    routers: {
      "router-a": {
        id: "router-a",
        name: "Router A",
        customer_id: "customer-a",
        type: "event",
        enabled: true,
        private_key_env: "CARDANO_WALLET_SEED_TESTNET",
        triggers: {
          events: ["IntentRegistered"],
          conditions: [],
        },
        processing: { datasource: "enrichment" },
        destinations: [
          {
            cardano: includeTxMode
              ? ({
                  network: "Preview",
                  client_state_path: "state/preview/clients/client-a.json",
                  protocol_state_path: "state/preview/config-bootstrap.json",
                  tx_mode: "auto",
                } as unknown as ModularConfig["routers"][string]["destinations"][number]["cardano"])
              : {
                  network: "Preview",
                  client_state_path: "state/preview/clients/client-a.json",
                  protocol_state_path: "state/preview/config-bootstrap.json",
                },
          },
        ],
      },
    },
    parsedAbis: parseAllAbis(eventDefinitions, contracts),
  };
}

describe("validateModularConfig", () => {
  it("accepts cardano destinations without tx_mode", () => {
    const issues = validateModularConfig(makeConfig(false));
    assert.deepEqual(issues, []);
  });

  it("accepts multiple routers that share one Cardano client/protocol destination", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.triggers.conditions = [
      { field: "event.symbol", operator: "in", value: ["BTC/USD"] },
    ];
    config.routers["router-b"] = {
      ...config.routers["router-a"]!,
      id: "router-b",
      name: "Router B",
      private_key_env: "CARDANO_WALLET_SEED_TESTNET_ALT",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["ETH/USD"] }],
      },
      destinations: [
        {
          cardano: {
            network: "Preview",
            client_state_path: "state/preview/clients/client-a.json",
            protocol_state_path: "state/preview/config-bootstrap.json",
          },
          time_threshold: "30m",
          price_deviation: "1%",
        },
      ],
    };

    assert.deepEqual(validateModularConfig(config), []);
  });

  it("rejects a router without customer_id", () => {
    const config = makeConfig(false);
    delete (config.routers["router-a"] as Partial<ModularConfig["routers"][string]>).customer_id;

    const issues = validateModularConfig(config);
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-a.customer_id" &&
          /Required/.test(issue.message),
      ),
      `expected missing customer_id to be rejected; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects unknown router fields", () => {
    const config = makeConfig(false);
    (config.routers["router-a"] as unknown as Record<string, unknown>).unexpected_label = "nope";

    const issues = validateModularConfig(config);
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-a.unexpected_label" &&
          issue.message === "Unknown field.",
      ),
      `expected unknown field to be rejected; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects one router whose Cardano destinations point at different clients", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.destinations.push({
      cardano: {
        network: "Preview",
        client_state_path: "state/preview/clients/client-b.json",
        protocol_state_path: "state/preview/config-bootstrap.json",
      },
      time_threshold: "30m",
      price_deviation: "1%",
    });

    const issues = validateModularConfig(config);
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-a.destinations" &&
          /same on-chain client deployment/.test(issue.message),
      ),
      `expected mixed-client router destinations to be rejected; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects one client deployment referenced by multiple customer_id values", () => {
    const config = makeConfig(false);
    config.routers["router-b"] = {
      ...config.routers["router-a"]!,
      id: "router-b",
      name: "Router B",
      customer_id: "customer-b",
      private_key_env: "CARDANO_WALLET_SEED_TESTNET_ALT",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["ETH/USD"] }],
      },
    };

    const issues = validateModularConfig(config);
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-a.customer_id" &&
          /exactly one customer_id/.test(issue.message),
      ),
      `expected mixed customer ownership to be rejected on router-a; got ${JSON.stringify(issues)}`,
    );
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-b.customer_id" &&
          /exactly one customer_id/.test(issue.message),
      ),
      `expected mixed customer ownership to be rejected on router-b; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects overlapping symbols across routers that share one Cardano lane", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.triggers.conditions = [
      { field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] },
    ];
    config.routers["router-b"] = {
      ...config.routers["router-a"]!,
      id: "router-b",
      name: "Router B",
      private_key_env: "CARDANO_WALLET_SEED_TESTNET_ALT",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD", "ADA/USD"] }],
      },
      destinations: [
        {
          cardano: {
            network: "Preview",
            client_state_path: "state/preview/clients/client-a.json",
            protocol_state_path: "state/preview/config-bootstrap.json",
          },
        },
      ],
    };

    const issues = validateModularConfig(config);
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-a.destinations[0].cardano.client_state_path" &&
          /overlaps on symbol\(s\) BTC\/USD/.test(issue.message),
      ),
      `expected a shared-lane overlap error on router-a; got ${JSON.stringify(issues)}`,
    );
    assert.ok(
      issues.some(
        (issue) =>
          issue.severity === "error" &&
          issue.path === "routers.router-b.destinations[0].cardano.client_state_path" &&
          /overlaps on symbol\(s\) BTC\/USD/.test(issue.message),
      ),
      `expected a shared-lane overlap error on router-b; got ${JSON.stringify(issues)}`,
    );
  });

  it("accepts one customer that owns two clients on distinct lanes", () => {
    // A customer may run multiple on-chain client deployments (each its own
    // Receiver/deposit/lane). Same customer_id, different client_state_path.
    const config = makeConfig(false);
    config.routers["router-a"]!.triggers.conditions = [
      { field: "event.symbol", operator: "in", value: ["BTC/USD"] },
    ];
    config.routers["router-b"] = {
      ...config.routers["router-a"]!,
      id: "router-b",
      name: "Router B",
      private_key_env: "CARDANO_WALLET_SEED_TESTNET_ALT",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["ETH/USD"] }],
      },
      destinations: [
        {
          cardano: {
            network: "Preview",
            client_state_path: "state/preview/clients/client-b.json",
            protocol_state_path: "state/preview/config-bootstrap.json",
          },
        },
      ],
    };

    assert.deepEqual(validateModularConfig(config), []);
  });

  it("accepts overlapping symbols when the routers target different clients/lanes", () => {
    // The disjoint-symbol rule only applies WITHIN one shared lane. Two routers
    // on different clients (different lanes) may both serve BTC/USD.
    const config = makeConfig(false);
    config.routers["router-a"]!.triggers.conditions = [
      { field: "event.symbol", operator: "in", value: ["BTC/USD"] },
    ];
    config.routers["router-b"] = {
      ...config.routers["router-a"]!,
      id: "router-b",
      name: "Router B",
      private_key_env: "CARDANO_WALLET_SEED_TESTNET_ALT",
      triggers: {
        events: ["IntentRegistered"],
        conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD"] }],
      },
      destinations: [
        {
          cardano: {
            network: "Preview",
            client_state_path: "state/preview/clients/client-b.json",
            protocol_state_path: "state/preview/config-bootstrap.json",
          },
        },
      ],
    };

    assert.deepEqual(validateModularConfig(config), []);
  });

  // tx_mode is no longer rejected — the guard was removed as a rename leftover.

  // R10.A.10 — EVM payload-reshaping config is rejected for Cardano routers,
  // because the payload is a signed intent (transforming it breaks the
  // on-chain EIP-712 signature). These guards convert silent no-ops into
  // loud config errors. (Backs R10.C.19.j: there is no transformer→submit
  // path to integration-test; the rejection IS the contract.)
  it("rejects a non-empty processing.transformations block", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.processing.transformations = [
      { field: "price", operation: "multiply", input: "price", params: { factor: 2 } },
    ] as unknown as ModularConfig["routers"][string]["processing"]["transformations"];
    const issues = validateModularConfig(config);
    assert.ok(
      issues.some((i) => i.severity === "error" && /transformations/.test(i.message)),
      `expected a transformations rejection; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects processing.datasource = 'processed'", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.processing.datasource = "processed";
    const issues = validateModularConfig(config);
    assert.ok(
      issues.some((i) => i.severity === "error" && /datasource/.test(i.message)),
      `expected a datasource rejection; got ${JSON.stringify(issues)}`,
    );
  });

  it("rejects processing.validationenabled = false", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.processing.validationenabled = false;
    const issues = validateModularConfig(config);
    assert.ok(
      issues.some((i) => i.severity === "error" && /validationenabled/.test(i.message)),
      `expected a validationenabled rejection; got ${JSON.stringify(issues)}`,
    );
  });

  it("accepts an empty transformations array and validationenabled=true (the real config shape)", () => {
    const config = makeConfig(false);
    config.routers["router-a"]!.processing.transformations = [];
    config.routers["router-a"]!.processing.validationenabled = true;
    assert.deepEqual(validateModularConfig(config), []);
  });
});
