# Feeder state

Per-network runtime state for the feeder, under `state/<network>/` (e.g. `preview/`). It
mixes two kinds of data: artifacts **imported** from the CLI (committed) and **runtime**
data the daemon writes (gitignored).

## Contents

- [Imported artifacts (committed)](#imported-artifacts-committed)
- [Runtime data (gitignored)](#runtime-data-gitignored)
- [Field reference](#field-reference)

## Imported artifacts (committed)

Produced by the CLI and imported via `feeder init` (see [`../README.md`](../README.md)):

- `<network>/config-bootstrap.json` — protocol/global state: compiled scripts, reference
  scripts, PaymentHook, datums. The feeder reads this to know the deployed protocol.
- `<network>/clients/<client>.json` — per-client Receiver state the feeder reads to build
  oracle-update transactions for that client.

## Runtime data (gitignored)

Created and maintained by the running daemon; not committed:

- `<network>/feeder.sqlite` (+ `-wal`, `-shm`) — the 6-table database
  (see [`../README.md` → Database](../README.md#database)).
- `<network>/logs/` — `feeder.log`, `transactions.jsonl`, `lane.jsonl`, and `intents/`.

## Field reference

The field-by-field meaning of the imported artifacts is documented once, canonically, in
[`../../cli/state/README.md`](../../cli/state/README.md) — they are generated there.
