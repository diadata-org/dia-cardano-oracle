// Intent injector — a file source that runs alongside the live block scanner.
//
// An operator stages a fault-drill intent by dropping a CLI-signed intent file
// (the `intent:create-and-sign` artifact: `{ intent, witness }`) into the run's
// drop directory. The injector reads each file, turns it into the same
// `EnrichedIntent` the scanner's enrichment stage produces, hands it to the
// shared routing + submission path, and archives the file under `processed/`.
//
// The signed intent carries a witness signed by an authorized DIA key, so it
// flows through the bridge's signature check exactly like a scanned intent and
// lands a real on-chain update. The injector adds intents; the block scanner
// keeps running in parallel and the live feed flows on its own.
//
// The file source is described in docs/architecture/feeder.md §3 (Ingestion);
// the operator how-to (the `make inject` target, scenarios) is in the feeder
// README under "Fault-drill intent injection". The loop is wired to the daemon
// in `cmd/feeder/daemon-cmd.ts`.

import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { keccak256, toBytes, type Address, type Hex } from "viem";

import { INTENT_INJECT_PROCESSED_DIRNAME } from "../config/constants.js";
import type { EnrichedIntent, OracleIntent } from "./types.js";

export { INTENT_INJECT_PROCESSED_DIRNAME };

/** Hands one injected intent to the live routing + submission path. The daemon
 *  binds this to the same post-enrichment processing the scanner uses. */
export type InjectedIntentHandler = (enriched: EnrichedIntent) => Promise<void>;

type SignedIntentFile = {
  intent: {
    intentType: string;
    version: string;
    chainId: string;
    nonce: string;
    expiry: string;
    symbol: string;
    price: string;
    timestamp: string;
    source: string;
    signature: string;
    signer: string;
  };
  witness: { intentHash: string };
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`intent injector: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`intent injector: ${label}.${key} is required`);
  }
  return value;
}

function requireIntegerBigint(record: Record<string, unknown>, key: string, label: string): bigint {
  const value = requireString(record, key, label);
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`intent injector: ${label}.${key} must be an integer string, got "${value}"`);
  }
  return BigInt(value.trim());
}

/**
 * Turn a CLI signed-intent artifact into the `EnrichedIntent` the downstream
 * pipeline consumes. The full OracleIntent comes straight from the file (it
 * already carries every field the registry view-call would supply); the
 * synthetic `ExtractedEvent` takes its intent hash from the witness and leaves
 * the source-chain coordinates at zero. The two latency phases keyed on a block
 * timestamp record only when it is positive, so they stay at rest here.
 */
export function parseSignedIntent(raw: unknown): EnrichedIntent {
  const root = asRecord(raw, "signed intent");
  const intentRecord = asRecord(root.intent, "intent");
  const witnessRecord = asRecord(root.witness, "witness");

  const fullIntent: OracleIntent = {
    intentType: requireString(intentRecord, "intentType", "intent"),
    version: requireString(intentRecord, "version", "intent"),
    chainId: requireIntegerBigint(intentRecord, "chainId", "intent"),
    nonce: requireIntegerBigint(intentRecord, "nonce", "intent"),
    expiry: requireIntegerBigint(intentRecord, "expiry", "intent"),
    symbol: requireString(intentRecord, "symbol", "intent"),
    price: requireIntegerBigint(intentRecord, "price", "intent"),
    timestamp: requireIntegerBigint(intentRecord, "timestamp", "intent"),
    source: requireString(intentRecord, "source", "intent"),
    signature: requireString(intentRecord, "signature", "intent"),
    signer: requireString(intentRecord, "signer", "intent"),
  };

  const intentHash = requireString(witnessRecord, "intentHash", "witness") as Hex;

  return {
    event: {
      intentHash,
      symbolHash: keccak256(toBytes(fullIntent.symbol)),
      price: fullIntent.price,
      timestamp: fullIntent.timestamp,
      signer: fullIntent.signer as Address,
      blockNumber: 0n,
      txHash: intentHash,
      logIndex: 0,
      blockTimestamp: 0n,
    },
    fullIntent,
  };
}

async function archive(injectDir: string, fileName: string, stamp: number): Promise<void> {
  const processedDir = path.join(injectDir, INTENT_INJECT_PROCESSED_DIRNAME);
  await mkdir(processedDir, { recursive: true });
  const archivedName = `${fileName.replace(/\.json$/, "")}.${stamp}.json`;
  await rename(path.join(injectDir, fileName), path.join(processedDir, archivedName));
}

/**
 * Drain the drop directory once: every top-level `*.json` file is parsed,
 * handed to `onEnriched`, and archived under `processed/`. A file that fails to
 * parse is reported and archived after that one attempt, so each file is
 * processed at most once. When `onEnriched` throws, its file is left in place
 * for a later pass and the error propagates to the caller.
 */
export async function injectPendingIntents(args: {
  injectDir: string;
  onEnriched: InjectedIntentHandler;
  report: (line: string) => void;
  clock?: () => number;
}): Promise<{ injected: number; failed: number }> {
  const { injectDir, onEnriched, report } = args;
  const clock = args.clock ?? Date.now;

  let entries: Dirent[];
  try {
    entries = await readdir(injectDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { injected: 0, failed: 0 };
    throw err;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  let injected = 0;
  let failed = 0;
  for (const fileName of files) {
    let enriched: EnrichedIntent;
    try {
      const raw = JSON.parse(await readFile(path.join(injectDir, fileName), "utf8"));
      enriched = parseSignedIntent(raw);
    } catch (err) {
      report(`intent injector: skipping ${fileName} — ${(err as Error).message}`);
      await archive(injectDir, fileName, clock());
      failed++;
      continue;
    }

    await onEnriched(enriched);
    await archive(injectDir, fileName, clock());
    injected++;
  }

  return { injected, failed };
}

/**
 * Watch the drop directory and drain it on each tick until the signal aborts.
 * A failed pass is reported and the loop continues to the next tick, so the
 * injector and daemon keep running through a bad submission.
 */
export async function runIntentInjector(args: {
  injectDir: string;
  onEnriched: InjectedIntentHandler;
  report: (line: string) => void;
  intervalMs: number;
  signal?: AbortSignal;
  clock?: () => number;
}): Promise<void> {
  const { injectDir, onEnriched, report, intervalMs, signal, clock } = args;
  report(`intent injector: watching ${injectDir} every ${intervalMs}ms`);

  while (!signal?.aborted) {
    try {
      const result = await injectPendingIntents({ injectDir, onEnriched, report, clock });
      if (result.injected > 0 || result.failed > 0) {
        report(`intent injector: pass complete — injected=${result.injected} failed=${result.failed}`);
      }
    } catch (err) {
      report(`intent injector: pass failed — ${(err as Error).message}`);
    }
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") break;
      throw err;
    }
  }
  report("intent injector: aborted");
}
