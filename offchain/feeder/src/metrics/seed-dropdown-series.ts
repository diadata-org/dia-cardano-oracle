// Seed the Grafana filter dropdowns from config at startup.
//
// The dashboard's cascading filters (Customer -> Client -> Router -> Symbol) are
// populated by `label_values()` over the transaction-flow metrics, so an entity
// only appears once it has produced a transaction. On a fresh start (or after
// `make fresh` wipes Prometheus) the dropdowns are therefore empty until the
// first confirmation. Since the full set of customers, clients, routers and
// symbols is known from config at boot, register those series at value 0 with
// the SAME label shapes the live confirm path uses — so the dropdowns are
// populated immediately and the first real confirmation increments the very same
// series (no duplicate, no fake activity).

import type { ModularConfig } from "../config/types.js";
import type { FeederMetrics } from "../api/metrics.js";
import { clientLabels, routerMembershipLabels } from "../api/metric-labels.js";
import { clientIdFromStatePath } from "../runtime/identity.js";
import { extractRouterSymbols } from "../router/symbols.js";

type SeedMetrics = Pick<
  FeederMetrics,
  "transactionsTotal" | "transactionRouterMembership" | "txPairMembership" | "transactionsConfirmed"
>;

export function seedDropdownSeriesFromConfig(
  config: Pick<ModularConfig, "routers">,
  metrics: SeedMetrics,
): void {
  for (const router of Object.values(config.routers)) {
    if (!router.enabled) continue;
    const symbols = extractRouterSymbols(router);
    if (symbols.length === 0) continue;
    const customerId = router.customer_id;

    router.destinations.forEach((dest, destinationIndex) => {
      if (!dest?.cardano) return;
      const clientId = clientIdFromStatePath(dest.cardano.client_state_path);
      const client = clientLabels({ clientId, customerId });
      const membership = routerMembershipLabels({ clientId, customerId, routerId: router.id });

      // Customer + Client dropdowns (tx-level counter, no router_id).
      metrics.transactionsTotal.inc({ ...client, outcome: "confirmed" }, 0);
      // Router dropdown.
      metrics.transactionRouterMembership.inc({ ...membership, outcome: "confirmed" }, 0);

      for (const symbol of symbols) {
        // Symbol dropdown.
        metrics.txPairMembership.inc(
          { ...membership, destination_index: String(destinationIndex), symbol, outcome: "confirmed" },
          0,
        );
        // Per-pair liveness panel (Confirmed updates all-time).
        metrics.transactionsConfirmed.inc({ symbol, ...membership }, 0);
      }
    });
  }
}
