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

export type {
  CardanoWriteClient,
  SubmitRequest,
  SubmitResult,
  SubmitResultOk,
  SubmitResultErr,
} from "./types.js";
