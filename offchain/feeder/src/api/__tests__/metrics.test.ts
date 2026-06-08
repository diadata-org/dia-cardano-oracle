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
    metrics.transactionsSubmitted.inc({ symbol: "BTC/USD", client_id: "c1" });
    metrics.transactionsConfirmed.inc({ symbol: "BTC/USD", client_id: "c1" });
    metrics.transactionsFailed.inc({ symbol: "BTC/USD", client_id: "c1", error_code: "Err" });
    metrics.transactionsReorg.inc({ symbol: "BTC/USD", client_id: "c1" });
    metrics.intentToRegistrationSeconds.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.registrationToScanSeconds.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.scanToProcessingSeconds.observe({ symbol: "BTC/USD" }, 0.1);
    metrics.processingToSubmissionSeconds.observe({ symbol: "BTC/USD", client_id: "c1" }, 1.0);
    metrics.submissionToConfirmationSeconds.observe({ symbol: "BTC/USD", client_id: "c1" }, 10.0);
    metrics.endToEndLatencySeconds.observe({ symbol: "BTC/USD", client_id: "c1" }, 12.0);
    metrics.priceDeviationPercent.observe({ symbol: "BTC/USD" }, 0.5);
    metrics.priceAgeSeconds.observe({ symbol: "BTC/USD" }, 30);
    metrics.scannerLastBlock.set({ chain_id: "10050", scanner_type: "http" }, 1000);
    metrics.scannerBlockLag.set({ chain_id: "10050" }, 0);
    metrics.scannerRpcErrors.inc({ chain_id: "10050", error_type: "timeout" });
    metrics.scannerBackfillBlocks.inc({ chain_id: "10050" }, 100);
    metrics.scannerBackfillChunks.inc({ chain_id: "10050" });
    metrics.cardanoOracleLastConfirmedTimestampSeconds.set({ symbol: "BTC/USD", client_id: "c1" }, 1234567890);
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
    metrics.cardanoPairIsCreate.set({ symbol: "BTC/USD", client_id: "c1" }, 0);
    metrics.cronResubmissions.inc({ router_id: "r1", symbol: "BTC/USD", client_id: "c1", outcome: "submitted" });
    metrics.httpRequests.inc({ method: "GET", endpoint: "/health/live", status: "200" });
    metrics.httpRequestDurationSeconds.observe({ method: "GET", endpoint: "/health/live" }, 0.001);
    metrics.activeWorkers.set({ pool_type: "event" }, 0);
    metrics.workerPoolSize.set({ pool_type: "event" }, 4);
    metrics.workerQueueSize.set({ pool_type: "event" }, 0);
    metrics.workerTasksCompleted.inc();
    metrics.workerTasksFailed.inc();
    metrics.workerTasksDropped.inc({ pool_type: "event" });
    metrics.workerTaskRetries.inc();
    // Spectra lifecycle aliases
    metrics.bridgeIntentsScanned.inc({ symbol: "BTC/USD", scanner_type: "http" });
    metrics.bridgeIntentsProcessed.inc({ symbol: "BTC/USD", customer: "acme" });
    metrics.bridgeIntentsSubmitted.inc({ symbol: "BTC/USD", client_id: "c1", customer: "acme" });
    metrics.bridgeIntentsConfirmed.inc({ symbol: "BTC/USD", client_id: "c1", customer: "acme" });
    metrics.bridgeIntentsFailed.inc({ symbol: "BTC/USD", client_id: "c1", customer: "acme", reason: "timeout" });
    metrics.bridgeTransactionFeeLovelace.observe({ symbol: "BTC/USD", client_id: "c1", customer: "acme" }, 200000);
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
      "dia_bridge_transactions_reorg_total",
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
