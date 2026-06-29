import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  Emulator,
  Lucid,
  generateEmulatorAccount,
  type LucidEvolution,
  type UTxO,
} from "@lucid-evolution/lucid";

import { createWalletArbiter } from "../wallet-arbiter.js";
import { createWalletPool, type PoolWallet, type WalletUtxo } from "../wallet-pool.js";
import { createUtxoLockTable } from "../utxo-lock-table.js";

// ---------------------------------------------------------------------------
// Integration proof for the signer-pool arbiter against a live (emulated)
// ledger. The unit tests prove the arbiter hands DISJOINT UTxO subsets; these
// prove the payoff: when each concurrent lane pins coin selection to its own
// reserved subset (`overrideUTxOs`), two — and then N — transactions built off
// the SAME one-wallet pool all confirm on the ledger. Without the pin, lucid
// coin-selects the same largest UTxO for every lane and the second submit is a
// double-spend; the final test pins that failure down as the control.
// ---------------------------------------------------------------------------

const TTL = 60_000;
const ADA = 1_000_000n;

/** Lucid UTxO → the arbiter's lean cache row. */
function toWalletUtxo(u: UTxO): WalletUtxo {
  return {
    outRef: `${u.txHash}#${u.outputIndex}`,
    lovelace: u.assets.lovelace ?? 0n,
    hasOnlyAda: Object.keys(u.assets).length === 1,
  };
}

/**
 * Fund one emulator wallet and shatter its single genesis UTxO into `pieces`
 * pure-ADA UTxOs of `each` lovelace (the shape a `wallet:split` leaves behind),
 * so the arbiter has several disjoint UTxOs to hand out. Returns the live Lucid,
 * the wallet address/seed, and the post-split wallet UTxOs.
 */
async function fundedSplitWallet(opts: {
  pieces: number;
  each: bigint;
}): Promise<{
  lucid: LucidEvolution;
  emulator: Emulator;
  address: string;
  seed: string;
  utxos: UTxO[];
}> {
  // Genesis lovelace must cover every piece plus generous fee/change headroom.
  const genesis = opts.each * BigInt(opts.pieces) + 10_000n * ADA;
  const account = generateEmulatorAccount({ lovelace: genesis });
  const emulator = new Emulator([account]);
  const lucid = await Lucid(emulator, "Preview");
  lucid.selectWallet.fromSeed(account.seedPhrase);

  let split = lucid.newTx();
  for (let i = 0; i < opts.pieces; i += 1) {
    split = split.pay.ToAddress(account.address, { lovelace: opts.each });
  }
  const signed = await (await split.complete()).sign.withWallet().complete();
  await signed.submit();
  emulator.awaitBlock(1);

  const utxos = await lucid.wallet().getUtxos();
  return { lucid, emulator, address: account.address, seed: account.seedPhrase, utxos };
}

function singleWalletPool(seed: string, address: string, utxos: UTxO[]) {
  const wallet: PoolWallet = {
    id: "main",
    role: "main",
    signer: { kind: "seed", value: seed },
    address,
  };
  const pool = createWalletPool([wallet]);
  pool.setUtxos("main", utxos.map(toWalletUtxo));
  const lockTable = createUtxoLockTable();
  const arbiter = createWalletArbiter({ pool, lockTable, lockTtlMs: TTL });
  return { pool, arbiter };
}

/**
 * Build (but do not submit) a self-payment whose fee/collateral coin selection
 * is pinned to exactly `reserved`. Mirrors the bridge's lane: `overrideUTxOs`
 * before build, cleared after, so a later read sees the whole wallet again.
 */
async function buildPinnedSelfPayment(
  lucid: LucidEvolution,
  address: string,
  reserved: UTxO[],
): Promise<{ submit: () => Promise<string> }> {
  lucid.overrideUTxOs(reserved);
  try {
    const built = await lucid.newTx().pay.ToAddress(address, { lovelace: 2n * ADA }).complete();
    return await built.sign.withWallet().complete();
  } finally {
    lucid.overrideUTxOs([]);
  }
}

