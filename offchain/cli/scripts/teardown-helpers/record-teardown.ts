#!/usr/bin/env tsx
// record-teardown.ts — write the teardown OUTCOME back into a state JSON.
//
// The teardown is chain-as-truth: after it acts on a live UTxO (burn /
// reclaim / settle / withdraw) and the tx confirms, it calls this helper to
// record what happened in that entity's own state JSON. Two mutually exclusive
// modes:
//
//   1. Recovery tx (default): append ONE entry to the JSON's `transactions`
//      array in the SAME shape the deploy uses —
//        { "step": "<step>", "submittedTxHash": "<hash>", "confirmed": <bool> }
//      and set a teardown status field:
//        { "teardown": { "status": "<status>", "step": "<step>",
//                        "txHash": "<hash>", "recordedAt": "<iso>" } }
//      Pass --no-append when the CLI verb itself already persisted the tx into
//      `transactions` (settle / receiver:withdraw / pair:burn etc. all do):
//      then this helper only stamps the `teardown` status and adds NO duplicate
//      transactions entry.
//
//   2. --orphan: the entity had NO live on-chain match (already burned /
//      reclaimed elsewhere, or never minted). NO tx is appended. Only the
//      status is set:
//        { "teardown": { "status": "orphaned", "orphaned": true,
//                        "reason": "<reason>", "recordedAt": "<iso>" } }
//
// The file is rewritten ATOMICALLY (temp file + rename) and NEVER carries a
// stale outRef: we only ever APPEND the recovery tx + a status. The rest of
// the JSON is preserved verbatim.
//
// Usage:
//   tsx scripts/teardown-helpers/record-teardown.ts \
//     --file <path> --step <name> --tx-hash <hash> [--confirmed true|false] \
//     [--status <status>]
//
//   tsx scripts/teardown-helpers/record-teardown.ts \
//     --file <path> --orphan [--reason <text>]

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

type Args = {
  file: string;
  step: string | null;
  txHash: string | null;
  confirmed: boolean;
  status: string | null;
  orphan: boolean;
  reason: string | null;
  noAppend: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: "",
    step: null,
    txHash: null,
    confirmed: true,
    status: null,
    orphan: false,
    reason: null,
    noAppend: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--file":
        args.file = argv[++i];
        break;
      case "--step":
        args.step = argv[++i];
        break;
      case "--tx-hash":
        args.txHash = argv[++i];
        break;
      case "--confirmed":
        args.confirmed = String(argv[++i]).toLowerCase() !== "false";
        break;
      case "--status":
        args.status = argv[++i];
        break;
      case "--orphan":
        args.orphan = true;
        break;
      case "--no-append":
        args.noAppend = true;
        break;
      case "--reason":
        args.reason = argv[++i];
        break;
      default:
        throw new Error(`record-teardown: unknown argument: ${a}`);
    }
  }
  if (!args.file) throw new Error("record-teardown: --file is required");
  if (!args.orphan && (!args.step || !args.txHash)) {
    throw new Error(
      "record-teardown: --step and --tx-hash are required unless --orphan",
    );
  }
  return args;
}

function writeAtomic(filePath: string, data: unknown): void {
  const resolved = path.resolve(filePath);
  const tmp = `${resolved}.teardown-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, resolved);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const json = JSON.parse(readFileSync(args.file, "utf8"));
  const recordedAt = new Date().toISOString();

  if (args.orphan) {
    json.teardown = {
      status: "orphaned",
      orphaned: true,
      reason: args.reason ?? "no live on-chain UTxO matched at teardown time",
      recordedAt,
    };
    writeAtomic(args.file, json);
    process.stderr.write(`record-teardown: marked ORPHANED ${args.file}\n`);
    return;
  }

  if (!args.noAppend) {
    if (!Array.isArray(json.transactions)) {
      json.transactions = [];
    }
    json.transactions.push({
      step: args.step,
      submittedTxHash: args.txHash,
      confirmed: args.confirmed,
    });
  }
  json.teardown = {
    status: args.status ?? args.step,
    step: args.step,
    txHash: args.txHash,
    confirmed: args.confirmed,
    recordedAt,
  };
  writeAtomic(args.file, json);
  process.stderr.write(
    `record-teardown: recorded ${args.step} (${args.txHash}) in ${args.file}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `record-teardown: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
