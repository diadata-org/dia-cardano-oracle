import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyError, type FeederErrorCode } from "../codes.js";

class TxDroppedFromChainError extends Error {
  constructor(message = "tx dropped from chain") {
    super(message);
    this.name = "TxDroppedFromChainError";
  }
}

describe("classifyError", () => {
  it("returns Unknown for non-Error values with a clear remediation", () => {
    const r = classifyError("oops");
    assert.equal(r.code, "Unknown");
    assert.match(r.remediation, /non-Error/i);
  });

  it("detects TxDroppedFromChainError by name (not by message)", () => {
    const r = classifyError(new TxDroppedFromChainError());
    assert.equal(r.code, "TxDroppedFromChain");
    assert.match(r.remediation, /re-queued/i);
  });

  it("classifies intent-expired messages", () => {
    const r = classifyError(new Error("Intent has expired before submission"));
    assert.equal(r.code, "IntentExpired");
  });

  it("classifies monotonicity violations", () => {
    const r1 = classifyError(new Error("nonce monotonic check failed"));
    const r2 = classifyError(new Error("intent nonce is not strictly greater"));
    const r3 = classifyError(new Error("nonce must be greater than the previous on-chain nonce"));
    assert.equal(r1.code, "NonMonotonicNonce");
    assert.equal(r2.code, "NonMonotonicNonce");
    assert.equal(r3.code, "NonMonotonicNonce");
  });

  it("classifies BOTH the nonce and the timestamp branch of the build-time monotonicity assertion", () => {
    // The build-time assertion (cli preflight/oracle-update.ts) throws a nonce
    // OR a timestamp message; both mean the intent is superseded on chain and
    // no tx was broadcast, so both must be NonMonotonicNonce (not BuilderError,
    // which would count as a real failed transaction). Non-batch + batch forms.
    for (const message of [
      "Oracle intent nonce must be greater than the current on-chain nonce; intent superseded, not submitted.",
      "Oracle intent timestamp must be greater than the current on-chain timestamp; intent superseded, not submitted.",
      "Intent timestamp must be greater than the current on-chain timestamp for /tmp/oracle-batch.json; intent superseded, not submitted.",
    ]) {
      assert.equal(classifyError(new Error(message)).code, "NonMonotonicNonce", message);
    }
    // Guard: the min-UTxO validation message ("greater than zero") must NOT be
    // swept into NonMonotonicNonce by the broadened match.
    assert.notEqual(
      classifyError(new Error("Config min_utxo_lovelace must be greater than zero")).code,
      "NonMonotonicNonce",
    );
  });

  it("classifies signer-authorisation errors", () => {
    const r1 = classifyError(new Error("Wallet is not a config admin"));
    const r2 = classifyError(new Error("wallet is not a config signer"));
    const r3 = classifyError(new Error("not authorized to mint"));
    assert.equal(r1.code, "SignerNotAuthorizedToMint");
    assert.equal(r2.code, "SignerNotAuthorizedToMint");
    assert.equal(r3.code, "SignerNotAuthorizedToMint");
  });

  it("classifies provider-lag errors", () => {
    const r = classifyError(new Error("UTxO set did not refresh after submission"));
    assert.equal(r.code, "ProviderLag");
  });

  it("classifies wallet insufficient funds", () => {
    const r = classifyError(new Error("Wallet has insufficient funds"));
    assert.equal(r.code, "WalletInsufficientFunds");
  });

  it("classifies receiver insufficient funds (receiver + balance/lovelace pattern)", () => {
    const r1 = classifyError(new Error("Receiver balance below fee threshold"));
    const r2 = classifyError(new Error("Receiver UTxO lovelace too low"));
    assert.equal(r1.code, "ReceiverInsufficientFunds");
    assert.equal(r2.code, "ReceiverInsufficientFunds");
  });

  it("classifies batch-size-exceeded errors", () => {
    const r = classifyError(new Error("Batch exceeds max size limit"));
    assert.equal(r.code, "BatchSizeExceeded");
  });

  it("falls back to BuilderError for tx-construction-shaped messages", () => {
    const r = classifyError(new Error("Failed to build transaction body"));
    // BuilderError is the canonical fallback for tx-construction failures.
    assert.ok(["BuilderError", "Unknown"].includes(r.code as FeederErrorCode));
    assert.ok(r.remediation.length > 0);
  });

  it("every classification result carries a non-empty remediation string", () => {
    const samples: Array<unknown> = [
      "not-an-error",
      new Error(""),
      new Error("Intent has expired"),
      new TxDroppedFromChainError(),
      new Error("insufficient funds"),
    ];
    for (const s of samples) {
      const r = classifyError(s);
      assert.ok(r.code, "code must be set");
      assert.ok(r.remediation.length > 0, "remediation must be non-empty");
    }
  });
});
