// Runtime ABI parser for the YAML-shipped ABI fragments.
//
// Mirrors what `services/bridge/internal/pipeline/extractor.go` and
// `services/bridge/internal/pipeline/enricher.go` do upstream: ABIs
// declared as strings in the modular YAML config are parsed once at
// load time and become the source of truth for every decode and view
// call the feeder performs.
//
// Two reasons this lives in its own module:
//
//   1. Keeps `loader.ts` focused on filesystem IO.
//   2. Lets the validator import the same parser to surface parse
//      errors with the YAML file path + key (no double-parsing in
//      different places).
//
// JSON shapes accepted (mirrors what Spectra's events.yaml /
// contracts.yaml ship):
//
//   - A single event/function object, e.g.:
//
//         abi: |
//           { "type": "event", "name": "IntentRegistered", ... }
//
//   - A full ABI array, e.g.:
//
//         abi: |
//           [ { "type": "event", ... }, { "type": "function", ... } ]
//
// In both cases the result is normalised to an ABI array
// (`AbiFragment[]`), and helpers below let consumers pick the specific
// event or function they need from a known abi by name.

import type { Abi, AbiEvent, AbiFunction } from "viem";

import type { ContractConfig, EventDefinition } from "./types.js";

export type AbiFragment = AbiEvent | AbiFunction;

/** Output of `parseAllAbis`. Keyed by event name and contract id for
 *  direct lookup in the pipeline. */
export type ParsedAbis = {
  events: Record<string, ParsedEventDefinition>;
  contracts: Record<string, Abi>;
};

export type ParsedEventDefinition = {
  /** The decoded event ABI item (the `IntentRegistered` fragment). */
  event: AbiEvent;
  /** Optional enrichment function ABI item. `null` when the event
   *  declares no enrichment. */
  enrichment: AbiFunction | null;
};

/**
 * Parse every ABI string declared in `events.yaml` and `contracts.yaml`,
 * returning a typed bundle the pipeline can consume directly. Throws
 * with a YAML-shaped pointer (`event_definitions.<name>.abi`,
 * `contracts.<id>.abi`) on any parse failure so the operator knows
 * which fragment to fix.
 */
export function parseAllAbis(
  eventDefinitions: Record<string, EventDefinition>,
  contracts: Record<string, ContractConfig>,
): ParsedAbis {
  return {
    events: parseEventDefinitions(eventDefinitions),
    contracts: parseContracts(contracts),
  };
}

function parseEventDefinitions(
  defs: Record<string, EventDefinition>,
): Record<string, ParsedEventDefinition> {
  const out: Record<string, ParsedEventDefinition> = {};
  for (const [name, def] of Object.entries(defs)) {
    const event = parseSingleEventFragment(def.abi, `event_definitions.${name}.abi`, name);

    let enrichment: AbiFunction | null = null;
    if (def.enrichment?.abi) {
      enrichment = parseSingleFunctionFragment(
        def.enrichment.abi,
        `event_definitions.${name}.enrichment.abi`,
        def.enrichment.method,
      );
    }

    out[name] = { event, enrichment };
  }
  return out;
}

function parseContracts(contracts: Record<string, ContractConfig>): Record<string, Abi> {
  const out: Record<string, Abi> = {};
  for (const [id, contract] of Object.entries(contracts)) {
    if (!contract.abi) {
      throw new Error(`contracts.${id}.abi: missing.`);
    }
    out[id] = parseAbiArray(contract.abi, `contracts.${id}.abi`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON → ABI helpers. Each helper validates the shape so a downstream
// type assertion is sound.
// ---------------------------------------------------------------------------

/** Parse a YAML-embedded ABI string into a normalised ABI array. */
function parseAbiArray(raw: string, where: string): Abi {
  const value = parseJson(raw, where);
  const array = Array.isArray(value) ? value : [value];
  assertEveryFragmentValid(array, where);
  return array as Abi;
}

/** Parse a single event fragment from a YAML-embedded ABI string.
 *  Accepts either a bare event object or a one-element array. */
function parseSingleEventFragment(raw: string, where: string, expectedName: string): AbiEvent {
  const fragments = parseAbiArray(raw, where);
  const events = fragments.filter((f) => f.type === "event") as AbiEvent[];
  if (events.length === 0) {
    throw new Error(`${where}: no event fragment found.`);
  }
  if (events.length > 1) {
    const named = events.find((e) => e.name === expectedName);
    if (!named) {
      throw new Error(
        `${where}: multiple event fragments and none named "${expectedName}".`,
      );
    }
    return named;
  }
  const only = events[0];
  if (only.name !== expectedName) {
    throw new Error(
      `${where}: declared event name is "${only.name}" but the event_definitions key is "${expectedName}". They must match.`,
    );
  }
  return only;
}

/** Parse a single function fragment from a YAML-embedded ABI string. */
function parseSingleFunctionFragment(
  raw: string,
  where: string,
  expectedName: string,
): AbiFunction {
  const fragments = parseAbiArray(raw, where);
  const fns = fragments.filter((f) => f.type === "function") as AbiFunction[];
  if (fns.length === 0) {
    throw new Error(`${where}: no function fragment found.`);
  }
  const matched = fns.find((f) => f.name === expectedName);
  if (!matched) {
    throw new Error(
      `${where}: no function named "${expectedName}". Declared methods: ${fns.map((f) => f.name).join(", ")}.`,
    );
  }
  return matched;
}

function parseJson(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${where}: failed to parse JSON — ${(error as Error).message}`);
  }
}

/** Light sanity check on each fragment so we fail at config-load time
 *  rather than the first decode call. Detailed semantic validation
 *  (e.g. compatibility against a recorded log fixture) is the
 *  validator's job. */
function assertEveryFragmentValid(fragments: unknown[], where: string): void {
  if (fragments.length === 0) {
    throw new Error(`${where}: ABI must not be empty.`);
  }
  for (const [index, fragment] of fragments.entries()) {
    if (!fragment || typeof fragment !== "object") {
      throw new Error(`${where}[${index}]: expected an object, got ${typeof fragment}.`);
    }
    const fr = fragment as { type?: unknown; name?: unknown };
    if (typeof fr.type !== "string") {
      throw new Error(`${where}[${index}]: missing or non-string \`type\` field.`);
    }
    if (fr.type === "event" || fr.type === "function") {
      if (typeof fr.name !== "string" || fr.name.length === 0) {
        throw new Error(
          `${where}[${index}]: ${fr.type} fragment requires a non-empty \`name\`.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers — what the rest of the pipeline calls. They never
// re-parse; they receive the already-built `ParsedAbis`.
// ---------------------------------------------------------------------------

/** Get the parsed event definition by name, throwing if absent. */
export function requireEvent(parsed: ParsedAbis, eventName: string): ParsedEventDefinition {
  const def = parsed.events[eventName];
  if (!def) {
    throw new Error(`Unknown event "${eventName}" — not declared in events.yaml.`);
  }
  return def;
}

/** Get the full parsed ABI for a contract by id, throwing if absent. */
export function requireContractAbi(parsed: ParsedAbis, contractId: string): Abi {
  const abi = parsed.contracts[contractId];
  if (!abi) {
    throw new Error(`Unknown contract "${contractId}" — not declared in contracts.yaml.`);
  }
  return abi;
}
