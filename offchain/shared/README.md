# DIA Cardano Oracle — Shared library

Dependency-light building blocks used by **more than one** off-chain service, so
neither has to reinvent them and the two stay identical. Today that is the HTTP
**API documentation surface**: the OpenAPI 3.0 generator, the Swagger UI `/docs`
page, and the vendored UI assets — behind both the [feeder](../feeder/README.md)'s
and the [indexer](../indexer/README.md)'s `/docs` and `/openapi.json`.

It exists so the OpenAPI/Swagger machinery lives in **one** place: the feeder and
the indexer each own their route table and import the generator from here. It
depends only on [TypeBox](https://github.com/sinclairzx81/typebox) (schemas), so
importing it never pulls a service's heavy stack (DB, Lucid, workers).

## Contents

- [What's in it](#whats-in-it)
- [Who uses it](#who-uses-it)
- [Vendored Swagger UI assets](#vendored-swagger-ui-assets)
- [Develop / test](#develop--test)

## What's in it

| Export | File | Responsibility |
| --- | --- | --- |
| `@…/shared/openapi` | [`src/openapi.ts`](src/openapi.ts) | `buildOpenApiDocument(routes, opts)` — turns a `RouteDescriptor[]` table into an OpenAPI 3.0.3 document. Pure, no I/O. Also exports the `RouteDescriptor` type + the shared `errorResponseSchema`. |
| `@…/shared/docs` | [`src/docs.ts`](src/docs.ts) | `renderDocsHtml()` (the Swagger UI page) + `loadSwaggerAssets()` / `locatePublicDir()` (serve the vendored bundle). |

A service describes its routes once as a `RouteDescriptor[]` table; the generator
produces `/openapi.json` from it, so the spec **cannot drift** from what the
server serves.

## Who uses it

- **Feeder** — [`src/api/routes.ts`](../feeder/src/api/routes.ts) (its table) +
  [`src/api/server.ts`](../feeder/src/api/server.ts) (imports `buildOpenApiDocument`
  + the docs helpers).
- **Indexer** — [`src/api/routes.ts`](../indexer/src/api/routes.ts) (its table) +
  [`src/http.ts`](../indexer/src/http.ts).

Both depend on it as `file:../shared`. In the Docker image it is built **before**
the feeder and indexer (see the [Dockerfile](../feeder/Dockerfile)).

## Vendored Swagger UI assets

`public/` holds the Swagger UI bundle (`swagger-ui-bundle.js` + `swagger-ui.css`,
obtained via `npm pack swagger-ui-dist`), vendored **once** here and served by
both services under `/public/`. `loadSwaggerAssets()` locates them by walking up
from this package, so it works whether the dep is symlinked or copied. They are
part of the package `files`, so they travel with `dist/`.

## Develop / test

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test — generator + Swagger UI helpers
npm run build       # tsc → dist
```
