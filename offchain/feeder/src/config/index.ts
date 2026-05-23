// Public surface of the modular config subsystem.
//
// Callers (currently `cmd/feeder/main.ts`; pipeline modules in later
// phases) import everything they need from here, not from the
// individual files. That keeps the internal split (yaml-fs, loader,
// types, validate, issues) free to evolve without churning import
// sites.

export { loadModularConfig, type LoaderOptions } from "./loader.js";
export { validateModularConfig } from "./validate.js";
export { IssueCollector, type ValidationIssue, type IssueSeverity } from "./issues.js";

export type {
  ModularConfig,
  InfrastructureConfig,
  DatabaseConfig,
  SourceConfig,
  EventMonitorConfig,
  BlockScannerConfig,
  EventProcessorConfig,
  WorkerPoolConfig,
  HealthCheckConfig,
  RecoveryConfig,
  APIConfig,
  MetricsConfig,
  ReplicaConfig,
  CronServiceConfig,
  ChainConfig,
  ContractConfig,
  MethodConfig,
  EventDefinition,
  EnrichmentConfig,
  RouterConfig,
  RouterTriggers,
  TriggerCondition,
  TriggerConditionOperator,
  ProcessingConfig,
  Transformation,
  RouterDestination,
  DestinationMethodConfig,
  CardanoDestinationConfig,
} from "./types.js";
