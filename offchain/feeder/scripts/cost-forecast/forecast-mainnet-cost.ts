// Forecast the recurring on-chain network-fee cost of running the feeder, from
// data that already exists in an M2 evidence pack. Pure calculator: it reads
// files only, never touches a chain and never submits a transaction.
//
// What it answers: "given how the feeder behaved on Preview (same config we
// will use on Mainnet — N pairs, one client, 10-minute heartbeat + price
// deviation), how much ADA in network fees does keeping it alive for a window
// of D minutes cost?"
//
// It does NOT estimate one-off deploy / bootstrap / teardown fees — those are a
// separate, one-time spend and most of the locked ADA is recovered by the
// Mainnet teardown. This script only sizes the recurring "feeder is alive" cost.
//
// Inputs (all optional, sensible defaults):
//   --pack <dir>        Evidence pack directory. Default: newest
//                       docs/milestones/evidence/m2-preview-* (excludes _archived).
//   --minutes <N>       Forecast window in minutes. Default: 90 (1 h 30 m).
//   --pairs <N>         Pairs in the forecast scenario. Default: 10.
//   --clients <N>       Clients in the forecast scenario. Default: 1.
//   --heartbeat-min <N> Cron heartbeat in minutes (time_threshold). Default: 10.
//   --fee-report <path> Optional CLI fee-benchmark fee-report.json for a
//                       batch-curve cross-check (offchain/cli/scripts/fee-benchmark.sh).
//   --out <path>        Where to write the markdown report. Default: stdout only.
//   --json <path>       Where to write the JSON report. Default: stdout only.
//
// Usage (from offchain/feeder/):
//   node --import tsx/esm scripts/cost-forecast/forecast-mainnet-cost.ts \
//     --minutes 90 \
//     --fee-report ../../docs/milestones/evidence/_archived/m1-fee-benchmark-20260506-162133/fee-report.json

import * as fs from "node:fs";
import * as path from "node:path";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Paths and CLI args.
// ---------------------------------------------------------------------------
const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
// cost-forecast → scripts → feeder → offchain → repo root (4 levels up)
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
const EVIDENCE_ROOT = path.join(REPO_ROOT, "docs", "milestones", "evidence");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function numArg(name: string, fallback: number): number {
  const v = arg(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`--${name} must be a positive number, got "${v}"`);
  }
  return n;
}
function fail(msg: string): never {
  process.stderr.write(`[forecast-cost] error: ${msg}\n`);
  process.exit(1);
}

const FORECAST_MINUTES = numArg("minutes", 90);
const PAIRS = numArg("pairs", 10);
const CLIENTS = numArg("clients", 1);
const HEARTBEAT_MIN = numArg("heartbeat-min", 10);

// ---------------------------------------------------------------------------
// Resolve the evidence pack: explicit --pack, else newest m2-preview-* dir.
// ---------------------------------------------------------------------------
function newestPreviewPack(): string {
  if (!fs.existsSync(EVIDENCE_ROOT)) fail(`evidence root not found: ${EVIDENCE_ROOT}`);
  const packs = fs
    .readdirSync(EVIDENCE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("m2-preview-"))
    .map((d) => d.name)
    .sort();
  if (packs.length === 0) fail(`no m2-preview-* pack found under ${EVIDENCE_ROOT}`);
  return path.join(EVIDENCE_ROOT, packs[packs.length - 1]!);
}

const packDir = arg("pack")
  ? path.resolve(arg("pack")!)
  : newestPreviewPack();
if (!fs.existsSync(packDir)) fail(`pack directory not found: ${packDir}`);

// ---------------------------------------------------------------------------
// Read SUMMARY.json — window-scoped totals (NOT cumulative across restarts).
// ---------------------------------------------------------------------------
type Summary = {
  pack_stamp?: string;
  window?: { first_event_iso?: string; last_event_iso?: string };
  totals?: { tx_confirmed?: number; tx_failed?: number; reorgs?: number };
};
const summaryPath = path.join(packDir, "SUMMARY.json");
if (!fs.existsSync(summaryPath)) fail(`SUMMARY.json not found in pack: ${summaryPath}`);
const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Summary;

const txConfirmed = Number(summary.totals?.tx_confirmed ?? 0);
const txFailed = Number(summary.totals?.tx_failed ?? 0);
const firstIso = summary.window?.first_event_iso;
const lastIso = summary.window?.last_event_iso;
if (!firstIso || !lastIso) fail("SUMMARY.json is missing window.first_event_iso/last_event_iso");
const observedMinutes = (Date.parse(lastIso) - Date.parse(firstIso)) / 60_000;
if (!(observedMinutes > 0)) fail("SUMMARY.json window has non-positive duration");
if (txConfirmed <= 0) fail("SUMMARY.json reports zero confirmed transactions; cannot derive a rate");

