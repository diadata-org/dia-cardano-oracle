// Public surface of the source-side subsystem. Importers should pull
// from here, not from the individual files.

export {
  type CardanoNetwork,
  envVarFor,
  readDiaExplorerUrl,
  readNetworkEnv,
  requireNetworkEnv,
} from "./env.js";

export {
  composeAuthenticatedWsUrl,
  createHttpRegistryClient,
  createWsRegistryClient,
  resolveSourceFromConfig,
  type RegistryClient,
  type RegistryLog,
  type ResolvedSource,
} from "./registry-client.js";

export {
  createIntentRegisteredDecoder,
  decodeIntentRegisteredLog,
  decodeIntentRegisteredLogs,
} from "./extractor.js";

export {
  createJsonCheckpoint,
  defaultCheckpointPath,
  type Checkpoint,
  type JsonCheckpointOptions,
} from "./checkpoint.js";

export {
  runHttpScanner,
  type HttpScannerOptions,
  type ScannerMetricsSink,
} from "./scanner-http.js";
export { runWsScanner, type WsScannerOptions } from "./scanner-ws.js";
export { processLogBatch, type ScanHandler, type ScannedBatch } from "./scan-handler.js";

export type { ExtractedEvent, EnrichedIntent, OracleIntent } from "./types.js";
