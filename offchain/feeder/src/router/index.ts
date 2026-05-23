// Public surface of the router subsystem.

export { createRouterRegistry, type RouterRegistry } from "./registry.js";
export { routeIntent, type DispatchResult, type RouterOutput } from "./router.js";
export {
  createPolicyGate,
  parseDurationMs,
  parseDeviationPct,
  type PolicyGateOptions,
  type PolicyVerdict,
} from "./policy.js";