// ---------------------------------------------------------------------------
// Read api/metrics.txt — average network fee per confirmed update tx.
// dia_bridge_transaction_fee_lovelace is a histogram; summing every label set's
// _sum / _count yields the mean fee per fee-bearing transaction. The COUNT is
// reset by daemon restarts, so we only trust it as a denominator for the
// average — never as a rate (the rate comes from SUMMARY's window totals).
// ---------------------------------------------------------------------------
const metricsPath = path.join(packDir, "api", "metrics.txt");
if (!fs.existsSync(metricsPath)) fail(`api/metrics.txt not found in pack: ${metricsPath}`);
const metricsText = fs.readFileSync(metricsPath, "utf8");

function sumMetric(suffix: "sum" | "count"): number {
  const re = new RegExp(
    `^(?:dia_)?bridge_transaction_fee_lovelace_${suffix}\\{[^}]*\\}\\s+([0-9.eE+-]+)`,
    "gm",
  );
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(metricsText)) !== null) total += Number(m[1]);
  return total;
}
const feeSumLovelace = sumMetric("sum");
const feeCount = sumMetric("count");
if (feeCount <= 0 || feeSumLovelace <= 0) {
  fail("no dia_bridge_transaction_fee_lovelace samples found in api/metrics.txt");
}
const avgFeeLovelace = feeSumLovelace / feeCount;
const avgFeeAda = avgFeeLovelace / 1e6;

// ---------------------------------------------------------------------------
// Primary method — OBSERVED RATE.
// The pack ran the exact config we will use on Mainnet, so its confirmed-tx
// rate is the most faithful predictor. Scale it to the forecast window and
// price each tx at the observed average fee.
// ---------------------------------------------------------------------------
const observedTxPerMinute = txConfirmed / observedMinutes;
const projectedTx = observedTxPerMinute * FORECAST_MINUTES;
const projectedFeeAda = projectedTx * avgFeeAda;

// ---------------------------------------------------------------------------
// Cross-check method — HEARTBEAT MODEL.
// Lower bound: the cron heartbeat alone forces every stale pair out once per
// time_threshold. With the coalescer, one client's due pairs ride one batch tx
// per cycle. cycles = window / heartbeat; tx = cycles * clients.
// If a CLI fee-benchmark batch curve is supplied, price the batch at
// batch-<pairs>; otherwise fall back to the observed average fee per tx.
// ---------------------------------------------------------------------------
const cycles = FORECAST_MINUTES / HEARTBEAT_MIN;
const heartbeatBatchTx = cycles * CLIENTS;

type FeeReport = {
  maxBatch?: number | null;
  results?: Record<string, { fee?: { avgLovelace?: number; avgAda?: string } }>;
};
let batchFeeAda: number | null = null;
let batchModel: { base: number; perPair: number; source: string } | null = null;
const feeReportPath = arg("fee-report");
if (feeReportPath) {
  const fr = path.resolve(feeReportPath);
  if (!fs.existsSync(fr)) fail(`--fee-report not found: ${fr}`);
  const report = JSON.parse(fs.readFileSync(fr, "utf8")) as FeeReport;
  const results = report.results ?? {};
  const pts: Array<[number, number]> = [];
  for (const [op, v] of Object.entries(results)) {
    const mm = /^batch-(\d+)$/.exec(op);
    const lov = v.fee?.avgLovelace;
    if (mm && typeof lov === "number") pts.push([Number(mm[1]), lov / 1e6]);
  }
  if (pts.length >= 2) {
    // Linear regression fee = base + perPair * N over the measured batch sizes.
    const n = pts.length;
    const sx = pts.reduce((a, [x]) => a + x, 0);
    const sy = pts.reduce((a, [, y]) => a + y, 0);
    const sxx = pts.reduce((a, [x]) => a + x * x, 0);
    const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
    const denom = n * sxx - sx * sx;
    const perPair = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const base = (sy - perPair * sx) / n;
    batchModel = { base, perPair, source: path.relative(REPO_ROOT, fr) };
    batchFeeAda = base + perPair * PAIRS;
  }
}
const heartbeatFeePerTxAda = batchFeeAda ?? avgFeeAda;
const heartbeatModelFeeAda = heartbeatBatchTx * heartbeatFeePerTxAda;

// ---------------------------------------------------------------------------
// Assemble the report.
// ---------------------------------------------------------------------------
const round = (n: number, d = 6) => Number(n.toFixed(d));
const ada = (n: number) => `${n.toFixed(6)} ADA`;

