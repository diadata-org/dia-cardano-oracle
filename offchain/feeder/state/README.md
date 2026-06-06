# Feeder state

Per-run, per-network runtime state for the feeder, under
`state/<network>_run_<id>/` (e.g. `preview_run_20260604-100120/`,
`mainnet_run_20260517-063917/`). Each deployment gets its own run dir — keyed by
the **same run id the CLI used** (`../../cli/state/<network>_run_<id>/`) — so
multiple deployments of the same network never clobber each other's DB, logs, or
pair state. A run dir mixes two kinds of data: artifacts **imported** from the
CLI (committed) and **runtime** data the daemon writes (gitignored).

## Contents

- [Run selection (RUN_ID)](#run-selection-run_id)
- [Imported artifacts (committed)](#imported-artifacts-committed)
- [Runtime data (gitignored)](#runtime-data-gitignored)
- [Migrating a flat `state/<network>/` deployment](#migrating-a-flat-statenetwork-deployment)
- [Field reference](#field-reference)

## Run selection (RUN_ID)

Every feeder command (`make up`, `init`, `checkpoint`, `prune`, `reset`,
`make evidence`, and the daemon itself) resolves the active run dir the same way
(`cmd/feeder/run-state.ts` → `resolveRunStateDir`):

| `RUN_ID` | Resolves to |
| --- | --- |
| set (`make up RUN_ID=20260517-063917`) | `state/<network>_run_20260517-063917/` |
| empty | the **newest** `state/<network>_run_*/` dir |
| empty **and** no run dirs exist | the flat `state/<network>/` (legacy layout) |

`RUN_ID` is read from the environment (`.env` or `make … RUN_ID=…`). The lowercase
`<network>` tag comes from `CARDANO_NETWORK` (`Preview` → `preview`, `Mainnet` →
`mainnet`).

## Imported artifacts (committed)

Produced by the CLI and imported via `feeder init` (see [`../README.md`](../README.md)).
`feeder init bootstrap` / `init client` import a CLI run
(`../../cli/state/<network>_run_<id>/`) into the matching feeder run dir,
preserving the run id:

- `<network>_run_<id>/config-bootstrap.json` — protocol/global state: compiled
  scripts, reference scripts, PaymentHook, datums. The feeder reads this to know
  the deployed protocol.
- `<network>_run_<id>/clients/<client>.json` — per-client Receiver state the
  feeder reads to build oracle-update transactions for that client.

## Runtime data (gitignored)

Created and maintained by the running daemon; not committed:

- `<network>_run_<id>/feeder.sqlite` (+ `-wal`, `-shm`) — the 6-table database
  (see [`../README.md` → Database](../README.md#database)).
- `<network>_run_<id>/logs/` — `feeder.log`, `transactions.jsonl`, `lane.jsonl`,
  and `intents/`.

## Migrating a flat `state/<network>/` deployment

A feeder that was first set up under the older flat layout keeps a directory like
`state/preview/` with no run id. It keeps working unchanged: with `RUN_ID` empty
and no `state/preview_run_*` dirs present, the resolver falls back to
`state/preview/`. To move it onto the per-run layout, re-run `feeder init` against
the CLI run (`make init-bootstrap` / `init-client`) — that writes a fresh
`state/<network>_run_<id>/`, after which start with `make up RUN_ID=<id>`. The old
flat dir can then be removed once you've confirmed the run dir is in use.

## Field reference

The field-by-field meaning of the imported artifacts is documented once,
canonically, in [`../../cli/state/README.md`](../../cli/state/README.md) — they
are generated there.
