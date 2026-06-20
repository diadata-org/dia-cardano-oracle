// Chain-reader port — the indexer's only window onto Cardano.
//
// `utxosAt(address)` + `tip()` is everything the index service needs: it reads
// the live Pair / Receiver / PaymentHook UTxOs and the chain tip, needing ONLY
// a provider key — no feeder daemon, no wallet, no transaction building. The
// port is an interface so the index service is unit-tested against a FAKE reader
// (no live chain), mirroring how the feeder's feed-sanity check injects
// `utxosAt`. The concrete Blockfrost/Koios wiring lives in
// `chain-reader-providers.ts` so importing this module pulls no provider/wasm.

/** Minimal UTxO shape the indexer needs — decoupled from any provider's type so
 *  the port stays light and fake-testable. */
export interface IndexerUtxo {
  address: string;
  txHash: string;
  outputIndex: number;
  assets: Record<string, bigint>;
  /** Inline datum CBOR hex, or null when the UTxO carries none. */
  datum: string | null;
}

export interface ChainTip {
  slot: number;
  height: number;
  hash: string;
}

export interface ChainReader {
  /** Live UTxOs at a script/address, each with its inline datum (if any). */
  utxosAt(address: string): Promise<IndexerUtxo[]>;
  /** Current chain tip — backs `/v1/health` and freshness checks. */
  tip(): Promise<ChainTip>;
}

/** The slice of a Lucid provider the reader uses (just UTxO lookup). Structural
 *  so a fake satisfies it without importing the provider package. */
export interface UtxoProvider {
  getUtxos(address: string): Promise<
    Array<{
      address: string;
      txHash: string;
      outputIndex: number;
      assets: Record<string, bigint>;
      datum?: string | null;
    }>
  >;
}

export type TipFetcher = () => Promise<ChainTip>;

/**
 * Build a {@link ChainReader} from any {@link UtxoProvider} (the Lucid
 * Blockfrost/Koios classes satisfy it) plus a tip fetcher. Pure wiring — fully
 * exercised with fakes; the concrete provider factories live alongside.
 */
export function createProviderChainReader(
  provider: UtxoProvider,
  fetchTip: TipFetcher,
): ChainReader {
  return {
    async utxosAt(address: string): Promise<IndexerUtxo[]> {
      const utxos = await provider.getUtxos(address);
      return utxos.map((u) => ({
        address: u.address,
        txHash: u.txHash,
        outputIndex: u.outputIndex,
        assets: u.assets,
        datum: u.datum ?? null,
      }));
    },
    tip: fetchTip,
  };
}

// ---------------------------------------------------------------------------
// Tip response parsers (pure — testable without a network call)
// ---------------------------------------------------------------------------

/** Parse a Blockfrost `/blocks/latest` body into a {@link ChainTip}. */
export function parseBlockfrostTip(body: unknown): ChainTip {
  const b = body as { slot?: number; height?: number; hash?: string };
  if (typeof b?.slot !== "number" || typeof b?.height !== "number" || typeof b?.hash !== "string") {
    throw new Error("Blockfrost /blocks/latest: unexpected response shape.");
  }
  return { slot: b.slot, height: b.height, hash: b.hash };
}

/** Parse a Koios `/tip` body (an array with one row) into a {@link ChainTip}. */
export function parseKoiosTip(body: unknown): ChainTip {
  const row = Array.isArray(body) ? (body[0] as { abs_slot?: number; block_no?: number; hash?: string }) : undefined;
  if (!row || typeof row.abs_slot !== "number" || typeof row.block_no !== "number" || typeof row.hash !== "string") {
    throw new Error("Koios /tip: unexpected response shape.");
  }
  return { slot: row.abs_slot, height: row.block_no, hash: row.hash };
}
