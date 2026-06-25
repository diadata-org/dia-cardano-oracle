// Indexer constants — the single home for defaults, limits, fixed mappings, and
// allow-lists. Every tunable lives here: config.ts reads env and falls back to
// these; the chain reader reads its timeout here. Mirrors the cli/feeder
// `constants.ts` convention.

export type CardanoNetwork = "Mainnet" | "Preview";
export type IndexerProvider = "Blockfrost" | "Koios";

// --- defaults (overridable via env; see config.ts) -------------------------

/** Default target network when CARDANO_NETWORK is unset. */
export const DEFAULT_NETWORK: CardanoNetwork = "Preview";
/** Default chain provider when CARDANO_PROVIDER is unset. */
export const DEFAULT_PROVIDER: IndexerProvider = "Blockfrost";
/** Default HTTP listen port when INDEXER_PORT is unset. */
export const DEFAULT_PORT = 3001;
/** Valid TCP port range (for INDEXER_PORT validation). */
export const MIN_TCP_PORT = 1;
export const MAX_TCP_PORT = 65_535;

// --- allow-lists (config validation) ---------------------------------------

export const VALID_NETWORKS: readonly CardanoNetwork[] = ["Mainnet", "Preview"];
export const VALID_PROVIDERS: readonly IndexerProvider[] = ["Blockfrost", "Koios"];

// --- env var conventions (shared with the feeder/CLI) ----------------------

/** Per-network suffix for the shared provider env vars — IDENTICAL to the
 *  feeder/CLI so a single `.env` drives both (e.g. BLOCKFROST_PROJECT_ID_TESTNET
 *  on Preview, *_MAINNET on Mainnet). */
export const NETWORK_ENV_SUFFIX: Record<CardanoNetwork, string> = {
  Mainnet: "MAINNET",
  Preview: "TESTNET",
};

// --- limits ----------------------------------------------------------------

/** Per-request timeout for the chain-tip REST call (ms). */
export const TIP_TIMEOUT_MS = 15_000;

// --- metrics ---------------------------------------------------------------

/** Prometheus series prefix (`<namespace>_<metric>`). IDENTICAL to the feeder's
 *  `METRICS_NAMESPACE` so the indexer's `provider_requests_total` lands on the
 *  SAME series the feeder exposes; Prometheus separates the two services by the
 *  scrape `job` label, and a `sum by (provider)` query folds both together. */
export const METRICS_NAMESPACE = "dia_bridge";
