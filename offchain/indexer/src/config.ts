// Indexer runtime config from the environment.
//
// REUSES the feeder/CLI env conventions so a single `.env` drives both:
//   CARDANO_NETWORK            Mainnet | Preview
//   CARDANO_PROVIDER           Blockfrost | Koios
//   BLOCKFROST_API_URL_<SFX>   per-network (SFX = MAINNET | TESTNET)
//   BLOCKFROST_PROJECT_ID_<SFX>
//   KOIOS_API_URL_<SFX>
// Only the HTTP port and an optional registry-file override are indexer-specific:
//   INDEXER_PORT               default from constants
//   INDEXER_REGISTRY_FILE      path to a registry JSON (else shared run state)
//
// It reads the provider endpoint/key and the target network. Every default,
// allow-list, and suffix mapping comes from constants.ts.

import {
  DEFAULT_NETWORK,
  DEFAULT_PORT,
  DEFAULT_PROVIDER,
  MAX_TCP_PORT,
  MIN_TCP_PORT,
  NETWORK_ENV_SUFFIX,
  VALID_NETWORKS,
  VALID_PROVIDERS,
  type CardanoNetwork,
  type IndexerProvider,
} from "./constants.js";

export type { CardanoNetwork, IndexerProvider } from "./constants.js";

export interface IndexerConfig {
  network: CardanoNetwork;
  provider: IndexerProvider;
  /** Blockfrost endpoint + project id (present when provider = Blockfrost). */
  blockfrostUrl?: string;
  blockfrostProjectId?: string;
  /** Koios endpoint (present when provider = Koios). */
  koiosUrl?: string;
  /** TCP port the HTTP API listens on. */
  port: number;
  /** Explicit registry config file; when unset, the registry is resolved from shared run state. */
  registryFile?: string;
}

/**
 * Build {@link IndexerConfig} from environment variables. Fails loud (throws)
 * on a missing/invalid required value — no silent defaults for the provider
 * credentials, so a misconfigured deploy is caught at startup.
 */
export function readIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const network = (env.CARDANO_NETWORK?.trim() || DEFAULT_NETWORK) as CardanoNetwork;
  if (!VALID_NETWORKS.includes(network)) {
    throw new Error(`CARDANO_NETWORK must be one of ${VALID_NETWORKS.join(", ")}; got "${network}".`);
  }

  const provider = (env.CARDANO_PROVIDER?.trim() || DEFAULT_PROVIDER) as IndexerProvider;
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(`CARDANO_PROVIDER must be one of ${VALID_PROVIDERS.join(", ")}; got "${provider}".`);
  }

  const suffix = NETWORK_ENV_SUFFIX[network];

  const portRaw = env.INDEXER_PORT?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < MIN_TCP_PORT || port > MAX_TCP_PORT) {
    throw new Error(`INDEXER_PORT must be a valid TCP port; got "${portRaw}".`);
  }

  const registryFile = env.INDEXER_REGISTRY_FILE?.trim() || undefined;

  if (provider === "Blockfrost") {
    const blockfrostUrl = env[`BLOCKFROST_API_URL_${suffix}`]?.trim();
    const blockfrostProjectId = env[`BLOCKFROST_PROJECT_ID_${suffix}`]?.trim();
    if (!blockfrostUrl || !blockfrostProjectId) {
      throw new Error(
        `Blockfrost provider requires BLOCKFROST_API_URL_${suffix} and BLOCKFROST_PROJECT_ID_${suffix}.`,
      );
    }
    return { network, provider, blockfrostUrl, blockfrostProjectId, port, registryFile };
  }

  const koiosUrl = env[`KOIOS_API_URL_${suffix}`]?.trim();
  if (!koiosUrl) {
    throw new Error(`Koios provider requires KOIOS_API_URL_${suffix}.`);
  }
  return { network, provider, koiosUrl, port, registryFile };
}
