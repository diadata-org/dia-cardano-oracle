// Registry loader — derives the per-network script identifiers from the SHARED
// state tree (offchain/state/<run>/clients/*.json), the single source of truth
// the CLI and feeder already use. Bootstrap a client with the CLI and the
// indexer serves it on the next request.
//
// INDEXER_REGISTRY_FILE points the loader at a published registry JSON instead —
// for running the indexer from just the addresses (e.g. a third party who has
// the published registry). The default reads the shared state.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRunStateDir } from "@diadata-org/dia-cardano-oracle-cli/core/run-state";
import { readClientState, readConfigState } from "@diadata-org/dia-cardano-oracle-cli/core/state";

import type { CardanoNetwork } from "./constants.js";
import type { Registry, RegistryClient, RegistryConfig } from "./registry.js";

// The shared state root (offchain/state), resolved absolutely from this module
// so it is correct regardless of the indexer's working directory — the same
// tree the CLI/feeder bind-mount and write to. `../../state` works from both
// src/ (tsx) and dist/ (built), which sit one level under the package root.
const SHARED_STATE_ROOT = fileURLToPath(new URL("../../state", import.meta.url));

const REQUIRED_CLIENT_FIELDS: ReadonlyArray<keyof RegistryClient> = [
  "clientId",
  "pairPolicyId",
  "pairValidatorAddress",
  "receiverValidatorAddress",
  "receiverUnit",
];

export interface LoadRegistryOptions {
  /** Explicit registry JSON (INDEXER_REGISTRY_FILE) — override for running
   *  without the shared state tree. */
  registryFile?: string;
  /** Shared-state run directory override (tests). Defaults to the CLI's
   *  per-network resolution under the shared state root (honours `RUN_ID`). */
  stateDir?: string;
}

/**
 * Build the {@link Registry} for a network. By default it reads every client in
 * the shared state tree's active run dir; pass `registryFile` to load a
 * published JSON instead. Throws a clear error if neither yields any clients.
 */
export async function loadRegistry(
  network: CardanoNetwork,
  options: LoadRegistryOptions = {},
): Promise<Registry> {
  if (options.registryFile) {
    return loadRegistryFromFile(options.registryFile);
  }

  const stateDir = options.stateDir ?? resolveRunStateDir(network, SHARED_STATE_ROOT);
  const clientsDir = path.join(stateDir, "clients");

  // The Config UTxO location (where the on-chain fee parameters live), from the
  // protocol bootstrap artifact. Absent before protocol:init — the service then
  // serves everything except /v1/protocol/fees.
  let config: RegistryConfig | undefined;
  try {
    const configArtifact = await readConfigState(path.join(stateDir, "config-bootstrap.json"));
    config = {
      configValidatorAddress: configArtifact.scripts.configValidatorAddress,
      configUnit: configArtifact.scripts.configUnit,
    };
  } catch {
    config = undefined;
  }

  // A deployment before its first client bootstrap has an empty registry; the
  // service stays up and serves it (0 pairs) until a client appears.
  let files: string[] = [];
  try {
    files = readdirSync(clientsDir).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }

  const clients: RegistryClient[] = [];
  for (const file of files.sort()) {
    const state = await readClientState(path.join(clientsDir, file));
    // A client becomes serveable once its Receiver is bootstrapped.
    if (!state.receiver) continue;
    clients.push({
      clientId: state.clientId,
      pairPolicyId: state.scripts.pairPolicyId,
      pairValidatorAddress: state.scripts.pairValidatorAddress,
      receiverValidatorAddress: state.receiver.receiverValidatorAddress,
      receiverUnit: state.receiver.receiverUnit,
    });
  }
  return { network, config, clients };
}

// ---------------------------------------------------------------------------
// Override: an explicit published registry JSON (no shared state tree)
// ---------------------------------------------------------------------------

function assertValidRegistry(value: unknown, source: string): asserts value is Registry {
  const registry = value as Registry;
  if (!registry || typeof registry.network !== "string" || !Array.isArray(registry.clients)) {
    throw new Error(`Registry ${source}: expected an object { network, clients: [...] }.`);
  }
  registry.clients.forEach((client, index) => {
    for (const field of REQUIRED_CLIENT_FIELDS) {
      const v = (client as RegistryClient)[field];
      if (typeof v !== "string" || v.length === 0) {
        throw new Error(`Registry ${source}: clients[${index}].${field} is missing or not a string.`);
      }
    }
  });
}

function loadRegistryFromFile(registryFile: string): Registry {
  let raw: string;
  try {
    raw = readFileSync(registryFile, "utf8");
  } catch (error) {
    throw new Error(`Cannot read registry file ${registryFile}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Registry ${registryFile}: invalid JSON — ${(error as Error).message}`);
  }
  assertValidRegistry(parsed, registryFile);
  return parsed;
}
