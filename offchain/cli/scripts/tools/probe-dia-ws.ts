#!/usr/bin/env tsx
// Probe DIA Lasna WebSocket auth schemes using the credential in `.env`
// (variables `DIA_WS_CREDENTIAL_TESTNET` / `DIA_WS_CREDENTIAL_MAINNET`).
// Tries every plausible scheme against both
// testnet and mainnet endpoints; for each, reports either the WS upgrade
// failure code or the JSON-RPC reply to `eth_chainId`.
//
// Usage:  pnpm tsx scripts/tools/probe-dia-ws.ts
//         (run from offchain/cli)

import "dotenv/config";
import WebSocket from "ws";

import { getDiaSourceConfigFor } from "../../src/core/config.js";

const testnet = getDiaSourceConfigFor("TESTNET");
const mainnet = getDiaSourceConfigFor("MAINNET");
const cred = testnet.wsCredential ?? mainnet.wsCredential;
if (!cred) {
  console.error(
    "DIA_WS_CREDENTIAL_TESTNET or DIA_WS_CREDENTIAL_MAINNET must be set in .env",
  );
  process.exit(1);
}

const endpoints = [
  { name: "testnet", url: `${testnet.wsUrl}/ws` },
  { name: "mainnet", url: `${mainnet.wsUrl}/ws` },
];

type Attempt = {
  label: string;
  url: (base: string) => string;
  headers?: Record<string, string>;
  protocols?: string | string[];
};

const attempts: Attempt[] = [
  { label: "Authorization: Bearer <cred>", url: (b) => b, headers: { Authorization: `Bearer ${cred}` } },
  { label: "Authorization: Basic <cred-as-is>", url: (b) => b, headers: { Authorization: `Basic ${cred}` } },
  {
    label: "Authorization: Basic base64(cred:)",
    url: (b) => b,
    headers: { Authorization: `Basic ${Buffer.from(`${cred}:`).toString("base64")}` },
  },
  {
    label: "Authorization: Basic base64(:cred)",
    url: (b) => b,
    headers: { Authorization: `Basic ${Buffer.from(`:${cred}`).toString("base64")}` },
  },
  {
    label: "Authorization: Basic base64(api:cred)",
    url: (b) => b,
    headers: { Authorization: `Basic ${Buffer.from(`api:${cred}`).toString("base64")}` },
  },
  { label: "Authorization: Token <cred>", url: (b) => b, headers: { Authorization: `Token ${cred}` } },
  { label: "X-API-Key: <cred>", url: (b) => b, headers: { "X-API-Key": cred } },
  { label: "X-Auth-Token: <cred>", url: (b) => b, headers: { "X-Auth-Token": cred } },
  { label: "Sec-WebSocket-Protocol: <cred>", url: (b) => b, protocols: cred },
  { label: "userinfo in URL (cred@host)", url: (b) => b.replace("wss://", `wss://${encodeURIComponent(cred)}@`) },
  { label: "userinfo in URL (cred:@host)", url: (b) => b.replace("wss://", `wss://${encodeURIComponent(cred)}:@`) },
  { label: "query ?token=<cred>", url: (b) => `${b}?token=${encodeURIComponent(cred)}` },
  { label: "query ?apikey=<cred>", url: (b) => `${b}?apikey=${encodeURIComponent(cred)}` },
  { label: "query ?api_key=<cred>", url: (b) => `${b}?api_key=${encodeURIComponent(cred)}` },
  { label: "query ?key=<cred>", url: (b) => `${b}?key=${encodeURIComponent(cred)}` },
  { label: "query ?auth=<cred>", url: (b) => `${b}?auth=${encodeURIComponent(cred)}` },
  { label: "path /ws/<cred>", url: (b) => b.replace(/\/ws$/, `/ws/${encodeURIComponent(cred)}`) },
  // Conduit-style: API key as the URL path component (before /ws or instead of it)
  { label: "path /<cred> (no /ws)", url: (b) => b.replace(/\/ws$/, `/${encodeURIComponent(cred)}`) },
  { label: "path /<cred>/ws", url: (b) => b.replace(/\/ws$/, `/${encodeURIComponent(cred)}/ws`) },
  { label: "path /v1/<cred>", url: (b) => b.replace(/\/ws$/, `/v1/${encodeURIComponent(cred)}`) },
  { label: "path /v1/ws/<cred>", url: (b) => b.replace(/\/ws$/, `/v1/ws/${encodeURIComponent(cred)}`) },
];

type Outcome =
  | { kind: "open"; rpc?: unknown; rpcError?: string }
  | { kind: "unexpected-response"; status: number; body: string }
  | { kind: "error"; message: string };

function tryOne(base: string, attempt: Attempt): Promise<Outcome> {
  return new Promise((resolve) => {
    const url = attempt.url(base);
    let settled = false;
    const done = (o: Outcome) => {
      if (settled) return;
      settled = true;
      try {
        ws.removeAllListeners();
      } catch {}
      try {
        ws.terminate();
      } catch {}
      resolve(o);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, attempt.protocols ?? [], {
        headers: attempt.headers ?? {},
        handshakeTimeout: 8000,
      });
    } catch (e: unknown) {
      resolve({ kind: "error", message: (e as Error).message });
      return;
    }
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }));
      } catch (e) {
        done({ kind: "open", rpcError: (e as Error).message });
      }
    });
    ws.on("message", (data) => {
      const text = data.toString();
      try {
        done({ kind: "open", rpc: JSON.parse(text) });
      } catch {
        done({ kind: "open", rpc: text });
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        done({
          kind: "unexpected-response",
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString().slice(0, 200),
        }),
      );
    });
    ws.on("error", (e) => done({ kind: "error", message: e.message }));
    ws.on("close", (code, reason) => done({ kind: "error", message: `closed ${code} ${reason.toString()}` }));
  });
}

function fmt(o: Outcome): string {
  switch (o.kind) {
    case "open":
      if (o.rpc !== undefined) return `OPEN  rpc=${JSON.stringify(o.rpc)}`;
      if (o.rpcError) return `OPEN  (send failed: ${o.rpcError})`;
      return "OPEN  (no rpc reply)";
    case "unexpected-response":
      return `HTTP ${o.status}  ${o.body ? `body=${JSON.stringify(o.body)}` : ""}`;
    case "error":
      return `ERR   ${o.message}`;
  }
}

async function main() {
  console.log(`Credential length=${cred?.length} first=${cred?.[0]} last=${cred?.[cred.length - 1]}`);
  console.log("");
  for (const ep of endpoints) {
    console.log(`=== ${ep.name}  ${ep.url} ===`);
    for (const a of attempts) {
      const o = await tryOne(ep.url, a);
      console.log(`  ${a.label.padEnd(40)} -> ${fmt(o)}`);
      if (o.kind === "open" && o.rpc) {
        console.log(`  *** SUCCESS on '${a.label}' against ${ep.name} ***`);
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
