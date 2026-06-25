// Chain-reader port — the indexer's only window onto Cardano.
//
// `utxosAt(address)` + `tip()` is everything the index service needs: it reads
// the live Pair / Receiver / PaymentHook UTxOs and the chain tip from a provider
// key alone. The port is an interface so the index service is unit-tested against
// a FAKE reader, mirroring how the feeder's feed-sanity check injects `utxosAt`.
// The concrete Blockfrost/Koios wiring lives in `chain-reader-providers.ts`,
// keeping this module to plain types + pure helpers.

import {
  isQuotaError,
  isRateLimitError,
  type ProviderCallEvent,
  type ProviderCallOutcome,
} from "@diadata-org/dia-cardano-oracle-cli/core/provider-retry";

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

/** Observer fired once per Cardano provider request, identical to the one the
 *  CLI's retrying provider emits for `getUtxos` — see chain-reader-providers.ts. */
export type ProviderCallObserver = (event: ProviderCallEvent) => void;

/**
 * Wrap a tip fetcher so each call reports to the provider-call observer with
 * method `"tip"`, classifying failures with the SAME helpers the retrying
 * provider uses for `getUtxos`. This is how the chain-tip REST call (not a Lucid
 * provider method) still counts toward `provider_requests_total`. Returns the
 * fetcher untouched when no observer is supplied.
 */
export function countedTip(
  provider: string,
  fetchTip: TipFetcher,
  onCall: ProviderCallObserver | undefined,
): TipFetcher {
  if (!onCall) return fetchTip;
  return async () => {
    try {
      const tip = await fetchTip();
      onCall({ provider, method: "tip", outcome: "ok" });
      return tip;
    } catch (error) {
      const outcome: ProviderCallOutcome = isQuotaError(error)
        ? "quota_exceeded"
        : isRateLimitError(error)
          ? "rate_limited"
          : "error";
      onCall({ provider, method: "tip", outcome });
      throw error;
    }
  };
}

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
// Tip response parsers (pure functions over a parsed JSON body)
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
