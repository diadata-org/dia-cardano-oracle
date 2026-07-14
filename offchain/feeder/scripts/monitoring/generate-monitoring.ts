// Monitoring threshold GENERATOR (CLI) — writes the operational thresholds from
// `config/infrastructure.<network>.yaml` (the single source of truth) INTO that
// network's own monitoring directory: the Prometheus rules
// (`monitoring/<network>/alerts.yml`), the Grafana dashboards
// (`monitoring/<network>/dashboards/*.json`), and the Alertmanager routing
// config (`monitoring/<network>/alertmanager.yml`).
//
// Each network has its OWN committed monitoring directory (monitoring/preview/,
// monitoring/mainnet/), so preview and mainnet carry independent thresholds and
// neither ever overwrites the other. docker-compose mounts the active network's
// directory (selected by CARDANO_NETWORK). The prometheus.yml scrape config and
// the Grafana provisioning are network-agnostic and stay shared under
// `monitoring/`.
//
// This is the I/O + CLI half. The pure string transforms it drives live in
// `src/alerting/monitoring-rendering.ts`, shared with the threshold-drift test
// so the two can never encode the thresholds differently. See that module's
// header for HOW the in-place numeric substitution works and WHY the files are
// not round-tripped through a parser.
//
// USAGE (from offchain/feeder/):
//   node --import tsx/esm scripts/monitoring/generate-monitoring.ts [--network preview|mainnet]
// Network resolution (first non-empty wins):
//   1. --network <name> CLI flag
//   2. CARDANO_NETWORK env var (the same selector the daemon + Makefile read)
//   3. default: preview
// The name is lowercased to pick config/infrastructure.<network>.yaml AND the
// monitoring/<network>/ directory, matching the on-disk names (preview / mainnet).

import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  type Alerting,
  type WalletBlock,
  patchAlertsYaml,
  patchWalletAlerts,
  patchDashboard,
  PANEL_STEPS,
  INTERNALS_PANEL_STEPS,
} from "../../src/alerting/monitoring-rendering.js";

// scripts/monitoring → scripts → feeder root (2 levels up).
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const FEEDER_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** The four monitoring files a network renders, all under monitoring/<network>/. */
function monitoringFiles(network: string): {
  alerts: string;
  dashboard: string;
  internals: string;
  alertmanager: string;
} {
  const netDir = path.join(FEEDER_ROOT, "monitoring", network);
  return {
    alerts: path.join(netDir, "alerts.yml"),
    dashboard: path.join(netDir, "dashboards", "feeder.json"),
    internals: path.join(netDir, "dashboards", "feeder-internals.json"),
    alertmanager: path.join(netDir, "alertmanager.yml"),
  };
}

// ---------------------------------------------------------------------------
// Network resolution: --network flag > CARDANO_NETWORK env > preview.
// ---------------------------------------------------------------------------
function resolveNetwork(): string {
  const argv = process.argv.slice(2);
  const flagIndex = argv.findIndex((a) => a === "--network" || a === "-n");
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1]!.trim().toLowerCase();
  }
  const inline = argv.find((a) => a.startsWith("--network="));
  if (inline) return inline.slice("--network=".length).trim().toLowerCase();
  const env = process.env["CARDANO_NETWORK"]?.trim().toLowerCase();
  if (env) return env;
  return "preview";
}

