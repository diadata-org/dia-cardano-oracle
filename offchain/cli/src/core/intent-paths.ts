import path from "node:path";

import { networkTag } from "./config.js";

// Intents live in the shared state tree: ../state/<network>/intents/ (relative
// to the CLI cwd offchain/cli → offchain/state). Network from CARDANO_NETWORK.
function intentsDir(): string {
  return `../state/${networkTag()}/intents`;
}

export function pairSlugFromSymbol(symbol: string): string {
  const slug = symbol
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "pair";
}

export function unsignedIntentPathForSymbol(symbol: string): string {
  return path.join(intentsDir(), `${pairSlugFromSymbol(symbol)}.unsigned.json`);
}

export function signedIntentPathForSymbol(symbol: string): string {
  return path.join(intentsDir(), `${pairSlugFromSymbol(symbol)}.signed.json`);
}
