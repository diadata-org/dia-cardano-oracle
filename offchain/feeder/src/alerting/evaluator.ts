// Alert evaluator — periodic rules engine that fires and resolves alerts
// in the `alert_log` table.
//
// Current rules:
//   - OraclePairStale: fires when a price-cache entry has not been
//     refreshed within `pairStalenessThresholdMs`.
//
// TODO: add ScannerLag rule when scanner health is wired to HealthState.
// TODO: add WorkerQueueDepth rule once worker-pool queue depth is tracked.

import type { Db } from "../persistence/db.js";
import type { PriceCache } from "../processor/price-cache.js";

export type AlertEvaluatorOptions = {
  db: Db;
  priceCache: PriceCache;
  /** How often to evaluate alert rules (ms). Default: 30_000. */
  evaluationIntervalMs?: number;
  /** How old a price entry must be before OraclePairStale fires (ms). Default: 300_000. */
  pairStalenessThresholdMs?: number;
  /** Optional log sink for diagnostic messages. */
  log?: (line: string) => void;
  /** AbortSignal to stop the evaluator loop gracefully. */
  signal?: AbortSignal;
};

export type AlertEvaluatorHandle = {
  done: Promise<void>;
};

/**
 * Start the alert evaluator loop. Returns a handle whose `done` promise
 * resolves when the signal fires or the loop exits for any other reason.
 */
export function startAlertEvaluator(options: AlertEvaluatorOptions): AlertEvaluatorHandle {
  const {
    db,
    priceCache,
    evaluationIntervalMs = 30_000,
    pairStalenessThresholdMs = 300_000,
    log = () => {},
    signal,
  } = options;

  // Track active alert IDs keyed by a stable rule key so we don't re-fire
  // the same alert continuously and can resolve it when the condition clears.
  const activeAlertIds = new Map<string, number>();

  const done = runLoop();
  return { done };

  async function runLoop(): Promise<void> {
    while (!signal?.aborted) {
      await evaluate();
      await sleep(evaluationIntervalMs, signal);
      if (signal?.aborted) break;
    }
  }

  async function evaluate(): Promise<void> {
    const now = Date.now();

    // Rule: OraclePairStale
    for (const entry of priceCache.all()) {
      const age = now - entry.updatedAtMs;
      const ruleKey = `OraclePairStale:${entry.symbol}`;

      if (age > pairStalenessThresholdMs) {
        if (!activeAlertIds.has(ruleKey)) {
          try {
            const id = await db.recordAlert({
              name: "OraclePairStale",
              severity: "warning",
              message: `Oracle pair ${entry.symbol} has not been updated for ${Math.round(age / 1000)}s`,
              labels: { symbol: entry.symbol },
            });
            activeAlertIds.set(ruleKey, id);
            log(`[alert-evaluator] fired OraclePairStale id=${id} symbol=${entry.symbol}`);
          } catch (err) {
            log(`[alert-evaluator] failed to record alert: ${String(err)}`);
          }
        }
      } else {
        const existingId = activeAlertIds.get(ruleKey);
        if (existingId !== undefined) {
          try {
            await db.resolveAlert(existingId, now);
            activeAlertIds.delete(ruleKey);
            log(`[alert-evaluator] resolved OraclePairStale id=${existingId} symbol=${entry.symbol}`);
          } catch (err) {
            log(`[alert-evaluator] failed to resolve alert: ${String(err)}`);
          }
        }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
