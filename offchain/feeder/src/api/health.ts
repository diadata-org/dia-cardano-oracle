// /healthz and /readyz handlers.
//
// /healthz — liveness: always 200 if the process is running.
// /readyz  — readiness: 200 only when:
//   - the EVM registry was reachable within the last `maxStalenessMs`
//   - the last successful submission (if any) is within `maxLastSubmitAge`
//
// Both handlers return JSON bodies.

export type HealthState = {
  /** Epoch-ms of the last successful registry poll. 0 = never. */
  lastRegistryPollMs: number;
  /** Epoch-ms of the last successful Cardano submission. 0 = never submitted. */
  lastSubmitMs: number;
  /** How long ago a registry poll is considered stale (ms). Default 5 min. */
  maxStalenessMs?: number;
  /** Max age of last submission before readiness fails (ms).
   *  If `0`, this check is skipped. Default 0 (skip). */
  maxLastSubmitAgeMs?: number;
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
  const maxAge = state.maxLastSubmitAgeMs ?? 0;

  const registryAge = now - state.lastRegistryPollMs;
  const registryOk = state.lastRegistryPollMs > 0 && registryAge <= staleness;

  const submitOk =
    maxAge === 0 ||
    state.lastSubmitMs === 0 ||
    now - state.lastSubmitMs <= maxAge;

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
    checks.submission = {
      ok: submitOk,
      detail: submitOk
        ? `last submission ${Math.round((now - state.lastSubmitMs) / 1000)}s ago`
        : `last submission ${Math.round((now - state.lastSubmitMs) / 1000)}s ago (too old)`,
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return { status: allOk ? "ok" : "degraded", checks };
}
