// DIA Cardano Oracle Feeder — entry point.
//
//   - `--config <dir>` selects the modular config directory.
//   - `--log-level <debug|info|warn|error>` controls logger verbosity.
//   - `--validate-only` loads + validates the config and exits.
//   - `--scan` runs the source pipeline (scanner + dedup + enricher) only;
//     the router, coalescer, and write-client are not started. Useful for
//     verifying DIA registry connectivity before going live.
//   - `--dry-run` runs the full pipeline (scanner → router → coalescer →
//     write-client) with a no-op write-client — no Cardano txs are built or
//     submitted. Independent of `--scan`: can be used together or alone.
//   - `--from-block <N>` / `--from-latest` seed the block-scanner checkpoint
//     before startup. Use after `--clean` to avoid replaying expired intents.
//   - `init bootstrap` copies config-bootstrap.json from a CLI state dir.
//   - `init client`    copies a client JSON and generates a router YAML
//     interactively.
//   - default: long-running daemon.
//
// This file stays thin: it parses args, resolves the active network,
// dispatches to the right handler, and orchestrates graceful shutdown
// via an AbortController.

import "dotenv/config";

import { parseArgs, type FeederMode, type ParsedArgs } from "./args.js";
import { runScan } from "./scan-cmd.js";
import { runValidateOnly } from "./validate-cmd.js";
import { runDaemon, cleanFeederState } from "./daemon-cmd.js";
import { runInit } from "./init-cmd.js";
import { runCheckpoint } from "./checkpoint-cmd.js";
import { runPrune, parseDuration } from "./prune-cmd.js";

const HELP_TEXT = `dia-cardano-oracle-feeder

Long-running daemon that consumes DIA OracleIntentRegistry events from
DIA Lasernet (testnet or mainnet) and submits matching Cardano oracle
updates. Architecturally aligned with the DIA Spectra Bridge.

Usage:
  feeder --config <dir> [--log-level <level>]
  feeder --config <dir> --validate-only
  feeder --config <dir> --scan [--transport http|ws] [--dry-run]
  feeder init bootstrap [--from <cli-state-dir-or-file>] [--force]
  feeder init client    [--from <client.json>]           [--force]
  feeder checkpoint get
  feeder checkpoint set --from-latest | --from-block <N> | --clear
  feeder reset
  feeder prune [--max-age <duration>] [--dry-run]
  feeder --help

Flags:
  --config <dir>        Path to the modular configuration directory.
                        Expected files: infrastructure.<network>.yaml,
                        chains.yaml, contracts.yaml, events.yaml,
                        routers/*.yaml.
                        Default: ./config
  --log-level <level>   One of: debug | info | warn | error.
                        Default: info
  --validate-only       Load + validate the config and exit.
                        Exits 0 on success, 1 on any error-severity issue.
  --scan                Run the source pipeline (scanner + dedup +
                        enricher) and print enriched intents.
  --transport <kind>    Applies to --scan. http (default) or ws.
  --dry-run             Print enriched intents but never submit a
                        Cardano tx. Also reachable via DRY_RUN=true.
  --from-block <N>      Seed the block-scanner checkpoint to block N
                        before starting. The scanner will process from
                        block N onwards. Mutually exclusive with
                        --from-latest.
  --from-latest         Query the current chain tip and seed the
                        checkpoint to that block. Only new intents
                        (arriving after startup) will be processed.
                        Mutually exclusive with --from-block.
  --clean               Delete feeder-generated state before starting:
                          logs/, feeder-checkpoint.json, feeder.sqlite*,
                          clients/*/pairs/*.json
                        CLI bootstrap state files are never touched:
                          config-bootstrap.json, clients/*.json
  --help, -h            Show this help message and exit.

Init sub-commands (one-time setup):
  init bootstrap        Copy config-bootstrap.json from a CLI state dir
                        into state/<network>/. Auto-scans ../cli/state/
                        for matching network run dirs; use --from to
                        supply a path explicitly.
  init client           Copy a client JSON from a CLI state dir into
                        state/<network>/clients/, then run an interactive
                        wizard to generate config/routers/<id>.<network>.yaml.
                        Use --from <client.json> to skip auto-scan.

  --from <path>         Source path for init sub-commands. For 'bootstrap':
                        a CLI state dir or the JSON file directly. For
                        'client': the client JSON file.
  --force               Skip the overwrite confirmation prompt (init only).

Checkpoint sub-commands (mutate chain_state.last_scan_block in the DB):
  checkpoint get        Print the current persisted checkpoint and which
                        block the daemon will start scanning from.
  checkpoint set        Mutate the checkpoint. Requires exactly one of:
                          --from-latest   query chain tip, scan only new
                          --from-block N  scan from block N onwards
                          --clear         reset to 0 (replays from YAML
                                          start_block on next daemon run)

                        Safe to run while the daemon is stopped. The
                        daemon only reads the checkpoint at startup, so
                        running these while it is live has no effect on
                        the active scanner.

Reset sub-command (full wipe, then exit — does NOT start the daemon):
  reset                 Delete ALL feeder-generated state and exit:
                          logs/, feeder.sqlite*, clients/*/pairs/*.json
                        CLI bootstrap state files are never touched:
                          config-bootstrap.json, clients/*.json
                        Same deletion as the --clean flag, but exits
                        instead of starting the daemon — use this for
                        one-off resets (e.g. in Docker via 'make reset').
                        After reset, re-seed the scanner with
                        'checkpoint set --from-latest' before starting.

Prune sub-command (partial, age-based — keeps the DB file):
  prune                 Delete old per-intent log files, rotate line logs,
                        and prune confirmed/failed transaction_log +
                        processed_events rows older than the cutoff. CLI
                        bootstrap state (config-bootstrap.json, client JSON)
                        is never touched. Unlike reset, the DB file and
                        recent rows survive.
  --max-age <duration>  Age cutoff: 1h | 30m | 2h30m | 90s. Default: 1h.
  --dry-run             Print what would be deleted without deleting.

The active network (Preview <-> DIA Testnet, Mainnet <-> DIA Mainnet)
is selected by CARDANO_NETWORK in .env, matching the CLI behavior.
`;

