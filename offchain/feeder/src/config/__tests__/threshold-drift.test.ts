// Threshold drift guard — enforces that `infrastructure.<network>.yaml::alerting.*`
// is the SINGLE SOURCE OF TRUTH for every operational threshold. It fails when a
// Prometheus rule (monitoring/alerts.yml) or a Grafana panel
// (monitoring/grafana/dashboards/feeder.json) carries a threshold that has
// drifted from the YAML, and when the two network YAMLs disagree (the alerts +
// dashboard are network-agnostic, so both must match the one file).
//
// This is the mechanism that lets the README say "edit the YAML, nothing else
// is the source of truth": any hand-edit that diverges turns this test red.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// src/config/__tests__ -> feeder root
const FEEDER_ROOT = path.join(import.meta.dirname, "../../..");
const read = (rel: string): string => readFileSync(path.join(FEEDER_ROOT, rel), "utf8");

type Alerting = Record<string, number>;

function loadAlerting(networkFile: string): Alerting {
  const doc = parseYaml(read(`config/${networkFile}`)) as {
    infrastructure?: { alerting?: Alerting };
  };
  const alerting = doc.infrastructure?.alerting;
  assert.ok(alerting, `${networkFile}: missing infrastructure.alerting block`);
  return alerting;
}

// alert name -> { yamlKey, divisor }. divisor 1e6 = the expr divides lovelace
// by 1_000_000 and compares in ADA; divisor 1 = the value is used verbatim.
const ALERT_TO_YAML: Record<string, { yamlKey: string; divisor: number }> = {
  OraclePairStale: { yamlKey: "oracle_pair_stale_seconds", divisor: 1 },
  ReceiverBalanceLow: { yamlKey: "receiver_balance_low_lovelace", divisor: 1_000_000 },
  SettleOverdue: { yamlKey: "settle_overdue_lovelace", divisor: 1_000_000 },
  PaymentHookWithdrawReady: { yamlKey: "payment_hook_withdraw_ready_lovelace", divisor: 1_000_000 },
  AdminWalletLow: { yamlKey: "admin_wallet_low_lovelace", divisor: 1_000_000 },
  PriceDeviationHigh: { yamlKey: "price_deviation_high_percent", divisor: 1 },
  PriceAgeHigh: { yamlKey: "price_age_high_seconds", divisor: 1 },
  ReorgRateHigh: { yamlKey: "reorg_rate_high_per_hour", divisor: 1 },
  ReceiverDepositsPending: { yamlKey: "deposit_pending_merge_lovelace", divisor: 1_000_000 },
};

/** Pull the threshold (the operand of the final `<`/`>` comparison) from a PromQL expr. */
function thresholdFromExpr(expr: string): number {
  const matches = [...expr.matchAll(/[<>]\s*([0-9.]+)/g)];
  assert.ok(matches.length > 0, `no comparison operator found in expr: ${expr}`);
  return Number(matches[matches.length - 1]![1]);
}

type AlertRule = { alert: string; expr: string; annotations?: { summary?: string; description?: string } };

function loadAlertRules(): Map<string, AlertRule> {
  const doc = parseYaml(read("monitoring/alerts.yml")) as {
    groups: Array<{ rules: AlertRule[] }>;
  };
  const map = new Map<string, AlertRule>();
  for (const group of doc.groups) for (const rule of group.rules) if (rule.alert) map.set(rule.alert, rule);
  return map;
}

type Step = { color: string; value: number | null };
type Panel = {
  title?: string;
  fieldConfig?: {
    defaults?: { thresholds?: { steps?: Step[] } };
    overrides?: Array<{
      matcher?: { id?: string; options?: string };
      properties?: Array<{ id?: string; value?: { steps?: Step[] } }>;
    }>;
  };
};

function loadDashboard(): { panels: Panel[]; templating: { list: Array<{ name: string }> } } {
  return JSON.parse(read("monitoring/grafana/dashboards/feeder.json"));
}

const panelByTitle = (panels: Panel[], title: string): Panel => {
  const p = panels.find((x) => x.title === title);
  assert.ok(p, `dashboard panel not found: "${title}"`);
  return p;
};
const step = (panel: Panel, color: string): number => {
  const s = panel.fieldConfig?.defaults?.thresholds?.steps?.find((x) => x.color === color);
  assert.ok(s && s.value !== null, `panel "${panel.title}" has no ${color} threshold step`);
  return s.value as number;
};
const overrideStep = (panel: Panel, byName: string, color: string): number => {
  const ov = panel.fieldConfig?.overrides?.find((o) => o.matcher?.options === byName);
  const steps = ov?.properties?.find((p) => p.id === "thresholds")?.value?.steps;
  const s = steps?.find((x) => x.color === color);
  assert.ok(s && s.value !== null, `panel "${panel.title}" override "${byName}" has no ${color} step`);
  return s.value as number;
};

