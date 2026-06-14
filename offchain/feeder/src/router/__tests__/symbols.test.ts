// R10.C.7 — extractRouterSymbols unit tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractRouterSymbols } from "../symbols.js";
import type { RouterConfig, TriggerCondition } from "../../config/types.js";

function routerWith(conditions: TriggerCondition[]): RouterConfig {
  return {
    id: "r",
    name: "r",
    customer_id: "customer-r",
    type: "generic",
    enabled: true,
    private_key_env: "X",
    triggers: { events: ["IntentRegistered"], conditions },
    processing: { datasource: "enrichment" },
    destinations: [],
  };
}

describe("extractRouterSymbols", () => {
  it("operator=eq on event.symbol returns the single symbol", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "event.symbol", operator: "eq", value: "BTC/USD" },
    ]));
    assert.deepEqual(out, ["BTC/USD"]);
  });

  it("operator=in on event.symbol returns all symbols in the array", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] },
    ]));
    assert.deepEqual(out.sort(), ["BTC/USD", "ETH/USD"]);
  });

  it("recognises the templated ${enrichment.fullIntent.symbol} field", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "${enrichment.fullIntent.symbol}", operator: "eq", value: "ADA/USD" },
    ]));
    assert.deepEqual(out, ["ADA/USD"]);
  });

  it("recognises the capital-S enrichment.fullIntent.Symbol field", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "enrichment.fullIntent.Symbol", operator: "eq", value: "SOL/USD" },
    ]));
    assert.deepEqual(out, ["SOL/USD"]);
  });

  it("ignores non-symbol field conditions", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "event.price", operator: "gt", value: "100" },
    ]));
    assert.deepEqual(out, []);
  });

  it("returns [] when the router has no conditions", () => {
    assert.deepEqual(extractRouterSymbols(routerWith([])), []);
  });

  it("deduplicates a symbol named by multiple conditions", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "event.symbol", operator: "eq", value: "BTC/USD" },
      { field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] },
    ]));
    assert.deepEqual(out.sort(), ["BTC/USD", "ETH/USD"]);
  });

  it("skips non-string values inside an `in` array", () => {
    const out = extractRouterSymbols(routerWith([
      { field: "event.symbol", operator: "in", value: ["BTC/USD", 42, null] as unknown as string[] },
    ]));
    assert.deepEqual(out, ["BTC/USD"]);
  });
});
