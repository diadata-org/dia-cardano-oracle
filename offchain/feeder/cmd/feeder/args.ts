// CLI flag parser for the feeder binary. Lives in its own module so
// the entry point can be a thin orchestrator and the parser can be
// unit-tested without spawning a process.
//
// Flags supported:
//
//   --config <dir>       (default: ./config)
//   --log-level <level>  (default: info)
//   --validate-only      mutually exclusive with --scan
//   --scan               run scanner + enricher only; no router/write-client
//   --transport <kind>   one of: http | ws (default: http)
//   --dry-run            full pipeline with no-op write-client; also DRY_RUN=true
//   --clean              delete feeder-generated state before starting
//   --from-block <N>     seed the block-scanner checkpoint to block N before
//                        starting; scanner processes from block N onwards.
//                        Mutually exclusive with --from-latest.
//   --from-latest        query the current chain tip and seed the checkpoint
//                        to that block; only intents arriving after startup
//                        are processed. Mutually exclusive with --from-block.
//   --force              skip overwrite confirmation prompts (init only)
//   --from <path>        source path for init sub-commands
//   --help, -h
//
// Positional sub-commands:
//
//   init bootstrap       copy config-bootstrap.json from CLI state
//   init client          copy client JSON + generate router YAML interactively

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Transport = "http" | "ws";
export type InitSubCommand = "bootstrap" | "client";
export type CheckpointSubCommand = "set" | "get";

/** Mutually exclusive top-level "mode" the binary runs in. */
export type FeederMode = "daemon" | "validate" | "scan" | "init" | "checkpoint" | "prune" | "reset";

export type ParsedArgs = {
  configPath: string;
  logLevel: LogLevel;
  mode: FeederMode;
  transport: Transport;
  dryRun: boolean;
  cleanState: boolean;
  showHelp: boolean;
  // Checkpoint seeding (mutually exclusive) — used by both the daemon
  // (as a one-shot seed before the scanner starts) and the `checkpoint`
  // sub-command (as the only way to mutate state).
  fromBlock?: string;   // "N" → scan starts from block N
  fromLatest: boolean;  // scan starts from current chain tip
  clear: boolean;       // checkpoint set --clear: reset to 0
  // init-specific
  initSubCommand?: InitSubCommand;
  initFrom?: string;
  force: boolean;
  // checkpoint-specific
  checkpointSubCommand?: CheckpointSubCommand;
  // prune-specific: human duration string ("1h", "30m", "2h30m") for the
  // age cutoff. Undefined defers to runPrune's own default.
  maxAge?: string;
};

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const VALID_TRANSPORTS: readonly Transport[] = ["http", "ws"];

const DEFAULTS: ParsedArgs = {
  configPath: "./config",
  logLevel: "info",
  mode: "daemon",
  transport: "http",
  dryRun: false,
  cleanState: false,
  showHelp: false,
  fromLatest: false,
  clear: false,
  force: false,
};

