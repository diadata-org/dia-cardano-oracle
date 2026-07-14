// Monitoring RENDERING library — the pure functions that write the operational
// thresholds from `config/infrastructure.<network>.yaml` INTO that network's own
// Prometheus rules (`monitoring/<network>/alerts.yml`) and Grafana dashboards
// (`monitoring/<network>/dashboards/*.json`).
//
// TWO CONSUMERS SHARE THIS ONE MODULE so their encodings can never drift:
//   * scripts/monitoring/generate-monitoring.ts — the `make generate-monitoring`
//     CLI that reads a network's YAML and rewrites the monitoring files in place.
//   * src/config/__tests__/threshold-drift.test.ts — the CI guard that renders
//     EACH network in memory and asserts every threshold matches that network's
//     YAML. Because each network is verified against its own YAML, preview and
//     mainnet may carry their own threshold values independently.
//
// HOW IT EDITS (and why it does NOT round-trip the files through a parser)
// -----------------------------------------------------------------------
// Re-emitting alerts.yml from a YAML parser or feeder.json from JSON.stringify
// would destroy the extensive operator-facing comments / prose / hand-tuned
// formatting in those files. Instead these functions do IN-PLACE NUMERIC
// SUBSTITUTION: they locate the exact number to change (the operand of an
// alert's final `<`/`>` comparison, the "<N> ADA" / "<N>%" prose, and the
// specific dashboard `thresholds.steps` value) and rewrite only that number,
// leaving every other byte untouched. Running twice produces no diff
// (idempotent) because the second run substitutes the same values back in.
//
// These are PURE string transforms — no file or process I/O. On a malformed
// input (a missing YAML key, an alert/panel/step that cannot be located) they
// THROW; the CLI catches and reports, the test lets it fail the assertion.

// The `alerting.*` block: threshold name -> value (lovelace / seconds / percent).
export type Alerting = Record<string, number>;

// The per-wallet alerts (PoolWalletLow / MainWalletCannotFundPool /
// WalletConcentrated) read their thresholds from the `wallet_pool` and
// `wallet_shape` blocks rather than `alerting.*`.
export type WalletBlock = Record<string, number>;

// ---------------------------------------------------------------------------
// Mapping: alert name -> { yamlKey, divisor }. divisor 1e6 means the alert
// divides a lovelace metric by 1_000_000 and compares/displays in ADA; divisor
// 1 means the value is used verbatim (seconds / percent / count).
// ---------------------------------------------------------------------------
// A threshold operand is either one YAML key (divided by `divisor`) or the
// PRODUCT of two keys (e.g. a per-provider daily quota × a warn ratio).
export type ThresholdSpec =
  | { yamlKey: string; divisor: number }
  | { product: [string, string]; divisor: number };

