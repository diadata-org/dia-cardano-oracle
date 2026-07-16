# Progress Update for DIA — Milestone 4 mainnet run complete, submission-ready

**Date:** 2026-07-16 · **Audience:** DIA + PROTOFIRE · **Purpose:** a short,
plain-language status note covering what we did since the
[July 1 update](./20260701-progress-update-for-dia.md) and exactly what we
need from DIA before Milestone 4 can be submitted.

This is a status note, not a remediation document.

## Contents

- [Progress Update for DIA — Milestone 4 mainnet run complete, submission-ready](#progress-update-for-dia--milestone-4-mainnet-run-complete-submission-ready)
  - [Contents](#contents)
  - [TL;DR](#tldr)
  - [Where each milestone stands](#where-each-milestone-stands)
  - [What we did since July 1](#what-we-did-since-july-1)
  - [What we need from DIA](#what-we-need-from-dia)
  - [Where to read more](#where-to-read-more)

## TL;DR

- **The mainnet reliability run happened.** The one thing the last update
  flagged as outstanding — a multi-day live run on Mainnet proving sustained
  uptime — ran 2026-07-13 to 2026-07-14: **40 confirmed updates, 0 reorgs,
  99.78% uptime** against the 99.99% target.
- **Monitoring now runs independently per network.** Preview and Mainnet each
  carry their own alert thresholds and dashboards, so tuning one can no longer
  affect the other.
- **We corrected one number in our own evidence before sending anything out**
  — a mislabeled failure, fixed; real result is 0 real on-chain failures for
  the run, not 1.
- **Preview evidence stays in the submission** — it is what shows 10+ live
  feeds, which Mainnet alone does not carry.
- **What's left needs DIA:** the close-out report needs a few inputs from
  you, and **both the close-out video and the end-to-end install/access demo
  are DIA's to produce**, not ours.

## Where each milestone stands

- **Milestone 1 — approved.** ✅
- **Milestone 2 — approved.** ✅
- **Milestone 3 — submitted; awaiting sign-off.**
- **Milestone 4 — build and mainnet run complete; submission-ready pending
  the close-out materials** (see below).

## What we did since July 1

- **Mainnet reliability run, done.** `ARS/USDT` ran live on Mainnet
  2026-07-13 09:45 → 2026-07-14 18:01 UTC (~32.3 h): **40 confirmed updates,
  0 reorgs, 99.78% uptime**. Full evidence pack in the repository; the PoA's
  uptime, headline transaction, and AC#1 links are filled in with real data.
- **Monitoring split per network.** Preview and Mainnet each now have their
  own alert thresholds and dashboards instead of sharing one config.
- **Evidence packager hardened.** Fixed port resolution and added retries so
  a slow chain provider doesn't blank out a report.
- **One evidence number corrected.** A mislabeled transaction failure (it had
  never actually reached the chain) is now counted correctly: 0 real on-chain
  failures for the run, not 1.
- **Preview evidence confirmed necessary.** It's the only place in the
  submission showing 10+ live feeds (16, vs. Mainnet's 1) — kept and cited
  explicitly in the PoA.
- **Close-out report — first draft started**, built only from verified
  numbers (transactions, uptime, feed count, tests). See
  [`../milestones/close-out-report.md`](../milestones/close-out-report.md).

## What we need from DIA

**The close-out report** needs four inputs only DIA can supply — we're not
guessing at these:

1. Any current or committed dApp integrations using the live feed, if any.
2. Any TVL, partnership, or ecosystem-adoption figures you want reported.
3. The maintenance/support arrangement and revenue model going forward.
4. When to publish the developer documentation on DIA's website (already
   noted in the PoA as timed to your marketing announcement).

**Two videos are still missing:**

1. **The close-out video** (Catalyst requirement, ~2-5 min).
2. **The end-to-end install/access demo** (for developers adopting the
   tooling).

Neither blocks us from continuing to prepare the rest of the submission.

Details: [`../plans/m4-plan.md`](../plans/m4-plan.md).

## Where to read more

- **Milestone 4 PoA:** [`../milestones/milestone-4-poa.md`](../milestones/milestone-4-poa.md)
- **Mainnet evidence pack:** [`milestone-4-mainnet-evidence.md`](../milestones/evidence/m4-mainnet-20260616-074413/milestone-4-mainnet-evidence.md)
- **Preview evidence pack:** [`milestone-4-preview-evidence.md`](../milestones/evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md)
- **Close-out report (draft, DIA inputs needed):** [`../milestones/close-out-report.md`](../milestones/close-out-report.md)
- **Indexer:** [`../../offchain/indexer/README.md`](../../offchain/indexer/README.md)
- **Dashboards:** [`../architecture/grafana-dashboards.md`](../architecture/grafana-dashboards.md)
- **Plans:** [`../plans/m4-plan.md`](../plans/m4-plan.md)
- **Previous update:** [`20260701-progress-update-for-dia.md`](./20260701-progress-update-for-dia.md)
