// `feeder init client` — one-time setup wizard. State lives at
// ../state/<network>_run_<id>/ (offchain/state); the CLI and the feeder both
// use that tree. This generates config/routers/<network>/<id>.yaml pointing the
// daemon at the client's state (../state/<run>/clients/<id>.json).
//
// Run from offchain/feeder/. The auto-scan looks under ../state/ for
// <network>_run_* dirs, newest first; it uses the only match, prompts when
// several exist, or takes --from <path>. The daemon selects the run via RUN_ID
// (or the newest run dir) — see cmd/feeder/run-state.ts.

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import { join, basename, extname, dirname } from "node:path";

import { DEFAULT_INIT_PAIRS } from "../../src/config/constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type InitCmdOptions = {
  network: string;
  from?: string;
  force: boolean;
  report: (line: string) => void;
};

export async function runInit(options: InitCmdOptions): Promise<number> {
  return runInitClient(options);
}

/**
 * Recover the deployment run id from a CLI state path by finding its
 * `<network>_run_<id>` segment (the CLI run dir). The feeder reuses that id
 * for its own run dir so the two share a deployment identity. Falls back to
 * the RUN_ID env; returns null if neither is available so the caller errors
 * rather than invent a run id divorced from the deployment.
 */
function runIdFromSourcePath(sourcePath: string, networkLower: string): string | null {
  const prefix = `${networkLower}_run_`;
  for (const segment of sourcePath.split(/[\\/]+/)) {
    if (segment.startsWith(prefix)) {
      return segment.slice(prefix.length);
    }
  }
  return process.env.RUN_ID?.trim() || null;
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
      const candidates = await findConfigClientCandidates(networkLower);
      if (candidates.length === 0) {
        report(`init client: no client JSONs found under ../state/`);
        report(`init client: hint: run from offchain/feeder/, or use --from <client.json>`);
        return 1;
      }
      if (candidates.length === 1) {
        sourcePath = candidates[0];
        out(`  Found: ${candidates[0]}`);
      } else {
        sourcePath = await selectOne(rl, "Multiple client JSONs found (newest first) — Enter takes the newest, or pick a number:", candidates);
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

    // --- Step 3: locate the client's state in the run dir. The router YAML
    // generated below points the daemon at this path. ---
    const runId = runIdFromSourcePath(sourcePath, networkLower);
    if (!runId) {
      report(`init client: could not determine the run id from ${sourcePath}.`);
      return 1;
    }
    const runDir = `../state/${networkLower}_run_${runId}`;
    const clientStatePath = `${runDir}/clients/${clientId}.json`;

    // --- Step 4: interactive router YAML generation ---
    out(`\n  Now let's configure the router for ${clientId} on Cardano ${network}.\n`);

    const routerId = `${clientId.replace(/-/g, "_")}_${networkLower}`;
    const routerTarget = `config/routers/${networkLower}/${clientId}.yaml`;

    const existingPairs = await loadExistingPairsFromYaml(routerTarget);
    const pairPool: string[] =
      existingPairs.length > 0 ? existingPairs : [...DEFAULT_INIT_PAIRS];
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
    const customer     = await askText(rl, "  Customer — business client that groups this router (defaults to the client id)", clientId);
    const timeThresh   = await askText(rl, "  Heartbeat — max time between updates; the cron pushes at least this often (e.g. 5m, 10m)", "10m");
    const priceDevRaw  = await askText(rl, "  Price deviation to push early (e.g. 0.1%, 0.5%)", "0.1%");
    const priceDev     = priceDevRaw.replace(/"/g, "");

    const yaml = buildRouterYaml({
      routerId,
      clientId,
      customer,
      network: network as "Preview" | "Mainnet",
      keyEnv,
      pairs: activePairs,
      clientStatePath,
      protocolStatePath: `${runDir}/config-bootstrap.json`,
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

    out(`\n  All done (run id ${runId}). Start the feeder for THIS run:`);
    out(`    Docker:  make up RUN_ID=${runId} MONITORING=1     (from offchain/)`);
    out(`    Local:   RUN_ID=${runId} npm run feeder:dev -- daemon  (from offchain/feeder/)`);
    out(`  Without RUN_ID the feeder picks the newest ../state/${networkLower}_run_* dir.`);
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
  customer: string;
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
    customer: ${opts.customer}
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
          client_state_path: ${opts.clientStatePath}
          protocol_state_path: ${opts.protocolStatePath}
        # Push an update as soon as the price moves at least this much.
        price_deviation: "${opts.priceDeviation}"
        # The cron heartbeat guarantees an update at least this often (the max
        # staleness per pair), even when the price is flat. Needs cron: true below.
        time_threshold: ${opts.timeThreshold}
        # Enable the cron liveness heartbeat for this destination (Spectra parity);
        # without it, a flat pair would only update on price deviation and could
        # stay stale past time_threshold.
        cron: true
`;
}

// ---------------------------------------------------------------------------
// State discovery
// ---------------------------------------------------------------------------

export async function findConfigClientCandidates(
  networkLower: string,
  stateDir = "../state",
): Promise<string[]> {
  const prefix = networkLower === "mainnet" ? "mainnet_run_" : "preview_run_";
  const hits: string[] = [];
  try {
    const runDirs = await readdir(stateDir, { withFileTypes: true });
    for (const rd of runDirs) {
      if (!rd.isDirectory() || !rd.name.startsWith(prefix)) continue;
      const clientsDir = join(stateDir, rd.name, "clients");
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
    // no stateDir
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
