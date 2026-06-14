import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { clientLabels, routerMembershipLabels } from "../metric-labels.js";

const identity = {
  network: "Preview",
  customerId: "acme",
  clientId: "client-a",
  routerId: "client_a_router_majors",
  destinationIndex: 0,
  laneKey: "x::y",
};

describe("clientLabels", () => {
  it("emits only client_id + customer_id (NO router_id — a tx can mix routers on one lane)", () => {
    assert.deepEqual(clientLabels(identity), { client_id: "client-a", customer_id: "acme" });
  });

  it("ignores extra fields on the identity object", () => {
    assert.deepEqual(Object.keys(clientLabels(identity)).sort(), ["client_id", "customer_id"]);
  });
});

describe("routerMembershipLabels", () => {
  it("adds router_id on top of the client dimensions", () => {
    assert.deepEqual(routerMembershipLabels(identity), {
      client_id: "client-a",
      customer_id: "acme",
      router_id: "client_a_router_majors",
    });
  });
});
