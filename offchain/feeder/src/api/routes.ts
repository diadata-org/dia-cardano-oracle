// API route table — the single metadata source for the OpenAPI document.
//
// Every HTTP route the feeder serves is described here as a `RouteDescriptor`.
// The descriptor carries the method, the OpenAPI-style path template (with
// `{param}` placeholders), the dispatch `kind`, a human summary, and TypeBox
// schemas for path parameters, query parameters and the success response.
//
// This table is *metadata only*: routing itself still flows through
// `matchRoute()` + the `switch (route.kind)` dispatch in `server.ts`. The two
// must not drift, so a test (`__tests__/routes.test.ts`) asserts the set of
// `kind`s here matches the set of `kind`s the dispatch handles, in both
// directions. Add a route to the dispatch → add it here (and vice-versa) or CI
// fails.
//
// The `kind` strings are the same discriminants as the `RouteMatch` union in
// `server.ts`; keeping them identical is what makes the consistency test
// meaningful.

import { Type } from "@sinclair/typebox";

import type { RouteDescriptor } from "@diadata-org/dia-cardano-oracle-shared/openapi";

// ---------------------------------------------------------------------------
// Reusable schema fragments
// ---------------------------------------------------------------------------

/** Permissive object — used where the exact shape is complex or dynamic and
 *  pinning it down in TypeBox would add maintenance cost without payoff. It
 *  still documents "this returns a JSON object" in the spec. */
const AnyObject = Type.Object({}, { additionalProperties: true });

const PriceEntry = Type.Object(
  {
    routerId: Type.String(),
    clientId: Type.Optional(Type.String()),
    customerId: Type.Optional(Type.String()),
    network: Type.Optional(Type.String()),
    destinationIndex: Type.Integer(),
    symbol: Type.String(),
    price: Type.String({ description: "Integer price as a decimal string." }),
    timestamp: Type.String({ description: "Unix timestamp as a decimal string." }),
    intentHash: Type.String(),
    cardanoTxHash: Type.Optional(Type.String()),
    confirmedAtDepth: Type.Integer(),
    updatedAtMs: Type.Integer(),
  },
  { additionalProperties: false },
);

const PricesResponse = Type.Object(
  { count: Type.Integer(), prices: Type.Array(PriceEntry) },
  { additionalProperties: false },
);

const PriceResponse = Type.Object(
  { symbol: Type.String(), count: Type.Integer(), prices: Type.Array(PriceEntry) },
  { additionalProperties: false },
);

const SymbolsResponse = Type.Object(
  { count: Type.Integer(), symbols: Type.Array(Type.String()) },
  { additionalProperties: false },
);

