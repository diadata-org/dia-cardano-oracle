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

// ---------------------------------------------------------------------------
// init sub-commands
// ---------------------------------------------------------------------------

describe("parseArgs — init bootstrap", () => {
  it("sets mode=init and subCommand=bootstrap", () => {
    const r = parseArgs(["init", "bootstrap"]);
    assert.equal(r.mode, "init");
    assert.equal(r.initSubCommand, "bootstrap");
    assert.equal(r.force, false);
    assert.equal(r.initFrom, undefined);
  });

  it("--from sets initFrom", () => {
    const r = parseArgs(["init", "bootstrap", "--from", "/some/dir"]);
    assert.equal(r.initFrom, "/some/dir");
  });

  it("--force sets force", () => {
    const r = parseArgs(["init", "bootstrap", "--force"]);
    assert.equal(r.force, true);
  });

  it("--help inside init sets showHelp", () => {
    const r = parseArgs(["init", "bootstrap", "--help"]);
    assert.equal(r.showHelp, true);
  });

  it("throws on unknown flag inside init bootstrap", () => {
    assert.throws(
      () => parseArgs(["init", "bootstrap", "--config", "x"]),
      /Unknown argument for 'init bootstrap'/,
    );
  });
});

describe("parseArgs — init client", () => {
  it("sets mode=init and subCommand=client", () => {
    const r = parseArgs(["init", "client"]);
    assert.equal(r.mode, "init");
    assert.equal(r.initSubCommand, "client");
  });

  it("--from and --force together", () => {
    const r = parseArgs(["init", "client", "--from", "/client.json", "--force"]);
    assert.equal(r.initFrom, "/client.json");
    assert.equal(r.force, true);
  });
});

describe("parseArgs — init errors", () => {
  it("throws when no sub-command given", () => {
    assert.throws(() => parseArgs(["init"]), /requires a sub-command/);
  });

  it("throws on unknown init sub-command", () => {
    assert.throws(() => parseArgs(["init", "badcmd"]), /requires a sub-command/);
  });
});

// ---------------------------------------------------------------------------
// --from-block
// ---------------------------------------------------------------------------

describe("parseArgs — --from-block", () => {
  it("sets fromBlock to the string value", () => {
    const r = parseArgs(["--from-block", "7200000"]);
    assert.equal(r.fromBlock, "7200000");
    assert.equal(r.fromLatest, false);
  });

  it("accepts block 0", () => {
    assert.equal(parseArgs(["--from-block", "0"]).fromBlock, "0");
  });

  it("throws when value is missing", () => {
    assert.throws(() => parseArgs(["--from-block"]), /--from-block requires a value/);
  });

  it("throws on non-integer value", () => {
    assert.throws(() => parseArgs(["--from-block", "abc"]), /non-negative integer/);
  });

  it("throws on negative value", () => {
    assert.throws(() => parseArgs(["--from-block", "-1"]), /non-negative integer/);
  });

  it("throws on decimal value", () => {
    assert.throws(() => parseArgs(["--from-block", "1.5"]), /non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// --from-latest
// ---------------------------------------------------------------------------

describe("parseArgs — --from-latest", () => {
  it("sets fromLatest to true", () => {
    const r = parseArgs(["--from-latest"]);
    assert.equal(r.fromLatest, true);
    assert.equal(r.fromBlock, undefined);
  });
});

// ---------------------------------------------------------------------------
// --from-block / --from-latest mutual exclusion
// ---------------------------------------------------------------------------

describe("parseArgs — --from-block and --from-latest mutual exclusion", () => {
  it("throws when --from-block comes before --from-latest", () => {
    assert.throws(
      () => parseArgs(["--from-block", "100", "--from-latest"]),
      /mutually exclusive/,
    );
  });

  it("throws when --from-latest comes before --from-block", () => {
    assert.throws(
      () => parseArgs(["--from-latest", "--from-block", "100"]),
      /mutually exclusive/,
    );
  });
});

// ---------------------------------------------------------------------------
// --from-block / --from-latest combined with other flags
// ---------------------------------------------------------------------------

describe("parseArgs — checkpoint flags combined with other flags", () => {
  it("--clean --from-latest parses correctly", () => {
    const r = parseArgs(["--clean", "--from-latest"]);
    assert.equal(r.cleanState, true);
    assert.equal(r.fromLatest, true);
  });

  it("--clean --from-block N parses correctly", () => {
    const r = parseArgs(["--clean", "--from-block", "7800000"]);
    assert.equal(r.cleanState, true);
    assert.equal(r.fromBlock, "7800000");
  });

  it("--scan --from-latest parses correctly", () => {
    const r = parseArgs(["--scan", "--from-latest"]);
    assert.equal(r.mode, "scan");
    assert.equal(r.fromLatest, true);
  });
});
