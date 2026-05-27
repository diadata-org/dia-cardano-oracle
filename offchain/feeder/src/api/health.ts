// /health/live and /health/ready handlers.
//
// /health/live  — liveness: always 200 if the process is running.
// /health/ready — readiness: 200 only when:
//   - the EVM registry was reachable within the last `maxStalenessMs`
//   - the last confirmed Cardano oracle update (if any) is within
//     `maxLastConfirmedAgeMs` (config key: `api.readiness.max_last_confirmed_age`).
//
// Both handlers return JSON bodies.

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
  const staleness = state.maxStalenessMs ?? 5 * 60_000;
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

  const allOk = Object.values(checks).every((c) => c.ok);
  return { status: allOk ? "ok" : "degraded", checks };
}
