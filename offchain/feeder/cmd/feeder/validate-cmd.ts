// `--validate-only` command implementation.
//
// Loads the modular config for the active network, runs the validator,
// prints every issue and a one-line summary, and returns an exit code:
//   0  no error-severity issues
//   1  at least one error-severity issue
//
// Warnings never fail validation; they are surfaced so an operator can
// notice them before the daemon starts.
//
// Load-time errors (filesystem, YAML parse, ABI parse) are caught here
// and presented as a single error-severity `ValidationIssue` so the
// operator-facing output is uniform with the semantic validator's
// output. The structured error from the loader carries enough context
// (file path + key) to point straight at the broken fragment.

import {
  loadModularConfig,
  validateModularConfig,
  type ModularConfig,
  type ValidationIssue,
} from "../../src/config/index.js";

export type ValidateCmdOptions = {
  configPath: string;
  network: "Preview" | "Mainnet";
  report: (line: string) => void;
};

export async function runValidateOnly(options: ValidateCmdOptions): Promise<number> {
  const { configPath, network, report } = options;
  report(`validating config at ${configPath} for network=${network}...`);

  const loadResult = await tryLoad(configPath, network);
  if (!loadResult.ok) {
    report(formatIssue(loadResult.issue));
    report(`validation: 1 error(s), 0 warning(s).`);
    return 1;
  }

  const config = loadResult.config;
  const issues = validateModularConfig(config);
  for (const issue of issues) {
    report(formatIssue(issue));
  }
  report(formatLoadedCounts(config));
  report(formatValidationSummary(issues));

  return issues.some((i) => i.severity === "error") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LoadResult =
  | { ok: true; config: ModularConfig }
  | { ok: false; issue: ValidationIssue };

async function tryLoad(configPath: string, network: "Preview" | "Mainnet"): Promise<LoadResult> {
  try {
    const config = await loadModularConfig({ baseDir: configPath, network });
    return { ok: true, config };
  } catch (error) {
    return {
      ok: false,
      issue: {
        severity: "error",
        path: "(load)",
        message: (error as Error).message,
      },
    };
  }
}

function formatIssue(issue: ValidationIssue): string {
  const tag = issue.severity === "error" ? "ERROR" : "WARN ";
  const where = issue.path || "(root)";
  return `[${tag}] ${where}: ${issue.message}`;
}

function formatLoadedCounts(config: ModularConfig): string {
  const counts = {
    chains: Object.keys(config.chains).length,
    contracts: Object.keys(config.contracts).length,
    events: Object.keys(config.event_definitions).length,
    routers: Object.keys(config.routers).length,
    enabledRouters: Object.values(config.routers).filter((r) => r.enabled).length,
  };
  return `loaded ${counts.chains} chain(s), ${counts.contracts} contract(s), ${counts.events} event def(s), ${counts.routers} router(s) (${counts.enabledRouters} enabled).`;
}

function formatValidationSummary(issues: ValidationIssue[]): string {
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  return `validation: ${errorCount} error(s), ${warningCount} warning(s).`;
}
