// Runtime identity of a routed oracle update.
//
// The feeder's reporting/ownership hierarchy is customer -> client -> router
// -> destination, with `lane` as the runtime serialization key. Every routed
// intent resolves to exactly one point in that hierarchy. This module builds
// that identity ONCE, when an intent is routed, so downstream stages (cron,
// queue, submit, result handling, metrics, logs) read it off a single object
// instead of re-deriving `clientId` from a path or looking `customerId` up in
// a side map on every event.

import type { CardanoDestinationConfig } from "../config/types.js";
import { laneKey } from "../submitter/lane-key.js";

/** The full identity of one routed update: where it lands on-chain (network,
 *  client), who owns it (customer), which off-chain router/destination produced
 *  it, and the lane key that serializes it. `clientId`, `customerId`, and
 *  `routerId` are the canonical metric/label dimensions; `laneKey` is the raw
 *  serialization key (never a Prometheus label — see `laneId` for that). */
export type RouterRuntimeIdentity = {
  network: string;
  customerId: string;
  clientId: string;
  routerId: string;
  destinationIndex: number;
  laneKey: string;
};

/** Derive the on-chain client id from its state-file path: the basename without
 *  the `.json` suffix (`…/clients/client-a.json` -> `client-a`). The client id
 *  is the identity of one Receiver/deposit deployment. */
export function clientIdFromStatePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  return fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
}

/** Build the runtime identity for one routed destination. `customerId` comes
 *  from the router (config requires it); the network, client id, and lane key
 *  all come from the resolved Cardano destination, so identity stays consistent
 *  with the lane the update is actually serialized on. */
export function buildRouterIdentity(args: {
  customerId: string;
  routerId: string;
  destinationIndex: number;
  cardano: CardanoDestinationConfig;
}): RouterRuntimeIdentity {
  return {
    network: args.cardano.network,
    customerId: args.customerId,
    clientId: clientIdFromStatePath(args.cardano.client_state_path),
    routerId: args.routerId,
    destinationIndex: args.destinationIndex,
    laneKey: laneKey(args.cardano),
  };
}
