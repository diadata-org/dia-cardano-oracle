// `feeder init` — one-time setup wizard.
//
// Sub-commands:
//   init bootstrap   Copy config-bootstrap.json from a CLI state dir into
//                    the feeder's state/<network>/ directory.
//   init client      Copy a client JSON from a CLI state dir, then run an
//                    interactive wizard to generate config/routers/<id>.<network>.yaml.
//
// Run from offchain/feeder/ (the feeder working directory). The auto-scan
// looks for CLI state dirs at ../cli/state/ relative to cwd.

import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { join, basename, extname, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type InitCmdOptions = {
  subCommand: "bootstrap" | "client";
  network: string;
  from?: string;
  force: boolean;
  report: (line: string) => void;
};

export async function runInit(options: InitCmdOptions): Promise<number> {
  if (options.subCommand === "bootstrap") {
    return runInitBootstrap(options);
  }
  return runInitClient(options);
}

// ---------------------------------------------------------------------------
// init bootstrap
// ---------------------------------------------------------------------------

async function runInitBootstrap(options: InitCmdOptions): Promise<number> {
  const { network, from, force, report } = options;
  const networkLower = network.toLowerCase();
  const target = `state/${networkLower}/config-bootstrap.json`;

  report(`init bootstrap: network=${network}`);

  const rl = openRl();
  try {
    let sourcePath: string;
    if (from) {
      sourcePath = from.endsWith(".json") ? from : join(from, "config-bootstrap.json");
    } else {
      const candidates = await findCliBootstrapCandidates(networkLower);
      if (candidates.length === 0) {
        report(`init bootstrap: no CLI state dirs found under ../cli/state/`);
        report(`init bootstrap: hint: run from offchain/feeder/, or use --from <path>`);
        return 1;
      }
      if (candidates.length === 1) {
        sourcePath = candidates[0];
        out(`  Found: ${candidates[0]}`);
      } else {
        sourcePath = await selectOne(rl, "Multiple CLI state dirs found — select one:", candidates);
      }
    }

    if (!await fileExists(sourcePath)) {
      report(`init bootstrap: source not found: ${sourcePath}`);
      return 1;
    }

    if (await fileExists(target) && !force) {
      const ok = await askConfirm(rl, `  ${target} already exists. Overwrite?`, false);
      if (!ok) {
        out("  Aborted.");
        return 0;
      }
    }

    await mkdir(dirname(target), { recursive: true });
    await copyFile(sourcePath, target);
    report(`init bootstrap: wrote ${target}`);
    out(`\n  Done. Bootstrap state file ready at ${target}`);
    return 0;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// init client
// ---------------------------------------------------------------------------

async function runInitClient(options: InitCmdOptions): Promise<number> {
  const { network, from, force, report } = options;
  const networkLower = network.toLowerCase();

  report(`init client: network=${network}`);

  const rl = openRl();
  try {
    // --- Step 1: locate source client JSON ---
    let sourcePath: string;
    if (from) {
      sourcePath = from;
    } else {
      const candidates = await findCliClientCandidates(networkLower);
      if (candidates.length === 0) {
        report(`init client: no client JSONs found under ../cli/state/`);
        report(`init client: hint: run from offchain/feeder/, or use --from <client.json>`);
        return 1;
      }
      if (candidates.length === 1) {
        sourcePath = candidates[0];
        out(`  Found: ${candidates[0]}`);
      } else {
        sourcePath = await selectOne(rl, "Multiple client JSONs found — select one:", candidates);
      }
    }

    if (!await fileExists(sourcePath)) {
      report(`init client: source not found: ${sourcePath}`);
      return 1;
    }

    // --- Step 2: read clientId ---
    const clientJson = JSON.parse(await readFile(sourcePath, "utf8")) as { clientId?: string };
    const clientId = clientJson.clientId;
    if (!clientId || typeof clientId !== "string") {
      report(`init client: source file has no clientId field: ${sourcePath}`);
      return 1;
    }

    // --- Step 3: copy client JSON to feeder state ---
    const clientTarget = `state/${networkLower}/clients/${clientId}.json`;
    if (await fileExists(clientTarget) && !force) {
      const ok = await askConfirm(rl, `  ${clientTarget} already exists. Overwrite?`, false);
      if (!ok) {
        out("  Aborted.");
        return 0;
      }
    }
    await mkdir(dirname(clientTarget), { recursive: true });
    await copyFile(sourcePath, clientTarget);
    report(`init client: wrote ${clientTarget}`);

    // --- Step 4: interactive router YAML generation ---
    out(`\n  Now let's configure the router for ${clientId} on Cardano ${network}.\n`);

    const routerId = `${clientId.replace(/-/g, "_")}_${networkLower}`;
    const routerTarget = `config/routers/${clientId}.${networkLower}.yaml`;

    const existingPairs = await loadExistingPairsFromYaml(routerTarget);
    const DEFAULT_PAIRS = [
      "BTC/USD", "ETH/USD", "USDC/USD", "USDT/USD",
      "DOGE/USD", "LTC/USD", "ARB/USD", "SHIB/USD",
      "NEIRO/USD", "XVG/USD",
    ];
    const pairPool = existingPairs.length > 0 ? existingPairs : DEFAULT_PAIRS;
    // All selected by default (select all for new, keep all for re-init)
    const initialSelected = pairPool.map(() => true);

    const activePairs = await askMultiSelect(
      rl,
      "Which pairs to activate?",
      pairPool,
      initialSelected,
    );
    if (activePairs.length === 0) {
      report("init client: no pairs selected. Aborted.");
      return 1;
    }

    const defaultKeyEnv = network === "Mainnet"
      ? "CARDANO_WALLET_SEED_MAINNET"
      : "CARDANO_WALLET_SEED_TESTNET";
    const keyEnv       = await askText(rl, "  Wallet seed env var", defaultKeyEnv);
    const timeThresh   = await askText(rl, "  Min time between updates (e.g. 5m, 1h)", "5m");
    const priceDevRaw  = await askText(rl, "  Price deviation threshold (e.g. 0.1%, 0.5%)", "0.1%");
    const priceDev     = priceDevRaw.replace(/"/g, "");

    const yaml = buildRouterYaml({
      routerId,
      clientId,
      network: network as "Preview" | "Mainnet",
      keyEnv,
      pairs: activePairs,
      clientStatePath: clientTarget,
      protocolStatePath: `state/${networkLower}/config-bootstrap.json`,
      timeThreshold: timeThresh,
      priceDeviation: priceDev,
    });

    // Show preview + confirm overwrite if needed
    out(`\n  Generated router YAML:\n`);
    out("─".repeat(60));
    out(yaml);
    out("─".repeat(60));

    if (await fileExists(routerTarget) && !force) {
      const ok = await askConfirm(rl, `  ${routerTarget} already exists. Overwrite?`, false);
      if (!ok) {
        report("init client: router YAML not written (aborted). Copy the output above manually.");
        return 0;
      }
    }

    await mkdir(dirname(routerTarget), { recursive: true });
    await writeFile(routerTarget, yaml, "utf8");
    report(`init client: wrote ${routerTarget}`);

    out(`\n  All done. Run the feeder:`);
    out(`    npm run feeder:dev`);
    out(`    npm run feeder:dev -- --transport ws`);
    out(``);
    return 0;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Router YAML template
// ---------------------------------------------------------------------------

export function buildRouterYaml(opts: {
  routerId: string;
  clientId: string;
  network: "Preview" | "Mainnet";
  keyEnv: string;
  pairs: string[];
  clientStatePath: string;
  protocolStatePath: string;
  timeThreshold: string;
  priceDeviation: string;
}): string {
  const pairsBlock = opts.pairs.map(p => `            - ${p}`).join("\n");
  return `# Router config — ${opts.clientId} on Cardano ${opts.network}.
# Generated by: feeder init client
# Edit any value and restart the feeder to pick up the change.

routers:
  ${opts.routerId}:
    id: ${opts.routerId}
    name: ${opts.clientId} → Cardano ${opts.network}
    customer: ${opts.clientId}
    type: event
    enabled: true
    # Env var holding the Cardano wallet mnemonic seed (from .env).
    private_key_env: ${opts.keyEnv}

    triggers:
      events:
        - IntentRegistered
      conditions:
        - field: \${enrichment.fullIntent.Symbol}
          operator: in
          value:
${pairsBlock}

    processing:
      datasource: enrichment
      transformations: []
      validationenabled: true

    destinations:
      - cardano:
          network: ${opts.network}
          # Paths to the CLI bootstrap state files (see: feeder init bootstrap/client).
          client_state_path: ${opts.clientStatePath}
          protocol_state_path: ${opts.protocolStatePath}
        # Minimum time between two updates for the same symbol.
        time_threshold: ${opts.timeThreshold}
        # Minimum price change required to trigger an update.
        price_deviation: "${opts.priceDeviation}"
`;
}

// ---------------------------------------------------------------------------
// CLI state discovery
// ---------------------------------------------------------------------------

export async function findCliBootstrapCandidates(
  networkLower: string,
  cliStateDir = "../cli/state",
): Promise<string[]> {
  const prefix = networkLower === "mainnet" ? "mainnet_run_" : "preview_run_";
  try {
    const entries = await readdir(cliStateDir, { withFileTypes: true });
    const hits: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const candidate = join(cliStateDir, e.name, "config-bootstrap.json");
      if (await fileExists(candidate)) hits.push(candidate);
    }
    return hits.sort().reverse(); // newest first
  } catch {
    return [];
  }
}

export async function findCliClientCandidates(
  networkLower: string,
  cliStateDir = "../cli/state",
): Promise<string[]> {
  const prefix = networkLower === "mainnet" ? "mainnet_run_" : "preview_run_";
  const hits: string[] = [];
  try {
    const runDirs = await readdir(cliStateDir, { withFileTypes: true });
    for (const rd of runDirs) {
      if (!rd.isDirectory() || !rd.name.startsWith(prefix)) continue;
      const clientsDir = join(cliStateDir, rd.name, "clients");
      try {
        const files = await readdir(clientsDir, { withFileTypes: true });
        for (const f of files) {
          if (f.isFile() && f.name.endsWith(".json")) {
            hits.push(join(clientsDir, f.name));
          }
        }
      } catch {
        // no clients dir in this run
      }
    }
  } catch {
    // no cliStateDir
  }
  return hits.sort().reverse(); // newest first
}

export async function loadExistingPairsFromYaml(routerYamlPath: string): Promise<string[]> {
  try {
    const content = await readFile(routerYamlPath, "utf8");
    const pairs: string[] = [];
    for (const line of content.split("\n")) {
      const m = line.trim().match(/^-\s+([A-Z0-9]+\/[A-Z0-9]+)$/);
      if (m) pairs.push(m[1]);
    }
    return pairs;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Interactive UI helpers (Node built-in readline/promises — no extra deps)
// ---------------------------------------------------------------------------

function openRl(): Interface {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function askText(rl: Interface, question: string, defaultVal: string): Promise<string> {
  const answer = (await rl.question(`${question} [${defaultVal}]: `)).trim();
  return answer || defaultVal;
}

async function askConfirm(rl: Interface, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function selectOne(rl: Interface, question: string, options: string[]): Promise<string> {
  out(`\n  ${question}`);
  options.forEach((opt, i) => out(`    ${i + 1}. ${opt}`));
  while (true) {
    const raw = (await rl.question("  Select [1]: ")).trim();
    const n = parseInt(raw || "1", 10);
    if (n >= 1 && n <= options.length) return options[n - 1];
    out(`  Enter a number between 1 and ${options.length}.`);
  }
}

async function askMultiSelect(
  rl: Interface,
  question: string,
  options: string[],
  initialSelected: boolean[],
): Promise<string[]> {
  const selected = [...initialSelected];

  const render = (): void => {
    out(`\n  ${question}`);
    options.forEach((opt, i) => {
      const mark = selected[i] ? "✓" : "○";
      out(`    ${i + 1}. [${mark}] ${opt}`);
    });
    out(`  Toggle by number (e.g. 1 3 5), 'all', 'none', or Enter to confirm:`);
  };

  render();
  while (true) {
    const raw = (await rl.question("  > ")).trim().toLowerCase();
    if (!raw) break;
    if (raw === "all")  { selected.fill(true);  render(); continue; }
    if (raw === "none") { selected.fill(false); render(); continue; }
    const nums = raw.split(/[\s,]+/).map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= options.length);
    for (const n of nums) selected[n - 1] = !selected[n - 1];
    render();
  }

  // Allow adding custom pairs
  const result = options.filter((_, i) => selected[i]);
  out(`\n  Current selection: ${result.join(", ")}`);
  while (true) {
    const custom = (await rl.question(`  Add a custom pair (e.g. SOL/USD), or Enter to finish: `))
      .trim()
      .toUpperCase();
    if (!custom) break;
    if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(custom)) {
      out(`  Invalid format. Use SYMBOL/SYMBOL (e.g. SOL/USD).`);
      continue;
    }
    if (!result.includes(custom)) {
      result.push(custom);
      out(`  Added ${custom}. Active: ${result.join(", ")}`);
    } else {
      out(`  ${custom} is already in the list.`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}
