// Cron service — Spectra parity (`internal/cron/cron_service.go`).
//
// Periodically scans every Cardano destination that opted into
// cron-driven liveness (`cron: true` in the router YAML) and re-submits
// the latest known intent for any symbol whose last on-chain confirm is
// older than the destination's `time_threshold`.
//
// Why this exists: the router policy can filter every incoming intent
// because the price barely moved (deviation below threshold). Without
// cron, the on-chain pair would stay stale even though DIA is emitting
// fresh data. The cron service guarantees a maximum staleness per pair.
//
// Submission goes through the same `queueManager.submit` path the
// event-driven flow uses, so the inflight lock, retry policy, and
// metric emission all behave identically. The Cardano contract's
// monotonicity check on `(timestamp, nonce)` ensures we never duplicate
// an on-chain update: if the latest known intent is the same one that
// is already on chain, the tx fails with `NonMonotonicNonce` and the
// daemon increments `transactions_failed_total{error_code=...}`. The
// counter `cron_resubmissions_total{outcome="skipped_already_fresh"}`
// captures the case where the cron tick decided NOT to submit because
// the on-chain timestamp is already at or beyond the cached intent.

import { setTimeout as sleep } from "node:timers/promises";

import type { CardanoDestinationConfig, RouterConfig } from "../config/types.js";
import type { FeederMetrics } from "../api/metrics.js";
import type { PriceCache } from "../processor/price-cache.js";
import type { LatestIntentCache } from "./latest-intent-cache.js";
import type { SubmitRequest, SubmitResult } from "../submitter/types.js";
import { parseDurationMs } from "../router/policy.js";

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export type CronServiceOptions = {
  /** Master switch — from `infrastructure.<network>.yaml::cron_service.enabled`. */
  enabled: boolean;
  /** Tick interval (ms). Sourced from `cron_service.tick_interval`. */
  tickIntervalMs: number;
  /** Map of routerId → RouterConfig. */
  routers: Record<string, RouterConfig>;
  /** Holds the latest known intent per (routerId, destIdx, symbol). */
  latestIntents: LatestIntentCache;
  /** Holds the latest CONFIRMED intent per (routerId, destIdx, symbol).
   *  Read-only here — written by the daemon's `onResult` callback. */
  priceCache: PriceCache;
  /** Submission entry point shared with the event-driven flow. */
  submit: (request: SubmitRequest) => Promise<SubmitResult>;
  /** Metrics emitter. */
  metrics: FeederMetrics;
  /** Structured log sink. */
  log: (line: string) => void;
  /** Abort signal for clean shutdown. */
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type CronServiceHandle = {
  /** Resolves when the service exits (signal aborted or `enabled: false`). */
  done: Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function startCronService(options: CronServiceOptions): CronServiceHandle {
  if (!options.enabled) {
    options.log("cron-service: disabled in config (cron_service.enabled=false).");
    return { done: Promise.resolve() };
  }

  options.log(
    `cron-service: starting (tick=${options.tickIntervalMs}ms, ` +
      `routers=${Object.keys(options.routers).length}).`,
  );

  const done = (async () => {
    while (!options.signal?.aborted) {
      try {
        await runOneTick(options);
      } catch (error) {
        options.log(`cron-service: tick failed — ${(error as Error).message}`);
      }
      await waitOrAbort(options.tickIntervalMs, options.signal);
    }
    options.log("cron-service: aborted.");
  })();

  return { done };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export async function runOneTick(options: CronServiceOptions): Promise<void> {
  const now = (options.now ?? Date.now)();

  for (const router of Object.values(options.routers)) {
    if (!router.enabled) continue;
    for (let destIdx = 0; destIdx < router.destinations.length; destIdx++) {
      const dest = router.destinations[destIdx]!;
      if (!dest.cardano || !dest.cron) continue;

      const symbol = extractDestinationSymbol(router);
      if (!symbol) {
        // Router does not bind a single symbol — cron resubmissions need
        // a (routerId, destIdx, symbol) tuple, so skip. The router YAML
        // is documented in the README cron section.
        continue;
      }

      const clientId = clientIdFromCardanoDestination(dest.cardano);
      const labels = {
        router_id: router.id,
        symbol,
        client_id: clientId,
      };

      const timeThresholdMs = parseDurationMs(dest.time_threshold);
      if (timeThresholdMs === undefined || timeThresholdMs === 0) continue;

      const confirmed = options.priceCache.get({ routerId: router.id, destinationIndex: destIdx, symbol });
      // If we have never confirmed anything on this pair, the cron path
      // cannot help — the event-driven flow has to mint/initialise it first.
      if (!confirmed) {
        options.metrics.cronResubmissions.inc({ ...labels, outcome: "skipped_uninitialised" });
        continue;
      }

      // The pair is fresh enough — no resubmission needed.
      if (now - confirmed.updatedAtMs <= timeThresholdMs) {
        continue;
      }

      const latest = options.latestIntents.get({
        routerId: router.id,
        destinationIndex: destIdx,
        symbol,
      });
      if (!latest) {
        options.metrics.cronResubmissions.inc({ ...labels, outcome: "skipped_no_intent" });
        continue;
      }

      // If the cached latest intent is the SAME one that is already
      // on chain, submitting again would fail with NonMonotonicNonce.
      // Skip cleanly.
      if (latest.intentHash === confirmed.intentHash) {
        options.metrics.cronResubmissions.inc({ ...labels, outcome: "skipped_already_fresh" });
        continue;
      }

      const request: SubmitRequest = {
        intentHash: latest.intentHash,
        enriched: latest.enriched,
        destination: dest.cardano,
        routerId: router.id,
        destinationIndex: destIdx,
      };

      options.log(
        `cron-service: resubmitting ${symbol} (router=${router.id}, ` +
          `confirmedAge=${Math.round((now - confirmed.updatedAtMs) / 1000)}s, ` +
          `threshold=${Math.round(timeThresholdMs / 1000)}s, ` +
          `intentHash=${latest.intentHash}).`,
      );
      options.metrics.cronResubmissions.inc({ ...labels, outcome: "submitted" });
      // Fire-and-forget: the queue manager records the result in metrics
      // and DB via the daemon's onResult callback the same way an
      // event-driven submission would.
      void options.submit(request);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The cron service emits one resubmission per (router, destination, symbol).
 * Our router YAML binds a router to a set of symbols via the
 * `conditions[].operator: in` filter on `event.symbol`. For cron to know
 * which symbol to resubmit, we pick the FIRST `symbol in [...]` condition
 * we find. Routers that match many symbols (or none) are skipped — the
 * operator can split them into one router per symbol if cron coverage is
 * required.
 */
function extractDestinationSymbol(router: RouterConfig): string | undefined {
  const conditions = router.triggers?.conditions ?? [];
  for (const cond of conditions) {
    if (cond.field === "event.symbol" && cond.operator === "in") {
      const values = cond.value;
      if (Array.isArray(values) && values.length === 1 && typeof values[0] === "string") {
        return values[0];
      }
    }
    if (cond.field === "event.symbol" && cond.operator === "eq" && typeof cond.value === "string") {
      return cond.value;
    }
  }
  return undefined;
}

function clientIdFromCardanoDestination(cardano: CardanoDestinationConfig): string {
  const path = cardano.client_state_path;
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.json$/, "");
}

async function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") return;
    throw error;
  }
}
