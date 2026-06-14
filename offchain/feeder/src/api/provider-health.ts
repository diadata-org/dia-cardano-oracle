// Cardano API provider health — primary vs secondary.
//
// The feeder talks to Cardano through two API providers with different roles:
//   - PRIMARY   — the provider lucid uses to build, sign, fetch protocol
//                 parameters/UTxOs, and submit. If it is down, NOTHING can be
//                 built → every pair freezes (e.g. a Blockfrost 402 quota wall).
//   - SECONDARY — the redundancy provider used for tx confirmation and reorg
//                 checks. If it is down, the system keeps working but loses
//                 confirmation/reorg redundancy.
//
// Which provider plays which role follows the configured `CARDANO_PROVIDER`
// (mirrors offchain/cli core config), so the critical alert always tracks
// whichever provider actually builds transactions — swap the env and the roles
// (and the alerts) follow.
//
// Health is exposed as two metrics, both labelled by `{provider, role}`:
//   - bridge_component_health                  — 1 healthy / 0 unhealthy
//   - bridge_provider_last_ok_timestamp_seconds — unix seconds of the last OK
// The PrimaryProviderDown / SecondaryProviderDown alerts fire on
// `time() - last_ok > alerting.provider_<role>_unhealthy_seconds`. The last-ok
// gauge is the authoritative alert signal: it ages on its own when calls stop
// landing, so the alert fires even if the recording loop itself stalls.
//
// Measurement:
//   - PRIMARY is exercised on every balance-refresh tick, so its health is
//     recorded PASSIVELY from those calls — no extra provider load.
//   - SECONDARY is only called on demand, so "idle" cannot be told from "down"
//     passively; it is probed ACTIVELY with one cheap read per tick.

import type { FeederMetrics } from "./metrics.js";

export type CardanoProviderName = "Blockfrost" | "Koios";
export type ProviderRole = "primary" | "secondary";

export type ProviderRoles = {
  /** The lucid build/submit provider. */
  primary: CardanoProviderName;
  /** The confirmation/reorg redundancy provider. */
  secondary: CardanoProviderName;
};

/** Resolve provider roles from the `CARDANO_PROVIDER` env var, mirroring the
 *  offchain/cli core config (`Koios` selects Koios as the lucid provider;
 *  anything else means Blockfrost). The other provider is the secondary. */
export function resolveProviderRoles(cardanoProviderEnv: string | undefined): ProviderRoles {
  const primary: CardanoProviderName =
    cardanoProviderEnv?.trim() === "Koios" ? "Koios" : "Blockfrost";
  return { primary, secondary: primary === "Koios" ? "Blockfrost" : "Koios" };
}

export type ProviderHealthRecorder = {
  /** Record the outcome of an interaction with `provider` acting in `role`.
   *  Success sets the health gauge to 1 and bumps the last-ok timestamp; failure
   *  sets the gauge to 0 and leaves the timestamp to age (so the down-alert
   *  fires on staleness). */
  record(role: ProviderRole, provider: CardanoProviderName, ok: boolean, nowMs?: number): void;
};

export function createProviderHealthRecorder(
  metrics: FeederMetrics,
  now: () => number = Date.now,
): ProviderHealthRecorder {
  return {
    record(role, provider, ok, nowMs) {
      const component = provider.toLowerCase();
      metrics.bridgeComponentHealth.set({ component, role }, ok ? 1 : 0);
      if (ok) {
        metrics.bridgeProviderLastOkTimestampSeconds.set(
          { provider: component, role },
          Math.floor((nowMs ?? now()) / 1000),
        );
      }
    },
  };
}

export type ProbeProviderOptions = {
  koiosApiUrl?: string;
  blockfrostApiUrl?: string;
  blockfrostProjectId?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/** Active liveness probe for the SECONDARY provider — hits a cheap read endpoint
 *  (Koios `/tip`, Blockfrost `/blocks/latest`) and returns whether it answered.
 *  Used because the secondary is only called on demand, so passive last-ok
 *  tracking cannot distinguish "idle" from "down". Returns false on any
 *  network/timeout/non-2xx outcome — never throws. */
export async function probeProvider(
  provider: CardanoProviderName,
  opts: ProbeProviderOptions,
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    if (provider === "Koios") {
      if (!opts.koiosApiUrl) return false;
      const res = await fetchImpl(`${trimTrailingSlash(opts.koiosApiUrl)}/tip`, {
        signal: controller.signal,
      });
      return res.ok;
    }
    if (!opts.blockfrostApiUrl || !opts.blockfrostProjectId) return false;
    const res = await fetchImpl(`${trimTrailingSlash(opts.blockfrostApiUrl)}/blocks/latest`, {
      headers: { project_id: opts.blockfrostProjectId },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
