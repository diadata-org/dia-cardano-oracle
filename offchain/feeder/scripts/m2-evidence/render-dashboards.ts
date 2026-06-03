// Render Grafana dashboards to PNG files.
//
// Mechanism: hits Grafana's `/render/d/<uid>/<slug>` endpoint, which is
// served by the `grafana-image-renderer` sidecar declared in
// `docker-compose.yml` (service: `renderer`, image:
// grafana/grafana-image-renderer). Make sure the `monitoring` compose
// profile is up before running this script (`make up MONITORING=1` or
// `docker compose --profile monitoring up`). No Playwright dependency.
//
// Usage (from offchain/feeder/):
//   node --import tsx/esm scripts/m2-evidence/render-dashboards.ts
//
// Env vars:
//   GRAFANA_URL              Base URL of the Grafana instance. Default: http://localhost:3000
//   GRAFANA_ADMIN_PASSWORD   Grafana admin password. Default: admin
//
// Output:
//   Writes PNGs to docs/evidence/m2-<timestamp>/grafana/<dashboardName>.png
//   Prints one JSON line per dashboard: { "dashboard": "name", "path": "...", "status": "ok"|"error" }

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Configuration — all tunables come from env vars with documented defaults.
// GRAFANA_URL : base URL of the Grafana instance (default: http://localhost:3000)
// GRAFANA_ADMIN_PASSWORD : admin password (default: admin)
// ---------------------------------------------------------------------------
const GRAFANA_URL = (process.env["GRAFANA_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const GRAFANA_USER = "admin";
const GRAFANA_PASS = process.env["GRAFANA_ADMIN_PASSWORD"] ?? "admin";

const RENDER_WIDTH = 1400;
const RENDER_HEIGHT = 900;
const RENDER_FROM = "now-24h";
const RENDER_TO = "now";

// ---------------------------------------------------------------------------
// Resolve output directory: docs/evidence/m2-<timestamp>/grafana/
// ---------------------------------------------------------------------------
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
// scripts/m2-evidence/ → feeder/scripts/ → feeder/ → offchain/ → repo root
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..", "..");
const STAMP = new Date()
  .toISOString()
  .replace(/[-:T]/g, "")
  .slice(0, 15)
  .replace(/(\d{8})(\d{6})/, "$1-$2");
const OUT_DIR = path.join(REPO_ROOT, "docs", "evidence", `m2-${STAMP}`, "grafana");

// ---------------------------------------------------------------------------
// HTTP helpers using only node:http / node:https
// ---------------------------------------------------------------------------

type FetchTextResult = { ok: boolean; status: number; body: string };
type FetchBinaryResult = { ok: boolean; status: number; buffer: Buffer };

function fetchText(urlStr: string, authHeader: string): Promise<FetchTextResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: "GET",
        headers: { Authorization: authHeader, Accept: "application/json" },
        timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                    status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`request timed out: ${urlStr}`)); });
    req.end();
  });
}

function fetchBinary(urlStr: string, authHeader: string): Promise<FetchBinaryResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: "GET",
        headers: { Authorization: authHeader }, timeout: 60_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                    status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`request timed out: ${urlStr}`)); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Grafana API types
// ---------------------------------------------------------------------------

type DashboardSearchItem = {
  uid: string;
  title: string;
  slug?: string;
  uri?: string;   // "db/<slug>" format returned by older API
  url?: string;   // "/d/<uid>/<slug>" format
};

function slugFromItem(item: DashboardSearchItem): string {
  if (item.url) {
    const parts = item.url.split("/");
    return parts[parts.length - 1] ?? item.uid;
  }
  if (item.uri) {
    return item.uri.replace(/^db\//, "");
  }
  return item.uid;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const authHeader = `Basic ${Buffer.from(`${GRAFANA_USER}:${GRAFANA_PASS}`).toString("base64")}`;

  // 1. List all dashboards.
  const searchUrl = `${GRAFANA_URL}/api/search?type=dash-db`;
  let dashboards: DashboardSearchItem[];
  try {
    const result = await fetchText(searchUrl, authHeader);
    if (!result.ok) {
      process.stderr.write(`[render-dashboards] Grafana search returned HTTP ${result.status} — is Grafana up at ${GRAFANA_URL}?\n`);
      process.exit(1);
    }
    dashboards = JSON.parse(result.body) as DashboardSearchItem[];
  } catch (err) {
    process.stderr.write(`[render-dashboards] Cannot reach Grafana at ${GRAFANA_URL}: ${String(err)}\n`);
    process.stderr.write(`[render-dashboards] Start monitoring with: cd offchain && make up MONITORING=1\n`);
    process.exit(1);
  }

  if (dashboards.length === 0) {
    process.stderr.write("[render-dashboards] No dashboards found in Grafana. Nothing to render.\n");
    process.exit(0);
  }

  // 2. Prepare output directory.
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 3. Render each dashboard.
  const results: Array<{ dashboard: string; path: string; status: "ok" | "error"; error?: string }> = [];

  for (const item of dashboards) {
    const slug = slugFromItem(item);
    const safeName = item.title.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").toLowerCase();
    const outPath = path.join(OUT_DIR, `${safeName}.png`);
    const relPath = path.relative(REPO_ROOT, outPath);

    const renderUrl =
      `${GRAFANA_URL}/render/d/${item.uid}/${slug}` +
      `?orgId=1&width=${RENDER_WIDTH}&height=${RENDER_HEIGHT}` +
      `&from=${RENDER_FROM}&to=${RENDER_TO}&kiosk`;

    try {
      const result = await fetchBinary(renderUrl, authHeader);
      if (!result.ok) {
        const entry = { dashboard: item.title, path: relPath, status: "error" as const,
                        error: `HTTP ${result.status}` };
        results.push(entry);
        process.stdout.write(JSON.stringify(entry) + "\n");
        continue;
      }
      // Verify we got a PNG (magic bytes: 89 50 4E 47).
      if (result.buffer.length < 4 || result.buffer[0] !== 0x89 || result.buffer[1] !== 0x50) {
        // Renderer returned something other than PNG (likely an error HTML page).
        const entry = { dashboard: item.title, path: relPath, status: "error" as const,
                        error: "response is not a PNG — renderer plugin may not be running" };
        results.push(entry);
        process.stdout.write(JSON.stringify(entry) + "\n");
        continue;
      }
      fs.writeFileSync(outPath, result.buffer);
      const entry = { dashboard: item.title, path: relPath, status: "ok" as const };
      results.push(entry);
      process.stdout.write(JSON.stringify(entry) + "\n");
    } catch (err) {
      const entry = { dashboard: item.title, path: relPath, status: "error" as const,
                      error: String(err) };
      results.push(entry);
      process.stdout.write(JSON.stringify(entry) + "\n");
    }
  }

  const ok = results.filter((r) => r.status === "ok").length;
  const errors = results.filter((r) => r.status === "error").length;
  process.stderr.write(`[render-dashboards] done: ${ok} ok, ${errors} error(s). Output: ${OUT_DIR}\n`);
}

main().catch((err) => {
  process.stderr.write(`[render-dashboards] fatal: ${String(err)}\n`);
  process.exit(1);
});
