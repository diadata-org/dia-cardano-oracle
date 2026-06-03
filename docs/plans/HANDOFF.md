# DIA Cardano Oracle Feeder — Handoff

**Last updated:** 2026-06-02
**Branch:** `main`
**Test status:** 464/464 passing · 0 TypeScript errors (`npx tsc --noEmit` clean)

This is the single document a new agent or engineer reads first. It says
exactly what is done, what remains, and how to verify any claim yourself.

---

## 1. How to verify the current state (do this first)

```sh
cd offchain/feeder
npm ci                 # if node_modules is absent
npx tsc --noEmit       # must print nothing (0 errors)
npm test               # must end with "# pass 464  # fail 0"
```

If those two commands are green, everything claimed below is real. Every
fix in Phase R10 has a corresponding test; nothing is "wired but unproven".

---

## 2. What this project is

A TypeScript daemon (`offchain/feeder/`) that reads `IntentRegistered`
events from DIA's Lasernet EVM chain and submits matching oracle-update
transactions to Cardano. The on-chain side is Aiken validators
(`onchain/`); the operator CLI is `offchain/cli/`. Spectra
(`diadata-org/Spectra-interoperability`) is the naming reference for every
metric, API path, config key, and DB column.

Architecture reference: [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md) §9.

---

## 3. Milestone status

| Phase | What | Status |
|---|---|---|
| R0–R9 | Original M2 build (DB, scanner, pipeline, router, worker pools, coalescer, cron, alert evaluator, API, metrics, security, docs) | ✅ Done (see `milestone-2-final-plan.md`) |
| **R10.A** | 11 critical audit fixes | ✅ Done |
| **R10.B** | 14 high-priority audit fixes | ✅ Done |
| **R10.C** | ~130 tests (unit + integration) | ✅ Done |
| R7 (evidence) | 48–72 h Preview run, Grafana PNGs, alert-firing demo, video | ⏳ **Requires a live run** — not code |
| R8 (mainnet) | Mainnet wallet/bootstrap/run + evidence | ⏳ **Requires live Mainnet ops** — not code |

**The codebase is feature-complete and test-green.** What remains is
operational evidence collection (R7/R8), which needs a running feeder
against live Preview/Mainnet — there is no further code to write for those
beyond what `scripts/m2-evidence/` already provides.

---

## 4. Phase R10 — what was fixed (all done)

The full adversarial audit (190 agents, 73 confirmed findings) and the
fix-by-fix detail live in [`milestone-2-final-plan.md`](./milestone-2-final-plan.md)
Phase R10. Every checkbox there is ticked. Summary:

**R10.A — critical (block real-money runs):**
A.1 wire `feeder cleanup` · A.2 handle 3 fire-and-forget `db.*` writes ·
A.3–A.5 throw on 0-row UPDATE (setChainHealth / updateTransactionLog /
resolve+acknowledgeAlert, both drivers) · A.6 `toRegistryLog` throws on
null fields · A.7 `processingTimeoutMs>0` validation · A.8 coalescer
flush recursion→loop · A.9 per-router signer (`private_key_env`) ·
A.10 reject EVM payload-reshaping config (transformations / datasource=
processed / validationenabled=false) · A.11 DB layer tests.

**R10.B — high-priority:**
B.1 AbortController + clearTimeout in worker pool · B.2 scanner reorg
cursor rewind · B.3 `normalizeConfigKey` actually applied · B.4 wire
`bridge_intents_*` aliases · B.5 emit `bridge_transaction_fee_lovelace` ·
B.6 `customer` label on lifecycle aliases · B.7 `getAlertById` SQL lookup
(+ API uses it, ack→404 on unknown) · B.8 rate-limiter bucket eviction ·
B.9 throttled log on metric-persist failure (+ `wrapWithPersistence` now
actually wired) · B.10 evaluator clears tracking on "row gone" (no
infinite retry) · B.11 `parseDurationMs` 0s/negative documented+tested ·
B.12 cron no-symbol startup warning · B.13 scan-handler blockTimestamp
fallback-to-0n on resolver error · B.14 removed dead `requireContractAbi`.

