// API route table — the single metadata source for the indexer's OpenAPI
// document. Mirrors the feeder's `src/api/routes.ts`: each entry is a
// `RouteDescriptor` (from the shared package) with the method, the
// OpenAPI-style path template, a dispatch `kind`, a human summary, and TypeBox
// schemas for path params + the success response. `buildOpenApiDocument` turns
// this table into the `/v1/openapi.json` document, so the spec cannot drift from
// the surface the server actually serves.

import { Type } from "@sinclair/typebox";

import type { RouteDescriptor } from "@diadata-org/dia-cardano-oracle-shared/openapi";

/** Title shown on `/docs` and in the OpenAPI document. */
export const INDEXER_API_TITLE = "DIA Cardano Oracle Indexer API";

// ---------------------------------------------------------------------------
// Response schemas — match the shapes the index service returns.
// ---------------------------------------------------------------------------

const AnyObject = Type.Object({}, { additionalProperties: true });

const UtxoRef = Type.Object(
  {
    txHash: Type.String({ description: "Transaction hash of the Pair UTxO." }),
    outputIndex: Type.Integer({ description: "Output index within that transaction." }),
  },
  { additionalProperties: false },
);

const Pair = Type.Object(
  {
    symbol: Type.String(),
    pairId: Type.String({ description: "Hex-encoded pair id." }),
    pairPolicyId: Type.String({ description: "Policy id of the Pair NFT — authenticate the reference input with it." }),
    price: Type.String({ description: "Integer price (DIA fixed-point) as a decimal string." }),
    timestamp: Type.String({ description: "Unix seconds as a decimal string." }),
    nonce: Type.String(),
    signer: Type.String(),
    intentHash: Type.String(),
    minUtxoLovelace: Type.String(),
    utxoRef: UtxoRef,
    ageSeconds: Type.Integer({ description: "now − timestamp at query time." }),
    clientId: Type.String(),
  },
  { additionalProperties: false },
);

const PairsResponse = Type.Object(
  { pairs: Type.Array(Pair) },
  { additionalProperties: false },
);

const ChainTip = Type.Object(
  { slot: Type.Integer(), height: Type.Integer(), hash: Type.String() },
  { additionalProperties: false },
);

const HealthResponse = Type.Object(
  { tip: ChainTip, pairCount: Type.Integer() },
  { additionalProperties: false },
);

const ClientResponse = Type.Object(
  {
    clientId: Type.String(),
    receiverBalanceLovelace: Type.String(),
    accruedToHookLovelace: Type.String(),
    subscribedPairs: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const ClientsResponse = Type.Object(
  { clients: Type.Array(ClientResponse) },
  { additionalProperties: false },
);

const ProtocolFeesResponse = Type.Object(
  {
    baseFeeLovelace: Type.String({ description: "Constant component of the fee formula (lovelace)." }),
    perPairFeeLovelace: Type.String({ description: "Per-pair component of the fee formula (lovelace)." }),
    feeFormula: Type.String({ description: "Human-readable formula: base + N × perPair." }),
    exampleSinglePairFeeLovelace: Type.String({ description: "What a 1-pair update costs (base + perPair)." }),
  },
  { additionalProperties: false },
);

const SymbolParam = Type.Object({
  symbol: Type.String({ description: "Pair symbol, URL-encoded (BTC/USD → BTC%2FUSD)." }),
});

const ClientIdParam = Type.Object({
  clientId: Type.String({ description: "Client id, e.g. client-test-01." }),
});

// ---------------------------------------------------------------------------
// The table — one entry per served route.
// ---------------------------------------------------------------------------

export const indexerRoutes: readonly RouteDescriptor[] = [
  {
    method: "GET",
    path: "/v1/health",
    kind: "health",
    summary: "Provider reachable, chain tip, and live pair count.",
    responseSchema: HealthResponse,
  },
  {
    method: "GET",
    path: "/v1/pairs",
    kind: "pairs",
    summary: "Every published pair with its latest on-chain value and UTxO ref.",
    responseSchema: PairsResponse,
  },
  {
    method: "GET",
    path: "/v1/pairs/{symbol}",
    kind: "pair-by-symbol",
    summary: "One pair's latest on-chain value.",
    params: SymbolParam,
    responseSchema: Pair,
  },
  {
    method: "GET",
    path: "/v1/pairs/{symbol}/utxo",
    kind: "pair-utxo",
    summary: "Just the TxIn (txHash + outputIndex) to use as a reference input.",
    params: SymbolParam,
    responseSchema: UtxoRef,
  },
  {
    method: "GET",
    path: "/v1/clients",
    kind: "clients",
    summary: "Every client publishing feeds, with receiver balance and subscribed pairs.",
    responseSchema: ClientsResponse,
  },
  {
    method: "GET",
    path: "/v1/clients/{clientId}",
    kind: "client-by-id",
    summary: "Receiver balance, accrued-to-hook, and subscribed pairs for a client.",
    params: ClientIdParam,
    responseSchema: ClientResponse,
  },
  {
    method: "GET",
    path: "/v1/protocol/fees",
    kind: "protocol-fees",
    summary: "The on-chain protocol fee parameters a client pays per update (base + N × per-pair).",
    responseSchema: ProtocolFeesResponse,
  },
  {
    method: "GET",
    path: "/v1/openapi.json",
    kind: "openapi",
    summary: "This OpenAPI 3.0 document, generated from the route table.",
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/docs",
    kind: "docs",
    summary: "Interactive API reference (Swagger UI) rendering this spec — with Try it out.",
  },
  {
    method: "GET",
    path: "/metrics",
    kind: "metrics",
    summary: "Prometheus exposition (text/plain) — provider request counts.",
  },
];
