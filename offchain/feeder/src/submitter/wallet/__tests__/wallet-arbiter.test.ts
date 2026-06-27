import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWalletArbiter, type WalletReservation } from "../wallet-arbiter.js";
import { createWalletPool, type PoolWallet, type WalletUtxo } from "../wallet-pool.js";
import { createUtxoLockTable } from "../utxo-lock-table.js";

const TTL = 60_000;

function wallet(id: string, role: PoolWallet["role"]): PoolWallet {
  return { id, role, signer: { kind: "seed", value: `seed-${id}` }, address: `addr_${id}` };
}

/** N pure-ADA UTxOs of `lovelace` each, out-refs prefixed by the wallet id. */
function utxos(walletId: string, count: number, lovelace = 98_000_000n): WalletUtxo[] {
  return Array.from({ length: count }, (_, i) => ({
    outRef: `${walletId}-tx#${i}`,
    lovelace,
    hasOnlyAda: true,
  }));
}

function setup(opts: {
  wallets: PoolWallet[];
  caches?: Record<string, WalletUtxo[]>;
  now?: () => number;
}) {
  const pool = createWalletPool(opts.wallets);
  for (const [id, u] of Object.entries(opts.caches ?? {})) pool.setUtxos(id, u);
  const lockTable = createUtxoLockTable({ now: opts.now });
  const arbiter = createWalletArbiter({ pool, lockTable, lockTtlMs: TTL, now: opts.now });
  return { pool, lockTable, arbiter };
}

function asReservation(r: ReturnType<ReturnType<typeof setup>["arbiter"]["acquire"]>): WalletReservation {
  assert.ok(!("unavailable" in r), "expected a reservation, got unavailable");
  return r;
}