/**
 * Parse a raw `argv` slice (the part after node + script). Throws on
 * unknown flags, invalid values, or conflicting modes so the entry
 * point can print usage and exit non-zero.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Positional sub-commands (init / checkpoint / prune / reset) normally come
  // first. But some invocations prepend the global `--config <dir>` (and
  // `--log-level <lvl>`) flags — notably the Docker Makefile, which always
  // runs `... main.js --config /config <subcommand>`. Peel those leading
  // global flags off so the sub-command is still detected, then apply them
  // to whatever the sub-parser returns.
  let idx = 0;
  let leadingConfig: string | undefined;
  let leadingLogLevel: LogLevel | undefined;
  while (idx < argv.length) {
    if (argv[idx] === "--config") {
      leadingConfig = requireValue(argv, idx + 1, "--config");
      idx += 2;
    } else if (argv[idx] === "--log-level") {
      leadingLogLevel = parseLogLevel(requireValue(argv, idx + 1, "--log-level"));
      idx += 2;
    } else {
      break;
    }
  }

  const head = argv[idx];
  if (head === "init" || head === "checkpoint" || head === "prune" || head === "reset") {
    const subArgv = argv.slice(idx);
    let parsed: ParsedArgs;
    switch (head) {
      case "init":       parsed = parseInitArgs(subArgv); break;
      case "checkpoint": parsed = parseCheckpointArgs(subArgv); break;
      case "prune":      parsed = parsePruneArgs(subArgv); break;
      default:           parsed = parseResetArgs(subArgv); break;
    }
    if (leadingConfig !== undefined) parsed.configPath = leadingConfig;
    if (leadingLogLevel !== undefined) parsed.logLevel = leadingLogLevel;
    return parsed;
  }

  // No sub-command — daemon flag loop. Scan the FULL argv (the loop handles
  // --config / --log-level wherever they appear).
  const parsed: ParsedArgs = { ...DEFAULTS };
  applyEnvOverrides(parsed);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      case "--validate-only":
        setMode(parsed, "validate", arg);
        break;
      case "--scan":
        setMode(parsed, "scan", arg);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--clean":
        parsed.cleanState = true;
        break;
      case "--from-block":
        if (parsed.fromLatest) {
          throw new Error("--from-block and --from-latest are mutually exclusive");
        }
        parsed.fromBlock = parseBlockNumber(requireValue(argv, ++i, "--from-block"));
        break;
      case "--from-latest":
        if (parsed.fromBlock !== undefined) {
          throw new Error("--from-block and --from-latest are mutually exclusive");
        }
        parsed.fromLatest = true;
        break;
      case "--config":
        parsed.configPath = requireValue(argv, ++i, "--config");
        break;
      case "--log-level":
        parsed.logLevel = parseLogLevel(requireValue(argv, ++i, "--log-level"));
        break;
      case "--transport":
        parsed.transport = parseTransport(requireValue(argv, ++i, "--transport"));
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function parseCheckpointArgs(argv: string[]): ParsedArgs {
  const sub = argv[1] as CheckpointSubCommand | undefined;
  if (sub !== "set" && sub !== "get") {
    throw new Error(
      `'checkpoint' requires a sub-command: set or get\n` +
      `  feeder checkpoint get\n` +
      `  feeder checkpoint set --from-latest\n` +
      `  feeder checkpoint set --from-block <N>\n` +
      `  feeder checkpoint set --clear`,
    );
  }

  const parsed: ParsedArgs = {
    ...DEFAULTS,
    mode: "checkpoint",
    checkpointSubCommand: sub,
  };
  applyEnvOverrides(parsed);

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      case "--config":
        parsed.configPath = requireValue(argv, ++i, "--config");
        break;
      case "--from-block":
        if (parsed.fromLatest || parsed.clear) {
          throw new Error("--from-block is mutually exclusive with --from-latest and --clear");
        }
        parsed.fromBlock = parseBlockNumber(requireValue(argv, ++i, "--from-block"));
        break;
      case "--from-latest":
        if (parsed.fromBlock !== undefined || parsed.clear) {
          throw new Error("--from-latest is mutually exclusive with --from-block and --clear");
        }
        parsed.fromLatest = true;
        break;
      case "--clear":
        if (parsed.fromBlock !== undefined || parsed.fromLatest) {
          throw new Error("--clear is mutually exclusive with --from-block and --from-latest");
        }
        parsed.clear = true;
        break;
      default:
        throw new Error(`Unknown argument for 'checkpoint ${sub}': ${arg}`);
    }
  }

  return parsed;
}

function parseResetArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { ...DEFAULTS, mode: "reset" };
  applyEnvOverrides(parsed);

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      default:
        throw new Error(`Unknown argument for 'reset': ${arg}`);
    }
  }

  return parsed;
}

function parsePruneArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { ...DEFAULTS, mode: "prune" };
  applyEnvOverrides(parsed);

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      case "--config":
        parsed.configPath = requireValue(argv, ++i, "--config");
        break;
      case "--max-age":
        parsed.maxAge = requireValue(argv, ++i, "--max-age");
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument for 'prune': ${arg}`);
    }
  }

  return parsed;
}

function parseInitArgs(argv: string[]): ParsedArgs {
  const sub = argv[1] as InitSubCommand | undefined;
  if (sub !== "bootstrap" && sub !== "client") {
    throw new Error(
      `'init' requires a sub-command: bootstrap or client\n` +
      `  feeder init bootstrap [--from <cli-state-dir>] [--force]\n` +
      `  feeder init client    [--from <client.json>]   [--force]`,
    );
  }

  const parsed: ParsedArgs = { ...DEFAULTS, mode: "init", initSubCommand: sub };
  applyEnvOverrides(parsed);

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.showHelp = true;
        break;
      case "--from":
        parsed.initFrom = requireValue(argv, ++i, "--from");
        break;
      case "--force":
        parsed.force = true;
        break;
      default:
        throw new Error(`Unknown argument for 'init ${sub}': ${arg}`);
    }
  }

  return parsed;
}

/** Read environment variables that act as flag fallbacks. Mirrors how
 *  the Spectra Bridge picks up `DRY_RUN` from the environment. */
function applyEnvOverrides(target: ParsedArgs): void {
  if (process.env.DRY_RUN?.trim().toLowerCase() === "true") {
    target.dryRun = true;
  }
}

function setMode(target: ParsedArgs, mode: FeederMode, flag: string): void {
  if (target.mode !== "daemon" && target.mode !== mode) {
    throw new Error(`Cannot combine ${flag} with --${target.mode}-only / --${target.mode}.`);
  }
  target.mode = mode;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value argument`);
  }
  return value;
}

function parseLogLevel(raw: string): LogLevel {
  if (!(VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `--log-level must be one of ${VALID_LOG_LEVELS.join("|")}, got "${raw}"`,
    );
  }
  return raw as LogLevel;
}

function parseTransport(raw: string): Transport {
  if (!(VALID_TRANSPORTS as readonly string[]).includes(raw)) {
    throw new Error(
      `--transport must be one of ${VALID_TRANSPORTS.join("|")}, got "${raw}"`,
    );
  }
  return raw as Transport;
}

function parseBlockNumber(raw: string): string {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`--from-block must be a non-negative integer, got "${raw}"`);
  }
  return raw.trim();
}
