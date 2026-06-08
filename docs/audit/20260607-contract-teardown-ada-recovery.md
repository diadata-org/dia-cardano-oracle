# Contract teardown & ADA-recovery audit

Decommissioning a live deployment to recover as much locked ADA as possible
before redeploying fresh. A redeploy is required because the on-chain change
that lets an oracle update absorb side-deposits (generalized `AccrueFee`, see
[`m2-hardening-implementation-plan.md` §A2](../plans/_archived/m2-hardening-implementation-plan.md))
changes the `receiver` and `update_coordinator` script hashes — every per-client
address re-derives, so the old deployment is orphaned and must be torn down.

**Do Preview first, then Mainnet.** This document is the procedure; the actual
on-chain run is gated and executed separately.

> **Chain-as-truth runner.** The per-command runbook below is the canonical
> manual sequence. For an automated run there is also
> `offchain/cli/scripts/run-teardown-cli.sh`, which stops trusting the committed
> state JSONs as the list of what to act on: it QUERIES the live on-chain UTxOs
> (`scripts/teardown-helpers/query-live.ts`), acts ONLY on what is on-chain right
> now, skips verbs whose target the chain says is already gone, and records
> orphan/teardown markers back into state (`scripts/teardown-helpers/record-teardown.ts`).
> A Preview teardown has been executed this way — see
> `docs/milestones/evidence/teardown-v2-preview-20260606-082456/`.

## Contents

