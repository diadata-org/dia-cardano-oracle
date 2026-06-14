import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { laneId, laneKey } from "../lane-key.js";
import type { CardanoDestinationConfig } from "../../config/types.js";

const DESTINATION: CardanoDestinationConfig = {
  network: "Preview",
  client_state_path: "../state/preview_run_1/clients/client-a.json",
  protocol_state_path: "../state/preview_run_1/config-bootstrap.json",
};

describe("laneKey", () => {
  it("keeps the raw technical lock key unchanged", () => {
    assert.equal(
      laneKey(DESTINATION),
      "../state/preview_run_1/clients/client-a.json::../state/preview_run_1/config-bootstrap.json",
    );
  });
});

describe("laneId", () => {
  it("returns a stable observability id without raw state paths", () => {
    const id = laneId(DESTINATION, "client-a");

    assert.match(id, /^lane_preview_client_a_[a-f0-9]{12}$/);
    assert.ok(!id.includes("../state"));
    assert.ok(!id.includes("config-bootstrap.json"));
  });

  it("changes when the underlying lane changes", () => {
    const other = laneId({
      ...DESTINATION,
      protocol_state_path: "../state/preview_run_2/config-bootstrap.json",
    }, "client-a");

    assert.notEqual(laneId(DESTINATION, "client-a"), other);
  });
});