const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    checks: Type.Record(
      Type.String(),
      Type.Object(
        { ok: Type.Boolean(), detail: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const StatusResponse = Type.Object(
  {
    status: Type.String(),
    uptime_seconds: Type.Integer(),
    network: Type.String(),
    db_driver: Type.String(),
    cron_enabled: Type.Boolean(),
    scanner: Type.Object(
      { last_scan_block: Type.Integer(), is_healthy: Type.Boolean() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ComponentsResponse = Type.Array(
  Type.Object(
    {
      name: Type.String(),
      healthy: Type.Boolean(),
      last_check_ms: Type.Integer(),
    },
    { additionalProperties: false },
  ),
);

const EventNamesResponse = Type.Object(
  { names: Type.Array(Type.String()) },
  { additionalProperties: false },
);

const PoolStats = Type.Object(
  {
    router_id: Type.String(),
    active_workers: Type.Integer(),
    max_workers: Type.Integer(),
    pending_count: Type.Integer(),
    queue_capacity: Type.Integer(),
  },
  { additionalProperties: false },
);

const PoolsResponse = Type.Object(
  { pools: Type.Array(PoolStats) },
  { additionalProperties: false },
);

const PoolTasksResponse = Type.Intersect([
  PoolStats,
  Type.Object({ tasks: Type.Array(AnyObject) }, { additionalProperties: false }),
]);

const AlertAckResponse = Type.Object(
  { acknowledged: Type.Boolean(), id: Type.Integer() },
  { additionalProperties: false },
);

const DebugResponse = Type.Object(
  { status: Type.String(), note: Type.String() },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Query-parameter fragments (each property → one OpenAPI query parameter)
// ---------------------------------------------------------------------------

const LimitQuery = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      default: 50,
      description: "Max rows to return (1-500, default 50).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// The table — one entry per route, mirroring matchRoute() + the switch.
// Order is documentation order (groups: health/ops, then /api/v1 resources).
// ---------------------------------------------------------------------------

export const apiRoutes: readonly RouteDescriptor[] = [
  {
    method: "GET",
    path: "/health",
    kind: "health",
    summary: "Liveness probe (always 200 while the process is up).",
    responseSchema: HealthResponse,
  },
  {
    method: "GET",
    path: "/health/live",
    kind: "health-live",
    summary: "Liveness probe alias.",
    responseSchema: HealthResponse,
  },
  {
    method: "GET",
    path: "/health/ready",
    kind: "health-ready",
    summary: "Readiness probe (503 when registry poll is stale or a component is degraded).",
    responseSchema: HealthResponse,
  },
  {
    method: "GET",
    path: "/metrics",
    kind: "metrics",
    summary: "Prometheus exposition (text/plain).",
  },
  {
    method: "GET",
    path: "/debug",
    kind: "debug",
    summary: "Debug status (404 unless api.debug_enabled is true).",
    responseSchema: DebugResponse,
  },
  {
    method: "GET",
    path: "/api/v1/openapi.json",
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
    path: "/api/v1/prices",
    kind: "prices",
    summary: "All latest confirmed prices held in the in-memory cache.",
    responseSchema: PricesResponse,
  },
  {
    method: "GET",
    path: "/api/v1/prices/{symbol}",
    kind: "price-by-symbol",
    summary: "Latest confirmed price(s) for one symbol.",
    params: Type.Object({ symbol: Type.String() }),
    responseSchema: PriceResponse,
  },
  {
    method: "GET",
    path: "/api/v1/symbols",
    kind: "symbols",
    summary: "All symbols configured across enabled routers.",
    responseSchema: SymbolsResponse,
  },
  {
    method: "GET",
    path: "/api/v1/symbols/{symbol}/updates",
    kind: "symbol-updates",
    summary: "Recent on-chain update history for one symbol.",
    params: Type.Object({ symbol: Type.String({ maxLength: 64 }) }),
    query: LimitQuery,
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/transactions",
    kind: "transactions-list",
    summary: "Recent submitted/confirmed Cardano transactions.",
    query: Type.Object({
      limit: LimitQuery.properties.limit,
      status: Type.Optional(Type.String({ description: "Filter by transaction status." })),
      symbol: Type.Optional(Type.String({ description: "Filter by symbol." })),
      router_id: Type.Optional(Type.String({ description: "Filter by router id." })),
    }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/transactions/{txHash}",
    kind: "transaction",
    summary: "All updates aggregated under one Cardano tx hash.",
    params: Type.Object({ txHash: Type.String({ maxLength: 64 }) }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/chains",
    kind: "chains",
    summary: "Configured chains with runtime + persisted scan state.",
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/chains/{id}/status",
    kind: "chain-status",
    summary: "Runtime + persisted state for one chain (by id or key).",
    params: Type.Object({ id: Type.String() }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/status",
    kind: "status",
    summary: "High-level feeder health snapshot (uptime, network, scanner).",
    responseSchema: StatusResponse,
  },
  {
    method: "GET",
    path: "/api/v1/status/components",
    kind: "status-components",
    summary: "Per-component health details.",
    responseSchema: ComponentsResponse,
  },
  {
    method: "GET",
    path: "/api/v1/events",
    kind: "events",
    summary: "Processed registry events.",
    query: Type.Object({
      limit: LimitQuery.properties.limit,
      status: Type.Optional(Type.String({ description: "Filter by processing status." })),
      from_block: Type.Optional(
        Type.String({ description: "Only events at or after this block number." }),
      ),
    }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/events/names",
    kind: "event-names",
    summary: "All known event names.",
    responseSchema: EventNamesResponse,
  },
  {
    method: "GET",
    path: "/api/v1/events/{hash}",
    kind: "event-by-hash",
    summary: "One processed event by intent hash.",
    params: Type.Object({ hash: Type.String({ maxLength: 64 }) }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/alerts",
    kind: "alerts",
    summary: "Alert log, optionally filtered by active state.",
    query: Type.Object({
      limit: LimitQuery.properties.limit,
      active: Type.Optional(
        Type.Boolean({ description: "true → only active; false → only resolved." }),
      ),
    }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/alerts/{id}",
    kind: "alert-by-id",
    summary: "One alert by numeric id.",
    params: Type.Object({ id: Type.Integer() }),
    responseSchema: AnyObject,
  },
  {
    method: "POST",
    path: "/api/v1/alerts/{id}/ack",
    kind: "alert-ack",
    summary: "Acknowledge one alert by numeric id.",
    params: Type.Object({ id: Type.Integer() }),
    responseSchema: AlertAckResponse,
  },
  {
    method: "POST",
    path: "/api/v1/alerts/ingest",
    kind: "alerts-ingest",
    summary: "Alertmanager webhook — record firing/resolved alerts in the alert log.",
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/performance",
    kind: "performance",
    summary: "Recorded performance metrics, time-windowable.",
    query: Type.Object({
      limit: LimitQuery.properties.limit,
      metric_name: Type.Optional(Type.String({ description: "Filter by metric name." })),
      since: Type.Optional(Type.Integer({ description: "Lower bound epoch-ms." })),
      until: Type.Optional(Type.Integer({ description: "Upper bound epoch-ms." })),
    }),
    responseSchema: AnyObject,
  },
  {
    method: "GET",
    path: "/api/v1/pools",
    kind: "pools",
    summary: "Per-router update worker-pool stats.",
    responseSchema: PoolsResponse,
  },
  {
    method: "GET",
    path: "/api/v1/pools/{router_id}/tasks",
    kind: "pool-tasks",
    summary: "Worker-pool stats and in-flight tasks for one router.",
    params: Type.Object({ router_id: Type.String() }),
    responseSchema: PoolTasksResponse,
  },
] as const;
