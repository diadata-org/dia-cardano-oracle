// Per-network env reader — secrets and selectors only.
//
// Every public data point (chain ids, RPC URLs, WS URLs, registry
// addresses, ABIs) lives in the YAML config under `config/`. This
// module is reserved for things that cannot live in YAML:
//
//   - secrets (WS credentials, wallet seeds — the latter via the
//     submitter, not the source side),
//   - informational values that have no Spectra-shaped YAML home
//     (the DIA explorer URL).
//
// The `_TESTNET` / `_MAINNET` suffix scheme matches the CLI.

export type CardanoNetwork = "Preview" | "Mainnet";

const NETWORK_SUFFIX: Record<CardanoNetwork, "TESTNET" | "MAINNET"> = {
  Preview: "TESTNET",
  Mainnet: "MAINNET",
};

/**
 * Compose the env var name for a given base and Cardano network:
 *
 *     envVarFor("DIA_WS_CREDENTIAL", "Preview") -> "DIA_WS_CREDENTIAL_TESTNET"
 *     envVarFor("DIA_WS_CREDENTIAL", "Mainnet") -> "DIA_WS_CREDENTIAL_MAINNET"
 */
export function envVarFor(base: string, network: CardanoNetwork): string {
  return `${base}_${NETWORK_SUFFIX[network]}`;
}

/**
 * Read a required env var for the active network. Throws with a
 * specific, operator-friendly message that names the missing var so
 * misconfiguration is obvious.
 */
export function requireNetworkEnv(base: string, network: CardanoNetwork): string {
  const name = envVarFor(base, network);
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} (CARDANO_NETWORK=${network}).`,
    );
  }
  return value;
}

/** Read an optional env var; return `undefined` when absent or empty. */
export function readNetworkEnv(base: string, network: CardanoNetwork): string | undefined {
  return process.env[envVarFor(base, network)]?.trim() || undefined;
}

/**
 * Read the DIA explorer URL for the active network. Informational
 * only: used by log rendering and explorer link-out. Returns
 * `undefined` when the operator has not configured it.
 *
 * Kept in env (not YAML) because the Spectra Bridge does not
 * catalogue explorer URLs in its YAML schema and the feeder mirrors
 * that schema verbatim.
 */
export function readDiaExplorerUrl(network: CardanoNetwork): string | undefined {
  return readNetworkEnv("DIA_EXPLORER_URL", network);
}