describe("threshold drift — YAML alerting.* is the single source of truth", () => {
  it("both network YAMLs declare identical alerting thresholds", () => {
    // alerts.yml + the dashboard are network-agnostic, so both YAMLs must agree.
    assert.deepEqual(loadAlerting("infrastructure.preview.yaml"), loadAlerting("infrastructure.mainnet.yaml"));
  });

  it("every alerting key is consumed by exactly one alert mapping (no orphan keys)", () => {
    const yaml = loadAlerting("infrastructure.preview.yaml");
    const mapped = new Set(Object.values(ALERT_TO_YAML).map((m) => m.yamlKey));
    for (const key of Object.keys(yaml)) {
      assert.ok(mapped.has(key), `alerting.${key} has no alert/dashboard binding — wire it or remove it`);
    }
  });

  it("monitoring/alerts.yml expr thresholds match the YAML", () => {
    const yaml = loadAlerting("infrastructure.preview.yaml");
    const rules = loadAlertRules();
    for (const [alert, { yamlKey, divisor }] of Object.entries(ALERT_TO_YAML)) {
      const rule = rules.get(alert);
      assert.ok(rule, `alerts.yml missing alert: ${alert}`);
      const expected = yaml[yamlKey]! / divisor;
      assert.equal(
        thresholdFromExpr(rule.expr),
        expected,
        `${alert} expr threshold drifted from alerting.${yamlKey} (${yaml[yamlKey]}${divisor > 1 ? ` / ${divisor}` : ""})`,
      );
    }
  });

  it("alerts.yml prose states the same ADA / percent numbers (operator-facing)", () => {
    const yaml = loadAlerting("infrastructure.preview.yaml");
    const rules = loadAlertRules();
    const prose = (alert: string): string => {
      const r = rules.get(alert)!;
      return `${r.annotations?.summary ?? ""} ${r.annotations?.description ?? ""}`;
    };
    // ADA-denominated alerts must mention "<N> ADA" in their text.
    for (const alert of ["ReceiverBalanceLow", "SettleOverdue", "PaymentHookWithdrawReady", "AdminWalletLow", "ReceiverDepositsPending"]) {
      const { yamlKey } = ALERT_TO_YAML[alert]!;
      const ada = yaml[yamlKey]! / 1_000_000;
      assert.match(prose(alert), new RegExp(`\\b${ada}\\s*ADA\\b`), `${alert} prose missing "${ada} ADA"`);
    }
    assert.match(prose("PriceDeviationHigh"), new RegExp(`\\b${yaml.price_deviation_high_percent}%`));
  });

  it("Grafana panel thresholds match the YAML", () => {
    const yaml = loadAlerting("infrastructure.preview.yaml");
    const { panels } = loadDashboard();
    assert.equal(step(panelByTitle(panels, "Pair staleness (per symbol)"), "red"), yaml.oracle_pair_stale_seconds);
    assert.equal(step(panelByTitle(panels, "Price data age p95 — 1 h window (per pair)"), "red"), yaml.price_age_high_seconds);
    assert.equal(step(panelByTitle(panels, "Price deviation p95 — 1 h window (per pair)"), "red"), yaml.price_deviation_high_percent);
    assert.equal(step(panelByTitle(panels, "Reorg counter"), "red"), yaml.reorg_rate_high_per_hour);
    assert.equal(step(panelByTitle(panels, "Receiver balance — ADA (per client)"), "yellow"), yaml.receiver_balance_low_lovelace / 1_000_000);
    assert.equal(step(panelByTitle(panels, "Deposit pending — ADA (per client)"), "yellow"), yaml.deposit_pending_merge_lovelace / 1_000_000);

    const wallets = panelByTitle(panels, "Admin wallet • PaymentHook • Receiver accrued — ADA");
    assert.equal(step(wallets, "green"), yaml.admin_wallet_low_lovelace / 1_000_000);
    assert.equal(overrideStep(wallets, "PaymentHook accrued", "yellow"), yaml.payment_hook_withdraw_ready_lovelace / 1_000_000);
    assert.equal(overrideStep(wallets, "Receiver accrued (sum)", "yellow"), yaml.settle_overdue_lovelace / 1_000_000);
  });

  it("dashboard has no dead template variables (every filter var is wired to a panel)", () => {
    const dashboard = loadDashboard() as unknown as {
      templating: { list: Array<{ name: string }> };
      panels: Array<{ targets?: Array<{ expr?: string }> }>;
    };
    assert.deepEqual(
      dashboard.templating.list.map((v) => v.name),
      ["datasource", "client", "symbol", "customer", "error_code"],
      "remove unused template vars or wire them to a panel",
    );
    // Every non-datasource var must be referenced by at least one panel target expr.
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? ""));
    for (const name of ["client", "symbol", "customer", "error_code"]) {
      assert.ok(
        exprs.some((e) => e.includes(`$${name}`)),
        `template var $${name} is not referenced by any panel target expr`,
      );
    }
  });

  it("count panels show counts (increase), not per-second rates, and keep the symbol label", () => {
    const { panels } = loadDashboard();
    const exprOf = (title: string): string => {
      const p = panels.find((x) => x.title === title) as Panel & {
        targets?: Array<{ expr?: string }>;
      };
      assert.ok(p, `panel not found: "${title}"`);
      return p.targets?.[0]?.expr ?? "";
    };
    for (const title of ["Tx confirmed (5m count)", "Tx failed (5m count)", "Intents filtered (5m count)"]) {
      const expr = exprOf(title);
      assert.match(expr, /increase\(/, `"${title}" should use increase() (a count), not rate()`);
      assert.doesNotMatch(expr, /\brate\(/, `"${title}" should not use rate() (per-second average)`);
      assert.match(expr, /\bsymbol\b/, `"${title}" should keep the symbol label in sum by(...)`);
    }
  });
});
