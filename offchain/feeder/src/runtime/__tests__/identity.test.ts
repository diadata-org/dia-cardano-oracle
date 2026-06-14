import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRouterIdentity, clientIdFromStatePath } from "../identity.js";
import type { CardanoDestinationConfig } from "../../config/types.js";

describe("clientIdFromStatePath", () => {
  it("strips the directory and .json suffix", () => {
    assert.equal(clientIdFromStatePath("state/preview_run_1/clients/client-a.json"), "client-a");
  });

  it("normalises Windows-style separators", () => {
    assert.equal(clientIdFromStatePath("state\\preview\\clients\\acme.json"), "acme");
  });

  it("returns the basename unchanged when there is no .json suffix", () => {
    assert.equal(clientIdFromStatePath("client-b"), "client-b");
  });
});

describe("buildRouterIdentity", () => {
  const cardano: CardanoDestinationConfig = {
    network: "Preview",
    client_state_path: "state/preview/clients/client-a.json",
    protocol_state_path: "state/preview/config-bootstrap.json",
  };

  it("resolves every dimension from the destination plus the router's customer", () => {
    const id = buildRouterIdentity({
      customerId: "acme",
      routerId: "client_a_router_majors",
      destinationIndex: 0,
      cardano,
    });
    assert.deepEqual(id, {
      network: "Preview",
      customerId: "acme",
      clientId: "client-a",
      routerId: "client_a_router_majors",
      destinationIndex: 0,
      // laneKey is the raw serialization key: client_state_path :: protocol_state_path.
      laneKey: "state/preview/clients/client-a.json::state/preview/config-bootstrap.json",
    });
  });

  it("two routers on the same client share clientId and laneKey but keep distinct routerId", () => {
    const majors = buildRouterIdentity({ customerId: "acme", routerId: "majors", destinationIndex: 0, cardano });
    const stables = buildRouterIdentity({ customerId: "acme", routerId: "stables", destinationIndex: 0, cardano });
    assert.equal(majors.clientId, stables.clientId);
    assert.equal(majors.laneKey, stables.laneKey);
    assert.equal(majors.customerId, stables.customerId);
    assert.notEqual(majors.routerId, stables.routerId);
  });
});