describe("createWalletArbiter", () => {
  it("acquires a free wallet and locks exactly RESERVED_UTXOS_PER_TX utxos including a collateral-capable one", () => {
    const { lockTable, arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });

    const r = asReservation(arbiter.acquire());

    assert.equal(r.utxos.length, 2, "reserves RESERVED_UTXOS_PER_TX (=2) utxos");
    assert.ok(r.utxos.some((u) => u.lovelace >= 5_000_000n), "includes a collateral-capable utxo");
    for (const u of r.utxos) {
      assert.equal(lockTable.isLocked(r.walletId, u.outRef), true, "reserved utxos are locked");
    }
    assert.equal(r.signer.value, `seed-${r.walletId}`);
  });

  it("prefers a pool wallet over the main wallet when both are free", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });

    const r = asReservation(arbiter.acquire());
    assert.equal(r.walletId, "p1", "the main wallet is kept free for funding/withdraws");
  });

  it("uses two different free wallets for two concurrent acquires", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool"), wallet("p2", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4), p2: utxos("p2", 4) },
    });

    const a = asReservation(arbiter.acquire());
    const b = asReservation(arbiter.acquire());
    assert.notEqual(a.walletId, b.walletId, "two free pool wallets are used before reusing one");
  });

  it("falls back to free UTxOs of a busy wallet (single-wallet pool stays parallel)", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 4) },
    });

    const a = asReservation(arbiter.acquire());
    const b = asReservation(arbiter.acquire());

    assert.equal(a.walletId, "main");
    assert.equal(b.walletId, "main", "same wallet, second reservation");
    const aRefs = new Set(a.utxos.map((u) => u.outRef));
    const bRefs = new Set(b.utxos.map((u) => u.outRef));
    for (const ref of bRefs) assert.equal(aRefs.has(ref), false, "the two reservations are disjoint");
  });

  it("returns unavailable when no wallet has enough free utxos", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 2) }, // exactly one reservation's worth
    });

    asReservation(arbiter.acquire()); // takes both
    const second = arbiter.acquire();
    assert.deepEqual(second, { unavailable: true });
  });

  it("skips a wallet with no collateral-capable utxo", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 4, 1_000_000n) }, // all 1 ADA < 5 ADA collateral floor
    });

    assert.deepEqual(arbiter.acquire(), { unavailable: true });
  });

  it("skips a wallet that is mid-consolidation", () => {
    const { pool, arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });
    pool.setConsolidating("p1", true);

    const r = asReservation(arbiter.acquire());
    assert.equal(r.walletId, "main", "the consolidating pool wallet is skipped");
  });

  it("release returns capacity and refreshes the cache with produced change", () => {
    const { pool, arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 2) },
    });

    const r = asReservation(arbiter.acquire());
    assert.deepEqual(arbiter.acquire(), { unavailable: true }, "exhausted while reserved");

    const produced: WalletUtxo[] = [{ outRef: "change#0", lovelace: 195_000_000n, hasOnlyAda: true }];
    arbiter.release(r, { consumedOutRefs: r.utxos.map((u) => u.outRef), producedUtxos: produced });

    // The consumed utxos are gone; the change utxo is now cached. With one change
    // utxo only, there are not RESERVED_UTXOS_PER_TX free utxos, so still unavailable.
    assert.deepEqual(pool.getUtxos("main"), produced, "cache = produced change only");
    assert.deepEqual(arbiter.acquire(), { unavailable: true });
  });

  it("treats a double release as a no-op (active count never under-counts)", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 4) },
    });

    const a = asReservation(arbiter.acquire());
    const b = asReservation(arbiter.acquire());
    assert.equal(arbiter.stats().wallets[0]?.reservations, 2);

    arbiter.release(a, { consumedOutRefs: [], producedUtxos: [] });
    arbiter.release(a, { consumedOutRefs: [], producedUtxos: [] }); // repeat

    assert.equal(arbiter.stats().wallets[0]?.reservations, 1, "b is still live; a's repeat release is ignored");
    assert.equal(b.walletId, "main");
  });

  it("reuses a wallet's utxos once their lock TTL has elapsed", () => {
    let now = 1_000;
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 2) },
      now: () => now,
    });

    asReservation(arbiter.acquire()); // locks both utxos, never released
    assert.deepEqual(arbiter.acquire(), { unavailable: true });

    now += TTL + 1;
    asReservation(arbiter.acquire()); // expired locks free the utxos again
  });

  it("reserves the smallest collateral-capable utxo and the largest remaining for the fee", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: {
        main: [
          { outRef: "small#0", lovelace: 6_000_000n, hasOnlyAda: true },
          { outRef: "big#0", lovelace: 98_000_000n, hasOnlyAda: true },
          { outRef: "mid#0", lovelace: 97_000_000n, hasOnlyAda: true },
        ],
      },
    });

    const r = asReservation(arbiter.acquire());
    const refs = new Set(r.utxos.map((u) => u.outRef));
    assert.equal(refs.has("small#0"), true, "smallest collateral-capable utxo is the collateral");
    assert.equal(refs.has("big#0"), true, "largest remaining utxo covers the fee");
    assert.equal(refs.has("mid#0"), false, "the spare utxo is left free for other lanes");
  });

  it("honours a reservedUtxosPerTx override of 1", () => {
    const pool = createWalletPool([wallet("main", "main")]);
    pool.setUtxos("main", utxos("main", 2));
    const arbiter = createWalletArbiter({
      pool,
      lockTable: createUtxoLockTable(),
      lockTtlMs: TTL,
      reservedUtxosPerTx: 1,
    });

    const r = asReservation(arbiter.acquire());
    assert.equal(r.utxos.length, 1);
    assert.ok(r.utxos[0]!.lovelace >= 5_000_000n, "the single reserved utxo is collateral-capable");
  });

  it("prefers a free main wallet over a busy pool wallet (free beats busy)", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });

    const first = asReservation(arbiter.acquire());
    assert.equal(first.walletId, "p1", "pool is preferred while both are free");
    const second = asReservation(arbiter.acquire());
    assert.equal(second.walletId, "main", "a free main beats the now-busy pool wallet");
  });

  it("acquireWallet reserves a specific wallet by id, bypassing the priority", () => {
    const { lockTable, arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });

    // acquire() would prefer the pool wallet; acquireWallet pins the main.
    const r = asReservation(arbiter.acquireWallet("main"));
    assert.equal(r.walletId, "main");
    for (const u of r.utxos) assert.equal(lockTable.isLocked("main", u.outRef), true);
  });

  it("acquireWallet returns unavailable for an unknown, exhausted, or consolidating wallet", () => {
    const { pool, arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 1), p1: utxos("p1", 4) }, // main has < RESERVED_UTXOS_PER_TX
    });

    assert.deepEqual(arbiter.acquireWallet("missing"), { unavailable: true }, "unknown id");
    assert.deepEqual(arbiter.acquireWallet("main"), { unavailable: true }, "too few utxos");

    pool.setConsolidating("p1", true);
    assert.deepEqual(arbiter.acquireWallet("p1"), { unavailable: true }, "consolidating");
  });

  it("acquireSpecificUtxos reserves exactly the requested utxos, verbatim and without a collateral requirement", () => {
    const { lockTable, arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: {
        main: [
          { outRef: "big#0", lovelace: 600_000_000n, hasOnlyAda: true }, // oversized, to be split
          { outRef: "tiny#0", lovelace: 2_000_000n, hasOnlyAda: true }, // below the collateral floor
          { outRef: "spare#0", lovelace: 98_000_000n, hasOnlyAda: true },
        ],
      },
    });

    // The split planner picks an oversized utxo + a tiny top-up; neither is a
    // collateral-capable pick, and the order is preserved exactly.
    const r = asReservation(arbiter.acquireSpecificUtxos("main", ["big#0", "tiny#0"]));

    assert.equal(r.walletId, "main");
    assert.deepEqual(
      r.utxos.map((u) => u.outRef),
      ["big#0", "tiny#0"],
      "reserves exactly the requested out-refs, in order",
    );
    for (const u of r.utxos) assert.equal(lockTable.isLocked("main", u.outRef), true, "requested utxos are locked");
    assert.equal(lockTable.isLocked("main", "spare#0"), false, "the un-requested utxo stays free for other lanes");
  });

  it("acquireSpecificUtxos returns unavailable when a requested utxo is already locked by another lane", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: utxos("main", 4) },
    });

    const held = asReservation(arbiter.acquire()); // locks two of main's utxos
    const stolen = held.utxos[0]!.outRef;

    assert.deepEqual(
      arbiter.acquireSpecificUtxos("main", [stolen, "main-tx#3"]),
      { unavailable: true },
      "a client lane already holds one of the requested utxos — split backs off",
    );
  });

  it("acquireSpecificUtxos returns unavailable for an unknown id, a missing out-ref, or a consolidating wallet", () => {
    const { pool, arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4) },
    });

    assert.deepEqual(arbiter.acquireSpecificUtxos("missing", ["main-tx#0"]), { unavailable: true }, "unknown id");
    assert.deepEqual(arbiter.acquireSpecificUtxos("main", []), { unavailable: true }, "empty request");
    assert.deepEqual(arbiter.acquireSpecificUtxos("main", ["nope#9"]), { unavailable: true }, "out-ref not in cache");

    pool.setConsolidating("p1", true);
    assert.deepEqual(arbiter.acquireSpecificUtxos("p1", ["p1-tx#0"]), { unavailable: true }, "consolidating");
  });

  it("acquireSpecificUtxos + release split outputs let a single wallet back two concurrent lanes", () => {
    const { pool, arbiter } = setup({
      wallets: [wallet("main", "main")],
      caches: { main: [{ outRef: "big#0", lovelace: 600_000_000n, hasOnlyAda: true }] }, // one fat utxo, no parallelism
    });

    // Before split: a single fat utxo can't even form one 2-utxo reservation.
    assert.deepEqual(arbiter.acquire(), { unavailable: true }, "one fat utxo backs no lane");

    // Split consumes the fat utxo and produces a parallel-friendly profile.
    const split = asReservation(arbiter.acquireSpecificUtxos("main", ["big#0"]));
    const profile: WalletUtxo[] = [
      { outRef: "w#0", lovelace: 100_000_000n, hasOnlyAda: true },
      { outRef: "w#1", lovelace: 100_000_000n, hasOnlyAda: true },
      { outRef: "c#0", lovelace: 10_000_000n, hasOnlyAda: true },
      { outRef: "c#1", lovelace: 10_000_000n, hasOnlyAda: true },
    ];
    arbiter.release(split, { consumedOutRefs: ["big#0"], producedUtxos: profile });

    // After split: the same wallet now backs two disjoint concurrent lanes.
    const a = asReservation(arbiter.acquire());
    const b = asReservation(arbiter.acquire());
    const aRefs = new Set(a.utxos.map((u) => u.outRef));
    for (const u of b.utxos) assert.equal(aRefs.has(u.outRef), false, "the two post-split lanes are disjoint");
  });

  it("round-robins across free wallets on repeated acquire/release", () => {
    const { arbiter } = setup({
      wallets: [wallet("main", "main"), wallet("p1", "pool"), wallet("p2", "pool")],
      caches: { main: utxos("main", 4), p1: utxos("p1", 4), p2: utxos("p2", 4) },
    });

    const first = asReservation(arbiter.acquire());
    arbiter.release(first, { consumedOutRefs: [], producedUtxos: [] });
    const second = asReservation(arbiter.acquire());

    assert.notEqual(first.walletId, second.walletId, "least-recently-used pool wallet is chosen next");
    assert.equal(first.role, "pool");
    assert.equal(second.role, "pool");
  });
});
