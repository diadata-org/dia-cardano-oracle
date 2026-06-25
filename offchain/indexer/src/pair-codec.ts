// Pair-id ⇆ symbol codec.
//
// On-chain a pair's `pairId` is simply its DIA symbol encoded as UTF-8 bytes in
// hex (the same `utf8ToHex(symbol)` the CLI uses when minting). The indexer
// needs both directions: symbol → pairId to look a pair up, and pairId → symbol
// to label a decoded datum for consumers. Kept as a tiny dedicated module so the
// relationship has one documented home.

/** DIA symbol (e.g. "BTC/USD") → on-chain `pairId` (lower-case UTF-8 hex). */
export function symbolToPairId(symbol: string): string {
  return Buffer.from(symbol, "utf8").toString("hex");
}

/** On-chain `pairId` (UTF-8 hex) → DIA symbol. */
export function pairIdToSymbol(pairId: string): string {
  return Buffer.from(pairId, "hex").toString("utf8");
}
