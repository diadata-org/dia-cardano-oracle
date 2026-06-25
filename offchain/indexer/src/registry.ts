// Protocol registry — the public script identifiers the indexer reads from
// chain. With the registry plus a provider key the indexer runs on its own.
//
// Pair and Receiver scripts are parameterised per client (per Receiver), so the
// registry is a list of clients; each carries the pair policy + validator
// address to enumerate that client's published pairs, and the Receiver address
// + NFT unit to read its balance. The values come from the shared state tree via
// the loader in registry-config.ts.

/** One deployed client: where its pairs and Receiver live on-chain. */
export interface RegistryClient {
  /** Stable client identifier (matches the feeder's client state basename). */
  clientId: string;
  /** Minting policy id of this client's Pair NFTs. */
  pairPolicyId: string;
  /** Address of the pair_state validator holding this client's Pair UTxOs. */
  pairValidatorAddress: string;
  /** Address of the receiver validator holding this client's Receiver UTxO. */
  receiverValidatorAddress: string;
  /** Full asset unit (policyId+assetName) of this client's Receiver NFT. */
  receiverUnit: string;
}

/** The single Config UTxO of a deployment — where the protocol-wide parameters
 *  (the fee formula inputs) live on-chain. */
export interface RegistryConfig {
  /** Address of the config validator holding the Config UTxO. */
  configValidatorAddress: string;
  /** Full asset unit (policyId+assetName) of the Config NFT marking it. */
  configUnit: string;
}

/** The published registry for one network. */
export interface Registry {
  /** "Mainnet" | "Preview" (informational; the reader is network-agnostic). */
  network: string;
  /** The Config UTxO location, when the protocol has been bootstrapped. Absent
   *  for a registry published from client addresses alone. */
  config?: RegistryConfig;
  /** Every deployed client whose pairs the indexer serves. */
  clients: RegistryClient[];
}
