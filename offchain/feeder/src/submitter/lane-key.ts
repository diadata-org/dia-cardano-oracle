// Lane key — canonical identifier for a (client_state_path, protocol_state_path) submission lane.
//
// The queue manager and coalescer must use the same formula so that
// a request targeting a given lane always maps to exactly one serial
// submission queue and one coalescer buffer.
import { createHash } from "node:crypto";

import type { CardanoDestinationConfig } from "../config/types.js";

export function laneKey(dest: CardanoDestinationConfig): string {
  return `${dest.client_state_path}::${dest.protocol_state_path}`;
}

export function laneId(dest: CardanoDestinationConfig, clientId = clientIdFromPath(dest.client_state_path)): string {
  const digest = createHash("sha256")
    .update(laneKey(dest))
    .digest("hex")
    .slice(0, 12);
  return `lane_${labelPart(dest.network)}_${labelPart(clientId)}_${digest}`;
}

function clientIdFromPath(clientStatePath: string): string {
  const file = clientStatePath.split(/[\\/]/).pop() ?? "client";
  return file.replace(/\.json$/i, "");
}

function labelPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}
