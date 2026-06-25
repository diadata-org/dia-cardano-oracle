// OpenAPI 3.0 document generator — shared by every offchain HTTP service.
//
// `buildOpenApiDocument(routes, opts)` turns a metadata route table into a plain
// OpenAPI 3.0.3 document object. It is a pure function — no I/O, no globals — so
// it is trivially unit-testable and cannot drift from the routes it is handed.
// Each service owns its own route table and passes its own `baseConfig`
// (title / version / servers); this module stays neutral.
//
// TypeBox schemas are themselves valid JSON Schema, so each route's
// `params`/`query`/`responseSchema` is embedded directly. OpenAPI 3.0 uses a
// JSON-Schema *dialect* (a subset/superset); the schemas we emit (objects,
// strings, integers, arrays, enums) are within the shared subset, so no
// translation layer is needed.

import { Type, type TSchema } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Route descriptor — the metadata each service describes its routes with.
// ---------------------------------------------------------------------------

export type RouteDescriptor = {
  /** HTTP method. */
  method: "GET" | "POST";
  /** OpenAPI path template, e.g. `/api/v1/prices/{symbol}`. */
  path: string;
  /** Dispatch discriminant — must match a `case` in the service's router. */
  kind: string;
  /** One-line human summary for the docs. */
  summary: string;
  /** Path-parameter schema (object whose properties are the `{param}`s). */
  params?: TSchema;
  /** Query-parameter schema (object whose properties are query keys). */
  query?: TSchema;
  /** Success (2xx) response body schema. */
  responseSchema?: TSchema;
};

/** Generic `{ error: string }` body used by every 4xx/5xx response. */
export const errorResponseSchema = Type.Object(
  { error: Type.String() },
  { additionalProperties: false },
);

export type OpenApiBaseConfig = {
  /** API title shown in the docs. */
  title?: string;
  /** API version string (independent of the OpenAPI spec version). */
  version?: string;
  /** Human description rendered at the top of the docs page. */
  description?: string;
  /** Server entries (e.g. the base URL the API is mounted at). */
  servers?: { url: string; description?: string }[];
};

export type BuildOpenApiOptions = {
  baseConfig?: OpenApiBaseConfig;
};

/** A JSON-Schema object whose `properties` become individual parameters. */
type ObjectSchema = TSchema & {
  properties?: Record<string, TSchema & { description?: string }>;
  required?: string[];
};

/** Convert a TypeBox object schema into a list of OpenAPI parameter objects. */
function paramsFromSchema(
  schema: TSchema | undefined,
  location: "path" | "query",
): unknown[] {
  if (!schema) return [];
  const obj = schema as ObjectSchema;
  const properties = obj.properties ?? {};
  const required = new Set(obj.required ?? []);

  return Object.entries(properties).map(([name, propSchema]) => {
    const { description, ...rest } = propSchema as TSchema & { description?: string };
    return {
      name,
      in: location,
      // Path params are always required by the OpenAPI spec.
      required: location === "path" ? true : required.has(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

/** Build the standard responses block for one operation. */
function responsesFor(route: RouteDescriptor): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: "Successful response.",
      ...(route.responseSchema
        ? { content: { "application/json": { schema: route.responseSchema } } }
        : route.kind === "metrics"
          ? { content: { "text/plain": { schema: { type: "string" } } } }
          : route.kind === "docs"
            ? { content: { "text/html": { schema: { type: "string" } } } }
            : {}),
    },
  };

  // Every route can 400 (bad params) / 404 (not found) / 429 (rate limit) /
  // 500. Document the common failure body so consumers know the shape.
  const errorContent = {
    content: { "application/json": { schema: errorResponseSchema } },
  };
  if (route.params) {
    responses["400"] = { description: "Invalid path or query parameter.", ...errorContent };
    responses["404"] = { description: "Resource not found.", ...errorContent };
  }
  responses["429"] = { description: "Rate limit exceeded.", ...errorContent };
  responses["500"] = { description: "Internal error.", ...errorContent };

  return responses;
}

/**
 * Build an OpenAPI 3.0.3 document from the route table.
 *
 * @param routes  The metadata route descriptors.
 * @param options `baseConfig` overrides title/version/description/servers.
 */
export function buildOpenApiDocument(
  routes: readonly RouteDescriptor[],
  options: BuildOpenApiOptions = {},
): Record<string, unknown> {
  const base = options.baseConfig ?? {};

  // Group descriptors by path so multiple methods on the same path merge into
  // one Path Item Object (OpenAPI keys path items by path, then by method).
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const pathItem = (paths[route.path] ??= {});
    const parameters = [
      ...paramsFromSchema(route.params, "path"),
      ...paramsFromSchema(route.query, "query"),
    ];

    pathItem[route.method.toLowerCase()] = {
      summary: route.summary,
      operationId: route.kind,
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: responsesFor(route),
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: base.title ?? "DIA Cardano Oracle API",
      version: base.version ?? "0.1.0",
      description:
        base.description ??
        "HTTP API generated from the in-code route table; cannot drift from the implementation.",
    },
    ...(base.servers && base.servers.length > 0 ? { servers: base.servers } : {}),
    paths,
  };
}
