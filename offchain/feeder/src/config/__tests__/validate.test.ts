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
      database: { driver: "sqlite", path: "state/preview/feeder.sqlite" },
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
