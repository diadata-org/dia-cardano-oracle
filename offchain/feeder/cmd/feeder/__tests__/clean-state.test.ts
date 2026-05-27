// Tests for cleanFeederState and checkBootstrapStateFiles.
//
// Both functions use a stateBase parameter (default "state") so tests can
// point at a temp directory without touching the real feeder state.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { cleanFeederState, checkBootstrapStateFiles } from "../daemon-cmd.js";
import type { ModularConfig } from "../../../src/config/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function noop(_: string): void {}

// Minimal ModularConfig shape sufficient for checkBootstrapStateFiles.
function makeConfig(
  clientStatePath: string,
  protocolStatePath = "ignored",
): ModularConfig {
  return {
    routers: {
      test_router: {
        id: "test_router",
        name: "Test",
        type: "event",
        enabled: true,
        triggers: { events: ["IntentRegistered"] },
        processing: { datasource: "enrichment", transformations: [] },
        destinations: [
          {
            cardano: {
              network: "Preview",
              client_state_path: clientStatePath,
              protocol_state_path: protocolStatePath,
            },
          },
        ],
      },
    },
  } as unknown as ModularConfig;
}

// ---------------------------------------------------------------------------
// cleanFeederState
// ---------------------------------------------------------------------------

describe("cleanFeederState", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "feeder-test-clean-"));
    const base = join(tmpDir, "preview");

    // Runtime state — should be deleted
    await mkdir(join(base, "logs", "intents"), { recursive: true });
    await writeFile(join(base, "logs", "feeder.log"), "log", "utf8");
    await writeFile(join(base, "feeder-checkpoint.json"), "{}", "utf8");
    await writeFile(join(base, "feeder.sqlite"), "db", "utf8");
    await writeFile(join(base, "feeder.sqlite-shm"), "shm", "utf8");
    await writeFile(join(base, "feeder.sqlite-wal"), "wal", "utf8");

    // Client state — should be deleted
    const pairsDir = join(base, "clients", "client-a", "pairs");
    await mkdir(pairsDir, { recursive: true });
    await writeFile(join(pairsDir, "btc-usd.json"), "{}", "utf8");

    // Bootstrap state files — must survive
    await writeFile(join(base, "config-bootstrap.json"), "{}", "utf8");
    await writeFile(join(base, "clients", "client-a.json"), "{}", "utf8");
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("removes logs directory", async () => {
    await cleanFeederState("Preview", noop, tmpDir);
    assert.equal(await exists(join(tmpDir, "preview", "logs")), false);
  });

  it("removes feeder-checkpoint.json", async () => {
    assert.equal(await exists(join(tmpDir, "preview", "feeder-checkpoint.json")), false);
  });

  it("removes feeder.sqlite and WAL files", async () => {
    assert.equal(await exists(join(tmpDir, "preview", "feeder.sqlite")), false);
    assert.equal(await exists(join(tmpDir, "preview", "feeder.sqlite-shm")), false);
    assert.equal(await exists(join(tmpDir, "preview", "feeder.sqlite-wal")), false);
  });

  it("removes pair state files", async () => {
    assert.equal(
      await exists(join(tmpDir, "preview", "clients", "client-a", "pairs", "btc-usd.json")),
      false,
    );
  });

  it("preserves config-bootstrap.json", async () => {
    assert.equal(await exists(join(tmpDir, "preview", "config-bootstrap.json")), true);
  });

  it("preserves clients/<name>.json bootstrap state file", async () => {
    assert.equal(await exists(join(tmpDir, "preview", "clients", "client-a.json")), true);
  });

  it("does not throw when state dir is already empty", async () => {
    const emptyBase = await mkdtemp(join(tmpdir(), "feeder-test-empty-"));
    try {
      await assert.doesNotReject(() => cleanFeederState("Preview", noop, emptyBase));
    } finally {
      await rm(emptyBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkBootstrapStateFiles
// ---------------------------------------------------------------------------

describe("checkBootstrapStateFiles", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "feeder-test-check-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false and reports hint when config-bootstrap.json is missing", async () => {
    const messages: string[] = [];
    const result = await checkBootstrapStateFiles(
      makeConfig(join(tmpDir, "clients", "client-a.json")),
      "Preview",
      (m) => messages.push(m),
      tmpDir,
    );
    assert.equal(result, false);
    assert.ok(messages.some(m => m.includes("missing bootstrap state file")));
    assert.ok(messages.some(m => m.includes("init bootstrap")));
  });

  it("returns false and reports hint when client state is missing", async () => {
    const base = join(tmpDir, "preview");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "config-bootstrap.json"), "{}", "utf8");

    const messages: string[] = [];
    const clientPath = join(base, "clients", "client-a.json");
    const result = await checkBootstrapStateFiles(
      makeConfig(clientPath),
      "Preview",
      (m) => messages.push(m),
      tmpDir,
    );
    assert.equal(result, false);
    assert.ok(messages.some(m => m.includes("missing client state")));
    assert.ok(messages.some(m => m.includes("init client")));
  });

  it("returns true when all state files are present", async () => {
    const base = join(tmpDir, "preview2");
    const clientsDir = join(base, "clients");
    await mkdir(clientsDir, { recursive: true });
    await writeFile(join(base, "config-bootstrap.json"), "{}", "utf8");
    const clientPath = join(clientsDir, "client-a.json");
    await writeFile(clientPath, "{}", "utf8");

    const result = await checkBootstrapStateFiles(
      makeConfig(clientPath),
      "Preview",
      noop,
      tmpDir,
    );
    assert.equal(result, true);
  });

  it("skips destinations without a cardano block", async () => {
    const base = join(tmpDir, "preview3");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "config-bootstrap.json"), "{}", "utf8");

    const configNoCardano = {
      routers: {
        evm_router: {
          id: "evm_router",
          name: "EVM",
          type: "event",
          enabled: true,
          triggers: { events: ["IntentRegistered"] },
          processing: { datasource: "enrichment", transformations: [] },
          destinations: [{ method: { name: "update", abi: "[]", params: {} } }],
        },
      },
    } as unknown as ModularConfig;

    const result = await checkBootstrapStateFiles(configNoCardano, "Preview", noop, tmpDir);
    assert.equal(result, true);
  });
});
