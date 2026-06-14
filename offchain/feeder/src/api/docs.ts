// Interactive API documentation page (Swagger UI).
//
// `/docs` serves an HTML page that loads the vendored Swagger UI assets from
// `/public/` (served by this same server) and points them at
// `/api/v1/openapi.json`. Every endpoint is interactive: fill parameters and
// fire the request straight from the browser against this server.
//
// The Swagger UI bundle (`swagger-ui-bundle.js` + `swagger-ui.css`) is committed
// under `offchain/feeder/public/` (obtained via `npm pack swagger-ui-dist`). The
// Dockerfile copies `public/` into the runtime image next to `dist/`.
//
// `locatePublicDir()` walks up from this module to find the `public/` dir so the
// same code works whether running compiled (`dist/src/api/docs.js`) or via tsx
// in the source tree (`src/api/docs.ts`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Path prefix the vendored assets are served under. */
export const PUBLIC_ASSET_PREFIX = "/public/";

/** The vendored Swagger UI assets, with the Content-Type each must be served as. */
export const SWAGGER_ASSETS: ReadonlyArray<{ file: string; contentType: string }> = [
  { file: "swagger-ui.css", contentType: "text/css; charset=utf-8" },
  { file: "swagger-ui-bundle.js", contentType: "application/javascript; charset=utf-8" },
];

/** Served path for a vendored asset (`swagger-ui.css` → `/public/swagger-ui.css`). */
export function publicAssetPath(file: string): string {
  return `${PUBLIC_ASSET_PREFIX}${file}`;
}

/**
 * Find the `public/` directory holding the vendored Swagger UI assets by walking
 * up the directory tree from this module. Returns `null` if not found (e.g. the
 * assets were not vendored), which lets the caller degrade gracefully.
 */
export function locatePublicDir(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  // Bound the walk; the feeder root is at most ~4 levels above this module.
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "public");
    if (existsSync(join(candidate, "swagger-ui-bundle.js"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** A loaded vendored asset: its served path, bytes, and Content-Type. */
export type LoadedAsset = { path: string; body: string; contentType: string };

/**
 * Read every vendored Swagger UI asset once, keyed by its served path
 * (`/public/<file>`). Returns `null` if the `public/` dir or any asset is
 * missing, so the caller can serve the fallback page. Callers cache the
 * result for the server lifetime.
 */
export function loadSwaggerAssets(): Map<string, LoadedAsset> | null {
  const publicDir = locatePublicDir();
  if (!publicDir) return null;
  const assets = new Map<string, LoadedAsset>();
  for (const { file, contentType } of SWAGGER_ASSETS) {
    try {
      const body = readFileSync(join(publicDir, file), "utf8");
      assets.set(publicAssetPath(file), { path: publicAssetPath(file), body, contentType });
    } catch {
      return null;
    }
  }
  return assets;
}

/**
 * Build the `/docs` HTML page.
 *
 * @param specUrl        URL of the OpenAPI JSON the page should render.
 * @param assetsAvailable Whether the Swagger UI assets could be located. When
 *   false we render a minimal fallback page that links to the raw spec instead
 *   of failing — so `/docs` always returns 200.
 */
export function renderDocsHtml(specUrl: string, assetsAvailable: boolean): string {
  if (!assetsAvailable) {
    return [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8" />',
      "<title>DIA Cardano Oracle Feeder API</title>",
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "</head><body>",
      "<h1>DIA Cardano Oracle Feeder API</h1>",
      "<p>The bundled API reference UI is unavailable in this build. ",
      `The machine-readable spec is at <a href="${specUrl}">${specUrl}</a>.</p>`,
      "</body></html>",
    ].join("\n");
  }

  // Swagger UI mounts into #swagger-ui from the vendored bundle and renders our
  // own /api/v1/openapi.json. `tryItOutEnabled` opens the request console on
  // every operation so endpoints can be exercised straight from the page.
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>DIA Cardano Oracle Feeder API</title>",
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<link rel="stylesheet" href="${publicAssetPath("swagger-ui.css")}" />`,
    "<style>body { margin: 0; padding: 0; }</style>",
    "</head>",
    "<body>",
    '<div id="swagger-ui"></div>',
    `<script src="${publicAssetPath("swagger-ui-bundle.js")}"></script>`,
    "<script>",
    "  window.ui = SwaggerUIBundle({",
    `    url: ${JSON.stringify(specUrl)},`,
    '    dom_id: "#swagger-ui",',
    "    deepLinking: true,",
    "    tryItOutEnabled: true",
    "  });",
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}
