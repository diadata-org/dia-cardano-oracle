# Progress Update for DIA — Milestone 2 delivered on Mainnet, Milestone 3 nearly complete

**Date:** 2026-06-18 · **Audience:** DIA + PROTOFIRE · **Purpose:** a short, plain-language
status note covering what we did since the [June 9 update](./20260609-progress-update-for-dia.md),
what is left for Milestone 3, and what is left for Milestone 4.

This is a status note, not a remediation document.

## Contents

- [TL;DR](#tldr)
- [What we did since June 9](#what-we-did-since-june-9)
- [What is left for Milestone 3](#what-is-left-for-milestone-3)
- [What is left for Milestone 4](#what-is-left-for-milestone-4)
- [Where to read more](#where-to-read-more)

## TL;DR

- **Milestone 2 is delivered on Cardano Mainnet.** We tore down the old Milestone 1
  mainnet deployment (recovering the locked ADA), redeployed the current contracts, and
  ran the feeder live on mainnet feeding the 10 real-world-asset price feeds. The
  Proof-of-Achievement and the mainnet evidence pack are in the repository.
- **Most of Milestone 3 is already built and working.** The monitoring and alerting
  system was overhauled into a real, production-style pipeline. What remains for M3 is a
  short live run **on mainnet** to capture the evidence, plus the demo video and the
  written reports.
- **Milestone 4 is where most of the remaining new work lives** — chiefly the **indexer**
  (the piece that lets any developer read any feed straight from the chain) and a longer,
  stable mainnet run that meets the 99.99% uptime target.

## What we did since June 9

- **Milestone 2 on Mainnet, end to end.** We safely decommissioned the old mainnet
  deployment and recovered the ADA, deployed the current contracts, and ran the feeder
  live: the 10 feeds were fed with confirmed on-chain transactions and no chain
  reorganizations during the window. This produced the Milestone 2 Proof-of-Achievement
  and a complete mainnet evidence pack.
- **Two additional DIA signing keys authorized.** The on-chain configuration was updated
  on mainnet to accept two more DIA signer keys, so the authorized signer set can grow
  without redeploying.
- **Real alert delivery.** Previously the alerts were evaluated but did not actually reach
  anyone — they fired into an empty room. We added a proper delivery pipeline so every
  alert is recorded and can notify a human (e-mail / Telegram are one configuration switch
  away), all through a single, consistent path.
- **More and better anomaly coverage.** The alert set grew to 13 rules, including a new
  **per-feed accuracy check** that compares the price and timestamp published on-chain
  against DIA's own signed source for each feed, plus alerts for data-source health and
  operator-wallet health. A third dashboard was added covering the system's internal
  health.
- **Self-maintenance.** The feeder now keeps itself healthy automatically — it recovers
  from transient failures, tops up client balances from their deposits, and keeps the
  operator wallet tidy — so it needs less hands-on attention during a run.
- **Fewer, larger transactions.** The decision of *when* to publish an update was tuned so
  the system batches more updates together, lowering the number of on-chain transactions
  (and therefore cost) without losing freshness.
- **Cleaner tooling and docs.** Internal terminology was normalized end to end, a client
  can now run more than one routing lane, interactive API documentation was added, and the
  monitoring/dashboard documentation was refreshed.

## What is left for Milestone 3

The monitoring system is built and proven on the Preview test network. What remains is to
capture the same thing **on mainnet** and write it up:

- A short **monitoring run on mainnet** with the dashboards live, the per-feed accuracy
  check running against the mainnet feeds, and at least one alert shown firing and then
  resolving.
- A **demo video** of the dashboards and live mainnet logs.
- An **uptime and accuracy report** over the run.
- The **QA validation report** (integration tests + alert-trigger logs + the per-feed
  accuracy table), assembled from that run.
- The **Milestone 3 Proof-of-Achievement** document.

Details: [`../plans/m3-plan.md`](../plans/m3-plan.md).

## What is left for Milestone 4

Milestone 4 is the end-to-end, production-grade close-out. The main items:

- **The indexer — the largest new piece.** Today the feeder exposes an API, but that API
  answers from the feeder's own point of view: "here is what *I* pushed and what is in my
  cache." The indexer answers the opposite, consumer-facing question: "what does the
  **chain itself** say right now for this feed?" — read directly from the live on-chain
  data, independent of our feeder. This is what lets **any** Cardano developer look up and
  consume **any** of DIA's feeds, which is exactly what Milestone 4 requires. It does not
  exist yet.
- **A long, stable mainnet run meeting 99.99% uptime.** Milestone 2 proved a short live
  run; Milestone 4 needs a longer one that meets the headline reliability target. As a
  prerequisite we will harden the feeder against the periodic internal restarts seen in
  the test runs so a long window stays clean.
- **The published materials:** the list of live feeds and contract addresses, the
  developer documentation on DIA's website (including how to request any of DIA's 2,500+
  price feeds and 10,000+ real-world-asset feeds, and the timeline to do so), the final
  close-out report, and the final closeout video.

Details: [`../plans/m4-plan.md`](../plans/m4-plan.md).

## Where to read more

- **Plans:** [`../plans/m3-plan.md`](../plans/m3-plan.md) ·
  [`../plans/m4-plan.md`](../plans/m4-plan.md)
- **Milestone 2 delivery:** [`../milestones/milestone-2-poa.md`](../milestones/milestone-2-poa.md)
  + the mainnet evidence pack `m2-mainnet-20260616-074413`
- **Architecture:** [`../architecture/feeder.md`](../architecture/feeder.md) ·
  [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
- **Operator manual:** [`../../offchain/feeder/README.md`](../../offchain/feeder/README.md)
- **Previous update:** [`20260609-progress-update-for-dia.md`](./20260609-progress-update-for-dia.md)
</content>
