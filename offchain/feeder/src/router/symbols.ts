// Shared symbol extraction from router config.
// Used by both the cron service and the API /symbols endpoint.

import type { RouterConfig } from "../config/types.js";

function normalizeField(field: string): string {
  const trimmed = field.trim();
  return trimmed.startsWith("${") && trimmed.endsWith("}")
    ? trimmed.slice(2, -1).trim()
    : trimmed;
}

/** Extract all symbols configured in a router's trigger conditions.
 *  Handles:
 *    - event.symbol eq <value>
 *    - event.symbol in [...]
 *    - ${enrichment.fullIntent.Symbol} eq <value>
 *    - ${enrichment.fullIntent.Symbol} in [...]
 */
export function extractRouterSymbols(router: RouterConfig): string[] {
  const out: string[] = [];

  for (const condition of router.triggers?.conditions ?? []) {
    const field = normalizeField(condition.field);

    const isSymbolField =
      field === "event.symbol" ||
      field === "enrichment.fullIntent.Symbol" ||
      field === "enrichment.fullIntent.symbol";

    if (!isSymbolField) continue;

    if (condition.operator === "eq" && typeof condition.value === "string") {
      out.push(condition.value);
      continue;
    }

    if (condition.operator === "in" && Array.isArray(condition.value)) {
      for (const v of condition.value) {
        if (typeof v === "string") {
          out.push(v);
        }
      }
    }
  }

  return out;
}
