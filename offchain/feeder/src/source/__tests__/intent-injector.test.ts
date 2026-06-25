// Intent injector — parse a CLI-signed intent file into an EnrichedIntent and
// drain a drop directory into the live processing path, archiving each file.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  injectPendingIntents,
  parseSignedIntent,
  INTENT_INJECT_PROCESSED_DIRNAME,
} from "../intent-injector.js";
import type { EnrichedIntent } from "../types.js";

// A CLI `intent:create-and-sign` artifact: numerics are integer strings, the
// witness carries the intent hash the bridge verifies the signature against.
function signedIntentFixture(overrides: Record<string, string> = {}) {
  return {
    intent: {
      intentType: "OracleUpdate",
      version: "1",
      chainId: "1050",
      nonce: "1777274633040",
      expiry: "1777278253",
      symbol: "BTC/USD",
      price: "6500000000000",
      timestamp: "1777274653",
      source: "DIA",
      signature: "0x" + "ab".repeat(65),
      signer: "0xf64d333c19b007519c7b9316680ed26578f98c08",
      ...overrides,
    },
    witness: {
      signerPublicKey: "02" + "cd".repeat(32),
      signerAddress: "0xf64d333c19b007519c7b9316680ed26578f98c08",
      intentHash: "0x" + "11".repeat(32),
      compactSignature: "0x" + "ef".repeat(64),
    },
  };
}

describe("parseSignedIntent", () => {
  it("maps a CLI signed-intent into an EnrichedIntent with bigint numerics", () => {
    const enriched = parseSignedIntent(signedIntentFixture());

    assert.equal(enriched.fullIntent.symbol, "BTC/USD");
    assert.equal(enriched.fullIntent.price, 6_500_000_000_000n);
    assert.equal(enriched.fullIntent.timestamp, 1_777_274_653n);
    assert.equal(enriched.fullIntent.nonce, 1_777_274_633_040n);
    assert.equal(enriched.fullIntent.expiry, 1_777_278_253n);
    assert.equal(enriched.fullIntent.chainId, 1_050n);
    assert.equal(enriched.fullIntent.signature, "0x" + "ab".repeat(65));
    assert.equal(enriched.fullIntent.signer, "0xf64d333c19b007519c7b9316680ed26578f98c08");
  });

  it("takes the intent hash from the witness and leaves source-chain fields empty", () => {
    const enriched = parseSignedIntent(signedIntentFixture());

    assert.equal(enriched.event.intentHash, "0x" + "11".repeat(32));
    assert.equal(enriched.event.signer, "0xf64d333c19b007519c7b9316680ed26578f98c08");
    assert.equal(enriched.event.price, 6_500_000_000_000n);
    assert.equal(enriched.event.timestamp, 1_777_274_653n);
    // No source block backed this intent, so the block-derived fields are zero
    // and the latency phases that need a block timestamp stay skipped.
    assert.equal(enriched.event.blockNumber, 0n);
    assert.equal(enriched.event.blockTimestamp, 0n);
    assert.equal(enriched.event.logIndex, 0);
    // symbolHash mirrors the extractor: keccak256 of the symbol bytes.
    assert.match(enriched.event.symbolHash, /^0x[0-9a-f]{64}$/);
  });

  it("rejects a payload missing the witness intent hash", () => {
    const bad = signedIntentFixture();
    delete (bad.witness as Record<string, unknown>).intentHash;
    assert.throws(() => parseSignedIntent(bad), /intentHash/);
  });

  it("rejects a payload whose numeric field is not an integer string", () => {
    assert.throws(() => parseSignedIntent(signedIntentFixture({ price: "12.5" })), /price/);
  });
});

describe("injectPendingIntents", () => {
  let dir: string;
  const clock = () => 1_700_000_000_000;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "inject-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns zero when the inject directory is absent", async () => {
    const calls: EnrichedIntent[] = [];
    const result = await injectPendingIntents({
      injectDir: path.join(dir, "does-not-exist"),
      onEnriched: async (e) => { calls.push(e); },
      report: () => {},
      clock,
    });
    assert.deepEqual(result, { injected: 0, failed: 0 });
    assert.equal(calls.length, 0);
  });

  it("feeds each signed-intent file through onEnriched and archives it", async () => {
    await writeFile(path.join(dir, "btc-usd.signed.json"), JSON.stringify(signedIntentFixture()), "utf8");
    const calls: EnrichedIntent[] = [];

    const result = await injectPendingIntents({
      injectDir: dir,
      onEnriched: async (e) => { calls.push(e); },
      report: () => {},
      clock,
    });

    assert.deepEqual(result, { injected: 1, failed: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fullIntent.symbol, "BTC/USD");

    // The source file is gone from the drop dir and archived under processed/.
    const top = await readdir(dir);
    assert.deepEqual(top, [INTENT_INJECT_PROCESSED_DIRNAME]);
    const archived = await readdir(path.join(dir, INTENT_INJECT_PROCESSED_DIRNAME));
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^btc-usd\.signed\./);
  });

  it("does not reprocess an already-archived file on a second pass", async () => {
    await writeFile(path.join(dir, "btc-usd.signed.json"), JSON.stringify(signedIntentFixture()), "utf8");
    const calls: EnrichedIntent[] = [];
    const onEnriched = async (e: EnrichedIntent) => { calls.push(e); };

    await injectPendingIntents({ injectDir: dir, onEnriched, report: () => {}, clock });
    const second = await injectPendingIntents({ injectDir: dir, onEnriched, report: () => {}, clock });

    assert.deepEqual(second, { injected: 0, failed: 0 });
    assert.equal(calls.length, 1);
  });

  it("ignores non-JSON files and the processed subdir", async () => {
    await mkdir(path.join(dir, INTENT_INJECT_PROCESSED_DIRNAME), { recursive: true });
    await writeFile(path.join(dir, "README.txt"), "not an intent", "utf8");
    const calls: EnrichedIntent[] = [];

    const result = await injectPendingIntents({
      injectDir: dir,
      onEnriched: async (e) => { calls.push(e); },
      report: () => {},
      clock,
    });

    assert.deepEqual(result, { injected: 0, failed: 0 });
    assert.equal(calls.length, 0);
  });

  it("archives a malformed file and reports it, without calling onEnriched", async () => {
    await writeFile(path.join(dir, "broken.signed.json"), "{ not valid json", "utf8");
    const calls: EnrichedIntent[] = [];
    const reported: string[] = [];

    const result = await injectPendingIntents({
      injectDir: dir,
      onEnriched: async (e) => { calls.push(e); },
      report: (line) => reported.push(line),
      clock,
    });

    assert.deepEqual(result, { injected: 0, failed: 1 });
    assert.equal(calls.length, 0);
    assert.equal(reported.length, 1);
    assert.match(reported[0], /broken\.signed\.json/);
    // It is moved out so the loop does not retry it forever.
    const top = await readdir(dir);
    assert.deepEqual(top, [INTENT_INJECT_PROCESSED_DIRNAME]);
  });

  it("stops the batch when onEnriched throws, leaving the file for a later pass", async () => {
    await writeFile(path.join(dir, "btc-usd.signed.json"), JSON.stringify(signedIntentFixture()), "utf8");

    await assert.rejects(
      injectPendingIntents({
        injectDir: dir,
        onEnriched: async () => { throw new Error("submit boom"); },
        report: () => {},
        clock,
      }),
      /submit boom/,
    );

    // A processing failure is not the file's fault: it stays in the drop dir.
    const top = await readdir(dir);
    assert.ok(top.includes("btc-usd.signed.json"));
  });
});
