#!/usr/bin/env tsx
// query-live.ts — CHAIN-AS-TRUTH reconnaissance for the teardown.
//
// Given a protocol state (config-bootstrap.json) and the client states under
// it, this script connects READ-ONLY via the CLI's own configured Lucid
// (`makeConfiguredLucid`, Blockfrost/Koios) and reports — as a single JSON
// object on stdout — what is ACTUALLY on-chain RIGHT NOW, per category:
//
//   * config   — is the Config NFT present at the config validator address?
//   * hook      — is the PaymentHook NFT present at the hook validator address?
//   * referenceScripts — which published ref-script outRefs (global config /
//     coordinator / payment-hook, and per-client receiver / pair / pairMint /
//     deposit) are STILL live at the reference-holder address.
//   * clients[] — per client: is the Receiver NFT present? and which of the
//     client's Pair NFTs are STILL live at the client's pair validator address
//     (matched back to the pair symbol/file so the bash can call pair:burn with
//     the right --pair-state).
//
// It NEVER builds, signs, or submits a transaction — it only queries. The
// teardown bash calls it to learn reality, then acts only on what is live.
//
// This is intentionally a thin orchestration layer: it imports the CLI's
// existing lucid/config helpers rather than re-deriving any provider/address
// logic. Units and addresses are read straight from the state JSONs (the same
// values the original deploy committed).
//
// Usage:
//   tsx scripts/teardown-helpers/query-live.ts \
//     --protocol-state ./state/<run>/config-bootstrap.json \
//     --client-state ./state/<run>/clients/client-a.json \
//     [--client-state ...] \
//     [--pair-glob-root ./state/<run>]   # where clients/<id>/pairs/*.json live
//
// Output (stdout): one JSON object. All diagnostics go to stderr.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import type { UTxO } from "@lucid-evolution/lucid";

import { makeConfiguredLucid } from "../../src/core/lucid.js";

type OutRef = { txHash: string; outputIndex: number; scriptHash?: string };

type LiveRefScript = {
  kind: string;
  txHash: string;
  outputIndex: number;
  present: boolean;
};

type LivePair = {
  // Pair file basename (e.g. "btc-usd") so the bash can target --pair-state.
  pairFile: string;
  pairId: string;
  pairUnit: string;
  present: boolean;
};

type LiveClient = {
  clientId: string;
  receiverPresent: boolean;
  receiverUnit: string;
  pairValidatorAddress: string;
  pairs: LivePair[];
};

function parseArgs(argv: string[]): {
  protocolState: string;
  clientStates: string[];
  pairGlobRoot: string | null;
} {
  let protocolState = "";
  const clientStates: string[] = [];
  let pairGlobRoot: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--protocol-state") {
      protocolState = argv[++i];
    } else if (a === "--client-state") {
      clientStates.push(argv[++i]);
    } else if (a === "--pair-glob-root") {
      pairGlobRoot = argv[++i];
    } else {
      throw new Error(`query-live: unknown argument: ${a}`);
    }
  }
  if (!protocolState) {
    throw new Error("query-live: --protocol-state is required");
  }
  return { protocolState, clientStates, pairGlobRoot };
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

// True iff the wallet/script address currently holds a UTxO carrying `unit`.
// Single read; no waiting — chain-as-truth means we believe the current tip.
async function unitPresent(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  address: string,
  unit: string,
): Promise<boolean> {
  const utxos = await lucid.utxosAtWithUnit(address, unit);
  return utxos.length > 0;
}

async function outRefLive(
  lucid: Awaited<ReturnType<typeof makeConfiguredLucid>>,
  outRef: OutRef,
): Promise<boolean> {
  const utxos = await lucid.utxosByOutRef([
    { txHash: outRef.txHash, outputIndex: outRef.outputIndex },
  ]);
  return utxos.length === 1;
}