function loadAlerting(network: string): Alerting {
  const file = path.join(FEEDER_ROOT, "config", `infrastructure.${network}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `config not found: ${file} (network "${network}" — expected config/infrastructure.${network}.yaml)`,
    );
  }
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as {
    infrastructure?: { alerting?: Alerting };
  };
  const alerting = doc.infrastructure?.alerting;
  if (!alerting) {
    throw new Error(`${file} has no infrastructure.alerting block`);
  }
  return alerting;
}

// The per-wallet alerts (PoolWalletLow / MainWalletCannotFundPool /
// WalletConcentrated) read their thresholds from the `wallet_pool` and
// `wallet_shape` blocks rather than `alerting.*`. Load them the same way so
// they, too, are rendered per network.
function loadWalletBlock(network: string, block: "wallet_pool" | "wallet_shape"): WalletBlock {
  const file = path.join(FEEDER_ROOT, "config", `infrastructure.${network}.yaml`);
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as {
    infrastructure?: Record<string, WalletBlock | undefined>;
  };
  const b = doc.infrastructure?.[block];
  if (!b) {
    throw new Error(`${file} has no infrastructure.${block} block`);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Alertmanager config generation — channels from infrastructure.<network>.yaml
// ::notifications; secrets are NOT written here (they are mounted as files from
// `.env` by docker-compose). The feeder webhook is always on (records every
// alert to alert_log + logs); Telegram / email are added only when enabled.
// ---------------------------------------------------------------------------
type NotificationsCfg = {
  telegram?: { enabled?: boolean; chat_id?: string | number };
  email?: { enabled?: boolean; to?: string[]; from?: string; smarthost?: string };
};

function loadNotifications(network: string): NotificationsCfg {
  const file = path.join(FEEDER_ROOT, "config", `infrastructure.${network}.yaml`);
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as {
    infrastructure?: { notifications?: NotificationsCfg };
  };
  return doc.infrastructure?.notifications ?? {};
}

function buildAlertmanagerYaml(n: NotificationsCfg): string {
  const lines: string[] = [
    "# GENERATED by scripts/monitoring/generate-monitoring.ts — DO NOT EDIT BY HAND.",
    "# Channels come from `infrastructure.<network>.yaml::notifications`; secrets come",
    "# from `.env` (mounted as files by docker-compose). Re-run `make generate-monitoring`",
    "# (or `make up`) after changing either. The feeder webhook is always on so every",
    "# firing/resolved alert is recorded in alert_log + the logs.",
    "",
    "route:",
    "  receiver: default",
    '  group_by: ["alertname", "symbol"]',
    "  group_wait: 30s",
    "  group_interval: 5m",
    "  repeat_interval: 4h",
    "",
    "receivers:",
    "  - name: default",
    "    webhook_configs:",
    "      - url: http://feeder-sqlite:8080/api/v1/alerts/ingest",
    "        send_resolved: true",
  ];
  if (n.telegram?.enabled) {
    lines.push(
      "    telegram_configs:",
      "      - bot_token_file: /etc/alertmanager/secrets/telegram-token",
      `        chat_id: ${Number(n.telegram.chat_id ?? 0)}`,
      "        send_resolved: true",
    );
  }
  if (n.email?.enabled) {
    lines.push(
      "    email_configs:",
      `      - to: ${JSON.stringify((n.email.to ?? []).join(", "))}`,
    );
    if (n.email.from) lines.push(`        from: ${JSON.stringify(n.email.from)}`);
    if (n.email.smarthost) lines.push(`        smarthost: ${JSON.stringify(n.email.smarthost)}`);
    lines.push(
      "        auth_password_file: /etc/alertmanager/secrets/smtp-password",
      "        send_resolved: true",
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main — read the network YAML, render every monitoring file in place, report
// what changed. Any rendering error (missing key, unlocatable alert/panel/step,
// invalid JSON result) is thrown by the rendering functions and reported here.
// ---------------------------------------------------------------------------
function writeIfChanged(file: string, next: string, label: string): boolean {
  const prev = fs.readFileSync(file, "utf8");
  if (prev === next) {
    process.stdout.write(`[generate-monitoring] ${label}: already up to date\n`);
    return false;
  }
  fs.writeFileSync(file, next);
  process.stdout.write(`[generate-monitoring] ${label}: updated\n`);
  return true;
}

function main(): void {
  const network = resolveNetwork();
  const files = monitoringFiles(network);
  process.stdout.write(`[generate-monitoring] network=${network} (config/infrastructure.${network}.yaml -> monitoring/${network}/)\n`);

  try {
    const alerting = loadAlerting(network);
    const walletPool = loadWalletBlock(network, "wallet_pool");
    const walletShape = loadWalletBlock(network, "wallet_shape");

    const alertsBase = patchAlertsYaml(fs.readFileSync(files.alerts, "utf8"), alerting);
    const alertsNext = patchWalletAlerts(alertsBase, walletPool, walletShape);
    writeIfChanged(files.alerts, alertsNext, `monitoring/${network}/alerts.yml`);

    for (const [file, steps, label] of [
      [files.dashboard, PANEL_STEPS, `monitoring/${network}/dashboards/feeder.json`],
      [files.internals, INTERNALS_PANEL_STEPS, `monitoring/${network}/dashboards/feeder-internals.json`],
    ] as const) {
      const dashNext = patchDashboard(fs.readFileSync(file, "utf8"), alerting, steps);
      // Guard: the result must still be valid JSON (catches a bad substitution).
      try {
        JSON.parse(dashNext);
      } catch (e) {
        throw new Error(`patched ${label} is not valid JSON: ${(e as Error).message}`);
      }
      writeIfChanged(file, dashNext, label);
    }

    const amNext = buildAlertmanagerYaml(loadNotifications(network));
    writeIfChanged(files.alertmanager, amNext, `monitoring/${network}/alertmanager.yml`);
  } catch (e) {
    process.stderr.write(`[generate-monitoring] error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

main();
