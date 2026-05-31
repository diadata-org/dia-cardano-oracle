// Lane key — canonical identifier for a (client_state_path, protocol_state_path) submission lane.
//
// The queue manager and coalescer must use the same formula so that
// a request targeting a given lane always maps to exactly one serial
// submission queue and one coalescer buffer.
import type { CardanoDestinationConfig } from "../config/types.js";

export function laneKey(dest: CardanoDestinationConfig): string {
  return `${dest.client_state_path}::${dest.protocol_state_path}`;
}
