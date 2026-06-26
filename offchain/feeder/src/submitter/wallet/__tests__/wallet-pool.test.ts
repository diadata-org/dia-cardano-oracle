import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createWalletPool, type PoolWallet, type WalletUtxo } from "../wallet-pool.js";

function wallet(id: string, role: PoolWallet["role"]): PoolWallet {
  return { id, role, signer: { kind: "seed", value: `seed-${id}` }, address: `addr_${id}` };
}

function utxo(outRef: string, lovelace: bigint, hasOnlyAda = true): WalletUtxo {
  return { outRef, lovelace, hasOnlyAda };
}

describe("createWalletPool", () => {
  it("exposes the registry and resolves wallets by id", () => {
    const pool = createWalletPool([wallet("main", "main"), wallet("w2", "pool")]);

    assert.deepEqual(
      pool.all().map((w) => w.id),
      ["main", "w2"],
    );
    assert.equal(pool.get("w2")?.address, "addr_w2");
    assert.equal(pool.get("missing"), undefined);
    assert.equal(pool.main().id, "main");
  });

  it("requires exactly one main wallet", () => {
    assert.throws(
      () => createWalletPool([wallet("a", "pool"), wallet("b", "pool")]),
      /exactly one main/,
    );
    assert.throws(
      () => createWalletPool([wallet("a", "main"), wallet("b", "main")]),
      /exactly one main/,
    );
  });

  it("rejects an empty pool and duplicate ids", () => {
    assert.throws(() => createWalletPool([]), /at least one wallet/);
    assert.throws(
      () => createWalletPool([wallet("dup", "main"), wallet("dup", "pool")]),
      /duplicate wallet id/,
    );
  });

  it("stores and returns a per-wallet UTxO cache (empty until set)", () => {
    const pool = createWalletPool([wallet("main", "main"), wallet("w2", "pool")]);

    assert.deepEqual(pool.getUtxos("w2"), []);

    const utxos = [utxo("a#0", 98_000_000n), utxo("b#0", 97_000_000n)];
    pool.setUtxos("w2", utxos);

    assert.deepEqual(pool.getUtxos("w2"), utxos);
    assert.deepEqual(pool.getUtxos("main"), [], "other wallets' caches are independent");
  });

  it("tracks a per-wallet consolidation flag", () => {
    const pool = createWalletPool([wallet("main", "main"), wallet("w2", "pool")]);

    assert.equal(pool.isConsolidating("w2"), false);
    pool.setConsolidating("w2", true);
    assert.equal(pool.isConsolidating("w2"), true);
    assert.equal(pool.isConsolidating("main"), false);
    pool.setConsolidating("w2", false);
    assert.equal(pool.isConsolidating("w2"), false);
  });
});
