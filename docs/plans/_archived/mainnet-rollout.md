> **ARCHIVED 2026-06-05** — superseded by [`../milestone-feeder-plan.md`](../milestone-feeder-plan.md).
> Its CLI commands were broken (no 'init bootstrap' / 'protocol init' / 'router init'); the corrected Mainnet procedure is in §3 of the new plan. Any still-open items were carried into that consolidated plan; the only live
> plans are `../work-plan.md` and `../milestone-feeder-plan.md`. Kept for history — do
> not use as the live plan.

---

# Mainnet Rollout and Rollback Plan

Operational runbook for promoting the DIA Cardano Oracle feeder from
Preview (Testnet) to Cardano Mainnet.

---

## R8.1 — Config validation checklist

Before starting the feeder on Mainnet, verify `infrastructure.mainnet.yaml`:

| Check | Expected | Command |
|---|---|---|
| `database.driver` | `sqlite` or `postgres` | `grep driver infrastructure.mainnet.yaml` |
| `database.path` | inside `state/` | Confirm path starts with `state/mainnet/` |
| `source.chain_id` | `1050` (DIA Mainnet) | `grep chain_id infrastructure.mainnet.yaml` |
| `source.rpc_urls` | at least one reachable | `curl -s <rpc_url>` responds |
| `api.host` | `127.0.0.1` for bare-metal; `0.0.0.0` inside Docker only | Confirm Docker or bare-metal deployment |
| `api.port` | not conflicting | `ss -tlnp \| grep <port>` |
| `alerting.*` | all thresholds defined | `grep alerting infrastructure.mainnet.yaml` |
| `dry_run` | `false` | `grep dry_run infrastructure.mainnet.yaml` |
| `worker_pool.retry_delay` | set (no silent default) | grep confirms value |
| `worker_pool.max_retries` | set | grep confirms value |
| `worker_pool.inflight_timeout_ms` | set | grep confirms value |

Run the config validator before starting:
```sh
npm run feeder:dev -- daemon --config config --network Mainnet --dry-run
```
A dry-run startup validates all config fields and exits cleanly if
everything is correct (with no Cardano transactions submitted).

---

## R8.3 — Wallet and funding

1. Generate the Mainnet feeder wallet (outside this repository; store
   only the **address** here, never the seed phrase):
   ```
   Mainnet feeder address: (record here after generation)
   ```
2. Fund the wallet with at least **10 ADA** for initial tx fees.
3. Set `alerting.admin_wallet_low_lovelace` to `5000000000` (5 ADA) so
   the feeder warns before fees run out.
4. The Receiver UTxO is funded via the `protocol-init` + `client-init`
   flows. Its minimum balance should exceed
   `alerting.receiver_balance_low_lovelace` (currently 2 ADA).

---

## R8.4 — Protocol and client bootstrap

Run these in order against Mainnet. Record all tx hashes in this file.

```sh
# 1. Bootstrap config
npm run cli -- init bootstrap --network mainnet

# 2. Protocol init (publishes reference scripts once per protocol deployment)
npm run cli -- protocol init --network mainnet

# 3. Client init (one per oracle pair client)
npm run cli -- init client --network mainnet --config <client-config>

# 4. Router init (creates the first pair UTxO; transitions pair from Mint → Update state)
npm run cli -- router init --network mainnet
```

| Tx | Hash | Block | Date |
|---|---|---|---|
| protocol-init | (record after run) | | |
| client-init | (record after run) | | |
| router-init | (record after run) | | |

---

## R8.5 — Feeder startup

```sh
cd offchain/feeder

# Preview the scan range before committing
npm run feeder:dev -- checkpoint set --network Mainnet --from-latest

# Start the daemon
npm run feeder:dev -- daemon --config config --network Mainnet --log-level info
```

Confirm at least one pair update per configured pair within the first
cron cycle (`cron_service.tick_interval`, default 30 s).

---

## R8.6 — Rollback plan

The Mainnet rollback is simple because the feeder is stateless with
respect to the on-chain protocol:

### Stop the feeder

```sh
# Send SIGTERM to the daemon process
kill -TERM <feeder-pid>

# Or via Docker
docker-compose -f offchain/feeder/docker-compose.yml stop feeder
```

The daemon drains in-flight submissions and exits. No chain-side action
is required — the on-chain pair UTxOs are immutable and do not need to
be cleaned up.

### On-chain state after rollback

- Pair UTxOs remain on-chain. They hold the last confirmed price data.
- No destructive tx is needed. The protocol validator does not expire
  UTxOs; they simply stop being updated while the feeder is stopped.
- Any in-flight Cardano tx that was submitted before the stop will
  confirm or fail on its own; no manual intervention required.

### DB / local state

- The SQLite DB (`state/mainnet/feeder.sqlite`) is operator state.
  Archive it if historical data is needed:
  ```sh
  cp state/mainnet/feeder.sqlite backups/feeder-$(date +%Y%m%d%H%M%S).sqlite
  ```
- To restart from a clean state after a rollback:
  ```sh
  npm run feeder:dev -- daemon --network Mainnet --clean
  ```
  This removes `state/mainnet/feeder.sqlite*` and pair-state JSON
  files, then starts fresh (no DB migration to reverse — the schema
  is created fresh on each clean start).

### No data loss risk

- The fresh DB schema (R1.3) has no ALTER TABLE migrations. A clean
  restart always creates a conformant schema.
- There is no JSON checkpoint file to reconcile; the checkpoint lives
  in `chain_state.last_scan_block` and is reset to 0 on `--clean`.
- Resetting the checkpoint means the scanner replays from `start_block`
  (or block 0). Set `--from-latest` after a rollback to avoid replaying
  all of Mainnet history:
  ```sh
  npm run feeder:dev -- checkpoint set --network Mainnet --from-latest
  ```

### Summary

| Action | Command | Notes |
|---|---|---|
| Stop feeder | `kill -TERM <pid>` | Drain in-flight; exits cleanly |
| Archive DB | `cp state/mainnet/feeder.sqlite backups/...` | Optional; for audit trail |
| Clean state | `daemon --network Mainnet --clean` | Removes DB + pair-state JSON |
| Set checkpoint | `checkpoint set --from-latest` | Skip Mainnet history replay |
| Restart | `daemon --network Mainnet` | Fresh start from chain tip |
