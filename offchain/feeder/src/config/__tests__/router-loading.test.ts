import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadRouterDirectory } from "../loader.js";

// A minimal router file targeting one Cardano network. loadRouterDirectory
// only reads `id` + `destinations[].cardano.network`; full validation is
// validate.ts's job, so this is enough to exercise the loader.
function routerYaml(id: string, network: "Preview" | "Mainnet"): string {
  return [
    "routers:",
    `  ${id}:`,
    `    id: ${id}`,
    "    enabled: true",
    "    destinations:",
    "      - cardano:",
    `          network: ${network}`,
    `          client_state_path: state/${network.toLowerCase()}/clients/client-a.json`,
    `          protocol_state_path: state/${network.toLowerCase()}/config-bootstrap.json`,
    "",
  ].join("\n");
}

describe("loadRouterDirectory — network-scoped", () => {
  it("loads only the active network's folder and skips a misfiled router", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "feeder-routers-"));
    try {
      const previewDir = path.join(base, "preview");
      await mkdir(previewDir, { recursive: true });
      // Correctly-filed Preview router + a misfiled Mainnet router in the same folder.
      await writeFile(path.join(previewDir, "client-a.yaml"), routerYaml("client_a_preview", "Preview"));
      await writeFile(path.join(previewDir, "oops-mainnet.yaml"), routerYaml("client_a_mainnet", "Mainnet"));

      const routers = await loadRouterDirectory(previewDir, "Preview");

      assert.ok(routers["client_a_preview"], "the Preview router must load");
      assert.equal(
        routers["client_a_mainnet"],
        undefined,
        "a router whose destination network != active network must be skipped",
      );
      assert.equal(Object.keys(routers).length, 1, "only the matching-network router loads");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns {} when the network folder does not exist", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "feeder-routers-"));
    try {
      const routers = await loadRouterDirectory(path.join(base, "mainnet"), "Mainnet");
      assert.deepEqual(routers, {});
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
