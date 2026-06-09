// Render the "Alerts active during the window" section of the M2 evidence pack
// as markdown, from the canonical alert rules and the live alert state.
//
// Usage (from offchain/feeder/):
//   node --import tsx/esm scripts/m2-evidence/build-alerts.ts <alerts-active.json>
//
// Inputs:
//   monitoring/alerts.yml            — canonical alert rules (catalog + remediation)
//   <alerts-active.json> (argv[2])   — Prometheus /api/v1/alerts snapshot captured at pack time
//
// Output: the markdown section is printed to stdout (the shell captures it).
// Everything degrades gracefully: a missing/empty active snapshot just renders
// "none firing at capture time".

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const FEEDER_ROOT = path.join(import.meta.dirname, "../..");
const ALERTS_YML = path.join(FEEDER_ROOT, "monitoring", "alerts.yml");

type Rule = {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; description?: string };
};

/** Replace Prometheus templating with readable placeholders for the catalog. */
function detemplate(s: string): string {
  return s
    .replace(/\{\{\s*\$labels\.([a-zA-Z_]+)\s*\}\}/g, "<$1>")
    .replace(/\{\{\s*\$value[^}]*\}\}/g, "<value>")
    .trim();
}

/** Last numeric operand of a `<`/`>` comparison in the expr (the threshold). */
function thresholdOf(expr: string): string {
  const matches = [...expr.matchAll(/[<>]\s*([0-9.]+)/g)];
  return matches.length ? matches[matches.length - 1]![1]! : "—";
}

function loadRules(): Rule[] {
  const doc = parseYaml(readFileSync(ALERTS_YML, "utf8")) as {
    groups?: Array<{ rules?: Rule[] }>;
  };
  const rules: Rule[] = [];
  for (const g of doc.groups ?? []) for (const r of g.rules ?? []) if (r.alert) rules.push(r);
  return rules;
}

type ActiveAlert = {
  state?: string;
  value?: string;
  activeAt?: string;
  labels?: Record<string, string>;
};

function loadActive(file: string | undefined): { ok: boolean; alerts: ActiveAlert[] } {
  if (!file) return { ok: false, alerts: [] };
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      status?: string;
      data?: { alerts?: ActiveAlert[] };
    };
    if (doc.status !== "success") return { ok: false, alerts: [] };
    return { ok: true, alerts: doc.data?.alerts ?? [] };
  } catch {
    return { ok: false, alerts: [] };
  }
}

const rules = loadRules();
const active = loadActive(process.argv[2]);

const out: string[] = [];
out.push(
  "Source of truth: [`offchain/feeder/monitoring/alerts.yml`](../../../offchain/feeder/monitoring/alerts.yml).",
  "Canonical thresholds: `infrastructure.<network>.yaml::alerting.*`. Every alert below carries an",
  "exact, copy-pasteable remediation (Docker + npm) in its description.",
  "",
  "### Alert catalog (all rules)",
  "",
  "| Alert | Severity | For | Threshold | Summary |",
  "| --- | --- | --- | --- | --- |",
);
for (const r of rules) {
  const sev = r.labels?.severity ?? "—";
  const dur = r.for ?? "—";
  const thr = r.expr ? thresholdOf(r.expr) : "—";
  const sum = detemplate(r.annotations?.summary ?? "").replace(/\|/g, "\\|");
  out.push(`| ${r.alert} | ${sev} | ${dur} | ${thr} | ${sum} |`);
}

out.push("", "### Active at capture time", "");
if (!active.ok) {
  out.push(
    "_Prometheus alert state could not be captured when this pack was assembled (the monitoring",
    "stack was not reachable). See `alerts-active.json`._",
  );
} else if (active.alerts.length === 0) {
  out.push(
    "No alerts were firing or pending at capture time — all feeds healthy. The raw snapshot is in",
    "[`alerts-active.json`](./alerts-active.json). (Pending/firing transitions over the window are",
    "also recorded in the feeder `alert_log` table — see `db/`.)",
  );
} else {
  out.push(
    "Captured live from Prometheus `/api/v1/alerts` (raw: [`alerts-active.json`](./alerts-active.json)):",
    "",
    "| Alert | State | Key labels | Value | Active since |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const a of active.alerts) {
    const name = a.labels?.["alertname"] ?? "—";
    const labelBits = ["symbol", "client_id", "run_dir"]
      .map((k) => (a.labels?.[k] ? `${k}=${a.labels[k]}` : null))
      .filter(Boolean)
      .join(", ");
    const value = a.value ?? "—";
    const since = a.activeAt ?? "—";
    out.push(`| ${name} | ${a.state ?? "—"} | ${labelBits || "—"} | ${value} | ${since} |`);
  }
}

out.push("", "### Remediation (exact operator commands)", "");
out.push(
  "Each alert's full description from `alerts.yml` — the WHY and the exact Docker + npm commands an",
  "operator runs. Labels shown as `{{ $labels.x }}` are filled in by Prometheus at fire time (the",
  "active table above shows the real values).",
  "",
);
for (const r of rules) {
  const desc = (r.annotations?.description ?? "").trim();
  out.push(`**${r.alert}** — ${detemplate(r.annotations?.summary ?? "")}`, "");
  out.push("```text", desc, "```", "");
}

process.stdout.write(out.join("\n").trimEnd() + "\n");
