import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import { parseArgs } from "../args.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withEnv(key: string, value: string, fn: () => void): void {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("parseArgs — defaults", () => {
  it("returns defaults when argv is empty", () => {
    const result = parseArgs([]);
    assert.equal(result.configPath, "./config");
    assert.equal(result.logLevel, "info");
    assert.equal(result.mode, "daemon");
    assert.equal(result.transport, "http");
    assert.equal(result.dryRun, false);
    assert.equal(result.showHelp, false);
  });
});

// ---------------------------------------------------------------------------
// --help / -h
// ---------------------------------------------------------------------------

describe("parseArgs — --help", () => {
  it("sets showHelp for --help", () => {
    assert.equal(parseArgs(["--help"]).showHelp, true);
  });

  it("sets showHelp for -h", () => {
    assert.equal(parseArgs(["-h"]).showHelp, true);
  });
});

// ---------------------------------------------------------------------------
// --config
// ---------------------------------------------------------------------------

describe("parseArgs — --config", () => {
  it("sets configPath", () => {
    assert.equal(parseArgs(["--config", "/etc/feeder"]).configPath, "/etc/feeder");
  });

  it("throws when value is missing", () => {
    assert.throws(() => parseArgs(["--config"]), /--config requires a value/);
  });
});

// ---------------------------------------------------------------------------
// --log-level
// ---------------------------------------------------------------------------

describe("parseArgs — --log-level", () => {
  for (const level of ["debug", "info", "warn", "error"] as const) {
    it(`accepts ${level}`, () => {
      assert.equal(parseArgs(["--log-level", level]).logLevel, level);
    });
  }

  it("throws on invalid value", () => {
    assert.throws(() => parseArgs(["--log-level", "verbose"]), /--log-level must be one of/);
  });

  it("throws when value is missing", () => {
    assert.throws(() => parseArgs(["--log-level"]), /--log-level requires a value/);
  });
});

// ---------------------------------------------------------------------------
// --transport
// ---------------------------------------------------------------------------

describe("parseArgs — --transport", () => {
  it("accepts http", () => {
    assert.equal(parseArgs(["--transport", "http"]).transport, "http");
  });

  it("accepts ws", () => {
    assert.equal(parseArgs(["--transport", "ws"]).transport, "ws");
  });

  it("throws on invalid value", () => {
    assert.throws(() => parseArgs(["--transport", "grpc"]), /--transport must be one of/);
  });

  it("throws when value is missing", () => {
    assert.throws(() => parseArgs(["--transport"]), /--transport requires a value/);
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe("parseArgs — --dry-run", () => {
  it("sets dryRun via flag", () => {
    assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  });

  it("sets dryRun via DRY_RUN=true env var", () => {
    withEnv("DRY_RUN", "true", () => {
      assert.equal(parseArgs([]).dryRun, true);
    });
  });

  it("ignores DRY_RUN=false", () => {
    withEnv("DRY_RUN", "false", () => {
      assert.equal(parseArgs([]).dryRun, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Mode flags
// ---------------------------------------------------------------------------

describe("parseArgs — modes", () => {
  it("defaults to daemon mode", () => {
    assert.equal(parseArgs([]).mode, "daemon");
  });

  it("--validate-only sets mode=validate", () => {
    assert.equal(parseArgs(["--validate-only"]).mode, "validate");
  });

  it("--scan sets mode=scan", () => {
    assert.equal(parseArgs(["--scan"]).mode, "scan");
  });

  it("--scan twice is idempotent", () => {
    assert.equal(parseArgs(["--scan", "--scan"]).mode, "scan");
  });

  it("throws when --scan and --validate-only are combined", () => {
    assert.throws(
      () => parseArgs(["--scan", "--validate-only"]),
      /Cannot combine/,
    );
  });

  it("throws when --validate-only and --scan are combined", () => {
    assert.throws(
      () => parseArgs(["--validate-only", "--scan"]),
      /Cannot combine/,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown flags
// ---------------------------------------------------------------------------

describe("parseArgs — unknown flags", () => {
  it("throws on unknown flag", () => {
    assert.throws(() => parseArgs(["--foo"]), /Unknown argument: --foo/);
  });
});

// ---------------------------------------------------------------------------
// Combined usage
// ---------------------------------------------------------------------------

describe("parseArgs — combined flags", () => {
  it("parses all flags together", () => {
    const result = parseArgs([
      "--config", "/opt/feeder/config",
      "--log-level", "debug",
      "--transport", "ws",
      "--dry-run",
      "--scan",
    ]);
    assert.equal(result.configPath, "/opt/feeder/config");
    assert.equal(result.logLevel, "debug");
    assert.equal(result.transport, "ws");
    assert.equal(result.dryRun, true);
    assert.equal(result.mode, "scan");
    assert.equal(result.showHelp, false);
  });
});
