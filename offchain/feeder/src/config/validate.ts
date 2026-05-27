// Semantic + cross-reference validator for the modular config.
//
// Loosely tracks `services/bridge/config/modular_types.go::Validate()`
// but tightened where the Cardano feeder has stricter requirements
// (Cardano destination shape, refusal of EVM destinations, env-var
// reference shape).
//
// Each section validator is its own private function that receives a
// scoped `IssueCollector`, so paths in messages always reflect the
// caller's perspective (`routers.client_a.destinations[0].cardano.network`)
// without the helper having to repeat the prefix.

import type {
  ContractConfig,
  ChainConfig,
  EventDefinition,
  InfrastructureConfig,
  ModularConfig,
  RouterConfig,
  RouterDestination,
  TriggerCondition,
  TriggerConditionOperator,
} from "./types.js";
import { IssueCollector, type ValidationIssue } from "./issues.js";

export { type ValidationIssue } from "./issues.js";

const VALID_OPERATORS: readonly TriggerConditionOperator[] = [
  "in",
  "not_in",
  "eq",
  "neq",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
];

const VALID_DATABASE_DRIVERS = ["sqlite", "postgres"] as const;
const VALID_CARDANO_NETWORKS = ["Preview", "Mainnet"] as const;

/**
 * Validate the whole `ModularConfig`. Returns every issue found across
 * every section; the caller decides whether to exit on a non-empty
 * error list. Validators are tolerant — missing optional blocks never
 * raise; missing required cross-references always do.
 *
 * ABI parse errors are NOT surfaced here — the loader throws them at
 * load time with the YAML path baked in. The `--validate-only` command
 * catches that throw and presents it as an error-severity issue, so
 * the operator-facing experience is uniform.
 */
export function validateModularConfig(config: ModularConfig): ValidationIssue[] {
  const collector = new IssueCollector();

  validateInfrastructure(config.infrastructure, collector.scope("infrastructure"));
  validateChainsMap(config.chains, collector.scope("chains"));
  validateContractsMap(config.contracts, collector.scope("contracts"), config);
  validateEventDefinitionsMap(
    config.event_definitions,
    collector.scope("event_definitions"),
    config,
  );
  validateRoutersMap(config.routers, collector.scope("routers"), config);
  validateSourceContractBinding(config, collector);

  return collector.all();
}

// ---------------------------------------------------------------------------
// infrastructure.<network>.yaml
// ---------------------------------------------------------------------------

/** The whole infrastructure block plus its database + source subtrees. */
function validateInfrastructure(
  infra: InfrastructureConfig | undefined,
  c: IssueCollector,
): void {
  if (!c.required("", infra, "Missing infrastructure config (expected `infrastructure.<network>.yaml`).")) {
    return;
  }
  validateDatabase(infra.database, c.scope("database"));
  validateSource(infra.source, c.scope("source"));
  validateBlockScanner(infra.block_scanner, c.scope("block_scanner"));
  validateApiConfig(infra.api, c.scope("api"));
  validateCardanoRuntime(infra.cardano, c.scope("cardano"));
  validateWorkerPool(infra.worker_pool, c.scope("worker_pool"));
  validateAlerting(infra.alerting, c.scope("alerting"));
}

function validateDatabase(db: InfrastructureConfig["database"], c: IssueCollector): void {
  if (!c.required("driver", db?.driver)) return;
  if (!c.oneOf("driver", db.driver, VALID_DATABASE_DRIVERS)) return;

  switch (db.driver) {
    case "postgres":
      if (!db.dsn && !db.dsn_env) {
        c.error("", "Postgres driver requires `dsn` or `dsn_env`.");
      }
      return;
    case "sqlite":
      if (!db.path && !db.path_env) {
        c.warn(
          "",
          "SQLite driver without `path` or `path_env` will default to `state/<network>/feeder.sqlite`.",
        );
      }
      return;
  }
}

function validateSource(source: InfrastructureConfig["source"], c: IssueCollector): void {
  if (!c.required("", source, "Required.")) return;
  c.required("chain_id", source.chain_id);
  c.required("name", source.name);
  c.required("rpc_urls", source.rpc_urls);
}

function validateBlockScanner(
  scanner: InfrastructureConfig["block_scanner"],
  c: IssueCollector,
): void {
  if (!scanner) return;
  validatePositiveInteger("block_range", scanner.block_range, c);
  validatePositiveInteger("confirmations", scanner.confirmations, c);
}

