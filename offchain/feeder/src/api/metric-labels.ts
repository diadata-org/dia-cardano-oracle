// Central builders for the customer/client/router metric label objects.
//
// The label dimension names (`client_id`, `customer_id`, `router_id`) are part
// of the external Prometheus contract, so they are defined once here instead of
// being retyped at every `.inc()` / `.observe()` call site. The builders take a
// structurally-typed identity (so a `RouterRuntimeIdentity` passes directly) and
// return only the dimensions that metric family is allowed to carry.

/** Client-scoped labels: one on-chain client under its customer. Used by
 *  tx-level counters (`transactions_total`, `transaction_pairs`) and per-client
 *  latency histograms. Deliberately carries NO `router_id`: a batch tx can mix
 *  several routers on one lane, and per-client gauges would double-count. */
export function clientLabels(id: { clientId: string; customerId: string }): {
  client_id: string;
  customer_id: string;
} {
  return { client_id: id.clientId, customer_id: id.customerId };
}

/** Router-membership labels: credits one router that contributed to a tx
 *  (`transaction_router_membership_total`, and the base of pair membership).
 *  Adds `router_id` on top of the client dimensions. */
export function routerMembershipLabels(id: {
  clientId: string;
  customerId: string;
  routerId: string;
}): { client_id: string; customer_id: string; router_id: string } {
  return { client_id: id.clientId, customer_id: id.customerId, router_id: id.routerId };
}
