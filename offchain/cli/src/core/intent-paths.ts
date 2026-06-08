import path from "node:path";

import { getDefaultIntentsDir } from "./state.js";

// Intents live in the active shared state run dir.
function intentsDir(): string {
  return getDefaultIntentsDir();
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
