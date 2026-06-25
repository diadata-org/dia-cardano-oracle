# Progress Update for DIA — Milestone 3 complete, Milestone 4 nearly complete

**Date:** 2026-06-25 · **Audience:** DIA + PROTOFIRE · **Purpose:** a short,
plain-language status note covering what we did since the
[June 18 update](./20260618-progress-update-for-dia.md), where each milestone
stands for submission, and the little that is left for Milestone 4.

This is a status note, not a remediation document.

## Contents

- [TL;DR](#tldr)
- [Where each milestone stands](#where-each-milestone-stands)
- [What we did since June 18](#what-we-did-since-june-18)
- [What is left for Milestone 4](#what-is-left-for-milestone-4)
- [Where to read more](#where-to-read-more)

## TL;DR

- **Milestone 3 is complete.** The monitoring and alerting system was run live on
  Cardano Mainnet, the evidence was captured, the demo video recorded, and the
  Proof-of-Achievement written and pinned to a specific code version. It is ready
  to submit.
- **Milestone 4 is now nearly complete.** The big remaining piece from the last
  update — the **indexer**, which lets any Cardano developer read any feed
  straight from the chain — is **built and working**, together with a worked
  example of a contract consuming a feed, and the developer documentation a
  consumer needs (how to read a feed, how the payment works, and how to request a
  new feed). What is left is mostly a **long, stable run on mainnet** and the
  externally-produced close-out materials.
- **The remaining work is now small and well-defined.** Most of Milestone 4 is
  done and in the repository; what is outstanding is a multi-day reliability run
  and the final report/video/website publication.

## Where each milestone stands

A simple view of the submission pipeline:

- **Milestone 1 — approved.** ✅
- **Milestone 2 — delivered; awaiting sign-off.** The work and evidence are in;
  we are waiting on the review sign-off.
- **Milestone 3 — complete and ready to submit.** Once Milestone 2 is signed off,
  we submit the Milestone 3 Proof-of-Achievement (it is already written, with its
  evidence pack and demo video).
- **Milestone 4 — nearly complete; will be presented once Milestone 3 is reviewed
  and signed.** The build is essentially done; we finish the mainnet reliability
  run and the close-out materials and then present it.

So the order is: M2 sign-off → submit M3 → once M3 is approved and signed,
present M4.

## What we did since June 18

**Milestone 3 — closed out.**

- We ran the monitoring system **live on Cardano Mainnet**: the dashboards live,
  the per-feed accuracy check running against the real mainnet feed, confirmed
  on-chain updates, and an alert shown firing and then clearing through the real
  pipeline.
- We recorded the **demo video** and assembled the **mainnet evidence pack**, then
  wrote the **Milestone 3 Proof-of-Achievement** and pinned it to a specific
  code version, so a reviewer can reproduce exactly what was submitted.

**Milestone 4 — most of the build landed.**

- **The indexer now exists and works.** This was the largest open item in the
  last update. The feeder's own API answers from the feeder's point of view
  ("here is what *I* pushed"). The indexer answers the consumer's question —
  "what does the **chain itself** say right now for this feed?" — reading straight
  from the live on-chain data, independent of our feeder, so **any** Cardano
  developer can look up and consume **any** published feed. It comes with
  interactive API documentation in the browser, and it can be run by anyone with
  just a data-provider key.
- **A worked example of consuming a feed.** We wrote a small example smart
  contract that reads a feed's price from the chain and only unlocks when the
  price clears a threshold — after checking the feed is authentic. It ships with
  an end-to-end demo (offline and against the real network) that shows a spend
  **succeeding** when the price qualifies and **failing** when it does not, which
  is exactly the pattern a real consumer follows.
- **Documentation for the developer consuming the oracle.** Plain instructions
  for the three things a consumer needs:
  - **How to read a feed** — query the indexer for the latest value and the exact
    on-chain reference to use.
  - **How the payment works** — keeping a feed updated is paid from a **prepaid
    balance**. Each consumer account has its own **deposit address**; the consumer
    tops it up with an ordinary wallet payment of ADA, and that balance is drawn
    down as updates are published. The indexer now also publishes the **current
    fee** (a base amount plus an amount per feed) and each account's **live
    balance**, so a consumer can see what they will pay and what they have left.
  - **How to request a new feed** — the published feeds on Cardano are a subset of
    DIA's catalogue; the documentation explains how to request any of DIA's 2,500+
    price feeds and 10,000+ real-world-asset feeds and what to expect for it to
    appear on-chain.
- **A more robust feeder for the long mainnet run.** We hardened the feeder so a
  multi-day window stays clean: it recovers cleanly from transient failures and
  restarts, confirms its submitted transactions on-chain, and survives temporary
  data-provider hiccups instead of stopping. We also added a small "fault drill"
  facility to deliberately feed it an unusual input on demand, so we can show it
  behaves correctly under edge cases.
- **Monitoring extended to cover the indexer too.** The feeder and the indexer
  share one data-provider key, so they share its daily usage allowance. The
  monitoring now counts the indexer's usage on the same charts and alerts, so the
  combined draw on the shared key is visible in one place and warns before any
  limit is reached.
- **Mainnet prepared for the reliability run.** The mainnet deployment is already
  pointed at a single feed (ARS/USDT) on a slow, every-30-minutes cadence, which
  keeps a multi-day window cheap while still demonstrating sustained liveness and
  accuracy — on the **same contracts already deployed for Milestone 2**, with no
  redeployment.

## What is left for Milestone 4

The build is essentially done. What remains:

- **The long, stable mainnet run** that meets the 99.99% uptime-and-accuracy
  target — a multi-day window on the single slow feed described above, with the
  monitoring capturing the uptime and accuracy evidence.
- **The published materials and close-out:** the developer documentation
  published on **DIA's own website** (it is already complete inside the
  repository), the final **close-out report**, and the final **closeout video**.

The Milestone 4 Proof-of-Achievement is already drafted, with the technical
evidence in place and clearly-marked placeholders for the items above.

Details: [`../plans/m4-plan.md`](../plans/m4-plan.md).

## Where to read more

- **Milestone 3 delivery:** [`../milestones/milestone-3-poa.md`](../milestones/milestone-3-poa.md)
  + the QA demo video <https://youtu.be/W-vfgsoeXp4>
- **Milestone 4 (draft):** [`../milestones/milestone-4-poa.md`](../milestones/milestone-4-poa.md)
  + the Preview evidence pack
  [`milestone-4-preview-evidence.md`](../milestones/evidence/m4-preview-20260608-040304/milestone-4-preview-evidence.md)
  (indexer responses, the consumer contract accepting/rejecting on price, the
  on-chain demo)
- **Indexer (the consumer's entry point):** [`../../offchain/indexer/README.md`](../../offchain/indexer/README.md)
  — how to read a feed, how the payment works, and how to request a new feed
- **Plans:** [`../plans/m4-plan.md`](../plans/m4-plan.md)
- **Architecture:** [`../architecture/cardano-oracle-architecture.md`](../architecture/cardano-oracle-architecture.md)
  · [`../architecture/feeder.md`](../architecture/feeder.md)
- **Previous update:** [`20260618-progress-update-for-dia.md`](./20260618-progress-update-for-dia.md)
