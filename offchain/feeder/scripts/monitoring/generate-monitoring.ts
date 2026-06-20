// Monitoring threshold GENERATOR — writes the operational thresholds from
// `config/infrastructure.<network>.yaml::alerting.*` (the single source of
// truth) INTO the Prometheus rules (`monitoring/alerts.yml`) and the Grafana
// dashboard (`monitoring/grafana/dashboards/feeder.json`).
//
// WHY THIS EXISTS
// ---------------
// The threshold-drift test (src/config/__tests__/threshold-drift.test.ts) is
// the CI guard that FAILS when alerts.yml / feeder.json diverge from the YAML.
// This script is the other half: instead of hand-editing the monitoring files
// to match the YAML and waiting for the test to catch a mistake, it edits them
// FOR you — `make generate-monitoring` (and, automatically, `make up`) rewrites
// the numbers so Prometheus/Grafana always load values that match the YAML.
//
// USAGE (from offchain/feeder/):
//   node --import tsx/esm scripts/monitoring/generate-monitoring.ts [--network preview|mainnet]
// Network resolution (first non-empty wins):
//   1. --network <name> CLI flag
//   2. CARDANO_NETWORK env var (the same selector the daemon + Makefile read)
//   3. default: preview
// The name is lowercased to pick config/infrastructure.<network>.yaml, matching
// the on-disk file names (infrastructure.preview.yaml / infrastructure.mainnet.yaml).
//
// HOW IT EDITS (and why it does NOT round-trip the files through a parser)
// -----------------------------------------------------------------------
// Re-emitting alerts.yml from a YAML parser or feeder.json from JSON.stringify
// would destroy the extensive operator-facing comments / prose / hand-tuned
// formatting in those files. Instead this script does IN-PLACE NUMERIC
// SUBSTITUTION: it locates the exact number to change (the operand of an
// alert's final `<`/`>` comparison, the "<N> ADA" / "<N>%" prose, and the
// specific dashboard `thresholds.steps` value) and rewrites only that number,
// leaving every other byte untouched. Running twice produces no diff
// (idempotent) because the second run substitutes the same values back in.
//
// The alert→YAML-key→divisor mapping below is the SAME encoding the drift test
// uses (lovelace keys are divided by 1e6 to compare/display in ADA; seconds and
// percent are used verbatim). Keep the two in sync: a new alerting key needs an
// entry here AND in the drift test's ALERT_TO_YAML.

import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";
import { parse as parseYaml } from "yaml";

// scripts/monitoring → scripts → feeder root (2 levels up).
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const FEEDER_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

const ALERTS_FILE = path.join(FEEDER_ROOT, "monitoring", "alerts.yml");
const DASHBOARD_FILE = path.join(FEEDER_ROOT, "monitoring", "grafana", "dashboards", "feeder.json");
const ALERTMANAGER_FILE = path.join(FEEDER_ROOT, "monitoring", "alertmanager.yml");

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

type Alerting = Record<string, number>;

