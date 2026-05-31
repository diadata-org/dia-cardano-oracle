// Modular config loader — TypeScript analogue of
// `services/bridge/config/modular_loader.go`.
//
// Loads the canonical 5-file layout from a directory:
//
//   <baseDir>/infrastructure.<network>.yaml   one per network; selected at load time
//   <baseDir>/chains.yaml
//   <baseDir>/contracts.yaml
//   <baseDir>/events.yaml
//   <baseDir>/routers/*.yaml                   one router per file
//
// Spectra ships a single `infrastructure.yaml` because each bridge
// deployment targets a single source chain. The Cardano feeder is
// designed to switch between networks via `CARDANO_NETWORK` without
// rebuilding, so we accept a per-network infrastructure file
// (`infrastructure.preview.yaml`, `infrastructure.mainnet.yaml`) and the
// caller picks one at load time.
//
// Key normalisation: Spectra config YAMLs appear in the wild with both
// snake_case (`scan_interval`) and compact no-separator spellings
// (`scaninterval`). `normalizeConfigKey` maps compact forms to the
// canonical snake_case used throughout our TypeScript types.

import { readdir } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Compact-key normalisation
// ---------------------------------------------------------------------------

/**
 * Maps Spectra compact (no-separator) key spellings to their canonical
 * snake_case equivalents. Both spellings are accepted in YAML files;
 * compact spellings are normalised during load so the rest of the
 * codebase only ever sees snake_case.
 */
const COMPACT_KEY_MAP: Record<string, string> = {
  enablecors: "enable_cors",
  scaninterval: "scan_interval",
  blockrange: "block_range",
  maxblockgap: "max_block_gap",
  backwardsync: "backward_sync",
  headtrackerinterval: "head_tracker_interval",
  gapdetectioninterval: "gap_detection_interval",
  backfillchunkblocks: "backfill_chunk_blocks",
  dedupcachesize: "dedup_cache_size",
  dedupcachettl: "dedup_cache_ttl",
  retrydelay: "retry_delay",
  maxretries: "max_retries",
  checkinterval: "check_interval",
  maxprocessinglag: "max_processing_lag",
  maxqueuesize: "max_queue_size",
  enableparallelmode: "enable_parallel_mode",
};

/**
 * Normalise a single YAML key. If the lowercase form appears in
 * `COMPACT_KEY_MAP`, the canonical snake_case spelling is returned.
 * All other keys pass through unchanged (including already-snake_case
 * keys such as `scan_interval`).
 */
export function normalizeConfigKey(key: string): string {
  return COMPACT_KEY_MAP[key.toLowerCase()] ?? key;
}

import { parseAllAbis } from "./abi-parser.js";
import type {
  ChainConfig,
  ContractConfig,
  EventDefinition,
  InfrastructureConfig,
  ModularConfig,
  RouterConfig,
} from "./types.js";
import {
  directoryExists,
  readYaml,
  readYamlIfExists,
  readYamlTopLevelMap,
} from "./yaml-fs.js";

/** Single argument to `loadModularConfig`. */
export type LoaderOptions = {
  /** Path to the directory holding the modular config files. */
  baseDir: string;
  /** Which network's infrastructure file to read. */
  network: "Preview" | "Mainnet";
};

/**
 * Load every file in the modular config layout and return a single
 * typed `ModularConfig`. Throws on filesystem / parse errors; semantic
 * validation lives in `validate.ts` and is the caller's responsibility.
 */
export async function loadModularConfig(options: LoaderOptions): Promise<ModularConfig> {
  const baseDir = path.resolve(options.baseDir);
  if (!(await directoryExists(baseDir))) {
    throw new Error(`Config directory not found: ${baseDir}`);
  }

  const networkTag = options.network.toLowerCase();
  const infrastructurePath = path.join(baseDir, `infrastructure.${networkTag}.yaml`);

  const [infrastructureFile, chains, contracts, eventDefinitions, routers] = await Promise.all([
    readYamlIfExists<InfrastructureFileShape>(infrastructurePath),
    readYamlTopLevelMap<ChainConfig>(path.join(baseDir, "chains.yaml"), "chains"),
    readYamlTopLevelMap<ContractConfig>(path.join(baseDir, "contracts.yaml"), "contracts"),
    readYamlTopLevelMap<EventDefinition>(
      path.join(baseDir, "events.yaml"),
      "event_definitions",
    ),
    loadRouterDirectory(path.join(baseDir, "routers")),
  ]);

  return {
    infrastructure: unwrapInfrastructure(infrastructureFile) ?? undefined,
    chains,
    contracts,
    event_definitions: eventDefinitions,
    routers,
    parsedAbis: parseAllAbis(eventDefinitions, contracts),
  };
}

