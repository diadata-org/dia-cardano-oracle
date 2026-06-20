// Concrete Blockfrost / Koios chain readers — the standalone providers the
// indexer runs with, needing ONLY a provider URL (+ key for Blockfrost). Kept
// apart from chain-reader.ts so the pure port and the index service can be
// imported (and unit-tested) without loading the provider/wasm stack.
//
// UTxO lookup reuses the Lucid provider's `getUtxos` (which returns inline
// datums); the chain tip is a direct REST call (the Provider interface has no
// tip), parsed by the pure helpers in chain-reader.ts.

import { Blockfrost, Koios } from "@lucid-evolution/provider";

import {
  createProviderChainReader,
  parseBlockfrostTip,
  parseKoiosTip,
  type ChainReader,
  type ChainTip,
  type UtxoProvider,
} from "./chain-reader.js";

const TIP_TIMEOUT_MS = 15_000;

export type BlockfrostReaderOptions = {
  url: string;
  projectId: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

/** A Blockfrost-backed {@link ChainReader} — needs only the API URL + project id. */
export function createBlockfrostChainReader(options: BlockfrostReaderOptions): ChainReader {
  const provider = new Blockfrost(options.url, options.projectId) as unknown as UtxoProvider;
  const fetchImpl = options.fetchImpl ?? fetch;

  const fetchTip = async (): Promise<ChainTip> => {
    const response = await fetchImpl(`${options.url}/blocks/latest`, {
      headers: { project_id: options.projectId },
      signal: AbortSignal.timeout(TIP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Blockfrost /blocks/latest failed (${response.status} ${response.statusText}).`);
    }
    return parseBlockfrostTip(await response.json());
  };

  return createProviderChainReader(provider, fetchTip);
}

export type KoiosReaderOptions = {
  url: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

/** A Koios-backed {@link ChainReader} — needs only the API URL. */
export function createKoiosChainReader(options: KoiosReaderOptions): ChainReader {
  const provider = new Koios(options.url) as unknown as UtxoProvider;
  const fetchImpl = options.fetchImpl ?? fetch;

  const fetchTip = async (): Promise<ChainTip> => {
    const response = await fetchImpl(`${options.url}/tip`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Koios /tip failed (${response.status} ${response.statusText}).`);
    }
    return parseKoiosTip(await response.json());
  };

  return createProviderChainReader(provider, fetchTip);
}
