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

import { readdir } from "node:fs/promises";
import path from "node:path";

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
 * Spectra accepts router YAMLs in three shapes, all of which appear in
 * the wild (see `services/bridge/config/event_definitions.go` and the
 * sample configs in the Spectra docker compose tree):
 *
 * 1. Top-level `router:` — single router per file:
 *
 *        router:
 *          id: ...
 *
 * 2. Top-level `routers:` — flat or nested map of routers per file:
 *
 *        routers:
 *          my_router:
 *            id: my_router
 *            ...
 *
 *        # or, legacy nested shape:
 *        routers:
 *          my_router:
 *            router:
 *              id: my_router
 *              ...
 *
 * 3. Wrapped under a top-level `config:` key, with `routers:` nested
 *    inside (matches the original Spectra single-file config).
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

/** Unwrap the legacy nested form `{ router: {...} }`, returning the
 *  inner `RouterConfig`. Direct (`RouterConfig`) entries pass through. */
function unwrapRouterEntry(entry: RouterEntry): RouterConfig {
  if (entry && typeof entry === "object" && "router" in entry && entry.router) {
    return entry.router;
  }
  return entry as RouterConfig;
}
