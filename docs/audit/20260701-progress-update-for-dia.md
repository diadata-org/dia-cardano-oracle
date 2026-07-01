# Progress Update for DIA — Milestone 4 build complete, in reliability run

**Date:** 2026-07-01 · **Audience:** DIA + PROTOFIRE · **Purpose:** a short,
plain-language status note covering what we did since the
[June 25 update](./20260625-progress-update-for-dia.md), where each milestone
stands for submission, and the little that is left for Milestone 4.

This is a status note, not a remediation document.

## Contents

- [TL;DR](#tldr)
- [Where each milestone stands](#where-each-milestone-stands)
- [What we did since June 25](#what-we-did-since-june-25)
- [What is left for Milestone 4](#what-is-left-for-milestone-4)
- [Where to read more](#where-to-read-more)

## TL;DR

- **Milestone 4 is now fully built.** Every piece of code, every test, and the
  Preview evidence are in the repository. Since the last update we finished the
  last capability that was still open — the ability to keep the oracle running
  **reliably at higher volume**, using **several signer wallets at once** and
  **many funds within each wallet at once**, so updates never queue up behind a
  single wallet. This is tested end-to-end on Preview.
- **We can now see exactly what the system costs to run.** New dashboards break
  out the on-chain fees and the "housekeeping" transactions (the overhead the
  operator pays, which no consumer reimburses), so the running cost is visible
  at a glance, per transaction type and per wallet.
- **What is left is small and external.** The remaining Milestone 4 items are
  the ones that depend on time or on outside publication: the **sustained
  mainnet reliability run**, the **close-out video**, the **final close-out
  report**, and **publishing the developer documentation on DIA's own website**
  (the documentation itself is already complete inside the repository).

## Where each milestone stands

A simple view of the submission pipeline:

- **Milestone 1 — approved.** ✅
- **Milestone 2 — delivered; awaiting sign-off.** The work and evidence are in;
  we are waiting on the review sign-off.
- **Milestone 3 — complete and ready to submit.** The Proof-of-Achievement is
  written, with its mainnet evidence pack and demo video, pinned to a specific
  code version.
- **Milestone 4 — build complete; in the reliability run.** All the code and
  tests are done and in the repository, proven on Preview. What remains is the
  multi-day mainnet run and the externally-produced close-out materials.

So the order is unchanged: M2 sign-off → submit M3 → once M3 is approved and
signed, present M4.

## What we did since June 25

The last update said Milestone 4 was "nearly complete", with the indexer, the
consumer example, and the consumer documentation all done. Since then we closed
the remaining engineering work, all of it landed in the repository with tests
and Preview evidence, and **on the same contracts already deployed for Milestone
2 — no redeployment**.

**Running reliably at volume: a pool of signer wallets.**

- The feeder can now sign and submit updates from **several wallets in parallel**
  instead of one. A shared arbiter hands each transaction its own wallet and its
  own set of funds, so two updates never fight over the same coin and never have
  to wait in line behind each other.
- Each wallet is kept in the right **shape** automatically: the system tops up
  pool wallets from the main wallet when they run low, and splits an
  over-concentrated wallet into enough separate funds to feed the parallel lanes.
  This all happens on the feeder's regular maintenance tick, with no operator
  intervention.
- This is the piece that lets a busy oracle keep up: many feeds updating close
  together no longer serialise through a single wallet. It is tested end-to-end —
  in a network emulator and on Preview — including the multi-wallet, multi-fund
  case running under load.

**Seeing every wallet, and warning early.**

- The monitoring now shows **each signer wallet on its own** — its balance, how
  many usable funds it holds, and whether it is ready to sign — with alerts that
  fire per wallet, so a single wallet drifting out of shape is caught before it
  affects updates.

**Seeing what the system costs to run.**

- Every **housekeeping transaction** — the ones the operator pays for and no
  consumer reimburses (settling client balances, withdrawing operator fees,
  funding and reshaping the wallet pool, tidying up funds) — now reports its
  actual on-chain fee, recorded by transaction type and by wallet.
- A new **Operational Cost** dashboard turns this into a clear running-cost view:
  how much ADA the overhead is consuming, split by what kind of transaction it is
  and which wallet paid it. The figures are persisted, so they survive restarts
  and reflect the lifetime cost, not just the current session. This is what lets
  us answer "how much overhead does managing the oracle actually add?" directly
  from the dashboards.

**Evidence refreshed.**

- We regenerated the Milestone 4 Preview evidence pack on top of the multi-wallet
  run and the new dashboards, and refreshed the Milestone 4
  Proof-of-Achievement draft to match.

## What is left for Milestone 4

The build is done. What remains is external or time-windowed:

- **The sustained mainnet reliability run** that meets the 99.99%
  uptime-and-accuracy target — a multi-day window on a single slow feed
  (ARS/USDT, every 30 minutes) that keeps the run cheap while demonstrating
  sustained liveness and accuracy — plus the mainnet evidence pack it produces.
- **The close-out video.**
- **The final close-out report.**
- **Publishing the developer documentation on DIA's own website** — the
  documentation itself is already complete in the repository; publication is the
  external step.

The Milestone 4 Proof-of-Achievement is already drafted, with all the technical
evidence in place and clearly-marked placeholders for exactly the four items
above.

Details: [`../plans/m4-plan.md`](../plans/m4-plan.md).

## Where to read more

- **Milestone 3 delivery:** [`../milestones/milestone-3-poa.md`](../milestones/milestone-3-poa.md)
  + the QA demo video <https://youtu.be/W-vfgsoeXp4>
- **Milestone 4 (draft):** [`../milestones/milestone-4-poa.md`](../milestones/milestone-4-poa.md)
  + the Preview evidence pack
  [`milestone-4-preview-evidence.md`](../milestones/evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md)
  (indexer responses, the consumer contract accepting/rejecting on price, the
  on-chain demo, the multi-wallet run, and the dashboards)
- **Indexer (the consumer's entry point):** [`../../offchain/indexer/README.md`](../../offchain/indexer/README.md)
  — how to read a feed, how the payment works, and how to request a new feed
- **Dashboards (per-wallet + operational cost):** [`../architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md)
- **Architecture:** [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
  · [`../architecture/feeder.md`](../architecture/feeder.md) (signer-wallet pool)
- **Plans:** [`../plans/m4-plan.md`](../plans/m4-plan.md)
- **Previous update:** [`20260625-progress-update-for-dia.md`](./20260625-progress-update-for-dia.md)