**R10.C — tests:** 45 DB-method tests, plus price-cache, checkpoint-db,
router/symbols, API builders, scanner-ws, registry-client, worker
construction-validation, coalescer reflush-loop, server rate-limiter/
parseLimit, queue-manager mixed-lane, policy duration edge cases, and 3
real-Db integration tests (crash recovery, multi-client alerts, API
round-trip). C.19 scenarios are each either implemented or covered by an
equivalent unit test — see the status note in the plan.

---

## 5. What genuinely remains (not code)

1. **R7 — Evidence pack.** Run the feeder against Cardano Preview for a
   continuous 48–72 h window, then run `make evidence` (renders Grafana
   PNGs via the `grafana-image-renderer` sidecar, builds error-counts +
   stats from the DB). Capture an alert firing (`OraclePairStale`). Record
   the demo video. Scripts already exist in `scripts/m2-evidence/`.
2. **R8 — Mainnet rollout.** Create+fund the Mainnet wallet, run
   `protocol-init` + `client-init`, then the feeder, per
   [`mainnet-rollout.md`](./mainnet-rollout.md). Capture at least one
   confirmed update per pair.

Both are operational, not engineering. Do NOT start a real run until DIA
confirms the live signer set and WS credentials.

---

## 6. M3-deferred (intentionally not wired)

See [`m3-deferred-features.md`](./m3-deferred-features.md). Nothing there
is a bug — each item is either typed-but-not-wired for a later milestone
(replica/HA, dedicated head-tracker/gap-detection loops, per-destination
cron schedules) or permanently excluded (EVM gas knobs, EVM-destination tx
submission, multi-chain fan-out, payload transformations on signed
intents). §D lists honest known limitations (e.g. the SQLite block-number
2^53 ceiling, which is physically unreachable).

---

## 7. Running the feeder locally (Preview)

```sh
cd offchain/feeder
# 1. seed the checkpoint to the chain tip (do NOT replay history):
npm run feeder:dev -- checkpoint set --from-latest
npm run feeder:dev -- checkpoint get        # verify
# 2. run the daemon:
npm run feeder:dev                           # or, full stack with monitoring:
cd ../ && make build && make up MONITORING=1 # feeder + Prometheus + Grafana + renderer
```

`MONITORING=1` is a toggle on every Docker start target (`up`,
`up-postgres`, `restart-latest`, `reset-restart`) — there is no separate
`up-monitoring`. Monitoring stays up until `make down`.

Operator CLI sub-commands: `feeder checkpoint get|set`, `feeder prune
[--max-age 1h] [--dry-run]`, `feeder reset`, `feeder init bootstrap|client`,
`feeder --validate-only`, `feeder --scan`. Full help: `feeder --help`.

`.env` carries selectors + secrets; `config/infrastructure.<network>.yaml`
carries everything else (every Spectra key is present, annotated WIRED or
NOT-WIRED).

---

## 8. Commit trail for Phase R10

All R10 work is on `main`, committed in reviewable units:

- `fix(feeder): R10.A.1-A.8 …` — wire cleanup, silent-failure guards, validation
- `fix(feeder/cmd+persistence): wire checkpoint subcommand …` (earlier)
- `fix(feeder): R10.A.9-A.10 …` — per-router signer + reject EVM payload config
- `test(feeder/persistence): R10.C.1 — 45 method-level Db tests`
- `test(feeder): R10.C.2/C.3/C.7/C.16 …` and `…C.4/C.6/C.8/C.9/C.15 …`
- `fix(feeder): R10.B high-priority fixes (11 of 14) …`
- `feat(feeder/metrics): R10.B.4/B.5/B.6 …`
- `test(feeder): R10 — reorg/getAlertById/evaluator/queue tests`
- integration tests + plan checkboxes (this batch)

`git log --oneline` on `main` shows the sequence.
