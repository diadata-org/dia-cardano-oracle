// Threshold drift guard — enforces that `infrastructure.<network>.yaml` is the
// SINGLE SOURCE OF TRUTH for every operational threshold, PER NETWORK.
//
// Each network has its OWN committed monitoring directory (monitoring/preview/,
// monitoring/mainnet/), rendered from that network's YAML by
// scripts/monitoring/generate-monitoring.ts (which drives the transforms in
// src/alerting/monitoring-rendering.ts). This test reads EACH network's
// committed files and asserts every threshold matches that network's YAML.
// Because each network is checked against its own YAML, preview and mainnet
// carry independent threshold values — there is no requirement that the two
// networks agree, and neither directory can overwrite the other.
//
// A hand-edit to any committed monitoring file that diverges from its network's
// YAML turns this test red; fix it by editing the YAML and running
// `make generate-monitoring` (which rewrites that network's directory). Values
// that only drive feeder BEHAVIOUR and never appear in a monitoring file (e.g.
// wallet_shape.working_utxo_lovelace / collateral_utxo_lovelace) are not
// constrained here and are free to differ per network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type Alerting,
  type WalletBlock,
  type ThresholdSpec,
  ALERT_TO_YAML,
  specKeys,
  resolveSpec,
} from "../../alerting/monitoring-rendering.js";

// src/config/__tests__ -> feeder root
const FEEDER_ROOT = path.join(import.meta.dirname, "../../..");
const read = (rel: string): string => readFileSync(path.join(FEEDER_ROOT, rel), "utf8");

const NETWORKS = ["preview", "mainnet"] as const;
// Network-agnostic dashboard STRUCTURE (template variables, panel encodings, the
// fixed feed-sanity verdict codes) is identical across networks; the structural
// checks read this canonical network's dashboards once.
const CANONICAL_NETWORK = "preview";

function loadAlerting(network: string): Alerting {
  const doc = parseYaml(read(`config/infrastructure.${network}.yaml`)) as {
    infrastructure?: { alerting?: Alerting };
  };
  const alerting = doc.infrastructure?.alerting;
  assert.ok(alerting, `infrastructure.${network}.yaml: missing infrastructure.alerting block`);
  return alerting;
}

/** Load a non-alerting config block (the lovelace/count thresholds the per-wallet
 *  alerts read). */
function loadBlock(network: string, block: "wallet_pool" | "wallet_shape"): WalletBlock {
  const doc = parseYaml(read(`config/infrastructure.${network}.yaml`)) as {
    infrastructure?: Record<string, WalletBlock | undefined>;
  };
  const b = doc.infrastructure?.[block];
  assert.ok(b, `infrastructure.${network}.yaml: missing infrastructure.${block} block`);
  return b;
}

// Automatic-remediation thresholds. These drive FEEDER BEHAVIOUR (auto settle /
// withdraw / consolidate), not a Prometheus rule, so they have no alert mapping.
// Each must sit BEYOND its paired alert so the alert fires FIRST and the
// automatic step only follows — asserted by the "ordering invariant" test below.
//   direction "above": auto value must be > the alert value (accruals grow)
//   direction "below": auto value must be < the alert value (collateral shrinks)
const AUTO_REMEDIATION_ORDERING: Array<{
  autoKey: string;
  alertKey: string;
  direction: "above" | "below";
}> = [
  { autoKey: "auto_settle_lovelace", alertKey: "settle_overdue_lovelace", direction: "above" },
  { autoKey: "auto_withdraw_lovelace", alertKey: "payment_hook_withdraw_ready_lovelace", direction: "above" },
  { autoKey: "auto_consolidate_below_lovelace", alertKey: "admin_wallet_min_collateral_lovelace", direction: "below" },
];
const AUTO_REMEDIATION_KEYS = new Set(AUTO_REMEDIATION_ORDERING.map((o) => o.autoKey));
// Non-numeric auto-remediation toggles (booleans) — they enable an automatic
// step but pair with no numeric alert, so they are exempt from the ordering test.
const NON_NUMERIC_AUTO_KEYS = new Set(["auto_split"]);