export const ALERT_TO_YAML: Record<string, ThresholdSpec> = {
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
export function specKeys(spec: ThresholdSpec): string[] {
  return "yamlKey" in spec ? [spec.yamlKey] : spec.product;
}

/** Resolve a spec to its numeric operand from the alerting block. */
export function resolveSpec(spec: ThresholdSpec, alerting: Alerting): number {
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
 * Isolate one alert's block (from `- alert: <name>` up to the next `- alert:`
 * or EOF), apply `transform` to it, and splice the result back so a number in
 * one alert never bleeds into another. Throws if the alert is not present.
 */
function editAlertBlock(text: string, alert: string, transform: (block: string) => string): string {
  const blockRe = new RegExp(`(- alert:\\s*${reEscape(alert)}\\b[\\s\\S]*?)(?=\\n\\s*- alert:|$)`);
  const m = text.match(blockRe);
  if (!m) {
    throw new Error(`alerts.yml has no alert block: ${alert}`);
  }
  const block = transform(m[1]!);
  return text.slice(0, m.index!) + block + text.slice(m.index! + m[1]!.length);
}

/**
 * Rewrite each `alerting.*`-backed alert block in alerts.yml:
 *   - the operand of the FINAL `<`/`>` comparison in the `expr:` field
 *   - every "<old> ADA" → "<new> ADA" (ADA-denominated alerts)
 *   - every "<old>%"     → "<new>%"   (PriceDeviationHigh only)
 * Substitutions are scoped to the alert's own block (from `- alert: <name>`
 * up to the next `- alert:` or EOF) so a number in one alert never bleeds into
 * another.
 */
export function patchAlertsYaml(text: string, alerting: Alerting): string {
  let out = text;
  for (const [alert, spec] of Object.entries(ALERT_TO_YAML)) {
    for (const key of specKeys(spec)) {
      if (alerting[key] === undefined) {
        throw new Error(`alerting.${key} missing (alert ${alert})`);
      }
    }
    const value = resolveSpec(spec, alerting);
    const valueStr = fmt(value);

    out = editAlertBlock(out, alert, (input) => {
      let block = input;

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

      return block;
    });
  }
  return out;
}

/**
 * Rewrite the per-wallet alert blocks, whose thresholds come from `wallet_pool`
 * and `wallet_shape` rather than `alerting.*`:
 *   - PoolWalletLow            — pool spendable `< pool_wallet_low_lovelace`
 *   - MainWalletCannotFundPool — COMPOUND: pool `< pool_wallet_low_lovelace`
 *                                AND main `< main_wallet_reserve_lovelace`
 *   - WalletConcentrated       — usable UTxO count `< min_usable_utxos`
 * The compound alert carries two operands, so each is anchored on its own
 * `role="…"` selector instead of the generic "final comparison" rule used for
 * the single-operand alerts.
 */
export function patchWalletAlerts(text: string, pool: WalletBlock, shape: WalletBlock): string {
  for (const key of ["pool_wallet_low_lovelace", "main_wallet_reserve_lovelace"]) {
    if (pool[key] === undefined) throw new Error(`wallet_pool.${key} missing`);
  }
  if (shape["min_usable_utxos"] === undefined) throw new Error("wallet_shape.min_usable_utxos missing");

  const poolLow = fmt(pool["pool_wallet_low_lovelace"]! / 1_000_000);
  const reserve = fmt(pool["main_wallet_reserve_lovelace"]! / 1_000_000);
  const minUsable = fmt(shape["min_usable_utxos"]!);

  let out = text;

  // PoolWalletLow — expr `{role="pool"} / 1000000 < <poolLow>`; prose "below <poolLow> ADA".
  out = editAlertBlock(out, "PoolWalletLow", (block) =>
    block
      .replace(/(\{role="pool"\}\s*\/\s*1000000\s*<\s*)[0-9]+(?:\.[0-9]+)?/, `$1${poolLow}`)
      .replace(/\bbelow\s+[0-9]+(?:\.[0-9]+)?(\s*ADA\b)/gi, `below ${poolLow}$1`),
  );

  // WalletConcentrated — expr `dia_bridge_cardano_wallet_usable_utxos < <minUsable>`;
  // prose "fewer than <minUsable> usable UTxOs".
  out = editAlertBlock(out, "WalletConcentrated", (block) =>
    block
      .replace(/(dia_bridge_cardano_wallet_usable_utxos\s*<\s*)[0-9]+(?:\.[0-9]+)?/, `$1${minUsable}`)
      .replace(/\bfewer than\s+[0-9]+(?:\.[0-9]+)?(\s+usable UTxOs)/gi, `fewer than ${minUsable}$1`),
  );

  // MainWalletCannotFundPool — compound: pool `< <poolLow>` AND main `< <reserve>`;
  // prose "low mark (<poolLow> ADA)" and "reserve (<reserve> ADA)".
  out = editAlertBlock(out, "MainWalletCannotFundPool", (block) =>
    block
      .replace(/(\{role="pool"\}\s*\/\s*1000000\s*<\s*)[0-9]+(?:\.[0-9]+)?/, `$1${poolLow}`)
      .replace(/(\{role="main"\}\s*\/\s*1000000\s*<\s*)[0-9]+(?:\.[0-9]+)?/, `$1${reserve}`)
      .replace(/(low mark\s*\()[0-9]+(?:\.[0-9]+)?(\s*ADA\))/i, `$1${poolLow}$2`)
      .replace(/(reserve\s*\()[0-9]+(?:\.[0-9]+)?(\s*ADA\))/i, `$1${reserve}$2`),
  );

  return out;
}

// ---------------------------------------------------------------------------
// feeder.json — in-place patch of the specific panel `thresholds.steps` values.
// Each entry names the panel by title, the threshold step color to rewrite, the
// YAML key + divisor. For panels whose threshold lives in a per-series override
// (matched `byName`), `override` carries that series name.
// ---------------------------------------------------------------------------
export type PanelStepTarget = {
  panelTitle: string;
  color: string;
  divisor: number;
  override?: string;
  /** A single alerting key (÷ divisor)... */
  yamlKey?: string;
  /** ...or the PRODUCT of two keys (e.g. a daily quota × a warn ratio). */
  product?: [string, string];
};

/** Resolve a panel-step target to its numeric value, throwing on a missing
 *  YAML key — mirrors how the alert thresholds resolve. */
function resolvePanelValue(target: PanelStepTarget, alerting: Alerting): number {
  const keys = target.product ?? [target.yamlKey!];
  for (const key of keys) {
    if (alerting[key] === undefined) {
      throw new Error(`alerting.${key} missing (panel "${target.panelTitle}")`);
    }
  }
  const raw = target.product
    ? alerting[target.product[0]]! * alerting[target.product[1]]!
    : alerting[target.yamlKey!]!;
  return raw / target.divisor;
}

export const PANEL_STEPS: PanelStepTarget[] = [
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

// Internals dashboard threshold steps. The provider-quota panel's red line is the
// SAME warn level the ProviderRequestQuotaHigh* alert uses (daily quota × warn
// ratio); both providers share one quota, so one threshold covers both lines.
export const INTERNALS_PANEL_STEPS: PanelStepTarget[] = [
  {
    panelTitle: "Requests in last 24h vs daily quota (per provider)",
    color: "red",
    product: ["provider_request_quota_per_day_blockfrost", "provider_request_quota_warn_ratio"],
    divisor: 1,
  },
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
    throw new Error(`dashboard panel not found: "${target.panelTitle}"`);
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
      throw new Error(`panel "${target.panelTitle}" has no override series "${target.override}"`);
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
    throw new Error(
      `panel "${target.panelTitle}"` +
        `${target.override ? ` override "${target.override}"` : ""} has no "${target.color}" threshold step`,
    );
  }
  const patchedRegion = region.replace(stepRe, (_f, prefix: string) => `${prefix}${fmt(value)}`);
  return text.slice(0, searchStart) + patchedRegion + text.slice(searchEnd);
}

export function patchDashboard(text: string, alerting: Alerting, steps: PanelStepTarget[]): string {
  let out = text;
  for (const target of steps) {
    out = patchDashboardStep(out, target, resolvePanelValue(target, alerting));
  }
  return out;
}