function loadAlerting(network: string): Alerting {
  const file = path.join(FEEDER_ROOT, "config", `infrastructure.${network}.yaml`);
  if (!fs.existsSync(file)) {
    process.stderr.write(
      `[generate-monitoring] error: config not found: ${file}\n` +
        `  (network "${network}" — expected config/infrastructure.${network}.yaml)\n`,
    );
    process.exit(1);
  }
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as {
    infrastructure?: { alerting?: Alerting };
  };
  const alerting = doc.infrastructure?.alerting;
  if (!alerting) {
    process.stderr.write(`[generate-monitoring] error: ${file} has no infrastructure.alerting block\n`);
    process.exit(1);
  }
  return alerting;
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
// Mapping: alert name -> { yamlKey, divisor }. divisor 1e6 means the alert
// divides a lovelace metric by 1_000_000 and compares/displays in ADA; divisor
// 1 means the value is used verbatim (seconds / percent / count). This MUST
// stay in lockstep with the drift test's ALERT_TO_YAML.
// ---------------------------------------------------------------------------
// A threshold operand is either one YAML key (divided by `divisor`) or the
// PRODUCT of two keys (e.g. a per-provider daily quota × a warn ratio).
type ThresholdSpec =
  | { yamlKey: string; divisor: number }
  | { product: [string, string]; divisor: number };

const ALERT_TO_YAML: Record<string, ThresholdSpec> = {
  OraclePairStale: { yamlKey: "oracle_pair_stale_seconds", divisor: 1 },
  ReceiverBalanceLow: { yamlKey: "receiver_balance_low_lovelace", divisor: 1_000_000 },
  SettleOverdue: { yamlKey: "settle_overdue_lovelace", divisor: 1_000_000 },
  PaymentHookWithdrawReady: { yamlKey: "payment_hook_withdraw_ready_lovelace", divisor: 1_000_000 },
  AdminWalletLow: { yamlKey: "admin_wallet_low_lovelace", divisor: 1_000_000 },
  AdminWalletFragmented: { yamlKey: "admin_wallet_min_collateral_lovelace", divisor: 1_000_000 },
  PriceDeviationHigh: { yamlKey: "price_deviation_high_percent", divisor: 1 },
  PriceAgeHigh: { yamlKey: "price_age_high_seconds", divisor: 1 },
  ReorgRateHigh: { yamlKey: "reorg_rate_high_per_hour", divisor: 1 },
  ReceiverDepositsPending: { yamlKey: "deposit_pending_merge_lovelace", divisor: 1_000_000 },
  PrimaryProviderDown: { yamlKey: "provider_primary_unhealthy_seconds", divisor: 1 },
  SecondaryProviderDown: { yamlKey: "provider_secondary_unhealthy_seconds", divisor: 1 },
  ProviderErrorRateHigh: { yamlKey: "provider_error_rate_warn_ratio", divisor: 1 },
  ProviderRequestQuotaHighBlockfrost: {
    product: ["provider_request_quota_per_day_blockfrost", "provider_request_quota_warn_ratio"],
    divisor: 1,
  },
  ProviderRequestQuotaHighKoios: {
    product: ["provider_request_quota_per_day_koios", "provider_request_quota_warn_ratio"],
    divisor: 1,
  },
};

/** The YAML keys a spec reads (one, or the two product factors). */
function specKeys(spec: ThresholdSpec): string[] {
  return "yamlKey" in spec ? [spec.yamlKey] : spec.product;
}

/** Resolve a spec to its numeric operand from the alerting block. */
function resolveSpec(spec: ThresholdSpec, alerting: Alerting): number {
  if ("yamlKey" in spec) return alerting[spec.yamlKey]! / spec.divisor;
  return (alerting[spec.product[0]]! * alerting[spec.product[1]]!) / spec.divisor;
}

// Alerts whose summary/description prose names the threshold as "<N> ADA".
// (Lovelace-denominated alerts only; verbatim alerts state the raw number.)
const ADA_PROSE_ALERTS = new Set([
  "ReceiverBalanceLow",
  "SettleOverdue",
  "PaymentHookWithdrawReady",
  "AdminWalletLow",
  "ReceiverDepositsPending",
]);

// ---------------------------------------------------------------------------
// alerts.yml — in-place patch of each alert's expr comparison operand and its
// ADA / percent prose.
// ---------------------------------------------------------------------------

/** Format a number the way the alert files write it: plain decimal, no
 *  trailing zeros (5, 2.5), matching how the YAML thresholds read after
 *  dividing lovelace by 1e6. */
function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** Escape a number for use as a literal inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite a single alert block in alerts.yml:
 *   - the operand of the FINAL `<`/`>` comparison in the `expr:` field
 *   - every "<old> ADA" → "<new> ADA" (ADA-denominated alerts)
 *   - every "<old>%"     → "<new>%"   (PriceDeviationHigh only)
 * Substitutions are scoped to the alert's own block (from `- alert: <name>`
 * up to the next `- alert:` or EOF) so a number in one alert never bleeds into
 * another.
 */
