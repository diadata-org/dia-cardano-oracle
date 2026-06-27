// Public surface of the submitter subsystem.

export {
  createCardanoWriteClient,
  type CardanoWriteClientDeps,
} from "./cardano-write-client.js";

export {
  createQueueManager,
  type QueueManager,
  type QueueManagerOptions,
} from "./queue-manager.js";

export {
  createSubmissionQueue,
  type SubmissionQueue,
  type QueueOptions,
} from "./queue.js";

export {
  createInflightTable,
  makeInflightEntry,
  type InflightTable,
  type InflightEntry,
  type InflightTableOptions,
} from "./inflight.js";

export {
  createSymbolInflightTracker,
  type SymbolInflightTracker,
  type SymbolInflightOptions,
} from "./symbol-inflight.js";

export type {
  CardanoWriteClient,
  SubmitRequest,
  SubmitResult,
  SubmitResultOk,
  SubmitResultErr,
} from "./types.js";

export {
  createCoalescerManager,
  type CoalescerManager,
  type CoalescerOptions,
} from "./coalescer.js";

export {
  createDefaultRetryPolicy,
  NON_RETRIABLE_CODES,
  type RetryPolicy,
  type RetryDecision,
} from "./retry-policy.js";

export { laneId, laneKey } from "./lane-key.js";

export {
  isProcessRecoverableWasmError,
  nextWasmFailureCount,
  shouldExitOnWasmFailures,
} from "./wasm-failure-guard.js";

export {
  shouldAutoSettle,
  shouldAutoWithdraw,
  shouldAutoConsolidate,
  shouldAutoSplit,
} from "./auto-remediation.js";
export type {
  AutoSettleDecision,
  AutoWithdrawDecision,
  AutoConsolidateDecision,
  AutoSplitDecision,
} from "./auto-remediation.js";