function validateApiConfig(
  api: InfrastructureConfig["api"],
  c: IssueCollector,
): void {
  if (!api) return;
  validatePositiveInteger("port", api.port, c);
}

function validateCardanoRuntime(
  cardano: InfrastructureConfig["cardano"],
  c: IssueCollector,
): void {
  if (!cardano) return;
  validatePositiveInteger("confirmation_depth", cardano.confirmation_depth, c);
}

function validateWorkerPool(
  worker: InfrastructureConfig["worker_pool"],
  c: IssueCollector,
): void {
  if (!worker) {
    c.error(
      "",
      "Missing worker_pool block. Required keys: inflight_timeout_ms, retry_delay, max_retries.",
    );
    return;
  }
  if (worker.inflight_timeout_ms === undefined) {
    c.error(
      "inflight_timeout_ms",
      "Required. How long (ms) an in-flight tx lock is held before being released. Set in infrastructure.<network>.yaml.",
    );
  } else {
    validatePositiveInteger("inflight_timeout_ms", worker.inflight_timeout_ms, c);
  }
  if (worker.max_retries === undefined) {
    c.error(
      "max_retries",
      "Required. Max retries per failed submission before the intent is dropped.",
    );
  } else if (!Number.isInteger(worker.max_retries) || worker.max_retries < 0) {
    c.error("max_retries", "Expected a non-negative integer.");
  }
  if (worker.retry_delay === undefined) {
    c.error(
      "retry_delay",
      "Required. Wait between retries (duration string, e.g. \"5s\").",
    );
  }
}

function validateAlerting(
  alerting: InfrastructureConfig["alerting"],
  c: IssueCollector,
): void {
  if (!alerting) {
    c.error(
      "",
      "Missing alerting block. Required keys (lovelace unless suffix says otherwise): " +
        "receiver_balance_low_lovelace, settle_overdue_lovelace, " +
        "payment_hook_withdraw_ready_lovelace, admin_wallet_low_lovelace, " +
        "oracle_pair_stale_seconds, price_deviation_high_percent, price_age_high_seconds.",
    );
    return;
  }
  validatePositiveInteger("receiver_balance_low_lovelace", alerting.receiver_balance_low_lovelace, c);
  validatePositiveInteger("settle_overdue_lovelace", alerting.settle_overdue_lovelace, c);
  validatePositiveInteger("payment_hook_withdraw_ready_lovelace", alerting.payment_hook_withdraw_ready_lovelace, c);
  validatePositiveInteger("admin_wallet_low_lovelace", alerting.admin_wallet_low_lovelace, c);
  validatePositiveInteger("oracle_pair_stale_seconds", alerting.oracle_pair_stale_seconds, c);
  validatePositiveNumber("price_deviation_high_percent", alerting.price_deviation_high_percent, c);
  validatePositiveInteger("price_age_high_seconds", alerting.price_age_high_seconds, c);

  const required: Array<[string, unknown]> = [
    ["receiver_balance_low_lovelace", alerting.receiver_balance_low_lovelace],
    ["settle_overdue_lovelace", alerting.settle_overdue_lovelace],
    ["payment_hook_withdraw_ready_lovelace", alerting.payment_hook_withdraw_ready_lovelace],
    ["admin_wallet_low_lovelace", alerting.admin_wallet_low_lovelace],
    ["oracle_pair_stale_seconds", alerting.oracle_pair_stale_seconds],
    ["price_deviation_high_percent", alerting.price_deviation_high_percent],
    ["price_age_high_seconds", alerting.price_age_high_seconds],
  ];
  for (const [field, value] of required) {
    if (value === undefined) {
      c.error(field, "Required — every alerting threshold must be set explicitly (no silent defaults).");
    }
  }
}

function validatePositiveNumber(
  field: string,
  value: number | undefined,
  c: IssueCollector,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) {
    c.error(field, "Expected a positive finite number.");
  }
}

function validatePositiveInteger(
  field: string,
  value: number | undefined,
  c: IssueCollector,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    c.error(field, "Expected a positive integer.");
  }
}

// ---------------------------------------------------------------------------
// chains.yaml
// ---------------------------------------------------------------------------

