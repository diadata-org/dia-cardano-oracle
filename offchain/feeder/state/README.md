# Feeder state

What lives in each feeder state directory. This is a directory guide only —
for **how** the feeder selects a run, starts, or migrates, see
[`../README.md` → Per-run state (RUN_ID)](../README.md#per-run-state-run_id).

State is kept per run, per network, under `state/<network>_run_<id>/`
(e.g. `preview_run_20260604-100120/`, `mainnet_run_20260517-063917/`). The
`<id>` matches the CLI run it was imported from
(`../../cli/state/<network>_run_<id>/`). A directory mixes artifacts **imported**
from the CLI (committed) and **runtime** data the daemon writes (gitignored).

## Contents

- [Imported artifacts (committed)](#imported-artifacts-committed)
- [Runtime data (gitignored)](#runtime-data-gitignored)
- [Field reference](#field-reference)

## Imported artifacts (committed)

Written by `feeder init bootstrap` / `init client` from a CLI run:

- `<network>_run_<id>/config-bootstrap.json` — protocol/global state: compiled
  scripts, reference scripts, PaymentHook, datums.
- `<network>_run_<id>/clients/<client>.json` — per-client Receiver state.

## Runtime data (gitignored)

Written by the running daemon:

- `<network>_run_<id>/feeder.sqlite` (+ `-wal`, `-shm`) — the 6-table database
  (see [`../README.md` → Database](../README.md#database)).
- `<network>_run_<id>/logs/` — `feeder.log`, `transactions.jsonl`, `lane.jsonl`,
  and `intents/`.

## Field reference

The field-by-field meaning of the imported artifacts is documented once,
canonically, in [`../../cli/state/README.md`](../../cli/state/README.md) — they
are generated there.