// ---------------------------------------------------------------------------
// Read a network's committed monitoring files (monitoring/<network>/...).
// ---------------------------------------------------------------------------
const readAlerts = (network: string): string => read(`monitoring/${network}/alerts.yml`);
const readDashboard = (network: string, file: string): string => read(`monitoring/${network}/dashboards/${file}`);

// ---------------------------------------------------------------------------
// Parsers.
// ---------------------------------------------------------------------------
type AlertRule = { alert: string; expr: string; annotations?: { summary?: string; description?: string } };

function parseAlertRules(text: string): Map<string, AlertRule> {
  const doc = parseYaml(text) as { groups: Array<{ rules: AlertRule[] }> };
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
type Dashboard = { panels: Panel[]; templating: { list: Array<{ name: string }> } };

/** Every numeric operand of a `<`/`>` comparison in an expr (for compound alerts). */
function allThresholds(expr: string): number[] {
  return [...expr.matchAll(/[<>]\s*([0-9.]+)/g)].map((m) => Number(m[1]));
}

/** Pull the threshold (the operand of the final `<`/`>` comparison) from a PromQL expr. */
function thresholdFromExpr(expr: string): number {
  const matches = [...expr.matchAll(/[<>]\s*([0-9.]+)/g)];
  assert.ok(matches.length > 0, `no comparison operator found in expr: ${expr}`);
  return Number(matches[matches.length - 1]![1]);
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

describe("threshold drift — infrastructure.<network>.yaml is the source of truth, per network", () => {
  for (const network of NETWORKS) {
    describe(`network ${network} (monitoring/${network}/)`, () => {
      const alerting = loadAlerting(network);
      const pool = loadBlock(network, "wallet_pool");
      const shape = loadBlock(network, "wallet_shape");
      const rules = parseAlertRules(readAlerts(network));
      const dashboard = JSON.parse(readDashboard(network, "feeder.json")) as Dashboard;
      const internals = JSON.parse(readDashboard(network, "feeder-internals.json")) as Dashboard;

      it("every alerting key is consumed by an alert mapping or an auto-remediation threshold (no orphan keys)", () => {
        const mapped = new Set(Object.values(ALERT_TO_YAML).flatMap(specKeys));
        for (const key of Object.keys(alerting)) {
          assert.ok(
            mapped.has(key) || AUTO_REMEDIATION_KEYS.has(key) || NON_NUMERIC_AUTO_KEYS.has(key),
            `alerting.${key} has no alert/dashboard binding and is not an auto-remediation threshold — wire it or remove it`,
          );
        }
      });

      it("auto-remediation thresholds sit BEYOND their paired alert (alert fires first, automatic follows)", () => {
        for (const { autoKey, alertKey, direction } of AUTO_REMEDIATION_ORDERING) {
          const auto = alerting[autoKey];
          const alert = alerting[alertKey];
          assert.ok(auto !== undefined, `alerting.${autoKey} is missing`);
          assert.ok(alert !== undefined, `alerting.${alertKey} is missing`);
          if (direction === "above") {
            assert.ok(
              auto > alert,
              `alerting.${autoKey} (${auto}) must be > alerting.${alertKey} (${alert}) so the alert fires before the auto step`,
            );
          } else {
            assert.ok(
              auto < alert,
              `alerting.${autoKey} (${auto}) must be < alerting.${alertKey} (${alert}) so the alert fires before the auto step`,
            );
          }
        }
      });

      it("alerts.yml expr thresholds match alerting.*", () => {
        for (const [alert, spec] of Object.entries(ALERT_TO_YAML)) {
          const rule = rules.get(alert);
          assert.ok(rule, `alerts.yml missing alert: ${alert}`);
          assert.equal(
            thresholdFromExpr(rule.expr),
            resolveSpec(spec, alerting),
            `${alert} expr threshold drifted from alerting.${specKeys(spec).join(" × ")}`,
          );
        }
      });

      it("per-wallet alert expr thresholds match wallet_pool / wallet_shape", () => {
        const poolLow = rules.get("PoolWalletLow");
        assert.ok(poolLow, "alerts.yml missing PoolWalletLow");
        assert.equal(
          thresholdFromExpr(poolLow.expr),
          pool.pool_wallet_low_lovelace / 1_000_000,
          "PoolWalletLow expr threshold drifted from wallet_pool.pool_wallet_low_lovelace",
        );

        // MainWalletCannotFundPool is compound: a pool below its low AND the main
        // below its reserve. (The `> 0` from count(...) is structural, not a config
        // threshold.)
        const mainCannot = rules.get("MainWalletCannotFundPool");
        assert.ok(mainCannot, "alerts.yml missing MainWalletCannotFundPool");
        const mainCannotThresholds = new Set(allThresholds(mainCannot.expr));
        assert.ok(
          mainCannotThresholds.has(pool.pool_wallet_low_lovelace / 1_000_000),
          "MainWalletCannotFundPool expr missing the wallet_pool.pool_wallet_low_lovelace threshold",
        );
        assert.ok(
          mainCannotThresholds.has(pool.main_wallet_reserve_lovelace / 1_000_000),
          "MainWalletCannotFundPool expr missing the wallet_pool.main_wallet_reserve_lovelace threshold",
        );

        // WalletConcentrated fires purely on the usable-UTxO count (no balance gate).
        const concentrated = rules.get("WalletConcentrated");
        assert.ok(concentrated, "alerts.yml missing WalletConcentrated");
        assert.deepEqual(
          new Set(allThresholds(concentrated.expr)),
          new Set([shape.min_usable_utxos]),
          "WalletConcentrated expr threshold drifted from wallet_shape.min_usable_utxos",
        );
      });

      it("per-wallet alert prose states the same ADA / count numbers", () => {
        const prose = (alert: string): string => {
          const r = rules.get(alert)!;
          return `${r.annotations?.summary ?? ""} ${r.annotations?.description ?? ""}`;
        };
        assert.match(prose("PoolWalletLow"), new RegExp(`\\b${pool.pool_wallet_low_lovelace / 1_000_000}\\s*ADA\\b`));
        assert.match(
          prose("MainWalletCannotFundPool"),
          new RegExp(`\\b${pool.main_wallet_reserve_lovelace / 1_000_000}\\s*ADA\\b`),
        );
        // WalletConcentrated prose states the usable-UTxO count (its only threshold).
        assert.match(prose("WalletConcentrated"), new RegExp(`\\b${shape.min_usable_utxos}\\b`));
      });

      it("alerts.yml prose states the same ADA / percent numbers (operator-facing)", () => {
        const prose = (alert: string): string => {
          const r = rules.get(alert)!;
          return `${r.annotations?.summary ?? ""} ${r.annotations?.description ?? ""}`;
        };
        // ADA-denominated alerts must mention "<N> ADA" in their text.
        for (const alert of ["ReceiverBalanceLow", "SettleOverdue", "PaymentHookWithdrawReady", "AdminWalletLow", "AdminWalletFragmented", "ReceiverDepositsPending"]) {
          const yamlKey = specKeys(ALERT_TO_YAML[alert] as ThresholdSpec)[0]!;
          const ada = alerting[yamlKey]! / 1_000_000;
          assert.match(prose(alert), new RegExp(`\\b${ada}\\s*ADA\\b`), `${alert} prose missing "${ada} ADA"`);
        }
        assert.match(prose("PriceDeviationHigh"), new RegExp(`\\b${alerting.price_deviation_high_percent}%`));
      });

      it("Grafana panel thresholds match alerting.*", () => {
        const { panels } = dashboard;
        assert.equal(step(panelByTitle(panels, "Pair staleness (per symbol)"), "red"), alerting.oracle_pair_stale_seconds);
        assert.equal(step(panelByTitle(panels, "Price data age p95 — 1 h window (per routed pair)"), "red"), alerting.price_age_high_seconds);
        assert.equal(step(panelByTitle(panels, "Price deviation p95 — 1 h window (per pair)"), "red"), alerting.price_deviation_high_percent);
        assert.equal(step(panelByTitle(panels, "Reorg counter"), "red"), alerting.reorg_rate_high_per_hour);
        assert.equal(step(panelByTitle(panels, "Receiver balance — ADA (per client)"), "yellow"), alerting.receiver_balance_low_lovelace / 1_000_000);
        assert.equal(step(panelByTitle(panels, "Deposit pending — ADA (per client)"), "yellow"), alerting.deposit_pending_merge_lovelace / 1_000_000);

        const wallets = panelByTitle(panels, "Admin wallet • PaymentHook • Receiver accrued — ADA");
        assert.equal(step(wallets, "green"), alerting.admin_wallet_low_lovelace / 1_000_000);
        assert.equal(overrideStep(wallets, "PaymentHook accrued", "yellow"), alerting.payment_hook_withdraw_ready_lovelace / 1_000_000);
        assert.equal(overrideStep(wallets, "Receiver accrued (sum)", "yellow"), alerting.settle_overdue_lovelace / 1_000_000);
        // Per-client accrued series (byRegexp override) use the same settle-overdue boundary.
        assert.equal(overrideStep(wallets, "Receiver accrued — .*", "yellow"), alerting.settle_overdue_lovelace / 1_000_000);

        // Fragmentation panel — largest pure-ADA UTxO vs the collateral floor.
        // Floor convention (same as the admin-wallet panel above): green AT the
        // floor value, red below it.
        assert.equal(
          step(panelByTitle(panels, "Admin wallet — largest UTxO — ADA (collateral floor)"), "green"),
          alerting.admin_wallet_min_collateral_lovelace / 1_000_000,
        );
      });

      it("internals provider-quota panel red line matches the ProviderRequestQuotaHigh* warn level", () => {
        const warn = alerting.provider_request_quota_per_day_blockfrost * alerting.provider_request_quota_warn_ratio;
        assert.equal(
          step(panelByTitle(internals.panels, "Requests in last 24h vs daily quota (per provider)"), "red"),
          warn,
          "the 24h-vs-quota panel's red line must equal daily quota × warn ratio (= the alert threshold)",
        );
      });
    });
  }

  // -------------------------------------------------------------------------
  // Network-agnostic structural checks — the fixed verdict codes, dead template
  // variables, and count-vs-rate panel encodings do not depend on any threshold,
  // so they run once against the canonical network's dashboards.
  // -------------------------------------------------------------------------
  const loadDashboard = (file = "feeder.json"): Dashboard =>
    JSON.parse(readDashboard(CANONICAL_NETWORK, file));

  it("feed-sanity panel verdict colours match the FeedAccuracyFail boundary", () => {
    // The verdict codes (0 ok / 1 suspect / 2 broken) are fixed, not a YAML threshold,
    // but the panel's red step MUST equal the status the FeedAccuracyFail rule fires on
    // (>= 2) so the chart and the alert can never silently diverge.
    const { panels } = loadDashboard();
    const p = panelByTitle(panels, "Feed sanity verdict (per pair)");
    assert.equal(step(p, "yellow"), 1, "feed-sanity yellow step must be 1 (suspect)");
    assert.equal(step(p, "red"), 2, "feed-sanity red step must be 2 (FeedAccuracyFail fires on status >= 2)");
  });

  it("dashboard has no dead template variables (every filter var is wired to a panel)", () => {
    const dashboard = loadDashboard() as unknown as {
      templating: { list: Array<{ name: string }> };
      panels: Array<{ targets?: Array<{ expr?: string }> }>;
    };
    assert.deepEqual(
      dashboard.templating.list.map((v) => v.name),
      ["datasource", "network", "customer", "client", "router", "symbol", "error_code"],
      "remove unused template vars or wire them to a panel",
    );
    // Every non-datasource var must be referenced by at least one panel target expr.
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? ""));
    for (const name of ["network", "customer", "client", "router", "symbol", "error_code"]) {
      assert.ok(
        exprs.some((e) => e.includes(`$${name}`)),
        `template var $${name} is not referenced by any panel target expr`,
      );
    }
  });

  it("transactions dashboard (feeder-tx.json) has no dead template variables", () => {
    const dashboard = loadDashboard("feeder-tx.json") as unknown as {
      templating: { list: Array<{ name: string }> };
      panels: Array<{ targets?: Array<{ expr?: string }> }>;
    };
    assert.deepEqual(
      dashboard.templating.list.map((v) => v.name),
      ["datasource", "network", "customer", "client", "router", "symbol", "wallet", "kind"],
      "feeder-tx.json: remove unused template vars or wire them to a panel",
    );
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? ""));
    for (const name of ["network", "customer", "client", "router", "symbol", "wallet", "kind"]) {
      assert.ok(
        exprs.some((e) => e.includes(`$${name}`)),
        `feeder-tx.json: template var $${name} is not referenced by any panel target expr`,
      );
    }
  });

  it("wallets dashboard (feeder-wallets.json) has no dead template variables", () => {
    const dashboard = loadDashboard("feeder-wallets.json") as unknown as {
      templating: { list: Array<{ name: string }> };
      panels: Array<{ targets?: Array<{ expr?: string }> }>;
    };
    assert.deepEqual(
      dashboard.templating.list.map((v) => v.name),
      ["datasource", "network", "wallet"],
      "feeder-wallets.json: remove unused template vars or wire them to a panel",
    );
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? ""));
    for (const name of ["network", "wallet"]) {
      assert.ok(
        exprs.some((e) => e.includes(`$${name}`)),
        `feeder-wallets.json: template var $${name} is not referenced by any panel target expr`,
      );
    }
  });

  it("internals dashboard (feeder-internals.json) has no dead template variables", () => {
    const dashboard = loadDashboard("feeder-internals.json") as unknown as {
      templating: { list: Array<{ name: string }> };
      panels: Array<{ targets?: Array<{ expr?: string }> }>;
    };
    assert.deepEqual(
      dashboard.templating.list.map((v) => v.name),
      ["datasource", "network", "job"],
      "feeder-internals.json: remove unused template vars or wire them to a panel",
    );
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr ?? ""));
    for (const v of ["$network", "$job"]) {
      assert.ok(
        exprs.some((e) => e.includes(v)),
        `feeder-internals.json: template var ${v} is not referenced by any panel target expr`,
      );
    }
  });

  it("count panels show counts (increase), not per-second rates, grouped by the right label", () => {
    const { panels } = loadDashboard();
    const exprOf = (title: string): string => {
      const p = panels.find((x) => x.title === title) as Panel & {
        targets?: Array<{ expr?: string }>;
      };
      assert.ok(p, `panel not found: "${title}"`);
      return p.targets?.[0]?.expr ?? "";
    };
    // title -> the label the panel aggregates by (`sum by (<group>)`).
    const countPanels: Array<{ title: string; group: string }> = [
      { title: "Symbol updates confirmed (5m)", group: "symbol, client_id" },
      { title: "Symbol-update failures (5m, by error code)", group: "error_code" },
      { title: "Intents filtered (5m, by reason)", group: "reason" },
      { title: "Tx confirmed vs failed (5m)", group: "outcome" },
    ];
    for (const { title, group } of countPanels) {
      const expr = exprOf(title);
      assert.match(expr, /increase\(/, `"${title}" should use increase() (a count), not rate()`);
      assert.doesNotMatch(expr, /\brate\(/, `"${title}" should not use rate() (per-second average)`);
      assert.match(expr, new RegExp(`sum by \\(${group}\\)`), `"${title}" should aggregate by ${group}`);
    }
  });
});