function validateChainsMap(chains: Record<string, ChainConfig>, c: IssueCollector): void {
  for (const [key, chain] of Object.entries(chains)) {
    const scope = c.scope(key);
    scope.required("chain_id", chain.chain_id);
    scope.required("name", chain.name);
    scope.required("rpc_urls", chain.rpc_urls);
  }
}

// ---------------------------------------------------------------------------
// contracts.yaml
// ---------------------------------------------------------------------------

function validateContractsMap(
  contracts: Record<string, ContractConfig>,
  c: IssueCollector,
  config: ModularConfig,
): void {
  const knownChainIds = new Set(Object.values(config.chains).map((chain) => chain.chain_id));

  for (const [key, contract] of Object.entries(contracts)) {
    const scope = c.scope(key);
    scope.required("chain_id", contract.chain_id);
    scope.required("address", contract.address);
    scope.required("type", contract.type);

    if (contract.chain_id && !knownChainIds.has(contract.chain_id)) {
      scope.error(
        "chain_id",
        `Contract references chain_id ${contract.chain_id} but no entry in chains.yaml has it.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// events.yaml
// ---------------------------------------------------------------------------

function validateEventDefinitionsMap(
  events: Record<string, EventDefinition>,
  c: IssueCollector,
  config: ModularConfig,
): void {
  const contractIds = new Set(Object.keys(config.contracts));

  for (const [name, def] of Object.entries(events)) {
    const scope = c.scope(name);
    scope.required("abi", def.abi);
    scope.required("data_extraction", def.data_extraction);

    if (def.contract && !isKnownContractIdOrPrefix(def.contract, contractIds)) {
      scope.warn(
        "contract",
        `References "${def.contract}" but no entry in contracts.yaml matches that id (or a per-network suffixed variant of it). The runtime resolves the contract by chain_id, so this is informational.`,
      );
    }

    if (def.enrichment) {
      const enrichScope = scope.scope("enrichment");
      enrichScope.required("method", def.enrichment.method);
      if (!def.enrichment.abi && !def.enrichment.contract) {
        enrichScope.warn(
          "",
          "Neither `abi` nor `contract` is set. The enricher will fall back to the event's emitting contract.",
        );
      }
    }

    // Consumer contract: the feeder's extractor (src/source/extractor.ts)
    // depends on a specific set of input names and types from the
    // IntentRegistered event. The YAML is allowed to evolve the ABI,
    // but the names and types still have to match what the rest of
    // the pipeline reads. If they drift the operator gets a loud
    // error here instead of a silent `undefined` at decode time.
    if (name === "IntentRegistered") {
      const parsed = config.parsedAbis.events[name];
      if (parsed) {
        validateIntentRegisteredShape(parsed.event, scope);
        if (parsed.enrichment) {
          validateGetIntentShape(parsed.enrichment, scope.scope("enrichment"));
        }
      }
    }
  }
}

/** Strict consumer contract for the `IntentRegistered` event. The
 *  feeder's extractor reads these inputs by name; any drift will
 *  produce `undefined` at decode time. We catch the drift at
 *  config-load time. */
const EXPECTED_INTENT_REGISTERED_INPUTS: ReadonlyArray<{
  name: string;
  type: string;
  indexed: boolean;
}> = [
  { name: "intentHash", type: "bytes32", indexed: true },
  { name: "symbol", type: "string", indexed: true },
  { name: "price", type: "uint256", indexed: true },
  { name: "timestamp", type: "uint256", indexed: false },
  { name: "signer", type: "address", indexed: false },
];

function validateIntentRegisteredShape(
  event: import("viem").AbiEvent,
  c: IssueCollector,
): void {
  const inputs = event.inputs as ReadonlyArray<{
    name?: string;
    type?: string;
    indexed?: boolean;
  }>;

  if (inputs.length !== EXPECTED_INTENT_REGISTERED_INPUTS.length) {
    c.error(
      "abi",
      `Expected ${EXPECTED_INTENT_REGISTERED_INPUTS.length} inputs on IntentRegistered, got ${inputs.length}. The feeder's extractor reads inputs by name and will produce undefined fields if the shape drifts. Update offchain/feeder/src/source/extractor.ts if the upstream contract genuinely changed.`,
    );
    return;
  }

  for (const [index, expected] of EXPECTED_INTENT_REGISTERED_INPUTS.entries()) {
    const actual = inputs[index];
    if (actual.name !== expected.name) {
      c.error(
        "abi",
        `Input #${index} should be named "${expected.name}" but is "${actual.name ?? "(unnamed)"}". The extractor reads \`args.${expected.name}\` and will see \`undefined\` until this is fixed.`,
      );
    }
    if (actual.type !== expected.type) {
      c.error(
        "abi",
        `Input "${expected.name}" should be of type ${expected.type}, got ${actual.type}.`,
      );
    }
    if ((actual.indexed ?? false) !== expected.indexed) {
      c.error(
        "abi",
        `Input "${expected.name}" should be ${expected.indexed ? "indexed" : "non-indexed"}.`,
      );
    }
  }
}

/** Consumer contract for the `getIntent` enrichment function. The
 *  enricher reads the returned tuple by field name. */
function validateGetIntentShape(fn: import("viem").AbiFunction, c: IssueCollector): void {
  if (fn.name !== "getIntent") {
    c.warn(
      "abi",
      `Enrichment function name is "${fn.name}"; the feeder expects "getIntent". This is informational — the function is invoked by its declared name.`,
    );
  }
  const outputs = fn.outputs as ReadonlyArray<{
    type?: string;
    components?: ReadonlyArray<{ name?: string }>;
  }>;
  const tuple = outputs[0];
  if (!tuple || tuple.type !== "tuple" || !tuple.components) {
    c.error(
      "abi",
      `getIntent must return a single tuple — the feeder reads the full OracleIntent struct from there.`,
    );
    return;
  }

  const expectedComponentNames = [
    "intentType",
    "version",
    "chainId",
    "nonce",
    "expiry",
    "symbol",
    "price",
    "timestamp",
    "source",
    "signature",
    "signer",
  ];
  const actualNames = tuple.components.map((c) => c.name);
  for (const expected of expectedComponentNames) {
    if (!actualNames.includes(expected)) {
      c.error(
        "abi",
        `getIntent return tuple is missing component "${expected}". The enricher reads it by name from the decoded OracleIntent.`,
      );
    }
  }
}

/**
 * Event definitions reference contracts by a "base" id (e.g.
 * `intent-registry`); contracts.yaml entries are typically suffixed
 * per network (`intent-registry-testnet`, `intent-registry-mainnet`).
 * Treat a match as "the base id equals a known id" OR "a known id
 * starts with the base id followed by `-` or `_`".
 */
function isKnownContractIdOrPrefix(base: string, knownIds: Set<string>): boolean {
  if (knownIds.has(base)) return true;
  for (const id of knownIds) {
    if (id.startsWith(`${base}-`) || id.startsWith(`${base}_`)) return true;
  }
  return false;
}

/**
 * The active source chain must have at least one matching `registry`
 * contract in `contracts.yaml`. That entry is what the registry-client
 * uses at runtime to resolve the address to call.
 */
function validateSourceContractBinding(config: ModularConfig, c: IssueCollector): void {
  const sourceChainId = config.infrastructure?.source?.chain_id;
  if (!sourceChainId) return; // already reported by validateInfrastructure

  const matching = Object.entries(config.contracts).filter(
    ([, contract]) =>
      contract.chain_id === sourceChainId && contract.type === "registry" && contract.enabled,
  );

  if (matching.length === 0) {
    c.error(
      "contracts",
      `No enabled \`type: registry\` contract in contracts.yaml has chain_id ${sourceChainId} (the active source). The registry-client cannot resolve a target address.`,
    );
  } else if (matching.length > 1) {
    const ids = matching.map(([id]) => id).join(", ");
    c.warn(
      "contracts",
      `Multiple registry contracts match source chain_id ${sourceChainId} (${ids}). The runtime will pick the first match deterministically.`,
    );
  }
}

// ---------------------------------------------------------------------------
// routers/*.yaml
// ---------------------------------------------------------------------------

function validateRoutersMap(
  routers: Record<string, RouterConfig>,
  c: IssueCollector,
  config: ModularConfig,
): void {
  for (const [key, router] of Object.entries(routers)) {
    validateRouter(key, router, c.scope(key), config);
  }
}

function validateRouter(
  key: string,
  router: RouterConfig,
  c: IssueCollector,
  config: ModularConfig,
): void {
  if (router.id !== key) {
    c.error("id", `Router id "${router.id}" must match its key "${key}".`);
  }
  if (!router.enabled) {
    c.warn("enabled", "Router is disabled; it will be loaded but not dispatched against.");
  }

  validateTriggers(router.triggers, c.scope("triggers"), config);
  validatePrivateKey(router, c);
  validateDestinations(router.destinations, c.scope("destinations"), config);
}

function validateTriggers(
  triggers: RouterConfig["triggers"],
  c: IssueCollector,
  config: ModularConfig,
): void {
  if (!c.required("events", triggers?.events)) return;

  const knownEvents = new Set(Object.keys(config.event_definitions));
  for (const eventName of triggers.events) {
    if (!knownEvents.has(eventName)) {
      c.error(
        "events",
        `References event "${eventName}" but no entry in events.yaml defines it.`,
      );
    }
  }

  if (triggers.conditions) {
    for (const [index, condition] of triggers.conditions.entries()) {
      validateCondition(condition, c.scope(`conditions[${index}]`));
    }
  }
}

function validateCondition(condition: TriggerCondition, c: IssueCollector): void {
  c.required("field", condition.field);
  if (!c.required("operator", condition.operator)) return;
  c.oneOf("operator", condition.operator, VALID_OPERATORS);
}

function validatePrivateKey(router: RouterConfig, c: IssueCollector): void {
  if (!router.private_key && !router.private_key_env) {
    c.error(
      "private_key_env",
      "Router has neither `private_key` nor `private_key_env`. One is required for the updater wallet signing.",
    );
    return;
  }
  if (router.private_key_env && !/^[A-Z][A-Z0-9_]*$/.test(router.private_key_env)) {
    c.warn(
      "private_key_env",
      `"${router.private_key_env}" does not look like a conventional env var name.`,
    );
  }
}

function validateDestinations(
  destinations: RouterDestination[] | undefined,
  c: IssueCollector,
  config: ModularConfig,
): void {
  if (!c.required("", destinations)) return;
  for (const [index, dest] of destinations.entries()) {
    validateDestination(dest, c.scope(`[${index}]`), config);
  }
}

/**
 * A destination must carry exactly one of `method` (EVM, Spectra-native)
 * or `cardano` (this feeder's extension). EVM destinations are rejected
 * with a clear pointer to the Spectra Bridge — silently no-oping them
 * would mask misconfiguration.
 */
function validateDestination(
  dest: RouterDestination,
  c: IssueCollector,
  config: ModularConfig,
): void {
  const variant = classifyDestinationVariant(dest);
  switch (variant) {
    case "both":
      c.error(
        "",
        "Destination has both `method` (EVM) and `cardano` blocks. Exactly one is allowed per destination.",
      );
      return;
    case "neither":
      c.error("", "Destination must have either a `method` (EVM) or a `cardano` block.");
      return;
    case "evm":
      c.error(
        "method",
        "EVM `method` destinations are not supported by this feeder. Replace with a `cardano:` block. (Run the Spectra Bridge for EVM destinations.)",
      );
      return;
    case "cardano":
      validateCardanoDestination(dest.cardano!, c.scope("cardano"));
      validateOptionalContractRef(dest.contract_ref, c, config);
      return;
  }
}

type DestinationVariant = "cardano" | "evm" | "both" | "neither";

function classifyDestinationVariant(dest: RouterDestination): DestinationVariant {
  const hasMethod = !!dest.method;
  const hasCardano = !!dest.cardano;
  if (hasMethod && hasCardano) return "both";
  if (!hasMethod && !hasCardano) return "neither";
  return hasCardano ? "cardano" : "evm";
}

function validateCardanoDestination(
  cardano: NonNullable<RouterDestination["cardano"]>,
  c: IssueCollector,
): void {
  c.oneOf("network", cardano.network, VALID_CARDANO_NETWORKS);
  c.required("client_state_path", cardano.client_state_path);
  c.required("protocol_state_path", cardano.protocol_state_path);
  if ("tx_mode" in (cardano as Record<string, unknown>)) {
    c.error(
      "tx_mode",
      "Remove `tx_mode`. The feeder selects single-intent or batch submission automatically from the flush size.",
    );
  }
}

function validateOptionalContractRef(
  contractRef: string | undefined,
  c: IssueCollector,
  config: ModularConfig,
): void {
  if (!contractRef) return;
  if (!config.contracts[contractRef]) {
    c.error(
      "contract_ref",
      `Unknown contract reference "${contractRef}". Expected a key from contracts.yaml.`,
    );
  }
}
