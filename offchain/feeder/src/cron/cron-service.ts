// Cron service — periodic staleness check and resubmission loop.
//
// Ticks every `cron_service.tick_interval` and scans every Cardano
// destination that opted into cron-driven liveness (`cron: true` in the
// router YAML). For each such destination it re-submits the latest known
// intent for any symbol whose last on-chain confirm is older than the
// destination's resubmission ceiling.
//
// Resubmission ceiling per destination:
//   - `time_threshold` > 0      → the short periodic heartbeat (classic
//                                  behaviour; resubmit once a pair is older
//                                  than `time_threshold`).
//   - `time_threshold` 0/absent + `max_staleness` set → deviation-only push
//                                  mode (B6): the short heartbeat is OFF, so
//                                  the cron uses `max_staleness` as the
//                                  ceiling — it only resubmits once a pair
//                                  exceeds `max_staleness`, leaving the
//                                  deviation gate to drive normal updates.
//                                  Fewer Cardano txs, lower fees.
//   - neither set               → no cron cadence; the destination is skipped.
//
// Why this exists: the router policy can filter every incoming intent
// because the price barely moved (deviation below threshold). Without
// cron, the on-chain pair would stay stale even though DIA is emitting
// fresh data. The cron service guarantees a maximum staleness per pair.
//
// Submission goes through the same coalescer path the event-driven flow uses.
// That keeps cron-triggered symbols batched per lane and lets newer intents
// supersede older buffered ones instead of building a FIFO backlog. The
// Cardano contract's monotonicity check on `(timestamp, nonce)` ensures we
// never duplicate an on-chain update: if the latest known intent is the same
// one that is already on chain, the cron skips it cleanly and increments
// `cron_resubmissions_total{outcome="skipped_already_fresh"}`.

import { setTimeout as sleep } from "node:timers/promises";

import type { CardanoDestinationConfig, RouterConfig } from "../config/types.js";
import type { FeederMetrics } from "../api/metrics.js";
import type { PriceCache } from "../processor/price-cache.js";
import type { LatestIntentCache } from "./latest-intent-cache.js";
import type { SubmitRequest } from "../submitter/types.js";
import { parseDurationMs } from "../router/policy.js";
import { extractRouterSymbols } from "../router/symbols.js";

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
  submit: (request: SubmitRequest) => void | Promise<unknown>;
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

  // One-time startup audit: warn about cron-enabled destinations that have
  // no symbol filter. The per-tick loop silently skips them (cron needs a
  // (routerId, destIdx, symbol) tuple), so without this warning an operator
  // who set `cron: true` would get no staleness protection and no signal.
  for (const router of Object.values(options.routers)) {
    if (!router.enabled) continue;
    const hasCronDest = router.destinations.some((d) => d.cardano && d.cron);
    if (hasCronDest && extractRouterSymbols(router).length === 0) {
      options.log(
        `[warn] cron-service: router "${router.id}" has cron-enabled destination(s) but no ` +
          `symbol filter in triggers.conditions — cron resubmissions are SKIPPED for it. ` +
          `Add an event.symbol eq/in condition to enable cron staleness protection.`,
      );
    }
  }

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

      const symbols = extractRouterSymbols(router);
      if (symbols.length === 0) {
        // Router has no symbol filter — cron resubmissions need a
        // (routerId, destIdx, symbol) tuple. The router YAML is
        // documented in the README cron section.
        continue;
      }

      // Resubmission ceiling: the short `time_threshold` heartbeat when set,
      // otherwise the long `max_staleness` bound in deviation-only push mode.
      const timeThresholdMs = parseDurationMs(dest.time_threshold);
      const maxStalenessMs = parseDurationMs(dest.max_staleness);
      const ceilingMs =
        timeThresholdMs !== undefined && timeThresholdMs > 0 ? timeThresholdMs : maxStalenessMs;
      // No cadence configured (no heartbeat and no max_staleness) — nothing to
      // enforce; the deviation gate alone drives this destination.
      if (ceilingMs === undefined || ceilingMs === 0) continue;

      const clientId = clientIdFromCardanoDestination(dest.cardano);

      for (const symbol of symbols) {
        const labels: Record<string, string> = {
          router_id: router.id,
          symbol,
          client_id: clientId,
        };
        if (router.customer) {
          labels.customer = router.customer;
        }

        const confirmed = options.priceCache.get({ routerId: router.id, destinationIndex: destIdx, symbol });
        // If we have never confirmed anything on this pair, the cron path
        // cannot help — the event-driven flow has to mint/initialise it first.
        if (!confirmed) {
          options.metrics.cronResubmissions.inc({ ...labels, outcome: "skipped_uninitialised" });
          continue;
        }

        // The pair is fresh enough — no resubmission needed.
        if (now - confirmed.updatedAtMs <= ceilingMs) {
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
            `ceiling=${Math.round(ceilingMs / 1000)}s, ` +
            `intentHash=${latest.intentHash}).`,
        );
        options.metrics.cronResubmissions.inc({ ...labels, outcome: "submitted" });
        // Fire-and-forget: the coalescer/queue records the result in metrics
        // and DB via the daemon's onResult callback the same way an
        // event-driven submission would.
        Promise.resolve(options.submit(request)).catch((err: unknown) => {
          options.log(
            `cron-service: submit failed for ${symbol} (router=${router.id}) — ${(err as Error).message}`,
          );
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