async function main(): Promise<void> {
  const { protocolState, clientStates, pairGlobRoot } = parseArgs(
    process.argv.slice(2),
  );

  const proto = readJson(protocolState);
  const stateRoot = pairGlobRoot ?? path.dirname(protocolState);

  const lucid = await makeConfiguredLucid();

  // ── Singletons: config + hook NFTs at their validator addresses. ──────────
  const configUnit: string = proto.scripts.configUnit;
  const configAddress: string = proto.scripts.configValidatorAddress;
  const hookUnit: string = proto.scripts.paymentHookUnit;
  const hookAddress: string = proto.scripts.paymentHookValidatorAddress;

  const configPresent = await unitPresent(lucid, configAddress, configUnit);
  const hookPresent = await unitPresent(lucid, hookAddress, hookUnit);

  // ── Global reference scripts at the reference-holder address. ─────────────
  const refHolderAddress: string = proto.scripts.referenceHolderAddress;
  const globalRefs = proto.referenceScripts?.global ?? {};
  const refScripts: LiveRefScript[] = [];
  for (const kind of Object.keys(globalRefs)) {
    const ref = globalRefs[kind] as OutRef;
    refScripts.push({
      kind: `global:${kind}`,
      txHash: ref.txHash,
      outputIndex: ref.outputIndex,
      present: await outRefLive(lucid, ref),
    });
  }

  // ── Per-client: receiver NFT + each pair NFT + client ref scripts. ────────
  const clients: LiveClient[] = [];
  for (const clientStatePath of clientStates) {
    const client = readJson(clientStatePath);
    const clientId: string = client.clientId;

    const receiverUnit: string = client.receiver.receiverUnit;
    const receiverAddress: string = client.receiver.receiverValidatorAddress;
    const receiverPresent = await unitPresent(
      lucid,
      receiverAddress,
      receiverUnit,
    );

    const pairValidatorAddress: string = client.scripts.pairValidatorAddress;

    // Per-client published reference scripts (receiver / pair / pairMint /
    // optional deposit) live at the SAME reference-holder address.
    const clientRefs = client.referenceScripts?.client ?? {};
    for (const kind of Object.keys(clientRefs)) {
      const ref = clientRefs[kind] as OutRef;
      refScripts.push({
        kind: `client:${clientId}:${kind}`,
        txHash: ref.txHash,
        outputIndex: ref.outputIndex,
        present: await outRefLive(lucid, ref),
      });
    }

    // Live pair NFTs: the client's pair address holds ALL its pair NFTs. Read
    // them all once, then match each pair file's committed pairUnit to what's
    // actually there.
    const liveAtPairAddr: UTxO[] = await lucid.utxosAt(pairValidatorAddress);
    const liveUnits = new Set<string>();
    for (const u of liveAtPairAddr) {
      for (const unit of Object.keys(u.assets)) {
        if (unit !== "lovelace") liveUnits.add(unit);
      }
    }

    const pairs: LivePair[] = [];
    const pairsDir = path.join(stateRoot, "clients", clientId, "pairs");
    if (existsSync(pairsDir)) {
      for (const file of readdirSync(pairsDir)) {
        if (!file.endsWith(".json")) continue;
        const pairFile = file.replace(/\.json$/, "");
        const pair = readJson(path.join(pairsDir, file));
        const pairUnit: string = pair.pair?.pairUnit;
        if (!pairUnit) {
          process.stderr.write(
            `query-live: ${clientId}/${pairFile} has no pair.pairUnit — skipping\n`,
          );
          continue;
        }
        pairs.push({
          pairFile,
          pairId: pair.pair?.pairId ?? "",
          pairUnit,
          present: liveUnits.has(pairUnit),
        });
      }
    }

    clients.push({
      clientId,
      receiverPresent,
      receiverUnit,
      pairValidatorAddress,
      pairs,
    });
  }

  const out = {
    config: { unit: configUnit, address: configAddress, present: configPresent },
    hook: { unit: hookUnit, address: hookAddress, present: hookPresent },
    referenceHolderAddress: refHolderAddress,
    referenceScripts: refScripts,
    clients,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((error) => {
  process.stderr.write(
    `query-live: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
