// /health/live and /health/ready handlers.
//
// /health/live  — liveness: always 200 if the process is running.
// /health/ready — readiness: 200 only when:
//   - the EVM registry was reachable within the last `maxStalenessMs`
//   - the last confirmed Cardano oracle update (if any) is within
//     `maxLastConfirmedAgeMs` (config key: `api.readiness.max_last_confirmed_age`).
//
// Both handlers return JSON bodies.

import { DEFAULT_MAX_STALENESS_MS } from "../config/constants.js";

export type HealthState = {
  /** Epoch-ms of the last successful registry poll. 0 = never. */
  lastRegistryPollMs: number;
  /** Epoch-ms of the last Cardano submission that reached `tx_confirmed`.
   *  Updated by the daemon's `onResult` callback ONLY after the result is
   *  ok (i.e. post-confirmation, not post-submit). 0 = never confirmed. */
  lastConfirmedMs: number;
  /** How long ago a registry poll is considered stale (ms). Default 5 min. */
  maxStalenessMs?: number;
  /** Max age of the last confirmed tx before readiness fails (ms).
   *  Sourced from `infrastructure.<network>.yaml::api.readiness.max_last_confirmed_age`.
   *  If `0`, this check is skipped. */
  maxLastConfirmedAgeMs?: number;
  /** Current worker queue depth. When > maxQueueSize, readiness fails with
   *  component "worker_queue". */
  workerQueueDepth?: number;
  /** Maximum worker queue depth before readiness fails. When absent the
   *  queue-depth check is skipped. */
  maxQueueSize?: number;
  /** Whether the scanner is reporting healthy. When false, readiness fails
   *  with component "scanner". */
  scannerIsHealthy?: boolean;
  /** Whether the primary Cardano API provider (the lucid build/submit provider)
   *  is reachable. When false, readiness fails with component
   *  "cardano_provider" — the feeder cannot build any update. Set by the
   *  daemon's balance-refresh pass; undefined skips the check. */
  primaryProviderHealthy?: boolean;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
};

export type HealthResult = {
  status: "ok" | "degraded";
  checks: Record<string, { ok: boolean; detail?: string }>;
};

export function livenessResult(): HealthResult {
  return {
    status: "ok",
    checks: { process: { ok: true } },
  };
}

export function readinessResult(state: HealthState): HealthResult {
  const now = (state.now ?? Date.now)();
  const staleness = state.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS;
  const maxAge = state.maxLastConfirmedAgeMs ?? 0;

  const registryAge = now - state.lastRegistryPollMs;
  const registryOk = state.lastRegistryPollMs > 0 && registryAge <= staleness;

  const confirmedOk =
    maxAge === 0 ||
    state.lastConfirmedMs === 0 ||
    now - state.lastConfirmedMs <= maxAge;

  const checks: HealthResult["checks"] = {
    registry: {
      ok: registryOk,
      detail: registryOk
        ? `last poll ${Math.round(registryAge / 1000)}s ago`
        : state.lastRegistryPollMs === 0
          ? "never polled"
          : `last poll ${Math.round(registryAge / 1000)}s ago (stale)`,
    },
  };

  if (maxAge > 0) {
    checks.confirmation = {
      ok: confirmedOk,
      detail: confirmedOk
        ? `last confirmed tx ${Math.round((now - state.lastConfirmedMs) / 1000)}s ago`
        : `last confirmed tx ${Math.round((now - state.lastConfirmedMs) / 1000)}s ago (older than max_last_confirmed_age)`,
    };
  }

  // Worker queue depth check.
  if (state.maxQueueSize !== undefined && state.workerQueueDepth !== undefined) {
    const queueOk = state.workerQueueDepth <= state.maxQueueSize;
    checks.worker_queue = {
      ok: queueOk,
      detail: queueOk
        ? `depth ${state.workerQueueDepth}/${state.maxQueueSize}`
        : `depth ${state.workerQueueDepth} exceeds max ${state.maxQueueSize}`,
    };
  }

  // Scanner health check.
  if (state.scannerIsHealthy !== undefined) {
    checks.scanner = {
      ok: state.scannerIsHealthy,
      detail: state.scannerIsHealthy ? "scanner healthy" : "scanner unhealthy",
    };
  }

  // Primary Cardano provider check — when the build/submit provider is
  // unreachable, the feeder cannot produce any update, so readiness fails.
  if (state.primaryProviderHealthy !== undefined) {
    checks.cardano_provider = {
      ok: state.primaryProviderHealthy,
      detail: state.primaryProviderHealthy
        ? "primary provider reachable"
        : "primary provider unreachable",
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return { status: allOk ? "ok" : "degraded", checks };
}