const SUPPORTED_NETWORKS = ["Preview", "Mainnet"] as const;
type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

/**
 * Resolve the active network from the `CARDANO_NETWORK` env var, with
 * `Preview` as the default. Throws on any unsupported value so that
 * misconfigured environments fail loudly instead of silently picking
 * the wrong DIA registry.
 */
function resolveActiveNetwork(): SupportedNetwork {
  const raw = process.env.CARDANO_NETWORK?.trim() ?? "Preview";
  if (!(SUPPORTED_NETWORKS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unsupported CARDANO_NETWORK "${raw}". Supported: ${SUPPORTED_NETWORKS.join(", ")}.`,
    );
  }
  return raw as SupportedNetwork;
}

/** Prefix every line written to stderr with `[feeder]`. */
function report(line: string): void {
  process.stderr.write(`[feeder] ${line}\n`);
}

/** AbortController whose signal trips on SIGINT or SIGTERM. The first
 *  signal triggers a graceful shutdown; a second one forces exit. */
function installShutdownController(): AbortController {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      report(`received second ${signal}, forcing exit.`);
      process.exit(130);
    }
    report(`received ${signal}, shutting down gracefully (Ctrl-C again to force).`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return controller;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  if (args.showHelp) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const network = resolveActiveNetwork();

  switch (args.mode satisfies FeederMode) {
    case "validate":
      return runValidateOnly({ configPath: args.configPath, network, report });

    case "scan": {
      const shutdown = installShutdownController();
      return runScan({
        network,
        configPath: args.configPath,
        transport: args.transport,
        dryRun: args.dryRun,
        fromBlock: args.fromBlock,
        fromLatest: args.fromLatest,
        report,
        signal: shutdown.signal,
      });
    }

    case "daemon": {
      const shutdown = installShutdownController();
      return runDaemon({
        network,
        configPath: args.configPath,
        transport: args.transport,
        dryRun: args.dryRun,
        cleanState: args.cleanState,
        logLevel: args.logLevel,
        fromBlock: args.fromBlock,
        fromLatest: args.fromLatest,
        report,
        signal: shutdown.signal,
      });
    }

    case "init":
      return runInit({
        subCommand: args.initSubCommand!,
        network,
        from: args.initFrom,
        force: args.force,
        report,
      });

    case "checkpoint":
      return runCheckpoint({
        network,
        configPath: args.configPath,
        subCommand: args.checkpointSubCommand!,
        fromBlock: args.fromBlock,
        fromLatest: args.fromLatest,
        clear: args.clear,
        report,
      });

    case "prune":
      return runPrune({
        network,
        // Default cutoff: 1h. parseDuration throws on malformed input,
        // surfacing a clear error rather than silently using the default.
        maxAgeMs: args.maxAge !== undefined ? parseDuration(args.maxAge) : 60 * 60 * 1_000,
        dryRun: args.dryRun,
        report,
      });

    case "reset":
      report(`reset: deleting all feeder-generated state for network=${network}`);
      await cleanFeederState(network, report);
      report(`reset: complete — re-seed with 'checkpoint set --from-latest' before starting`);
      return 0;
  }
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP_TEXT}`);
    process.exit(2);
  }

  const code = await dispatch(args);
  process.exit(code);
}

main().catch((error) => {
  process.stderr.write(`[feeder] fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
