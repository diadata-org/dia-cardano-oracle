// ---------------------------------------------------------------------------
// constants.ts — single home for the CLI's code-level constants and
// env-overridable defaults.
//
// SCOPE
//   This file holds *code-level* defaults and magic numbers/labels that carry
//   real meaning: retry budgets, timeouts, min-utxo floors, protocol:init
//   seed defaults, deposit tx-build caps, asset labels, etc. It does NOT hold
//   anything sourced from configuration — values read from `.env`,
//   `config-bootstrap.json::configState`, or a YAML stay config-sourced and
//   are NOT duplicated here.
//
// ENV-OVERRIDE CONVENTION
//   Where a default is env-overridable, the DEFAULT_* constant lives here and
//   the consuming module reads it via the `envNumber`/`envString` helpers
//   (also exported here). The env var name is documented next to each default.
//   Override at runtime by exporting the named env var; an invalid value
//   throws rather than silently falling back.
//
//   READMEs and operator docs should point here for the authoritative list of
//   tunable defaults rather than restating values inline.
//
// WHAT IS DELIBERATELY *NOT* HERE
//   Trivial structural literals are intentionally left in place because
//   centralising them hurts readability: array indices, 0/1/-1, "" initialisers,
//   discriminated-union constructor tags (e.g. `new Constr(0, [])`), log/error
//   message strings, one-off local values, and test fixtures.
// ---------------------------------------------------------------------------

// ===========================================================================
// Env-override helpers
// ===========================================================================

/**
 * Read a positive-number env override, falling back to `fallback` when the var
 * is unset/empty. Throws on a non-finite or non-positive value so a typo in an
 * operator's shell never silently degrades a timeout/attempt budget.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${name}=${raw}: expected a positive number of milliseconds or attempts.`,
    );
  }
  return value;
}

/**
 * Read a non-empty string env override, falling back to `fallback` when the
 * var is unset/empty.
 */
export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

// ===========================================================================
// Tx build — completeWithRetry (lucid-evolution WASM flakiness)
// ===========================================================================
// `.complete()` occasionally throws a transient WASM error
// ("detached ArrayBuffer" / "%TypedArray%.prototype.set") when lucid's WASM
// memory grows mid-build and detaches a held TypedArray view. completeWithRetry
// retries the SAME build on that specific error only; all other errors rethrow.
//
//   TX_BUILD_ATTEMPTS        (default 3)    total build attempts
//   TX_BUILD_RETRY_DELAY_MS  (default 300)  backoff between attempts
export const DEFAULT_TX_BUILD_ATTEMPTS = 3;
export const DEFAULT_TX_BUILD_RETRY_DELAY_MS = 300;

// ===========================================================================
// Tx confirmation — multi-provider confirmation pipeline
// ===========================================================================
// Each stage can be independently overridden when the network is congested.
// Total worst-case window with defaults: ~9 minutes across 3 providers.
//
//   TX_CONFIRMATION_PRIMARY_TIMEOUT_MS    (default 180_000 = 3 min)
//   TX_CONFIRMATION_KOIOS_ATTEMPTS        (default 60)
//   TX_CONFIRMATION_KOIOS_DELAY_MS        (default 3_000)  = 60 × 3 s = 3 min
//   TX_CONFIRMATION_BLOCKFROST_ATTEMPTS   (default 30)
//   TX_CONFIRMATION_BLOCKFROST_DELAY_MS   (default 6_000)  = 30 × 6 s = 3 min
export const DEFAULT_TX_CONFIRMATION_PRIMARY_TIMEOUT_MS = 180_000;
export const DEFAULT_TX_CONFIRMATION_KOIOS_ATTEMPTS = 60;
export const DEFAULT_TX_CONFIRMATION_KOIOS_DELAY_MS = 3_000;
export const DEFAULT_TX_CONFIRMATION_BLOCKFROST_ATTEMPTS = 30;
export const DEFAULT_TX_CONFIRMATION_BLOCKFROST_DELAY_MS = 6_000;

// ===========================================================================
// Reference-script / min-utxo
// ===========================================================================
// Minimum lovelace parked on a freshly-bootstrapped reference-script UTxO.
export const BOOTSTRAP_REF_MIN_LOVELACE = 1_000_000n;

// ===========================================================================
// Rollback detection (chain-helpers wait loops)
// ===========================================================================
// Inside the long "wait 3" / wallet-settlement polling loops, rollback
// detection runs every ROLLBACK_CHECK_INTERVAL attempts (~90 s at the default
// 1.5 s per-attempt delay).
export const ROLLBACK_CHECK_INTERVAL = 60;

// ===========================================================================
// protocol:init seed defaults
// ===========================================================================
// Seed values written into config-bootstrap.json::configState on a fresh
// `protocol:init` when no explicit flags are supplied. Once written they are
// config-sourced; these constants are only the first-run fallbacks.
export const DEFAULT_BASE_FEE_LOVELACE = "600000"; // 0.6 ADA base fee
export const DEFAULT_PER_PAIR_FEE_LOVELACE = "400000"; // 0.40 ADA per pair
export const DEFAULT_MAX_BOOTSTRAP_DRIFT_SECONDS = "300"; // 5 minutes
export const DEFAULT_MIN_UTXO_LOVELACE = "5000000";
export const DEFAULT_CONFIG_ASSET_LABEL = "DIA_CONFIG";
export const DEFAULT_PAYMENT_HOOK_ASSET_LABEL = "DIA_PAYMENT_HOOK";

// ===========================================================================
// Deposit tx-build defaults
// ===========================================================================
// Shared with the feeder via config-bootstrap.json. CLI flags
// (--deposit-min-lovelace / --deposit-max-per-merge /
// --deposit-max-per-update-fold) override these on `protocol:init`.
export const DEFAULT_DEPOSIT_MIN_LOVELACE = "1000000"; // 1 ADA — deposit dust floor
export const DEFAULT_DEPOSIT_MAX_PER_MERGE = "20"; // max deposit UTxOs folded into one merge tx
export const DEFAULT_DEPOSIT_MAX_PER_UPDATE_FOLD = "3"; // max deposit UTxOs an update may fold opportunistically
