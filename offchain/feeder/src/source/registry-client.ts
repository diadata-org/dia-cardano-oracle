// viem-backed client for the DIA `OracleIntentRegistry`.
//
// Exposes a small typed surface for the parts of the contract the
// feeder consumes:
//
//   - `getCurrentBlock()`       — HEAD height (used by the scanner).
//   - `getLogs({from, to})`     — `IntentRegistered` logs in a range.
//   - `getIntent(intentHash)`   — full `OracleIntent` tuple.
//
// Two flavors of the client are exported:
//
//   - `createHttpRegistryClient`  — uses the JSON-RPC HTTP transport.
//                                   Used by the polling scanner and by
//                                   the enricher's view-call.
//   - `createWsRegistryClient`    — uses the WebSocket transport with
//                                   the Conduit-style path credential.
//
// **Coordinates (chain id, RPC URLs, WS URL, registry address, event
// ABI) come from the loaded `ModularConfig` — NEVER from env.** The
// only env touch is the WS credential, which is a secret.

import {
  createPublicClient,
  http,
  webSocket,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { requireEvent } from "../config/abi-parser.js";
import type { ModularConfig, RouterConfig } from "../config/types.js";
import { readNetworkEnv, type CardanoNetwork } from "./env.js";
import type { OracleIntent } from "./types.js";

/** A minimal facade over viem's `PublicClient` that the rest of the
 *  source pipeline depends on. Keeping it narrow means the scanner and
 *  enricher are trivially mockable in tests. */
export type RegistryClient = {
  /** Resolved network coordinates, useful for logs / metrics. */
  readonly chainId: number;
  readonly registryAddress: Address;
  readonly transport: "http" | "ws";

  /** Current HEAD block height on the source chain. */
  getHeadBlockNumber(): Promise<bigint>;

  /** Raw viem `Log[]` for the configured event between `fromBlock`
   *  and `toBlock` (inclusive). Decoding is the extractor's job. */
  getIntentRegisteredLogs(args: { fromBlock: bigint; toBlock: bigint }): Promise<RegistryLog[]>;

  /** Fetch the full `OracleIntent` struct for an intent hash. */
  getIntent(intentHash: Hex): Promise<OracleIntent>;

  /** Release any persistent connection (currently the WS transport). */
  close(): Promise<void>;
};

/** Subset of viem's `Log` that the extractor consumes. Defined locally
 *  so call sites do not have to import viem types. */
export type RegistryLog = {
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
};

// ---------------------------------------------------------------------------
// Config → coordinates resolution.
// ---------------------------------------------------------------------------

/**
 * Everything the source side needs to operate, derived from the
 * loaded YAML config. This is the only place that knows how the
 * five YAML files compose into a single set of source coordinates.
 */
export type ResolvedSource = {
  chainId: number;
  rpcUrls: string[];
  wsUrl: string | undefined;
  registryAddress: Address;
  eventAbi: AbiEvent;
  enrichmentAbi: AbiFunction;
  registryContractId: string;
  registryAbi: Abi;
  /** Optional: list of routers that consume this source. Useful for
   *  diagnostic logging on startup. */
  routers: RouterConfig[];
};

/**
 * Walk the loaded config, pick the registry contract whose `chain_id`
 * matches `infrastructure.source.chain_id` (and whose `type` is
 * `registry`), and assemble the source coordinates. Throws with a
 * pointer to the missing field on any structural gap — the validator
 * would have caught these already, but we re-check at runtime for the
 * paths that bypass validation (e.g. programmatic config injection).
 */
export function resolveSourceFromConfig(
  config: ModularConfig,
  eventName: string = "IntentRegistered",
): ResolvedSource {
  const infra = config.infrastructure;
  if (!infra?.source) {
    throw new Error("infrastructure.source: missing — cannot resolve source coordinates.");
  }

  const { chain_id, rpc_urls, ws_url } = infra.source;
  if (typeof chain_id !== "number") {
    throw new Error("infrastructure.source.chain_id: required.");
  }
  if (!rpc_urls || rpc_urls.length === 0) {
    throw new Error("infrastructure.source.rpc_urls: required (non-empty list).");
  }

  const match = Object.entries(config.contracts).find(
    ([, contract]) =>
      contract.chain_id === chain_id && contract.type === "registry" && contract.enabled,
  );
  if (!match) {
    throw new Error(
      `contracts.yaml: no enabled \`type: registry\` contract for chain_id ${chain_id}.`,
    );
  }
  const [registryContractId, registryContract] = match;
  const registryAbi = config.parsedAbis.contracts[registryContractId];
  if (!registryAbi) {
    throw new Error(`contracts.${registryContractId}.abi: failed to resolve parsed ABI.`);
  }

  const eventDef = requireEvent(config.parsedAbis, eventName);
  if (!eventDef.enrichment) {
    throw new Error(
      `events.yaml::event_definitions.${eventName}.enrichment: required (the feeder fetches the full intent via getIntent).`,
    );
  }

  return {
    chainId: chain_id,
    rpcUrls: rpc_urls,
    wsUrl: ws_url,
    registryAddress: registryContract.address as Address,
    eventAbi: eventDef.event,
    enrichmentAbi: eventDef.enrichment,
    registryContractId,
    registryAbi,
    routers: Object.values(config.routers).filter((r) => r.enabled),
  };
}

// ---------------------------------------------------------------------------
// Client factories.
// ---------------------------------------------------------------------------

/**
 * Create a registry client that talks to the source chain over HTTP.
 *
 * Iterates `source.rpc_urls` in order: if a request fails, retries
 * against the next URL. Wraps all three `RegistryClient` methods with
 * this failover so any transient node outage is invisible to callers.
 */
export function createHttpRegistryClient(source: ResolvedSource): RegistryClient {
  const urls = source.rpcUrls;

  function makeAdapter(url: string) {
    return adaptViemClient({
      chainId: source.chainId,
      registryAddress: source.registryAddress,
      transport: "http",
      client: createPublicClient({ transport: http(url) }) as PublicClient,
      eventAbi: source.eventAbi,
      enrichmentAbi: source.enrichmentAbi,
    });
  }

  async function withFailover<T>(fn: (a: RegistryClient) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (const url of urls) {
      try {
        return await fn(makeAdapter(url));
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  return {
    chainId: source.chainId,
    registryAddress: source.registryAddress,
    transport: "http" as const,
    getHeadBlockNumber:       ()     => withFailover((a) => a.getHeadBlockNumber()),
    getIntentRegisteredLogs:  (args) => withFailover((a) => a.getIntentRegisteredLogs(args)),
    getIntent:                (hash) => withFailover((a) => a.getIntent(hash)),
    close: async () => {},
  };
}

/**
 * Create a registry client that talks to the source chain over
 * WebSocket. Authentication is Conduit-style: the key (from
 * `DIA_WS_CREDENTIAL_<network>`) is appended to the URL path. Throws
 * with an actionable message if the credential is missing.
 */
export function createWsRegistryClient(
  source: ResolvedSource,
  network: CardanoNetwork,
): RegistryClient {
  if (!source.wsUrl) {
    throw new Error(
      "infrastructure.source.ws_url: required for the WebSocket transport. Use --transport http if the YAML omits it.",
    );
  }
  const wsUrl = composeAuthenticatedWsUrl(source.wsUrl, network);
  const publicClient = createPublicClient({ transport: webSocket(wsUrl) });
  return adaptViemClient({
    chainId: source.chainId,
    registryAddress: source.registryAddress,
    transport: "ws",
    client: publicClient,
    eventAbi: source.eventAbi,
    enrichmentAbi: source.enrichmentAbi,
  });
}

/**
 * Compose `<wsUrl>/<credential>` using the Conduit path-style auth
 * convention. Trims trailing slashes from the base, URL-encodes the
 * credential while leaving slashes inside it untouched.
 *
 * The credential is the ONLY env-driven part of the source side; it
 * is a secret and therefore belongs in `.env`, not in the YAML.
 */
export function composeAuthenticatedWsUrl(baseWsUrl: string, network: CardanoNetwork): string {
  const credential = readNetworkEnv("DIA_WS_CREDENTIAL", network);
  if (!credential) {
    throw new Error(
      `DIA_WS_CREDENTIAL_${network === "Preview" ? "TESTNET" : "MAINNET"}: required for the WebSocket transport.`,
    );
  }
  const trimmedBase = baseWsUrl.replace(/\/+$/, "");
  const safeCredential = encodeURIComponent(credential).replace(/%2F/gi, "/");
  return `${trimmedBase}/${safeCredential}`;
}

// ---------------------------------------------------------------------------
// Adapter — wraps a viem PublicClient in our narrow surface.
// ---------------------------------------------------------------------------

type AdapterInputs = {
  chainId: number;
  registryAddress: Address;
  transport: "http" | "ws";
  client: PublicClient;
  eventAbi: AbiEvent;
  enrichmentAbi: AbiFunction;
};

function adaptViemClient(inputs: AdapterInputs): RegistryClient {
  const { chainId, registryAddress, transport, client, eventAbi, enrichmentAbi } = inputs;

  return {
    chainId,
    registryAddress,
    transport,

    async getHeadBlockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },

    async getIntentRegisteredLogs({ fromBlock, toBlock }): Promise<RegistryLog[]> {
      const logs = await client.getLogs({
        address: registryAddress,
        event: eventAbi,
        fromBlock,
        toBlock,
      });
      return logs.map((log) => ({
        topics: log.topics,
        data: log.data,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: log.transactionHash ?? ("0x" as Hex),
        logIndex: log.logIndex ?? 0,
      }));
    },

    async getIntent(intentHash) {
      const result = await client.readContract({
        address: registryAddress,
        abi: [enrichmentAbi],
        functionName: enrichmentAbi.name,
        args: [intentHash],
      });
      return normalizeOracleIntent(result);
    },

    async close(): Promise<void> {
      const transportInternals = (client.transport as unknown) as {
        socket?: { close: () => void };
      };
      transportInternals.socket?.close();
    },
  };
}

/** See `enricher.ts` for the canonical implementation. Kept here too
 *  because `RegistryClient.getIntent` shares the same shape. */
function normalizeOracleIntent(raw: unknown): OracleIntent {
  const o = raw as Record<string, unknown>;
  return {
    intentType: String(o.intentType),
    version: String(o.version),
    chainId: BigInt(o.chainId as bigint | number | string),
    nonce: BigInt(o.nonce as bigint | number | string),
    expiry: BigInt(o.expiry as bigint | number | string),
    symbol: String(o.symbol),
    price: BigInt(o.price as bigint | number | string),
    timestamp: BigInt(o.timestamp as bigint | number | string),
    source: String(o.source),
    signature: String(o.signature),
    signer: String(o.signer),
  };
}
