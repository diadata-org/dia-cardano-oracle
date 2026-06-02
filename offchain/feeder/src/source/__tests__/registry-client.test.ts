// R10.C.6 — registry-client: composeAuthenticatedWsUrl + resolveSourceFromConfig.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { composeAuthenticatedWsUrl, resolveSourceFromConfig } from "../registry-client.js";
import type { ModularConfig } from "../../config/types.js";

const ORIG = process.env.DIA_WS_CREDENTIAL_TESTNET;
afterEach(() => {
  if (ORIG === undefined) delete process.env.DIA_WS_CREDENTIAL_TESTNET;
  else process.env.DIA_WS_CREDENTIAL_TESTNET = ORIG;
});

describe("composeAuthenticatedWsUrl", () => {
  it("appends the credential as a path segment and trims trailing slashes", () => {
    process.env.DIA_WS_CREDENTIAL_TESTNET = "secret123";
    assert.equal(
      composeAuthenticatedWsUrl("wss://node.example.org/", "Preview"),
      "wss://node.example.org/secret123",
    );
  });

  it("URL-encodes special characters in the credential", () => {
    process.env.DIA_WS_CREDENTIAL_TESTNET = "a b&c";
    const url = composeAuthenticatedWsUrl("wss://node.example.org", "Preview");
    assert.ok(url.endsWith("/a%20b%26c"), `got ${url}`);
  });

  it("throws when the credential env var is missing", () => {
    delete process.env.DIA_WS_CREDENTIAL_TESTNET;
    assert.throws(
      () => composeAuthenticatedWsUrl("wss://node.example.org", "Preview"),
      /DIA_WS_CREDENTIAL_TESTNET/,
    );
  });
});

describe("resolveSourceFromConfig — structural validation", () => {
  it("throws when infrastructure.source is missing", () => {
    assert.throws(
      () => resolveSourceFromConfig({ infrastructure: {} } as unknown as ModularConfig),
      /infrastructure\.source: missing/,
    );
  });

  it("throws when chain_id is not a number", () => {
    const config = {
      infrastructure: { source: { rpc_urls: ["http://x"] } },
    } as unknown as ModularConfig;
    assert.throws(() => resolveSourceFromConfig(config), /chain_id: required/);
  });

  it("throws when rpc_urls is empty", () => {
    const config = {
      infrastructure: { source: { chain_id: 10050, rpc_urls: [] } },
    } as unknown as ModularConfig;
    assert.throws(() => resolveSourceFromConfig(config), /rpc_urls: required/);
  });
});
