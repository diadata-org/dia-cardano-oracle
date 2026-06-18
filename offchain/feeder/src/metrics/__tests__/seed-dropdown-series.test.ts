import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { seedDropdownSeriesFromConfig } from "../seed-dropdown-series.js";
import { clientIdFromStatePath } from "../../runtime/identity.js";
import type { ModularConfig, RouterConfig } from "../../config/types.js";

type IncCall = { metric: string; labels: Record<string, string>; value?: number };

function metricsStub() {
  const calls: IncCall[] = [];
  const mk = (metric: string) => ({
    inc: (labels: Record<string, string>, value?: number) => calls.push({ metric, labels, value }),
  });
  return {
    calls,
    transactionsTotal: mk("transactionsTotal"),
    transactionRouterMembership: mk("transactionRouterMembership"),
    txPairMembership: mk("txPairMembership"),
    transactionsConfirmed: mk("transactionsConfirmed"),
  };
}

function router(over: Partial<RouterConfig> & { id: string }): RouterConfig {
  return {
    name: over.id,
    customer_id: "cust-x",
    type: "cardano",
    enabled: true,
    triggers: { events: [], conditions: [{ field: "event.symbol", operator: "in", value: ["BTC/USD", "ETH/USD"] }] },
    processing: { datasource: "enrichment" },
    destinations: [{ cardano: { client_state_path: "/s/clients/client-a.json" } } as RouterConfig["destinations"][number]],
    ...over,
  } as RouterConfig;
}

describe("seedDropdownSeriesFromConfig", () => {
  it("registers the cascade-filter series at value 0 for enabled routers", () => {
    const cfg = {
      routers: {
        a: router({ id: "router-a", customer_id: "cust-1" }),
        off: router({ id: "router-off", customer_id: "cust-2", enabled: false }),
      },
    } as unknown as Pick<ModularConfig, "routers">;
    const m = metricsStub();

    seedDropdownSeriesFromConfig(cfg, m as never);

    // Every captured call seeds value 0 (no fake activity).
    assert.ok(m.calls.length > 0, "expected some series to be seeded");
    for (const c of m.calls) assert.equal(c.value, 0, `${c.metric} must be seeded at 0`);

    // Disabled router never seeded.
    assert.ok(!m.calls.some((c) => c.labels.router_id === "router-off"), "disabled router must not be seeded");

    const clientId = clientIdFromStatePath("/s/clients/client-a.json");
    const of = (metric: string) => m.calls.filter((c) => c.metric === metric);

    // Customer + Client dropdowns: one tx-total per (client, customer).
    assert.deepEqual(of("transactionsTotal").map((c) => c.labels), [
      { client_id: clientId, customer_id: "cust-1", outcome: "confirmed" },
    ]);
    // Router dropdown: one membership per (client, customer, router).
    assert.deepEqual(of("transactionRouterMembership").map((c) => c.labels), [
      { client_id: clientId, customer_id: "cust-1", router_id: "router-a", outcome: "confirmed" },
    ]);
    // Symbol dropdown: one pair-membership per symbol (with destination_index).
    assert.deepEqual(
      of("txPairMembership").map((c) => c.labels.symbol),
      ["BTC/USD", "ETH/USD"],
    );
    assert.ok(of("txPairMembership").every((c) => c.labels.destination_index === "0" && c.labels.router_id === "router-a"));
    // Liveness panel: one confirmed-total per (symbol, client, router).
    assert.deepEqual(
      of("transactionsConfirmed").map((c) => c.labels.symbol),
      ["BTC/USD", "ETH/USD"],
    );
  });
});