/**
 * Two equivalent layouts are tolerated for `infrastructure.<network>.yaml`,
 * matching Spectra's behavior in the wild:
 *
 *   - top-level `infrastructure: { ... }` (Spectra-native)
 *   - the fields directly at the root (flat)
 */
type InfrastructureFileShape =
  | InfrastructureConfig
  | { infrastructure?: InfrastructureConfig };

function unwrapInfrastructure(
  file: InfrastructureFileShape | null,
): InfrastructureConfig | null {
  if (!file) return null;
  if ("infrastructure" in file && file.infrastructure) {
    return file.infrastructure;
  }
  return file as InfrastructureConfig;
}

// ---------------------------------------------------------------------------
// Router collection — each file in `routers/` may contain one or many
// routers, in one of three Spectra-compatible YAML shapes. The shapes are
// tolerated centrally here so that the rest of the codebase can treat
// `routers` as a single flat map.
// ---------------------------------------------------------------------------

/**
 * Walk `routers/` and merge every `*.yaml` file into a flat map keyed by
 * router id. Returns `{}` if the directory is absent. Duplicate ids
 * across files are an error and surface the two source paths.
 */
async function loadRouterDirectory(dir: string): Promise<Record<string, RouterConfig>> {
  if (!(await directoryExists(dir))) {
    return {};
  }

  const routerFiles = (await readdir(dir))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort();

  const merged: Record<string, RouterConfig> = {};
  const sourceById = new Map<string, string>();

  for (const fileName of routerFiles) {
    const filePath = path.join(dir, fileName);
    const fileContent = await readYaml<RouterFileShape>(filePath);
    for (const router of collectRoutersFromFile(fileContent, filePath)) {
      const existingSource = sourceById.get(router.id);
      if (existingSource) {
        throw new Error(
          `Duplicate router id "${router.id}" — defined in ${existingSource} and ${filePath}.`,
        );
      }
      merged[router.id] = router;
      sourceById.set(router.id, filePath);
    }
  }

  return merged;
}

/**
 * Three Spectra-compatible router YAML shapes are accepted — all three
 * appear in the wild in Spectra operator deployments (see
 * `services/bridge/config/event_definitions.go` and the Spectra docker
 * compose sample configs). This is intentional Spectra parity, not a
 * compatibility shim.
 *
 * Shape 1 — top-level `router:`, single router per file:
 *
 *     router:
 *       id: ...
 *
 * Shape 2 — top-level `routers:` map (flat or doubly-nested):
 *
 *     routers:
 *       my_router:
 *         id: my_router
 *         ...
 *
 *     # or the doubly-nested form that Spectra also emits:
 *     routers:
 *       my_router:
 *         router:
 *           id: my_router
 *           ...
 *
 * Shape 3 — `config.routers:` (matches the original Spectra single-file
 * config layout):
 *
 *     config:
 *       routers:
 *         my_router:
 *           id: my_router
 *           ...
 */
type RouterFileShape = {
  router?: RouterConfig;
  routers?: Record<string, RouterEntry>;
  config?: { routers?: Record<string, RouterEntry> };
};

type RouterEntry = RouterConfig | { router: RouterConfig };

/**
 * Project one parsed file into a flat array of `RouterConfig` objects,
 * validating only the bare minimum (an id exists and matches its key
 * when keyed). Cross-file uniqueness is enforced by the caller.
 */
function collectRoutersFromFile(file: RouterFileShape, sourceFile: string): RouterConfig[] {
  const collected: RouterConfig[] = [];

  if (file.router) {
    const r = file.router;
    if (!r.id) {
      throw new Error(`${sourceFile}: top-level \`router\` is missing \`id\`.`);
    }
    collected.push(r);
  }

  const map = file.routers ?? file.config?.routers;
  if (map) {
    for (const [key, entry] of Object.entries(map)) {
      const router = unwrapRouterEntry(entry);
      if (!router.id) {
        throw new Error(`${sourceFile}: router "${key}" is missing \`id\`.`);
      }
      if (router.id !== key) {
        throw new Error(
          `${sourceFile}: router key "${key}" does not match its \`id\` "${router.id}". Keys must equal ids.`,
        );
      }
      collected.push(router);
    }
  }

  if (collected.length === 0) {
    throw new Error(
      `${sourceFile}: no router definitions found. Expected one of: top-level \`router:\`, \`routers:\`, or \`config.routers:\`.`,
    );
  }

  return collected;
}

/** Unwrap the doubly-nested form `{ router: {...} }`, returning the
 *  inner `RouterConfig`. Direct (`RouterConfig`) entries pass through. */
function unwrapRouterEntry(entry: RouterEntry): RouterConfig {
  if (entry && typeof entry === "object" && "router" in entry && entry.router) {
    return entry.router;
  }
  return entry as RouterConfig;
}
