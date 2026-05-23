// Enricher — turn an `ExtractedEvent` into an `EnrichedIntent` by
// fetching the full `OracleIntent` from the registry.
//
// Spectra calls this the "view-call enrichment" stage. For
// `IntentRegistered`, the on-chain log carries only the intent hash,
// signer, price, timestamp, and the keccak hash of the symbol; the
// readable symbol, the EIP-712 signature, version, source, nonce, and
// expiry live in the registry storage and are read back via
// `getIntent(intentHash)`.
//
// The function ABI is the one parsed from `events.yaml` at config load
// time (see `src/config/abi-parser.ts`). This module does not import
// any ABI constant — every view call goes through the operator's YAML.

import type { AbiFunction, Address, Hex, PublicClient } from "viem";

import type { EnrichedIntent, ExtractedEvent, OracleIntent } from "../source/types.js";

/** Inputs needed to enrich one event. Threading these in keeps the
 *  enricher decoupled from how the rest of the feeder builds its viem
 *  client and where the contract address came from. */
export type EnricherInputs = {
  /** Viem client to call `getIntent` against. Any transport works
   *  (HTTP is the usual choice; cheap one-shot view call). */
  client: PublicClient;
  /** Registry contract address. From `contracts.yaml::<id>.address`. */
  registryAddress: Address;
  /** Parsed `getIntent` function ABI, from
   *  `events.yaml::event_definitions.<event>.enrichment.abi`. */
  enrichmentAbi: AbiFunction;
};

/** Stable function shape so call sites (and tests) can swap in a fake. */
export type Enricher = (event: ExtractedEvent) => Promise<EnrichedIntent>;

/**
 * Build an enricher bound to the given client + registry + ABI. The
 * returned closure is the only thing the rest of the pipeline depends
 * on — the underlying viem client is hidden from the call site.
 */
export function createRegistryEnricher(inputs: EnricherInputs): Enricher {
  const { client, registryAddress, enrichmentAbi } = inputs;
  return async (event) => {
    const raw = await client.readContract({
      address: registryAddress,
      abi: [enrichmentAbi],
      functionName: enrichmentAbi.name,
      args: [event.intentHash as Hex],
    });
    return { event, fullIntent: normalizeOracleIntent(raw) };
  };
}

/**
 * Enrich a batch of events serially against the same enricher. Kept
 * sequential to play well with provider rate limits; can be replaced
 * by a concurrent variant once concrete throughput numbers justify
 * the added complexity.
 */
export async function enrichEvents(
  enricher: Enricher,
  events: ExtractedEvent[],
): Promise<EnrichedIntent[]> {
  const out: EnrichedIntent[] = [];
  for (const event of events) {
    out.push(await enricher(event));
  }
  return out;
}

/**
 * Coerce viem's decoded tuple into our canonical `OracleIntent` shape.
 * viem returns an object with the named fields when the ABI declares
 * them (which our `getIntent` ABI does), so we pass through verbatim
 * and only widen numerics to bigint at the boundary.
 */
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
