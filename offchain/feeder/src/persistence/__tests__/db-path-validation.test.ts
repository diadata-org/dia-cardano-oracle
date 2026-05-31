import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as nodePath from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { createDb } from "../db.js";

describe("createDb — sqlite path traversal validation", () => {
  let tmpDir: string;
  const origCwd = process.cwd();
  const origRoot = process.env["FEEDER_STATE_ROOT"];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "feeder-path-validation-"));
    process.chdir(tmpDir);
    fs.mkdirSync(nodePath.join(tmpDir, "state"), { recursive: true });
    delete process.env["FEEDER_STATE_ROOT"];
  });

  function restore(): void {
    process.chdir(origCwd);
    if (origRoot === undefined) delete process.env["FEEDER_STATE_ROOT"];
    else process.env["FEEDER_STATE_ROOT"] = origRoot;
  }

  it("rejects a relative path that resolves outside state/", async () => {
    await assert.rejects(
      () => createDb({ driver: "sqlite", path: "../../etc/feeder.sqlite" }),
      /resolves outside the feeder state root/,
    );
    restore();
  });

  it("rejects an absolute path outside the state root", async () => {
    await assert.rejects(
      () => createDb({ driver: "sqlite", path: "/etc/feeder.sqlite" }),
      /resolves outside the feeder state root/,
    );
    restore();
  });

  it("accepts a path that legitimately sits inside state/", async () => {
    // Use :memory: to avoid actually creating a file (better-sqlite3 may
    // not be installed in CI; this test only exercises the validator).
    // The validator runs before driver init, so we need to assert via a
    // path that PASSES the check — we then expect the better-sqlite3
    // import to either succeed or throw a module-not-found, both of which
    // mean the validator itself accepted the path.
    try {
      await createDb({ driver: "sqlite", path: "state/preview/feeder.sqlite" });
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("resolves outside the feeder state root"),
        `validator should accept this path, got: ${msg}`,
      );
    }
    restore();
  });

  it("respects FEEDER_STATE_ROOT for non-standard deployments", async () => {
    const customRoot = nodePath.join(tmpDir, "custom-state");
    fs.mkdirSync(customRoot, { recursive: true });
    process.env["FEEDER_STATE_ROOT"] = customRoot;

    // Path resolves inside customRoot — should pass validation.
    try {
      await createDb({ driver: "sqlite", path: nodePath.join(customRoot, "feeder.sqlite") });
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("resolves outside the feeder state root"),
        `validator should accept path inside FEEDER_STATE_ROOT, got: ${msg}`,
      );
    }

    // Path outside customRoot — should fail.
    await assert.rejects(
      () => createDb({ driver: "sqlite", path: nodePath.join(tmpDir, "other", "feeder.sqlite") }),
      /resolves outside the feeder state root/,
    );

    restore();
  });

  it("accepts :memory: regardless of cwd", async () => {
    try {
      await createDb({ driver: "sqlite", path: ":memory:" });
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(
        !msg.includes("resolves outside the feeder state root"),
        `:memory: must bypass the path check, got: ${msg}`,
      );
    }
    restore();
  });
});
