import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMetrics } from "../metrics.js";

describe("createMetrics", () => {
  it("uses the dia_bridge namespace and applies default labels", async () => {
    const metrics = await createMetrics({
      defaultLabels: {
        destination_chain: "cardano",
        network: "Preview",
        source_chain_id: "10050",
      },
    });

    metrics.eventsDetected.inc({ scanner_type: "http" });

    const text = await metrics.getMetricsText();
    assert.match(text, /dia_bridge_events_detected_total/);
    assert.match(text, /destination_chain="cardano"/);
    assert.match(text, /network="Preview"/);
    assert.match(text, /source_chain_id="10050"/);
    assert.match(text, /scanner_type="http"/);
  });

  // A real oracle-update tx fee on Cardano sits around 0.88 ADA (~880_000
  // lovelace). With coarse buckets jumping 500_000 → 1_000_000, every real fee
  // lands in that single bucket and `histogram_quantile` can only interpolate to
  // its midpoint (750_000) — a flat, false reading. The buckets must therefore
  // resolve inside the 500_000–1_000_000 band.
  it("transaction-fee histogram resolves inside the 500k–1M band", async () => {
    const metrics = await createMetrics({ namespace: "dia_bridge" });
    metrics.bridgeTransactionFeeLovelace.observe(
      { symbol: "ARS/USDT", client_id: "c1", customer_id: "acme", router_id: "r" },
      880_000,
    );

    const text = await metrics.getMetricsText();
    const boundaries = text
      .split("\n")
      .filter((line) => line.startsWith("dia_bridge_transaction_fee_lovelace_bucket"))
      .map((line) => Number(line.match(/le="([^"]+)"/)?.[1]))
      .filter((le) => Number.isFinite(le));
    const insideBand = boundaries.filter((le) => le > 500_000 && le < 1_000_000);
    assert.ok(
      insideBand.length > 0,
      `histogram needs a bucket boundary strictly between 500k and 1M so a real ` +
        `~0.88 ADA fee does not collapse to the 750k midpoint; got ${boundaries.join(",")}`,
    );
  });

  it("honours a custom namespace override", async () => {
    const metrics = await createMetrics({ namespace: "custom_bridge" });
    metrics.eventsDuplicate.inc();

    const text = await metrics.getMetricsText();
    assert.match(text, /custom_bridge_events_duplicate_total/);
  });

  // R3.8 — snapshot test: every required Spectra-parity metric must appear
  // in the /metrics exposition. Fails immediately when a name disappears.
  it("exports all required Spectra-parity and Cardano-extension metric names", async () => {
    const metrics = await createMetrics({ namespace: "dia_bridge" });

    // Touch every series so prom-client emits it.
    metrics.eventsDetected.inc({ scanner_type: "http" });
    metrics.eventsDuplicate.inc();
    metrics.eventsInvalid.inc({ reason: "enrichment" });
    metrics.intentsScanned.inc({ symbol: "BTC/USD", scanner_type: "http" });
    metrics.intentsRouted.inc({ symbol: "BTC/USD", router_id: "r1" });
    metrics.intentsFiltered.inc({ symbol: "BTC/USD", router_id: "r1", reason: "policy" });
    metrics.transactionsSubmitted.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" });
    metrics.transactionsConfirmed.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" });
    metrics.transactionsFailed.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme", error_code: "Err" });
    metrics.transactionsReorg.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" });
    metrics.transactionsTotal.inc({ client_id: "c1", customer_id: "acme", outcome: "confirmed" });
    metrics.transactionPairs.observe({ client_id: "c1", customer_id: "acme", outcome: "confirmed" }, 3);
    metrics.transactionRouterMembership.inc({
      client_id: "c1",
      customer_id: "acme",
      router_id: "r1",
      outcome: "confirmed",
    });
    metrics.txPairMembership.inc({
      client_id: "c1",
      customer_id: "acme",
      router_id: "r1",
      destination_index: "0",
      symbol: "BTC/USD",
      outcome: "confirmed",
    });
    metrics.txProcessingToSubmissionSeconds.observe({ client_id: "c1", customer_id: "acme" }, 1.0);
    metrics.txSubmissionToConfirmationSeconds.observe({ client_id: "c1", customer_id: "acme" }, 10.0);
    metrics.txEndToEndSeconds.observe({ client_id: "c1", customer_id: "acme" }, 12.0);
    metrics.intentToRegistrationSeconds.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.registrationToScanSeconds.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.scanToProcessingSeconds.observe({ symbol: "BTC/USD" }, 0.1);
    metrics.processingToSubmissionSeconds.observe({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 1.0);
    metrics.submissionToConfirmationSeconds.observe({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 10.0);
    metrics.endToEndLatencySeconds.observe({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 12.0);
    metrics.priceDeviationPercent.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.priceAgeSeconds.observe({ symbol: "BTC/USD" }, 30);
    metrics.scannerLastBlock.set({ chain_id: "10050", scanner_type: "http" }, 1000);
    metrics.scannerBlockLag.set({ chain_id: "10050" }, 0);
    metrics.scannerRpcErrors.inc({ chain_id: "10050", error_type: "timeout" });
    metrics.scannerBackfillBlocks.inc({ chain_id: "10050" }, 100);
    metrics.scannerBackfillChunks.inc({ chain_id: "10050" });
    metrics.cardanoOracleLastConfirmedTimestampSeconds.set({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 1234567890);
    metrics.cardanoReceiverBalanceLovelace.set(
      {
        client_id: "c1",
        receiver_address: "addr_test1wrn8test",
        deposit_address: "addr_test1deposit",
      },
      5000000000,
    );
    metrics.cardanoReceiverAccruedLovelace.set({ client_id: "c1" }, 100000);
    metrics.cardanoPaymentHookAccruedLovelace.set({}, 50000000);
    metrics.cardanoAdminWalletLovelace.set({}, 10000000000);
    metrics.cardanoReceiverTopupWarnings.inc({ client_id: "c1" });
    metrics.cardanoPairIsCreate.set({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 0);
    metrics.feedSanityStatus.set({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 0);
    metrics.cronResubmissions.inc({ router_id: "r1", symbol: "BTC/USD", client_id: "c1", outcome: "submitted" });
    metrics.httpRequests.inc({ method: "GET", endpoint: "/health/live", status: "200" });
    metrics.httpRequestDurationSeconds.observe({ method: "GET", endpoint: "/health/live" }, 0.001);
    metrics.activeWorkers.set({ pool_type: "event" }, 0);
    metrics.workerPoolSize.set({ pool_type: "event" }, 4);
    metrics.workerQueueSize.set({ pool_type: "event" }, 0);
    metrics.workerTasksCompleted.inc({ pool_type: "update" });
    metrics.workerTasksFailed.inc({ pool_type: "update" });
    metrics.workerTasksDropped.inc({ pool_type: "event" });
    metrics.workerTaskRetries.inc({ pool_type: "update" });
    // Spectra lifecycle aliases
    metrics.bridgeIntentsScanned.inc({ symbol: "BTC/USD", scanner_type: "http" });
    metrics.bridgeIntentsProcessed.inc({ symbol: "BTC/USD", customer_id: "acme" });
    metrics.bridgeIntentsSubmitted.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" });
    metrics.bridgeIntentsConfirmed.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" });
    metrics.bridgeIntentsFailed.inc({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme", reason: "timeout" });
    metrics.bridgeTransactionFeeLovelace.observe({ symbol: "BTC/USD", client_id: "c1", customer_id: "acme" }, 200000);
    metrics.bridgeDbOperations.inc({ table: "transaction_log", operation: "insert" });
    metrics.bridgeDbOperationDuration.observe({ table: "transaction_log", operation: "insert" }, 0.005);
    metrics.bridgeComponentHealth.set({ component: "scanner" }, 1);
    metrics.bridgeRecoveryAttempts.inc({ component: "scanner", reason: "rpc_error" });

    const text = await metrics.getMetricsText();

    // 6-phase latency (R3.4) — all phases must be present.
    const requiredNames = [
      "dia_bridge_intent_to_registration_seconds",
      "dia_bridge_registration_to_scan_seconds",
      "dia_bridge_scan_to_processing_seconds",
      "dia_bridge_processing_to_submission_seconds",
      "dia_bridge_submission_to_confirmation_seconds",
      "dia_bridge_end_to_end_latency_seconds",
      // Spectra lifecycle aliases (R3.1)
      "dia_bridge_intents_scanned_lifecycle_total",
      "dia_bridge_intents_processed_lifecycle_total",
      "dia_bridge_intents_submitted_lifecycle_total",
      "dia_bridge_intents_confirmed_lifecycle_total",
      "dia_bridge_intents_failed_lifecycle_total",
      // Fee histogram (R3.6)
      "dia_bridge_transaction_fee_lovelace",
      // Worker metrics (R3.3)
      "dia_bridge_active_workers",
      "dia_bridge_worker_pool_size",
      "dia_bridge_worker_queue_size",
      "dia_bridge_worker_tasks_completed_total",
      "dia_bridge_worker_tasks_failed_total",
      "dia_bridge_worker_tasks_dropped_total",
      "dia_bridge_worker_task_retries_total",
      // DB / health metrics (R3.2)
      "dia_bridge_db_operations_total",
      "dia_bridge_db_operation_duration_seconds",
      "dia_bridge_component_health",
      "dia_bridge_recovery_attempts_total",
      // Cardano-specific extensions (R3.5)
      "dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds",
      "dia_bridge_cardano_receiver_balance_lovelace",
      "dia_bridge_cardano_receiver_accrued_lovelace",
      "dia_bridge_cardano_payment_hook_accrued_lovelace",
      "dia_bridge_cardano_admin_wallet_lovelace",
      "dia_bridge_cardano_receiver_topup_warnings_total",
      "dia_bridge_feed_sanity_status",
      "dia_bridge_transactions_reorg_total",
      // Tx-level metrics (counted once per transaction, not per symbol)
      "dia_bridge_transactions_total",
      "dia_bridge_transaction_pairs",
      "dia_bridge_transaction_router_membership_total",
      "dia_bridge_tx_pair_membership_total",
      "dia_bridge_tx_processing_to_submission_seconds",
      "dia_bridge_tx_submission_to_confirmation_seconds",
      "dia_bridge_tx_end_to_end_seconds",
      // Core pipeline metrics
      "dia_bridge_events_detected_total",
      "dia_bridge_events_duplicate_total",
      "dia_bridge_events_invalid_total",
      "dia_bridge_intents_scanned_total",
      "dia_bridge_intents_routed_total",
      "dia_bridge_intents_filtered_total",
      "dia_bridge_transactions_submitted_total",
      "dia_bridge_transactions_confirmed_total",
      "dia_bridge_transactions_failed_total",
      "dia_bridge_scanner_last_block",
      "dia_bridge_scanner_block_lag",
      "dia_bridge_scanner_rpc_errors_total",
      "dia_bridge_scanner_backfill_blocks_total",
      "dia_bridge_scanner_backfill_chunks_total",
      "dia_bridge_cron_resubmissions_total",
      "dia_bridge_http_requests_total",
      "dia_bridge_http_request_duration_seconds",
      "dia_bridge_price_deviation_percent",
      "dia_bridge_price_age_seconds",
    ];

    for (const name of requiredNames) {
      assert.ok(text.includes(name), `required metric absent from /metrics output: ${name}`);
    }
  });

  // Per-pair updates belong to exactly one router (the config validator forbids
  // overlapping symbols on a shared lane), so every PER-SYMBOL series carries a
  // `router_id` label and the dashboard Router filter can scope them. TX-LEVEL
  // series must NOT carry `router_id`: a single batch tx can mix several routers
  // on one lane, so a scalar router_id there would be ambiguous.
  it("per-symbol metrics carry router_id; tx-level metrics do not", async () => {
    const metrics = await createMetrics({ namespace: "dia_bridge" });
    const pair = { symbol: "BTC/USD", client_id: "c1", customer_id: "acme", router_id: "router_a" };

    metrics.transactionsSubmitted.inc({ ...pair });
    metrics.transactionsConfirmed.inc({ ...pair });
    metrics.transactionsFailed.inc({ ...pair, error_code: "Err" });
    metrics.transactionsReorg.inc({ ...pair });
    metrics.intentsSuperseded.inc({ ...pair, reason: "NonMonotonicNonce" });
    metrics.processingToSubmissionSeconds.observe({ ...pair }, 1);
    metrics.submissionToConfirmationSeconds.observe({ ...pair }, 5);
    metrics.endToEndLatencySeconds.observe({ ...pair }, 6);
    metrics.cardanoOracleLastConfirmedTimestampSeconds.set({ ...pair }, 1234567890);
    metrics.cardanoPairIsCreate.set({ ...pair }, 1);
    metrics.bridgeTransactionFeeLovelace.observe({ ...pair }, 200000);
    metrics.bridgeIntentsSubmitted.inc({ ...pair });
    metrics.bridgeIntentsConfirmed.inc({ ...pair });
    metrics.bridgeIntentsFailed.inc({ ...pair, reason: "timeout" });
    metrics.priceDeviationPercent.observe({ symbol: "BTC/USD", router_id: "router_a" }, 0.5);
    metrics.priceAgeSeconds.observe({ symbol: "BTC/USD", router_id: "router_a" }, 30);

    const text = await metrics.getMetricsText();
    const perPairSeries = [
      "dia_bridge_transactions_submitted_total",
      "dia_bridge_transactions_confirmed_total",
      "dia_bridge_transactions_failed_total",
      "dia_bridge_transactions_reorg_total",
      "dia_bridge_intents_superseded_total",
      "dia_bridge_processing_to_submission_seconds_count",
      "dia_bridge_submission_to_confirmation_seconds_count",
      "dia_bridge_end_to_end_latency_seconds_count",
      "dia_bridge_cardano_oracle_last_confirmed_timestamp_seconds",
      "dia_bridge_cardano_pair_is_create",
      "dia_bridge_transaction_fee_lovelace_count",
      "dia_bridge_intents_submitted_lifecycle_total",
      "dia_bridge_intents_confirmed_lifecycle_total",
      "dia_bridge_intents_failed_lifecycle_total",
      "dia_bridge_price_deviation_percent_count",
      "dia_bridge_price_age_seconds_count",
    ];
    for (const name of perPairSeries) {
      const sample = text
        .split("\n")
        .find((line) => line.startsWith(name) && line.includes('router_id="router_a"'));
      assert.ok(sample, `per-symbol series ${name} must carry a router_id label`);
    }

    // Tx-level series must stay router-agnostic.
    metrics.transactionsTotal.inc({ client_id: "c1", customer_id: "acme", outcome: "confirmed" });
    metrics.transactionPairs.observe({ client_id: "c1", customer_id: "acme", outcome: "confirmed" }, 3);
    const txText = await metrics.getMetricsText();
    for (const name of ["dia_bridge_transactions_total", "dia_bridge_transaction_pairs_count"]) {
      const samples = txText
        .split("\n")
        .filter((line) => line.startsWith(name) && !line.startsWith("#"));
      assert.ok(samples.length > 0, `expected ${name} samples`);
      for (const line of samples) {
        assert.ok(!line.includes("router_id="), `tx-level series ${name} must NOT carry router_id: ${line}`);
      }
    }
  });

  it("per-transaction metrics carry the signer wallet label", async () => {
    const metrics = await createMetrics({ namespace: "dia_bridge" });
    const base = { client_id: "c1", customer_id: "acme", wallet: "pool-1" };
    metrics.transactionsTotal.inc({ ...base, outcome: "confirmed" });
    metrics.transactionPairs.observe({ ...base, outcome: "confirmed" }, 3);
    metrics.txProcessingToSubmissionSeconds.observe(base, 1);
    metrics.txSubmissionToConfirmationSeconds.observe(base, 5);
    metrics.txEndToEndSeconds.observe(base, 6);
    const text = await metrics.getMetricsText();
    for (const name of [
      "dia_bridge_transactions_total",
      "dia_bridge_transaction_pairs_count",
      "dia_bridge_tx_processing_to_submission_seconds_count",
      "dia_bridge_tx_submission_to_confirmation_seconds_count",
      "dia_bridge_tx_end_to_end_seconds_count",
    ]) {
      const sample = text.split("\n").find((line) => line.startsWith(name) && line.includes('wallet="pool-1"'));
      assert.ok(sample, `per-transaction series ${name} must carry the wallet label`);
    }
  });

  it("does not emit a default 0 for label-less balance gauges until set (no spurious low-balance alert on restart)", async () => {
    const metrics = await createMetrics({
      defaultLabels: { destination_chain: "cardano", network: "Preview", source_chain_id: "10050" },
    });

    // Fresh registry, nothing set yet: the admin-wallet and payment-hook
    // accrued gauges must be ABSENT, not 0. A default 0 would make
    // AdminWalletLow (admin_wallet_lovelace/1e6 < 5) fire on every restart.
    // Match DATA samples only (lines starting with the metric name), not the
    // always-present `# HELP` / `# TYPE` comment lines.
    const before = await metrics.getMetricsText();
    assert.ok(
      !/^dia_bridge_cardano_admin_wallet_lovelace[ {]/m.test(before),
      "admin wallet gauge must emit no sample before the first real reading",
    );
    assert.ok(
      !/^dia_bridge_cardano_payment_hook_accrued_lovelace[ {]/m.test(before),
      "payment-hook accrued gauge must emit no sample before the first real reading",
    );

    // Once a real balance is reported, the series appears.
    metrics.cardanoAdminWalletLovelace.set({}, 2_462_000_000);
    const after = await metrics.getMetricsText();
    assert.match(after, /^dia_bridge_cardano_admin_wallet_lovelace[ {][^\n]*2462000000/m);
  });
});
