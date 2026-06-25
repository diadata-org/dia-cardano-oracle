// Interactive API documentation page (Swagger UI) — shared by every offchain
// HTTP service.
//
// A service serves `/docs` as an HTML page that loads the vendored Swagger UI
// assets from `/public/` (served by the same server) and points them at the
// service's own OpenAPI JSON. Every endpoint is interactive: fill parameters and
// fire the request straight from the browser.
//
// The Swagger UI bundle (`swagger-ui-bundle.js` + `swagger-ui.css`) is vendored
// ONCE under this package's `public/` (obtained via `npm pack swagger-ui-dist`),
// so both the feeder and the indexer serve identical assets. `locatePublicDir()`
// walks up from this module to find that `public/` dir, so the same code works
// whether running compiled (`dist/docs.js`) or via tsx in the source tree.

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
  // Bound the walk; the package root is at most a few levels above this module.
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
 * @param title          Page + heading title (defaults to a neutral name).
 */
export function renderDocsHtml(
  specUrl: string,
  assetsAvailable: boolean,
  title = "DIA Cardano Oracle API",
): string {
  if (!assetsAvailable) {
    return [
      "<!DOCTYPE html>",
      '<html lang="en"><head><meta charset="utf-8" />',
      `<title>${title}</title>`,
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "</head><body>",
      `<h1>${title}</h1>`,
      "<p>The bundled API reference UI is unavailable in this build. ",
      `The machine-readable spec is at <a href="${specUrl}">${specUrl}</a>.</p>`,
      "</body></html>",
    ].join("\n");
  }

  // Swagger UI mounts into #swagger-ui from the vendored bundle and renders the
  // service's own OpenAPI JSON. `tryItOutEnabled` opens the request console on
  // every operation so endpoints can be exercised straight from the page.
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${title}</title>`,
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
