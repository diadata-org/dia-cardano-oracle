import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSubmissionQueue } from "../queue.js";
import { createInflightTable } from "../inflight.js";
import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "../types.js";
import type { EnrichedIntent } from "../../source/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNER = "0xf64D333c19B007519C7B9316680ED26578f98C08" as `0x${string}`;

function makeEnriched(symbol = "BTC/USD"): EnrichedIntent {
  return {
    event: {
      intentHash: `0x${"ab".repeat(32)}` as `0x${string}`,
      symbolHash: `0x${"cc".repeat(32)}` as `0x${string}`,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      signer: SIGNER,
      blockNumber: 1n,
      txHash: `0x${"dd".repeat(32)}` as `0x${string}`,
      logIndex: 0,
      blockTimestamp: 0n,
    },
    fullIntent: {
      intentType: "OracleUpdate",
      version: "1.0",
      chainId: 10050n,
      nonce: 1n,
      expiry: 9_999_999_999n,
      symbol,
      price: 100_000n,
      timestamp: 1_700_000_000n,
      source: "DIA Oracle",
      signature: "0xsig",
      signer: SIGNER,
    },
  };
}

function makeRequest(intentHash = "0xhash"): SubmitRequest {
  return {
    intentHash,
    enriched: makeEnriched(),
    destination: {
      network: "Preview",
      client_state_path: "state/preview/clients/client-a.json",
      protocol_state_path: "state/preview/config-bootstrap.json",
    },
    routerId: "r1",
    destinationIndex: 0,
  };
}

function makeOkClient(txHash = "cardano-tx-abc"): CardanoWriteClient {
  return {
    label: "test-client",
    async submit(req) {
      return {
        ok: true,
        cardanoTxHash: txHash,
        intentHash: req.intentHash,
        receiverUnit: "receiver-unit-test",
        pairUnit: "pair-unit-test",
      };
    },
    async submitBatch(requests) {
      return requests.map((req, index) => ({
        ok: true,
        cardanoTxHash: `${txHash}-${index}`,
        intentHash: req.intentHash,
        receiverUnit: "receiver-unit-test",
        pairUnit: `pair-unit-${index}`,
      }));
    },
  };
}

function makeFailClient(message = "submit failed"): CardanoWriteClient {
  return {
    label: "fail-client",
    async submit(req) {
      return {
        ok: false,
        intentHash: req.intentHash,
        error: new Error(message),
        code: "Unknown",
        remediation: "",
      };
    },
    async submitBatch(requests) {
      return requests.map((req) => ({
        ok: false,
        intentHash: req.intentHash,
        error: new Error(message),
        code: "Unknown",
        remediation: "",
      }));
    },
  };
}

