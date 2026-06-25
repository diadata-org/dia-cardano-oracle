// Index service — the consumer-facing query layer.
//
// Combines the registry (where the scripts live), the chain reader (live UTxOs +
// tip), and the shared datum decoders (A1) into the four questions a dApp asks:
//   listPairs()        every published pair's latest on-chain value
//   getPair(symbol)    one pair's latest value + the UTxO ref to reference-input
//   getClient(id)      a client's Receiver balance + the pairs it publishes
//   getProtocolFees()  the on-chain fee formula inputs (what an update costs)
//   health()           provider reachable, chain tip, pair count
//
// Source of truth is the live chain (the on-chain UTxOs). Pure aside from the
// injected reader/clock, so it is unit-tested against a fake reader.

import {
  decodeConfigFees,
  decodePairDatum,
  decodeReceiverDatum,
} from "@diadata-org/dia-cardano-oracle-cli/core/datum-decoders";

import type { ChainReader, ChainTip, IndexerUtxo } from "./chain-reader.js";
import type { Registry, RegistryClient } from "./registry.js";
import { pairIdToSymbol } from "./pair-codec.js";

// ---------------------------------------------------------------------------
// Served shapes (decoded, consumer-facing)
// ---------------------------------------------------------------------------

export interface Pair {
  /** DIA symbol, e.g. "BTC/USD" (decoded from the datum's pairId). */
  symbol: string;
  pairId: string;
  /** Policy id of the Pair NFT. A consumer needs it to authenticate the feed:
   *  the reference input must carry this policy's NFT (asset name derived from
   *  pairId). Public identifier — see the published addresses table. */
  pairPolicyId: string;
  /** Latest published price (integer string, DIA's fixed-point encoding). */
  price: string;
  /** Source timestamp the price was observed at (unix seconds, string). */
  timestamp: string;
  nonce: string;
  signer: string;
  intentHash: string;
  minUtxoLovelace: string;
  /** The exact TxIn to use as a reference input when consuming this feed. */
  utxoRef: { txHash: string; outputIndex: number };
  /** now − timestamp, in seconds (≥ 0). Freshness at query time. */
  ageSeconds: number;
  /** Client that published this pair (which Receiver it settles into). */
  clientId: string;
}

export interface ClientInfo {
  clientId: string;
  receiverBalanceLovelace: string;
  accruedToHookLovelace: string;
  /** Symbols this client currently publishes on-chain. */
  subscribedPairs: string[];
}

export interface IndexHealth {
  tip: ChainTip;
  pairCount: number;
}

export interface ProtocolFees {
  /** Constant component of the fee formula (lovelace, string). */
  baseFeeLovelace: string;
  /** Per-pair component of the fee formula (lovelace, string). */
  perPairFeeLovelace: string;
  /** Fee an `n`-pair update costs: `base + n × perPair` (lovelace, string). */
  feeForPairs(n: number): string;
}

export interface IndexService {
  listPairs(): Promise<Pair[]>;
  getPair(symbol: string): Promise<Pair | null>;
  listClients(): Promise<ClientInfo[]>;
  getClient(clientId: string): Promise<ClientInfo | null>;
  /** The protocol fee parameters read from the on-chain Config UTxO. Null when
   *  the deployment is not bootstrapped (no Config) or the registry omits it. */
  getProtocolFees(): Promise<ProtocolFees | null>;
  health(): Promise<IndexHealth>;
}

