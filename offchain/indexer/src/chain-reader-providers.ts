// Concrete Blockfrost / Koios chain readers — the standalone providers the
// indexer runs with, needing ONLY a provider URL (+ key for Blockfrost). Kept
// apart from chain-reader.ts so the pure port and the index service can be
// imported (and unit-tested) without loading the provider/wasm stack.
//
// UTxO lookup reuses the Lucid provider's `getUtxos` (which returns inline
// datums); the chain tip is a direct REST call (the Provider interface has no
// tip), parsed by the pure helpers in chain-reader.ts.
//
// Both providers are wrapped with the CLI's `createRetryingProvider` — the same
// wrapper the feeder/CLI use — so the indexer gets transient-error retry AND its
// `getUtxos` calls are reported through the shared provider-call observer. The
// tip REST call is reported via `countedTip`. Both feed the indexer's
// `provider_requests_total` counter (see api/metrics.ts).

import { Blockfrost, Koios } from "@lucid-evolution/provider";

import {
  DEFAULT_PROVIDER_RETRY_ATTEMPTS,
  DEFAULT_PROVIDER_RETRY_DELAY_MS,
  envNumber,
} from "@diadata-org/dia-cardano-oracle-cli/core/constants";
import { createRetryingProvider } from "@diadata-org/dia-cardano-oracle-cli/core/provider-retry";

import {
  countedTip,
  createProviderChainReader,
  parseBlockfrostTip,
  parseKoiosTip,
  type ChainReader,
  type ChainTip,
  type ProviderCallObserver,
  type UtxoProvider,
} from "./chain-reader.js";
import { TIP_TIMEOUT_MS } from "./constants.js";

/** Wrap a raw Lucid provider with the shared retrying provider so every
 *  `getUtxos` call retries transient errors and is reported to `onCall` —
 *  identical to how the feeder wraps its production providers. */
function withRetry(
  provider: unknown,
  providerName: string,
  onCall: ProviderCallObserver | undefined,
): UtxoProvider {
  return createRetryingProvider(provider as Parameters<typeof createRetryingProvider>[0], {
    attempts: envNumber("PROVIDER_RETRY_ATTEMPTS", DEFAULT_PROVIDER_RETRY_ATTEMPTS),
    delayMs: envNumber("PROVIDER_RETRY_DELAY_MS", DEFAULT_PROVIDER_RETRY_DELAY_MS),
    providerName,
    onCall,
  }) as unknown as UtxoProvider;
}

export type BlockfrostReaderOptions = {
  url: string;
  projectId: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Provider-call observer, fed the metrics counter in production. */
  onProviderCall?: ProviderCallObserver;
};

/** A Blockfrost-backed {@link ChainReader} — needs only the API URL + project id. */
export function createBlockfrostChainReader(options: BlockfrostReaderOptions): ChainReader {
  const provider = withRetry(
    new Blockfrost(options.url, options.projectId),
    "Blockfrost",
    options.onProviderCall,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const fetchTip = countedTip("Blockfrost", async (): Promise<ChainTip> => {
    const response = await fetchImpl(`${options.url}/blocks/latest`, {
      headers: { project_id: options.projectId },
      signal: AbortSignal.timeout(TIP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Blockfrost /blocks/latest failed (${response.status} ${response.statusText}).`);
    }
    return parseBlockfrostTip(await response.json());
  }, options.onProviderCall);

  return createProviderChainReader(provider, fetchTip);
}

export type KoiosReaderOptions = {
  url: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Provider-call observer, fed the metrics counter in production. */
  onProviderCall?: ProviderCallObserver;
};

/** A Koios-backed {@link ChainReader} — needs only the API URL. */
export function createKoiosChainReader(options: KoiosReaderOptions): ChainReader {
  const provider = withRetry(
    new Koios(options.url),
    "Koios",
    options.onProviderCall,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const fetchTip = countedTip("Koios", async (): Promise<ChainTip> => {
    const response = await fetchImpl(`${options.url}/tip`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Koios /tip failed (${response.status} ${response.statusText}).`);
    }
    return parseKoiosTip(await response.json());
  }, options.onProviderCall);

  return createProviderChainReader(provider, fetchTip);
}
