// Indexer entry point.
//
// Reads env config, builds the standalone chain reader for the configured
// provider, loads the registry from the shared state, and serves the consumer
// HTTP API. The provider key is its only credential.
//
//   INDEXER_NETWORK=Mainnet INDEXER_BLOCKFROST_URL=... \
//   INDEXER_BLOCKFROST_PROJECT_ID=... npm run indexer:dev

import { readIndexerConfig } from "./config.js";
import { loadRegistry } from "./registry-config.js";
import {
  createBlockfrostChainReader,
  createKoiosChainReader,
} from "./chain-reader-providers.js";
import { createIndexService } from "./index-service.js";
import { createIndexerServer } from "./http.js";
import { createIndexerMetrics } from "./api/metrics.js";
import type { ChainReader } from "./chain-reader.js";

const config = readIndexerConfig();

// Prometheus metrics: every provider request the reader makes is reported here
// and exposed at /metrics under the same `dia_bridge_provider_requests_total`
// series the feeder uses, so a `sum by (provider)` query covers both services.
// The default labels mirror the feeder's so a `$network`-filtered dashboard query
// includes the indexer's series too.
const metrics = await createIndexerMetrics({
  defaultLabels: { destination_chain: "cardano", network: config.network },
});

const reader: ChainReader =
  config.provider === "Koios"
    ? createKoiosChainReader({
        url: config.koiosUrl!,
        onProviderCall: metrics.recordProviderCall,
      })
    : createBlockfrostChainReader({
        url: config.blockfrostUrl!,
        projectId: config.blockfrostProjectId!,
        onProviderCall: metrics.recordProviderCall,
      });

const registry = await loadRegistry(config.network, { registryFile: config.registryFile });
const service = createIndexService({ reader, registry });
const server = createIndexerServer({ service, metricsText: metrics.getMetricsText });

server.listen(config.port, () => {
  console.error(
    `indexer: listening on :${config.port} ` +
      `(network=${config.network}, provider=${config.provider}, clients=${registry.clients.length})`,
  );
});