- [Locked-ADA inventory](#locked-ada-inventory)
- [Recovery path per UTxO type](#recovery-path-per-utxo-type)
- [Teardown order (and the hazards)](#teardown-order-and-the-hazards)
- [Recoverable vs permanently stuck](#recoverable-vs-permanently-stuck)
- [Two gaps that strand recoverable ADA](#two-gaps-that-strand-recoverable-ada)
- [Deployed state to tear down](#deployed-state-to-tear-down)
- [Runbook — Preview first, then Mainnet](#runbook--preview-first-then-mainnet)

## Locked-ADA inventory

Every UTxO that locks ADA in a live deployment, with how its lovelace is composed:

| UTxO | Count | Lovelace held | Pinned by |
| --- | --- | --- | --- |
| Config | 1 | `min_utxo` | `config_state.ak:80-81` |
| PaymentHook | 1 | `min_utxo + accrued_fees` | `payment_hook_logic.ak:31-33` |
| Receiver | 1 per client | `min_utxo + balance + accrued_to_hook` | `receiver_logic.ak:32-34` |
| Pair | 1 per client × pair | `min_utxo` | `pair_state.ak:209-210` |
| Reference scripts | `3 + 4·clients` | script bytes + min-UTxO (large) | published at `reference_holder` |
| Side-deposits | variable | plain ADA at the per-client deposit address | `deposit.ak` |

Reference-script UTxOs: **global (3)** — `config`, `update_coordinator`, `payment_hook`;
**per-client (4)** — `receiver`, `pair`, `pairMint`, `deposit`. A reference-script
UTxO holds the full Plutus script, so its min-UTxO is the **single largest
recoverable line item** (tens of ADA each).

## Recovery path per UTxO type

The CLI command column shows two generations side by side: the **current
deployed** contracts (old, no burn on config/hook/receiver) and the **next-gen
redeployed** contracts (a `Burn` path on all four NFT families + the deposit
ref-script reclaim fix). A teardown of an already-live deployment uses the
current-contract column; teardown of a future redeployment uses the next-gen
column.

| UTxO | CLI command (current) | CLI command (next-gen) | Auth | Recovers | Stuck (current) |
| --- | --- | --- | --- | --- | --- |
| Config | *(none — no burn action)* | `config:burn` | config signer | next-gen: **full min-UTxO** | **whole min-UTxO** |
| PaymentHook | `payment-hook:withdraw` | `payment-hook:withdraw` + `payment-hook:burn` | config signer | `accrued_fees`; next-gen also **min-UTxO** | **min-UTxO** (NFT not burnable) |
| Receiver | `receiver:withdraw` (+ `settle` for accrued) | `receiver:withdraw` + `settle` + `receiver:burn` | config signer | `balance` + `accrued`; next-gen also **min-UTxO** | **min-UTxO** (NFT not burnable) |
| Pair | `pair:burn` (`pair:dedup` for dups) | `pair:burn` (`pair:dedup` for dups) | config signer | **full min-UTxO** | nothing |
| Reference scripts | `reclaim-reference-script --script <config\|payment-hook\|client>` | same; `--script client` also reclaims the `deposit` ref-script | config signer | **full min-UTxO of each** | deposit ref-script (current only — see gaps) |
| Side-deposits | `deposit:merge` → then `receiver:withdraw` | same | permissionless on-chain | swept ADA → balance → withdrawn | dust below floor |

**The decisive fact (current deployed contracts):** the deployed `config_state`,
`payment_hook`, and `receiver` mint policies expose **only a `Bootstrap` action —
no burn**. Their NFTs can never be burned, so those UTxOs can never be fully spent
and their min-UTxO is permanently locked. Only `pair_state` has a burn, so only
Pair min-UTxOs and the (non-deposit) reference scripts come back in full.

**Next-gen redeployed contracts close this.** Each of `config_state`,
`payment_hook`, and `receiver` now exposes a `Burn` mint action and a `Burn` spend
redeemer (`config_logic.ak:48-55`, `payment_hook_logic.ak:16-26`,
`receiver_logic.ak:14-29`; validators `config_state.ak`, `payment_hook.ak`,
`receiver.ak`), mirroring the existing `pair_state` burn. Each burn is config-signer
gated, burns the NFT `-1`, forbids a continuation output carrying the NFT, and
zeroes the value fields it guards (receiver: `balance == 0 && accrued_to_hook == 0`;
hook: `accrued_fees == 0`; config: none — Config holds no value beyond its
min-UTxO). So on a next-gen teardown the config/hook/receiver min-UTxOs are
recovered too, leaving no per-deployment floor of stuck ADA beyond dust. This burn
**cannot be added retroactively** to the live deployments — it changes the script
hashes — but the redeploy that Option B already forces (the generalized `AccrueFee`,
see [`m2-hardening-implementation-plan.md` §A2](../plans/_archived/m2-hardening-implementation-plan.md))
re-bootstraps every contract, so the next generation ships with it.

## Teardown order (and the hazards)

On-chain constraints force this order; getting it wrong strands ADA.

1. **Stop the feeder.** New updates mint Pair NFTs and accrue fees, re-locking ADA.
2. **`deposit:merge` per client** — sweep side-deposits into the Receiver balance
   *first*. A deposit can only co-spend a tx that *raises* the Receiver's lovelace;
   `settle`/`withdraw` *lower* it and can never co-spend a deposit
   (`deposit_logic.ak:18-24`). Drain the receiver before merging and the deposits
   orphan. (No-op on deployments with no deposit address.)
3. **`settle` per client where `accrued > 0`** — drains each Receiver's accrual into
   the PaymentHook. `settle` rejects `accrued == 0` (`settle.ts:177-186`,
   `receiver_logic.ak:94`); skip zero-accrued receivers.
4. **`receiver:withdraw` per client** — drain `balance` to the admin/recipient.
5. **`payment-hook:withdraw`** — drain the hook's now-aggregated `accrued_fees`.
   Run **after** all settles to take the full total in one pass.
6. **`pair:burn` per (client, pair)** (and `pair:dedup` for duplicates) — burns each
   Pair NFT and returns its full min-UTxO. Independent of the receiver.
7. **`reclaim-reference-script` LAST.** Reference scripts are read by the
   withdraw/settle/burn txs; reclaiming them first only forces inline-validator
   fallback (supported, but bigger fees). Reclaim authorization reads the Config
   UTxO (`reference_holder.ak:16-21`) — so **keep the Config UTxO alive until every
   reference script is reclaimed** (on the current contracts it persists anyway,
   since the Config NFT can't be burned; on next-gen contracts `config:burn` is the
   very last step, after all reclaims). Order: `--script client` (×each client),
   `--script payment-hook`, `--script config` (reclaims config + coordinator
   together).

**Hazards:** merge before any receiver drain; settle before hook-withdraw; never
strand the Config UTxO while reference scripts remain unreclaimed; on next-gen,
never burn config/hook/receiver before their drains (the validator rejects it).

## Recoverable vs permanently stuck

Per deployment with `C` clients, `P` pairs, `min` = `min_utxo_lovelace`:

**Recoverable** = `Σ reference-script min-UTxOs (the big one)` + `Σ receiver balances`
+ `Σ receiver accrued + hook accrued` (via settle → hook-withdraw)
+ `P · min` (pair burns) + `Σ swept deposits`.

**Stuck on the current deployed contracts** = `config min` + `hook min` +
`C · receiver min` + deposit-address dust. (No deposit ref-script term: none of the
live deployments published one — see the deployed-state table below.)

With `min = 5 ADA` and `C = 1`, the floor of stuck ADA on a **current-contract**
teardown is **~15 ADA/deployment** (config + hook + receiver), plus dust.
Everything else comes back; the reference scripts are the bulk of the recovery and
their exact lovelace should be read from chain at teardown time.

**Stuck on a next-gen teardown** = deposit-address dust only. The `config:burn`,
`payment-hook:burn`, and `receiver:burn` paths recover `config min` + `hook min` +
`C · receiver min`, and `reclaim-reference-script --script client` recovers the
per-client `deposit` ref-script along with receiver/pair/pairMint. The ~15 ADA
floor is gone.

## Two gaps that strand recoverable ADA

Both gaps below are now **fixed in the next-gen contracts + CLI**. They are
**not** retrofittable to the live deployments (the burn changes script hashes), so
the immediate teardown of the current Preview/Mainnet deployments is unchanged —
the fixes apply to every teardown *after* the Option-B redeploy.

1. **Per-client `deposit` reference script is not reclaimable via the CLI.** It was
   published (`client-reference-scripts.ts:120`, output index 3) but omitted from
   `resolveClientUtxoRefs`, which reclaimed only `receiver`/`pair`/`pairMint`. The
   UTxO sits at `reference_holder` and the validator authorizes any config-signer
   spend. **FIXED:** `reclaim-reference-script --script client` now also reclaims the
   `deposit` reference output — `resolveClientUtxoRefs` pushes the `deposit` entry
   when the client state recorded one (`reclaim-reference-script.ts:306-312`), and
   the cleared-entry block resets it too (`:349-358`). Clients that never published
   a deposit ref-script (the current live deployments) are unaffected: the entry is
   absent, so nothing is added or cleared.

2. **Config / Hook / Receiver NFTs are non-burnable**, so their min-UTxO was lost on
   every teardown of the current contracts. **FIXED in next-gen:** `config_state`,
   `payment_hook`, and `receiver` each gained a `Burn` mint action and a `Burn`
   spend redeemer mirroring `pair_state` — config-signer gated, NFT burned `-1`, no
   continuation output, and the value-field preconditions (receiver: `balance == 0
   && accrued_to_hook == 0`; hook: `accrued_fees == 0`; config: none). The CLI
   exposes `config:burn`, `payment-hook:burn`, and `receiver:burn`. The burn cannot
   be added retroactively, but the Option-B redeploy already re-bootstraps every
   contract, so the next generation recovers these min-UTxOs.

## Deployed state to tear down

From the committed CLI state artifacts (exact on-chain balances to be re-read at
teardown):

| Deployment | clients | pairs | balance | accrued | deposit ref-script |
| --- | --- | --- | --- | --- | --- |
| `preview_run_20260516-090057` | 1 | 11 | 100.05 ADA | 42.5 ADA | none |
| `preview_run_20260606-082456` | 1 | 11 | 42.55 ADA | 0 | none |
| `mainnet_run_20260517-063917` | 1 | 11 | 42.55 ADA | 0 | none |

Each: 6 reference-script UTxOs (3 global + 3 per-client; no deposit), 11 Pair
UTxOs (55 ADA via burn), 1 Receiver, 1 Hook, 1 Config. Stuck floor ≈ 15 ADA each.

## Runbook — Preview first, then Mainnet

### Current deployments (old contracts — no config/hook/receiver burn)

All commands require the configured wallet to be a `config` signer. Use
`--build-only` first to inspect, then submit. `<cfg>` = that deployment's
`config-bootstrap.json`, `<client>` = `clients/client-a.json`.

```sh
# 0. Stop the feeder for that network (make down) so no new updates land.

# 1. (no deposits on current deployments — skip; future: deposit:merge per client)

# 2. settle accrued (only where accrued > 0 — e.g. preview_run_20260516)
npm run cli -- settle --protocol-state <cfg> --client-state <client>

# 3. withdraw the client's prepaid balance
npm run cli -- receiver:withdraw --amount-lovelace <balance> --protocol-state <cfg> --client-state <client>

# 4. withdraw the hook's aggregated fees
npm run cli -- payment-hook:withdraw --amount-lovelace <hook-accrued> --protocol-state <cfg>

# 5. burn every pair (11 per deployment); pair:dedup first if duplicates exist
npm run cli -- pair:dedup --protocol-state <cfg> --client-state <client>
#   then, per pair file under clients/<client>/pairs/:
npm run cli -- pair:burn --protocol-state <cfg> --client-state <client> --pair-state <pair>

# 6. reclaim reference scripts LAST (keep Config UTxO alive until done)
npm run cli -- reclaim-reference-script --script client       --protocol-state <cfg> --client-state <client>
npm run cli -- reclaim-reference-script --script payment-hook  --protocol-state <cfg>
npm run cli -- reclaim-reference-script --script config        --protocol-state <cfg>
```

Run the full sequence on **one Preview deployment** first, confirm the recovered
ADA lands in the wallet and the only residue is the ~15 ADA of non-burnable
min-UTxO, then repeat for the other Preview deployment, and finally for Mainnet.
The Config/Hook/Receiver UTxOs are left abandoned at the now-orphaned script
addresses — expected on the current contracts.

### Future deployments (next-gen contracts — all four families burn)

A teardown of a redeployed (next-gen) deployment runs steps 1–5 above unchanged,
then **burns the three remaining state UTxOs** before reclaiming the reference
scripts. Each burn requires the configured wallet to be a `config` signer and the
relevant drain to have run first (the validator rejects a burn otherwise).

```sh
# 5b. burn the receiver — only after its balance is withdrawn (step 3)
#     AND its accrued is settled (step 2); the validator requires
#     balance == 0 && accrued_to_hook == 0.
npm run cli -- receiver:burn --protocol-state <cfg> --client-state <client>

# 5c. burn the payment hook — only after its fees are withdrawn (step 4);
#     the validator requires accrued_fees == 0.
npm run cli -- payment-hook:burn --protocol-state <cfg>

# 6. reclaim reference scripts (keep Config UTxO alive until done).
#    --script client now also reclaims the per-client deposit ref-script.
npm run cli -- reclaim-reference-script --script client       --protocol-state <cfg> --client-state <client>
npm run cli -- reclaim-reference-script --script payment-hook  --protocol-state <cfg>
npm run cli -- reclaim-reference-script --script config        --protocol-state <cfg>

# 7. burn the config LAST — after every reference script is reclaimed, since
#    reclaim authorization reads the live Config UTxO.
npm run cli -- config:burn --protocol-state <cfg>
```

On a next-gen teardown the only residue is deposit-address dust; the config, hook,
and receiver min-UTxOs and the deposit ref-script are all recovered.