function makeThrowClient(): CardanoWriteClient {
  return {
    label: "throw-client",
    async submit(_req) {
      throw new Error("unexpected throw");
    },
    async submitBatch(_requests) {
      throw new Error("unexpected throw");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSubmissionQueue", () => {
  it("resolves with ok result from client", async () => {
    const q = createSubmissionQueue({
      client: makeOkClient("tx-ok-1"),
      inflight: createInflightTable(),
      inflightTimeoutMs: 60_000,
    });
    const result = await q.enqueue(makeRequest("h1"));
    assert.equal(result.ok, true);
    assert.equal("cardanoTxHash" in result && result.cardanoTxHash, "tx-ok-1");
    assert.equal(result.intentHash, "h1");
  });

  it("resolves with err result when client returns error", async () => {
    const q = createSubmissionQueue({
      client: makeFailClient("rpc down"),
      inflight: createInflightTable(),
      inflightTimeoutMs: 60_000,
    });
    const result = await q.enqueue(makeRequest("h2"));
    assert.equal(result.ok, false);
    assert.equal("error" in result && result.error.message, "rpc down");
  });

  it("catches thrown errors and wraps them as SubmitResultErr", async () => {
    const q = createSubmissionQueue({
      client: makeThrowClient(),
      inflight: createInflightTable(),
      inflightTimeoutMs: 60_000,
    });
    const result = await q.enqueue(makeRequest("h3"));
    assert.equal(result.ok, false);
    assert.equal("error" in result && result.error.message, "unexpected throw");
  });

  it("processes requests serially — order is preserved", async () => {
    const order: string[] = [];
    const client: CardanoWriteClient = {
      label: "ordered",
      async submit(req) {
        order.push(req.intentHash);
        return { ok: true, cardanoTxHash: `tx-${req.intentHash}`, intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
      async submitBatch(requests) {
        order.push(`batch:${requests.map((req) => req.intentHash).join(",")}`);
        return requests.map((req) => ({
          ok: true,
          cardanoTxHash: `tx-${req.intentHash}`,
          intentHash: req.intentHash,
          receiverUnit: "r",
          pairUnit: "p",
        }));
      },
    };
    const q = createSubmissionQueue({ client, inflight: createInflightTable(), inflightTimeoutMs: 60_000 });
    const [r1, r2, r3] = await Promise.all([
      q.enqueue(makeRequest("a")),
      q.enqueue(makeRequest("b")),
      q.enqueue(makeRequest("c")),
    ]);
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(r1.intentHash, "a");
    assert.equal(r2.intentHash, "b");
    assert.equal(r3.intentHash, "c");
  });

  it("calls onResult callback for each processed item", async () => {
    const results: SubmitResult[] = [];
    const q = createSubmissionQueue({
      client: makeOkClient(),
      inflight: createInflightTable(),
      inflightTimeoutMs: 60_000,
      onResult: (r) => results.push(r),
    });
    await q.enqueue(makeRequest("x1"));
    await q.enqueue(makeRequest("x2"));
    assert.equal(results.length, 2);
    assert.equal(results[0].intentHash, "x1");
    assert.equal(results[1].intentHash, "x2");
  });

  it("pending count decrements after processing", async () => {
    let resolveSubmit!: () => void;
    const blocker = new Promise<void>((res) => { resolveSubmit = res; });

    const client: CardanoWriteClient = {
      label: "slow",
      async submit(req) {
        await blocker;
        return { ok: true, cardanoTxHash: "tx-slow", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
      async submitBatch(requests) {
        await blocker;
        return requests.map((req) => ({
          ok: true,
          cardanoTxHash: "tx-slow",
          intentHash: req.intentHash,
          receiverUnit: "r",
          pairUnit: "p",
        }));
      },
    };
    const q = createSubmissionQueue({ client, inflight: createInflightTable(), inflightTimeoutMs: 60_000 });

    const p1 = q.enqueue(makeRequest("s1"));
    q.enqueue(makeRequest("s2")); // not awaited — stays pending
    // Give the drain loop a tick to start processing s1
    await new Promise((r) => setImmediate(r));
    assert.equal(q.pending, 1); // s2 is still queued
    resolveSubmit();
    await p1;
    // After s1 resolves, drain picks up s2
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(q.pending, 0);
  });

  it("enqueueBatch preserves request order and returns one result per request", async () => {
    const seen: string[][] = [];
    const client: CardanoWriteClient = {
      label: "batch",
      async submit(req) {
        return {
          ok: true,
          cardanoTxHash: `single-${req.intentHash}`,
          intentHash: req.intentHash,
          receiverUnit: "r",
          pairUnit: "p",
        };
      },
      async submitBatch(requests) {
        seen.push(requests.map((req) => req.intentHash));
        return requests.map((req, index) => ({
          ok: true,
          cardanoTxHash: "batch-tx",
          intentHash: req.intentHash,
          receiverUnit: "r",
          pairUnit: `pair-${index}`,
        }));
      },
    };

    const q = createSubmissionQueue({ client, inflight: createInflightTable(), inflightTimeoutMs: 60_000 });
    const results = await q.enqueueBatch([
      makeRequest("b1"),
      makeRequest("b2"),
      makeRequest("b3"),
    ]);

    assert.deepEqual(seen, [["b1", "b2", "b3"]]);
    assert.equal(results.length, 3);
    assert.equal(results[0]?.intentHash, "b1");
    assert.equal(results[1]?.intentHash, "b2");
    assert.equal(results[2]?.intentHash, "b3");
  });

  // -------------------------------------------------------------------------
  // Lane mutual exclusion: a merge task and an oracle update share one lane.
  //
  // On Cardano both a merge tx and an update tx spend the SAME Receiver UTxO,
  // so they MUST never run concurrently. The merge is dispatched as a lane
  // task (`enqueueTask`) onto the same serial queue the updates use; the queue
  // runs one entry at a time, so the two can never interleave. These tests
  // instrument enter/exit and assert no overlap.
  // -------------------------------------------------------------------------
  it("never overlaps a merge task with an in-flight update on the same lane", async () => {
    const events: string[] = [];
    let active = 0;
    // True if two bodies were ever executing at once (the bug we guard against).
    let overlapped = false;

    function track(tag: string): void {
      active++;
      if (active > 1) overlapped = true;
      events.push(`enter:${tag}`);
    }
    function untrack(tag: string): void {
      active--;
      events.push(`exit:${tag}`);
    }

    // A slow client whose submit only completes when we release `gate`. This
    // keeps the UPDATE body "in-flight" while we enqueue the merge, proving the
    // merge waits rather than running concurrently.
    let releaseUpdate!: () => void;
    const gate = new Promise<void>((res) => { releaseUpdate = res; });
    const client: CardanoWriteClient = {
      label: "lane-mx",
      async submit(req) {
        track("update");
        await gate;
        untrack("update");
        return { ok: true, cardanoTxHash: "tx-u", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p" };
      },
      async submitBatch(requests) {
        track("update");
        await gate;
        untrack("update");
        return requests.map((req) => ({
          ok: true, cardanoTxHash: "tx-u", intentHash: req.intentHash, receiverUnit: "r", pairUnit: "p",
        }));
      },
    };

    const q = createSubmissionQueue({ client, inflight: createInflightTable(), inflightTimeoutMs: 60_000 });

    // 1. Start an update; it parks inside submit() awaiting the gate.
    const updateP = q.enqueue(makeRequest("u1"));
    await new Promise((r) => setImmediate(r));
    assert.equal(active, 1, "update should be running");
    assert.equal(q.busy, true);

    // 2. Enqueue the merge while the update is still in-flight. It must NOT
    //    start yet — the lane is busy with the update.
    let mergeRan = false;
    const mergeP = q.enqueueTask(async () => {
      track("merge");
      mergeRan = true;
      await new Promise((r) => setImmediate(r));
      untrack("merge");
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(mergeRan, false, "merge must wait while the update holds the lane");

    // 3. Release the update; the merge then runs after it completes.
    releaseUpdate();
    await updateP;
    await mergeP;

    assert.equal(overlapped, false, "a merge and an update must never run at once on a lane");
    assert.equal(mergeRan, true);
    assert.deepEqual(events, ["enter:update", "exit:update", "enter:merge", "exit:merge"]);
  });

  it("runs an enqueued merge task before a later update on the same lane (FIFO)", async () => {
    const events: string[] = [];
    const client = makeOkClient();
    // Wrap submit to record ordering.
    const recordingClient: CardanoWriteClient = {
      ...client,
      async submit(req) {
        events.push(`update:${req.intentHash}`);
        return client.submit(req);
      },
    };
    const q = createSubmissionQueue({ client: recordingClient, inflight: createInflightTable(), inflightTimeoutMs: 60_000 });

    // Enqueue merge first, then an update — FIFO means merge runs first and the
    // update waits for it (serial lane).
    const mergeP = q.enqueueTask(async () => {
      events.push("merge:start");
      await new Promise((r) => setImmediate(r));
      events.push("merge:end");
    });
    const updateP = q.enqueue(makeRequest("after-merge"));

    await Promise.all([mergeP, updateP]);
    assert.deepEqual(events, ["merge:start", "merge:end", "update:after-merge"]);
  });

  it("propagates a thrown merge-task error to the enqueueTask caller without wedging the lane", async () => {
    const q = createSubmissionQueue({ client: makeOkClient(), inflight: createInflightTable(), inflightTimeoutMs: 60_000 });

    await assert.rejects(
      () => q.enqueueTask(async () => { throw new Error("merge boom"); }),
      /merge boom/,
    );

    // Lane is not wedged: a subsequent update still processes.
    const result = await q.enqueue(makeRequest("after-throw"));
    assert.equal(result.ok, true);
    assert.equal(q.busy, false);
  });
});