const json = {
  generatedAt: new Date().toISOString(),
  disclaimer:
    "Recurring feeder network-fee forecast only. Excludes one-off deploy/bootstrap/teardown fees and client-paid protocol fees. No chain interaction.",
  scenario: {
    pairs: PAIRS,
    clients: CLIENTS,
    heartbeatMinutes: HEARTBEAT_MIN,
    forecastMinutes: FORECAST_MINUTES,
    configNote: "Same router config as Preview: 10m time_threshold + 0.1% price_deviation + cron heartbeat.",
  },
  observed: {
    pack: path.relative(REPO_ROOT, packDir),
    packStamp: summary.pack_stamp ?? null,
    windowMinutes: round(observedMinutes, 2),
    txConfirmed,
    txFailed,
    avgNetworkFeeLovelacePerTx: round(avgFeeLovelace, 0),
    avgNetworkFeeAdaPerTx: round(avgFeeAda),
    feeSampleCount: feeCount,
    txPerMinute: round(observedTxPerMinute, 4),
  },
  forecastObservedRate: {
    method: "observed confirmed-tx rate x observed avg fee/tx, scaled to the window",
    projectedTx: round(projectedTx, 1),
    projectedNetworkFeeAda: round(projectedFeeAda),
  },
  forecastHeartbeatModel: {
    method: "cron-heartbeat floor: one coalesced batch tx per client per cycle",
    cycles: round(cycles, 2),
    batchTx: round(heartbeatBatchTx, 1),
    feePerBatchTxAda: round(heartbeatFeePerTxAda),
    batchCurve: batchModel
      ? { base: round(batchModel.base), perPair: round(batchModel.perPair), source: batchModel.source }
      : null,
    projectedNetworkFeeAda: round(heartbeatModelFeeAda),
  },
};

const lo = Math.min(projectedFeeAda, heartbeatModelFeeAda);
const hi = Math.max(projectedFeeAda, heartbeatModelFeeAda);

const md = `# Mainnet Cost Forecast — Recurring Feeder Network Fees

> Generated by \`offchain/feeder/scripts/cost-forecast/forecast-mainnet-cost.ts\`.
> Pure calculator over an existing evidence pack — no chain interaction.

This report sizes **only the recurring on-chain network fees of keeping the
feeder alive**. It deliberately excludes:

- **One-off deploy / bootstrap / teardown fees** — a separate, one-time spend.
  The current Mainnet deployment is reclaimed by the teardown (burns + ADA
  recovery), so most of that capital returns before redeploy.
- **Client-paid protocol fees** (\`0.6 ADA + 0.4 ADA x pairs\` per update) — paid
  by the client into their Receiver, not by the operator.

## Scenario

| Parameter | Value |
| --- | --- |
| Pairs | ${PAIRS} |
| Clients | ${CLIENTS} |
| Heartbeat (\`time_threshold\`) | ${HEARTBEAT_MIN} min |
| Price deviation | 0.1% |
| Forecast window | ${FORECAST_MINUTES} min |

Same router configuration as Preview (\`config/routers/preview/client-a-router-default.yaml\`):
OR-gate of \`price_deviation\` + a \`cron\` heartbeat at \`time_threshold\`.

## Observed baseline (source data)

From the evidence pack \`${json.observed.pack}\`:

| Metric | Value |
| --- | --- |
| Confirmed transactions | ${txConfirmed} |
| Failed transactions | ${txFailed} |
| Avg network fee / tx | ${ada(avgFeeAda)} (${Math.round(avgFeeLovelace).toLocaleString("en-US")} lovelace) |
| Confirmed-tx throughput | ${observedTxPerMinute.toFixed(4)} tx/min |

> Average fee is the mean of the \`dia_bridge_transaction_fee_lovelace\` histogram
> (${feeCount} samples). Throughput is derived from window-scoped \`SUMMARY.json\`
> totals, not from restart-resettable counters.

## Forecast for ${FORECAST_MINUTES} minutes

### Method 1 — observed rate (primary)

The pack ran the exact config planned for Mainnet, so its confirmed-tx rate is
the most faithful predictor.

- Projected transactions: **${projectedTx.toFixed(1)}**
- Projected network fees: **${ada(projectedFeeAda)}**

### Method 2 — heartbeat floor (cross-check)

Lower bound assuming the cron heartbeat is the only trigger and each client's
due pairs ride a single coalesced batch tx per cycle.

- Cycles: ${cycles.toFixed(2)} → batch transactions: ${heartbeatBatchTx.toFixed(1)}
- Fee per batch tx: ${ada(heartbeatFeePerTxAda)}${batchModel ? ` (from \`${batchModel.source}\`, fee = ${batchModel.base.toFixed(3)} + ${batchModel.perPair.toFixed(3)} x pairs)` : " (observed avg fee/tx)"}
- Projected network fees: **${ada(heartbeatModelFeeAda)}**

## Bottom line

Recurring network fees to keep the feeder alive for **${FORECAST_MINUTES} minutes**
on Mainnet land in the range **${lo.toFixed(2)} – ${hi.toFixed(2)} ADA**
(method 2 → method 1). Deploy/bootstrap and any extra working capital are
requested separately and are largely recoverable via teardown.
`;

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
const outMd = arg("out");
if (outMd) {
  const p = path.resolve(outMd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, md, "utf8");
  process.stderr.write(`[forecast-cost] wrote ${p}\n`);
}
const outJson = arg("json");
if (outJson) {
  const p = path.resolve(outJson);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n", "utf8");
  process.stderr.write(`[forecast-cost] wrote ${p}\n`);
}
process.stdout.write(JSON.stringify(json, null, 2) + "\n");