function patchAlertsYaml(text: string, alerting: Alerting): string {
  let out = text;
  for (const [alert, spec] of Object.entries(ALERT_TO_YAML)) {
    for (const key of specKeys(spec)) {
      if (alerting[key] === undefined) {
        process.stderr.write(`[generate-monitoring] error: alerting.${key} missing (alert ${alert})\n`);
        process.exit(1);
      }
    }
    const value = resolveSpec(spec, alerting);
    const valueStr = fmt(value);

    // Isolate this alert's block so substitutions stay local.
    const blockRe = new RegExp(`(- alert:\\s*${reEscape(alert)}\\b[\\s\\S]*?)(?=\\n\\s*- alert:|$)`);
    const m = out.match(blockRe);
    if (!m) {
      process.stderr.write(`[generate-monitoring] error: alerts.yml has no alert block: ${alert}\n`);
      process.exit(1);
    }
    let block = m[1]!;

    // 1) expr comparison operand: replace the number after the LAST `<`/`>`.
    block = block.replace(
      /([<>]\s*)([0-9]+(?:\.[0-9]+)?)(?![\s\S]*[<>]\s*[0-9])/,
      (_full, op: string) => `${op}${valueStr}`,
    );

    // 2) ADA prose — ONLY the threshold-stating phrases. Every ADA alert
    //    states its threshold as "below/above/over <N> ADA" (in the summary and
    //    in the "alert fires …" description line). We anchor on those
    //    prepositions so unrelated "<N> ADA" mentions in the same block — e.g.
    //    the lovelace-conversion example "(5000000 = 5 ADA)" or a top-up amount
    //    "Top it up with 5 ADA" — are left untouched.
    if (ADA_PROSE_ALERTS.has(alert)) {
      block = block.replace(
        /\b(below|above|over)(\s+)[0-9]+(?:\.[0-9]+)?(\s*ADA\b)/gi,
        (_f, prep: string, gap: string, suffix: string) => `${prep}${gap}${valueStr}${suffix}`,
      );
    }
    // 3) percent prose (PriceDeviationHigh: "more than 5%", "above 5%").
    if (alert === "PriceDeviationHigh") {
      block = block.replace(/\b[0-9]+(?:\.[0-9]+)?%/g, `${valueStr}%`);
    }

    out = out.slice(0, m.index!) + block + out.slice(m.index! + m[1]!.length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// feeder.json — in-place patch of the specific panel `thresholds.steps` values.
// Each entry names the panel by title, the threshold step color to rewrite, the
// YAML key + divisor. For panels whose threshold lives in a per-series override
// (matched `byName`), `override` carries that series name.
// ---------------------------------------------------------------------------
type PanelStepTarget = {
  panelTitle: string;
  color: string;
  yamlKey: string;
  divisor: number;
  override?: string;
};

const PANEL_STEPS: PanelStepTarget[] = [
  { panelTitle: "Pair staleness (per symbol)", color: "red", yamlKey: "oracle_pair_stale_seconds", divisor: 1 },
  { panelTitle: "Price data age p95 — 1 h window (per routed pair)", color: "red", yamlKey: "price_age_high_seconds", divisor: 1 },
  { panelTitle: "Price deviation p95 — 1 h window (per pair)", color: "red", yamlKey: "price_deviation_high_percent", divisor: 1 },
  { panelTitle: "Reorg counter", color: "red", yamlKey: "reorg_rate_high_per_hour", divisor: 1 },
  { panelTitle: "Receiver balance — ADA (per client)", color: "yellow", yamlKey: "receiver_balance_low_lovelace", divisor: 1_000_000 },
  { panelTitle: "Deposit pending — ADA (per client)", color: "yellow", yamlKey: "deposit_pending_merge_lovelace", divisor: 1_000_000 },
  { panelTitle: "Admin wallet • PaymentHook • Receiver accrued — ADA", color: "green", yamlKey: "admin_wallet_low_lovelace", divisor: 1_000_000 },
  { panelTitle: "Admin wallet • PaymentHook • Receiver accrued — ADA", color: "yellow", yamlKey: "payment_hook_withdraw_ready_lovelace", divisor: 1_000_000, override: "PaymentHook accrued" },
  { panelTitle: "Admin wallet • PaymentHook • Receiver accrued — ADA", color: "yellow", yamlKey: "settle_overdue_lovelace", divisor: 1_000_000, override: "Receiver accrued (sum)" },
  { panelTitle: "Admin wallet — largest UTxO — ADA (collateral floor)", color: "green", yamlKey: "admin_wallet_min_collateral_lovelace", divisor: 1_000_000 },
];

/**
 * Patch one threshold step value inside the dashboard JSON text. The dashboard
 * is hand-formatted (aligned step objects with trailing comments), so we cannot
 * JSON.parse → JSON.stringify without losing formatting. We instead find the
 * panel by its "title", then within its slice rewrite the value of the step
 * object carrying the requested color.
 *
 * For an override threshold (per-series, matched `byName`), we first narrow to
 * the override's slice (delimited by its `"matcher": { ... "options": "<name>"`)
 * so the default-thresholds steps of the same color are not touched.
 */
function patchDashboardStep(text: string, target: PanelStepTarget, value: number): string {
  // Locate the panel slice: from its `"title": "<panelTitle>"` backwards to the
  // opening of that panel object, forwards to the next panel title. Simpler and
  // robust: operate on the region between this panel's title and the previous
  // one. The thresholds appear BEFORE the title in each panel object, so we
  // bound the search region as [end of previous panel title .. this title].
  const titleNeedle = `"title": ${JSON.stringify(target.panelTitle)}`;
  const titleIdx = text.indexOf(titleNeedle);
  if (titleIdx < 0) {
    process.stderr.write(`[generate-monitoring] error: dashboard panel not found: "${target.panelTitle}"\n`);
    process.exit(1);
  }
  // Region start: the panel's own object start is after the previous `},\n    {`.
  // Find the last "{" that begins this panel by scanning back for `\n    {`.
  const panelStart = text.lastIndexOf("\n    {", titleIdx);
  const regionStart = panelStart >= 0 ? panelStart : 0;

  let searchStart = regionStart;
  let searchEnd = titleIdx;

  if (target.override) {
    // Narrow to the override block: from its matcher options to the end of its
    // properties value (the next `}` chain). We bound it to the slice between
    // the matcher line and the following override's matcher (or the title).
    const matcherNeedle = `"options": ${JSON.stringify(target.override)}`;
    const matcherIdx = text.indexOf(matcherNeedle, regionStart);
    if (matcherIdx < 0 || matcherIdx > titleIdx) {
      process.stderr.write(
        `[generate-monitoring] error: panel "${target.panelTitle}" has no override series "${target.override}"\n`,
      );
      process.exit(1);
    }
    searchStart = matcherIdx;
    // End at the NEXT override matcher within this panel, else at the title.
    const nextMatcher = text.indexOf(`"matcher":`, matcherIdx + matcherNeedle.length);
    searchEnd = nextMatcher >= 0 && nextMatcher < titleIdx ? nextMatcher : titleIdx;
  }

  const region = text.slice(searchStart, searchEnd);
  // Rewrite the value of the step object with the requested color. Step objects
  // look like: { "color": "yellow", "value": 5 }  (value may be a number or null).
  const stepRe = new RegExp(
    `("color":\\s*"${reEscape(target.color)}"\\s*,\\s*"value":\\s*)(null|-?[0-9]+(?:\\.[0-9]+)?)`,
  );
  if (!stepRe.test(region)) {
    process.stderr.write(
      `[generate-monitoring] error: panel "${target.panelTitle}"` +
        `${target.override ? ` override "${target.override}"` : ""} has no "${target.color}" threshold step\n`,
    );
    process.exit(1);
  }
  const patchedRegion = region.replace(stepRe, (_f, prefix: string) => `${prefix}${fmt(value)}`);
  return text.slice(0, searchStart) + patchedRegion + text.slice(searchEnd);
}

function patchDashboard(text: string, alerting: Alerting): string {
  let out = text;
  for (const target of PANEL_STEPS) {
    const raw = alerting[target.yamlKey];
    if (raw === undefined) {
      process.stderr.write(`[generate-monitoring] error: alerting.${target.yamlKey} missing (panel "${target.panelTitle}")\n`);
      process.exit(1);
    }
    out = patchDashboardStep(out, target, raw / target.divisor);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main — read YAML, patch both files in place, report what changed.
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
  const alerting = loadAlerting(network);
  process.stdout.write(`[generate-monitoring] network=${network} (config/infrastructure.${network}.yaml)\n`);

  const alertsNext = patchAlertsYaml(fs.readFileSync(ALERTS_FILE, "utf8"), alerting);
  writeIfChanged(ALERTS_FILE, alertsNext, "monitoring/alerts.yml");

  const dashNext = patchDashboard(fs.readFileSync(DASHBOARD_FILE, "utf8"), alerting);
  // Guard: the result must still be valid JSON (catches a bad substitution).
  try {
    JSON.parse(dashNext);
  } catch (e) {
    process.stderr.write(`[generate-monitoring] error: patched dashboard is not valid JSON: ${(e as Error).message}\n`);
    process.exit(1);
  }
  writeIfChanged(DASHBOARD_FILE, dashNext, "monitoring/grafana/dashboards/feeder.json");

  const amNext = buildAlertmanagerYaml(loadNotifications(network));
  writeIfChanged(ALERTMANAGER_FILE, amNext, "monitoring/alertmanager.yml");
}

main();