describe("wallet arbiter — emulator integration", () => {
  it("two concurrent lanes on a one-wallet pool both confirm when pinned to disjoint reservations", async () => {
    const { lucid, emulator, address, seed, utxos } = await fundedSplitWallet({
      pieces: 4,
      each: 1_000n * ADA,
    });
    const { arbiter } = singleWalletPool(seed, address, utxos);
    const byOutRef = new Map(utxos.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));

    // Two lanes acquire from the SAME wallet — the arbiter must hand disjoint
    // UTxO subsets.
    const a = arbiter.acquire();
    const b = arbiter.acquire();
    assert.ok(!("unavailable" in a) && !("unavailable" in b), "both lanes acquire");
    assert.equal(a.walletId, "main");
    assert.equal(b.walletId, "main");
    const aRefs = new Set(a.utxos.map((u) => u.outRef));
    for (const u of b.utxos) {
      assert.equal(aRefs.has(u.outRef), false, "the two reservations are disjoint");
    }

    // Build both txs against the same pre-submit ledger, each pinned to its own
    // reserved subset, THEN submit both. Disjoint inputs ⇒ no double-spend.
    const lucidUtxos = (refs: { outRef: string }[]) =>
      refs.map((r) => byOutRef.get(r.outRef)!);
    const txA = await buildPinnedSelfPayment(lucid, address, lucidUtxos(a.utxos));
    const txB = await buildPinnedSelfPayment(lucid, address, lucidUtxos(b.utxos));

    const hashA = await txA.submit();
    const hashB = await txB.submit();
    emulator.awaitBlock(1);

    assert.notEqual(hashA, hashB, "two distinct transactions");
    const confirmedA = await lucid.utxosByOutRef([{ txHash: hashA, outputIndex: 0 }]);
    const confirmedB = await lucid.utxosByOutRef([{ txHash: hashB, outputIndex: 0 }]);
    assert.equal(confirmedA.length, 1, "lane A confirmed on the ledger");
    assert.equal(confirmedB.length, 1, "lane B confirmed on the ledger");
  });

  it("a split wallet backs N parallel lanes — all N pinned txs confirm", async () => {
    const N = 3;
    const { lucid, emulator, address, seed, utxos } = await fundedSplitWallet({
      pieces: 2 * N, // RESERVED_UTXOS_PER_TX (=2) per lane
      each: 1_000n * ADA,
    });
    const { arbiter } = singleWalletPool(seed, address, utxos);
    const byOutRef = new Map(utxos.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));

    const reservations = Array.from({ length: N }, () => arbiter.acquire());
    for (const r of reservations) {
      assert.ok(!("unavailable" in r), "every lane acquires from the split wallet");
    }
    // All reserved out-refs across all lanes are globally unique.
    const allRefs = reservations.flatMap((r) =>
      "unavailable" in r ? [] : r.utxos.map((u) => u.outRef),
    );
    assert.equal(new Set(allRefs).size, allRefs.length, "lanes hold globally disjoint UTxOs");

    // Build sequentially: a single Lucid instance has ONE `overrideUTxOs` slot,
    // so concurrent builds would race it. Each real lane builds on its own Lucid;
    // here we serialise the pin, then submit all N against the same pre-submit
    // ledger to exercise the disjoint-input guarantee.
    const signed: Array<{ submit: () => Promise<string> }> = [];
    for (const r of reservations) {
      const reserved = ("unavailable" in r ? [] : r.utxos).map((u) => byOutRef.get(u.outRef)!);
      signed.push(await buildPinnedSelfPayment(lucid, address, reserved));
    }
    const hashes: string[] = [];
    for (const tx of signed) hashes.push(await tx.submit());
    emulator.awaitBlock(1);

    assert.equal(new Set(hashes).size, N, "N distinct transactions");
    for (const txHash of hashes) {
      const confirmed = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
      assert.equal(confirmed.length, 1, `tx ${txHash} confirmed on the ledger`);
    }
  });

  it("control: two UNPINNED lanes collide — proving the arbiter pin is what prevents the double-spend", async () => {
    const { lucid, emulator, address } = await fundedSplitWallet({
      pieces: 4,
      each: 1_000n * ADA,
    });
    // No arbiter, no pin: both lanes see the whole wallet and lucid coin-selects
    // the same UTxO for each. The first submits; the second is a double-spend.
    const txA = await lucid.newTx().pay.ToAddress(address, { lovelace: 2n * ADA }).complete();
    const signedA = await txA.sign.withWallet().complete();
    const txB = await lucid.newTx().pay.ToAddress(address, { lovelace: 2n * ADA }).complete();
    const signedB = await txB.sign.withWallet().complete();

    await signedA.submit();
    await assert.rejects(
      async () => {
        await signedB.submit();
        emulator.awaitBlock(1);
      },
      "an unpinned second lane double-spends the shared input",
    );
  });
});
