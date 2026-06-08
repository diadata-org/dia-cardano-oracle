// R10.C.15 — coalescer reflush loop (R10.A.8): many sequential reflush
// cycles must not grow the call stack. Before the fix, flush() recursed
// once per confirmed batch when the buffer refilled in-flight; a long run
// of reflushes would overflow the stack. The iterative while-loop is flat.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCoalescerManager } from "../coalescer.js";
import type { QueueManager } from "../queue-manager.js";
import type { SubmitRequest, SubmitResult } from "../types.js";
import type { EnrichedIntent } from "../../source/types.js";

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol: string): EnrichedIntent {
  return {
    event: {
      intentHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price: 100_000n, timestamp: 1_700_000_000n, signer: SIGNER,
      blockNumber: 1n, txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0, blockTimestamp: 0n,
    },
    fullIntent: {
      intentType: "OracleUpdate", version: "1.0", chainId: 10050n,
      nonce: 1_700_000_000n, expiry: 9_999_999_999n, symbol,
      price: 100_000n, timestamp: 1_700_000_000n, source: "DIA", signature: "0xsig", signer: SIGNER,
    },
  };
}

function makeRequest(intentHash: string, symbol: string): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(symbol),
    destination: {
      network: "Preview",
      client_state_path: "state/preview/clients/client-a.json",
      protocol_state_path: "state/preview/config-bootstrap.json",
    },
    routerId: "router-a",
    destinationIndex: 0,
  };
}

function okResult(request: SubmitRequest): SubmitResult {
  return {
    ok: true, cardanoTxHash: "tx", intentHash: request.intentHash,
    receiverUnit: "receiver-unit", pairUnit: `pair-${request.enriched.fullIntent.symbol}`,
  };
}

describe("coalescer reflush loop", () => {
  it("processes a long run of in-flight reflushes without stack overflow", async () => {
    const N = 500; // deep enough to overflow the old tail-recursion
    let submitted = 0;
    const seen: string[] = [];

    const queueManager: QueueManager = {
      async submit(request) { return okResult(request); },
      async submitBatch(requests) {
        submitted += requests.length;
        // Yield so the next accept (fired from onResult) lands while this
        // lane is in-flight, forcing a reflush rather than a fresh window.
        await Promise.resolve();
        return requests.map(okResult);
      },
      async enqueueLaneTask(_dest, run) { await run(); },
      queueKeys() { return []; },
      totalPending() { return 0; },
    };

    let next = 1;
    const done = new Promise<void>((resolve) => {
      const coalescer = createCoalescerManager({
        queueManager,
        coalesceWindowMs: 0,
        maxBatchSize: 1,
        onResult: (result) => {
          seen.push(result.intentHash);
          if (next < N) {
            // Accept the next intent (distinct symbol) → buffers during the
            // in-flight cycle → triggers a reflush loop iteration.
            next += 1;
            coalescer.accept(makeRequest(`h${next}`, `SYM${next}/USD`));
          } else {
            resolve();
          }
        },
      });
      coalescer.accept(makeRequest("h1", "SYM1/USD"));
    });

    await done;
    assert.equal(submitted, N);
    assert.equal(seen.length, N);
  });
});
