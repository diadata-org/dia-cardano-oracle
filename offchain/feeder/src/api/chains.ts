import type { ModularConfig } from "../config/types.js";
import type { ChainStateRow, Db } from "../persistence/index.js";

export type ChainRuntimeEntry = {
  chainId: number;
  scannerType?: string;
  headBlock?: bigint;
};

export type ChainRuntimeState = {
  entries(): IterableIterator<ChainRuntimeEntry>;
  set(entry: ChainRuntimeEntry): void;
};

export type ChainStatusEntry = {
  id: string;
  chainId: number;
  name: string;
  enabled: boolean;
  rpcUrls: string[];
  isActiveSource: boolean;
  scannerType?: string;
  headBlock?: string;
  lastProcessedBlock?: string;
  blockLag?: string;
  updatedAtMs?: number;
};

export type ChainsResponse = {
  count: number;
  chains: ChainStatusEntry[];
};

export function createChainRuntimeState(): ChainRuntimeState {
  const store = new Map<number, ChainRuntimeEntry>();
  return {
    *entries() {
      yield* store.values();
    },
    set(entry) {
      store.set(entry.chainId, entry);
    },
  };
}

export async function buildChainsResponse(
  config: ModularConfig,
  db: Db,
  runtime: ChainRuntimeState,
): Promise<ChainsResponse> {
  const chains = await collectChainStatuses(config, db, runtime);
  return { count: chains.length, chains };
}

export async function buildChainStatusResponse(
  config: ModularConfig,
  db: Db,
  runtime: ChainRuntimeState,
  chainIdOrKey: string,
): Promise<ChainStatusEntry | null> {
  const chains = await collectChainStatuses(config, db, runtime);
  return chains.find(
    (entry) => entry.id === chainIdOrKey || String(entry.chainId) === chainIdOrKey,
  ) ?? null;
}

async function collectChainStatuses(
  config: ModularConfig,
  db: Db,
  runtime: ChainRuntimeState,
): Promise<ChainStatusEntry[]> {
  const persisted = await db.listChainStates();
  const persistedByChainId = latestChainStateByChainId(persisted);
  const runtimeByChainId = new Map(
    Array.from(runtime.entries(), (entry) => [entry.chainId, entry] as const),
  );
  const activeSourceChainId = config.infrastructure?.source?.chain_id;

  const chains = Object.entries(config.chains).map(([id, chain]) => {
    const persistedState = persistedByChainId.get(chain.chain_id);
    const runtimeState = runtimeByChainId.get(chain.chain_id);
    const headBlock = runtimeState?.headBlock;
    const lastProcessedBlock = persistedState?.lastProcessedBlock;
    const blockLag =
      headBlock !== undefined && lastProcessedBlock !== undefined && headBlock >= lastProcessedBlock
        ? headBlock - lastProcessedBlock
        : undefined;

    return {
      id,
      chainId: chain.chain_id,
      name: chain.name,
      enabled: chain.enabled,
      rpcUrls: chain.rpc_urls,
      isActiveSource: chain.chain_id === activeSourceChainId,
      scannerType: runtimeState?.scannerType,
      headBlock: headBlock?.toString(),
      lastProcessedBlock: lastProcessedBlock?.toString(),
      blockLag: blockLag?.toString(),
      updatedAtMs: persistedState?.updatedAtMs,
    } satisfies ChainStatusEntry;
  });

  chains.sort((a, b) => a.chainId - b.chainId || a.id.localeCompare(b.id));
  return chains;
}

function latestChainStateByChainId(rows: ChainStateRow[]): Map<number, ChainStateRow> {
  const out = new Map<number, ChainStateRow>();
  for (const row of rows) {
    const previous = out.get(row.chainId);
    if (!previous || row.updatedAtMs > previous.updatedAtMs) {
      out.set(row.chainId, row);
    }
  }
  return out;
}
