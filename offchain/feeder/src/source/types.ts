// Shapes that flow through the source pipeline.
//
// Two layers:
//
//   1. `ExtractedEvent`   — what the scanner + extractor produce. Only
//                           the fields visible in the raw
//                           `IntentRegistered` log: `intentHash`,
//                           the keccak256-hashed `symbol`, `price`,
//                           `timestamp`, `signer`, plus the on-chain
//                           origin coordinates.
//
//                           Note that `symbol` arrives as
//                           `keccak256(bytes(symbol))` because the
//                           event declares it `indexed`. The
//                           human-readable string lives in the
//                           registry storage and arrives via the
//                           enrichment view-call.
//
//   2. `EnrichedIntent`   — what the enricher produces. Wraps the
//                           extracted event with the full DIA
//                           `OracleIntent` struct fetched via
//                           `OracleIntentRegistry.getIntent(intentHash)`.
//
// Both shapes are network-agnostic: chain ids, registry addresses, and
// signer policy live in the active config, not in these structs.

import type { Address, Hex } from "viem";

/**
 * The decoded `IntentRegistered` event plus the chain coordinates that
 * uniquely identify it for dedup, replay, and metrics.
 */
export type ExtractedEvent = {
  intentHash: Hex;
  /** `keccak256(bytes(symbol))`. Not human-readable; correlate to the
   *  full symbol via `EnrichedIntent.fullIntent.symbol`. */
  symbolHash: Hex;
  price: bigint;
  timestamp: bigint;
  signer: Address;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
};

/**
 * The full DIA OracleIntent tuple as returned by
 * `OracleIntentRegistry.getIntent(intentHash)`. Field order mirrors
 * the Solidity struct (see `OracleIntent.sol` in
 * `diadata-org/Spectra-interoperability/contracts/`).
 *
 * Numerics arrive as `bigint` to match how viem decodes `uint256`.
 */
export type OracleIntent = {
  intentType: string;
  version: string;
  chainId: bigint;
  nonce: bigint;
  expiry: bigint;
  symbol: string;
  price: bigint;
  timestamp: bigint;
  source: string;
  signature: string;
  signer: string;
};

/** An extracted event + its enrichment. The downstream router /
 *  policy / submitter pipeline only ever sees this shape. */
export type EnrichedIntent = {
  event: ExtractedEvent;
  fullIntent: OracleIntent;
};
