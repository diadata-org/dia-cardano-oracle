// Offline API documentation page (Redoc).
//
// `/docs` serves a tiny self-contained HTML page that loads the *vendored*
// Redoc standalone bundle from `/public/redoc.standalone.js` (served by this
// same server) and points it at `/api/v1/openapi.json`. No CDN, no external
// network at request time — it renders inside Docker / air-gapped hosts.
//
// The Redoc bundle is committed at `offchain/feeder/public/redoc.standalone.js`
// (obtained via `npm pack redoc`). The Dockerfile copies `public/` into the
// runtime image next to `dist/`.
//
// `locatePublicDir()` walks up from this module to find the `public/` dir so
// the same code works whether running compiled (`dist/src/api/docs.js`) or via
// tsx in the source tree (`src/api/docs.ts`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Name of the vendored bundle, served under `/public/`. */
export const REDOC_ASSET = "redoc.standalone.js";

/** Path the bundle is served at by the static route. */
export const REDOC_ASSET_PATH = `/public/${REDOC_ASSET}`;

/**
 * Find the `public/` directory holding the vendored Redoc bundle by walking up
 * the directory tree from this module. Returns `null` if not found (e.g. the
 * asset was not vendored), which lets the caller degrade gracefully.
 */
export function locatePublicDir(startDir?: string): string | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  // Bound the walk; the feeder root is at most ~4 levels above this module.
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "public");
    if (existsSync(join(candidate, REDOC_ASSET))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the vendored Redoc bundle once. Returns its contents (UTF-8) or `null`
 * if the asset is missing. Callers cache the result for the server lifetime.
 */
export function loadRedocAsset(): string | null {
  const publicDir = locatePublicDir();
  if (!publicDir) return null;
  try {
    return readFileSync(join(publicDir, REDOC_ASSET), "utf8");
  } catch {
    return null;
  }
}

/**
 * Build the `/docs` HTML page.
 *
 * @param specUrl    URL of the OpenAPI JSON the page should render.
 * @param assetAvailable Whether the Redoc bundle could be located. When false
 *   we render a minimal fallback page (still offline) that links to the raw
 *   spec instead of failing — so `/docs` always returns 200.
 */
export function renderDocsHtml(specUrl: string, assetAvailable: boolean): string {
  if (!assetAvailable) {
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

  // Redoc's <redoc> custom element + the standalone bundle. spec-url points at
  // our own /api/v1/openapi.json so the page is fully self-hosted.
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>DIA Cardano Oracle Feeder API</title>",
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<style>body { margin: 0; padding: 0; }</style>",
    "</head>",
    "<body>",
    `<redoc spec-url="${specUrl}"></redoc>`,
    `<script src="${REDOC_ASSET_PATH}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