export interface IndexServiceOptions {
  reader: ChainReader;
  registry: Registry;
  /** Injectable clock (ms since epoch) for deterministic `ageSeconds` in tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** True if the UTxO holds at least one asset minted under `policyId`. */
function holdsPolicy(utxo: IndexerUtxo, policyId: string): boolean {
  return Object.keys(utxo.assets).some(
    (unit) => unit !== "lovelace" && unit.startsWith(policyId),
  );
}

/** True if the UTxO holds exactly the given asset unit (policyId+assetName). */
function holdsUnit(utxo: IndexerUtxo, unit: string): boolean {
  return (utxo.assets[unit] ?? 0n) > 0n;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIndexService(options: IndexServiceOptions): IndexService {
  const { reader, registry } = options;
  const clock = options.now ?? Date.now;

  /** Decode every Pair UTxO published by one client. */
  async function pairsForClient(client: RegistryClient): Promise<Pair[]> {
    const utxos = await reader.utxosAt(client.pairValidatorAddress);
    const nowSec = clock() / 1_000;
    const pairs: Pair[] = [];
    for (const utxo of utxos) {
      // A Pair UTxO must carry a Pair NFT and an inline datum; anything else at
      // the address (dust, mis-sends) is ignored.
      if (!utxo.datum || !holdsPolicy(utxo, client.pairPolicyId)) continue;
      const decoded = decodePairDatum(utxo.datum);
      pairs.push({
        symbol: pairIdToSymbol(decoded.pairId),
        pairId: decoded.pairId,
        pairPolicyId: client.pairPolicyId,
        price: decoded.price,
        timestamp: decoded.timestamp,
        nonce: decoded.nonce,
        signer: decoded.signer,
        intentHash: decoded.intentHash,
        minUtxoLovelace: decoded.minUtxoLovelace,
        utxoRef: { txHash: utxo.txHash, outputIndex: utxo.outputIndex },
        ageSeconds: Math.max(0, Math.floor(nowSec - Number(decoded.timestamp))),
        clientId: client.clientId,
      });
    }
    return pairs;
  }

  async function listPairs(): Promise<Pair[]> {
    const perClient = await Promise.all(registry.clients.map(pairsForClient));
    return perClient.flat();
  }

  /** Build one client's view (receiver balance + subscribed pairs). Returns null
   *  when the client's canonical Receiver UTxO is not on-chain (yet). */
  async function clientInfoFor(client: RegistryClient): Promise<ClientInfo | null> {
    const utxos = await reader.utxosAt(client.receiverValidatorAddress);
    const receiverUtxo = utxos.find(
      (utxo) => utxo.datum != null && holdsUnit(utxo, client.receiverUnit),
    );
    if (!receiverUtxo?.datum) return null;

    const receiver = decodeReceiverDatum(receiverUtxo.datum);
    const subscribedPairs = (await pairsForClient(client)).map((pair) => pair.symbol);

    return {
      clientId: client.clientId,
      receiverBalanceLovelace: receiver.balanceLovelace,
      accruedToHookLovelace: receiver.accruedToHookLovelace,
      subscribedPairs,
    };
  }

  return {
    listPairs,

    async getPair(symbol: string): Promise<Pair | null> {
      // Reuse listPairs and match on the decoded symbol — keeps one decode path.
      const pairs = await listPairs();
      return pairs.find((pair) => pair.symbol === symbol) ?? null;
    },

    async listClients(): Promise<ClientInfo[]> {
      const infos = await Promise.all(registry.clients.map(clientInfoFor));
      return infos.filter((info): info is ClientInfo => info !== null);
    },

    async getClient(clientId: string): Promise<ClientInfo | null> {
      const client = registry.clients.find((c) => c.clientId === clientId);
      if (!client) return null;
      return clientInfoFor(client);
    },

    async getProtocolFees(): Promise<ProtocolFees | null> {
      if (!registry.config) return null;
      const utxos = await reader.utxosAt(registry.config.configValidatorAddress);
      const configUtxo = utxos.find(
        (utxo) => utxo.datum != null && holdsUnit(utxo, registry.config!.configUnit),
      );
      if (!configUtxo?.datum) return null;

      const { baseFeeLovelace, perPairFeeLovelace } = decodeConfigFees(configUtxo.datum);
      return {
        baseFeeLovelace,
        perPairFeeLovelace,
        feeForPairs: (n: number) =>
          (BigInt(baseFeeLovelace) + BigInt(n) * BigInt(perPairFeeLovelace)).toString(),
      };
    },

    async health(): Promise<IndexHealth> {
      const [tip, pairs] = await Promise.all([reader.tip(), listPairs()]);
      return { tip, pairCount: pairs.length };
    },
  };
}
