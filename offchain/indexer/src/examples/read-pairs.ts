// Read the live on-chain pairs — a standalone script (run via `npm run
// pairs:read`), kept out of the test suite.
//
// It exercises the indexer's read path against the REAL configured network
// (CARDANO_NETWORK + the provider env): it queries the chain tip and decodes
// every published pair, printing each. Read-only — it only queries and decodes,
// it never writes a transaction.
//
//   CARDANO_NETWORK=Mainnet BLOCKFROST_API_URL_MAINNET=… BLOCKFROST_PROJECT_ID_MAINNET=… \
//     npm run pairs:read          # or: npx tsx src/examples/read-pairs.ts

import assert from "node:assert/strict";

import { readIndexerConfig } from "../config.js";
import { loadRegistry } from "../registry-config.js";
import {
  createBlockfrostChainReader,
  createKoiosChainReader,
} from "../chain-reader-providers.js";
import { createIndexService } from "../index-service.js";
import type { ChainReader } from "../chain-reader.js";

async function main(): Promise<void> {
  const config = readIndexerConfig();

  const reader: ChainReader =
    config.provider === "Koios"
      ? createKoiosChainReader({ url: config.koiosUrl! })
      : createBlockfrostChainReader({
          url: config.blockfrostUrl!,
          projectId: config.blockfrostProjectId!,
        });

  const registry = await loadRegistry(config.network, { registryFile: config.registryFile });
  const service = createIndexService({ reader, registry });

  console.log(
    `pairs:read: ${config.network} via ${config.provider} (${registry.clients.length} client(s))`,
  );

  const health = await service.health();
  assert.ok(health.tip.height > 0, "expected a positive chain tip height");
  assert.match(health.tip.hash, /^[0-9a-f]{64}$/, "expected a 32-byte block hash");
  console.log(`  tip: height=${health.tip.height} slot=${health.tip.slot}`);

  const pairs = await service.listPairs();
  for (const pair of pairs) {
    assert.match(pair.price, /^[0-9]+$/, `price for ${pair.symbol} is an integer string`);
    assert.match(pair.utxoRef.txHash, /^[0-9a-f]{64}$/);
    assert.ok(pair.ageSeconds >= 0);
    console.log(
      `  ${pair.symbol}: price=${pair.price} age=${pair.ageSeconds}s ` +
        `@ ${pair.utxoRef.txHash}#${pair.utxoRef.outputIndex}`,
    );
  }
  assert.equal(health.pairCount, pairs.length);

  console.log(`pairs:read OK — decoded ${pairs.length} live pair(s) on ${config.network}.`);
}

main().catch((error) => {
  console.error(`pairs:read FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
