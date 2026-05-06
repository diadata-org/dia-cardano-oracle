import { slotToUnixTime, type LucidEvolution } from "@lucid-evolution/lucid";

import { getCliConfig } from "./config.js";

const TX_VALIDITY_START_BACK_SLOTS = 60;

export type NetworkNow = {
  slot: number;
  unixTimeMs: number;
  unixTimeSec: bigint;
};

export function getNetworkNow(
  lucid: Awaited<ReturnType<typeof import("./lucid.js").makeConfiguredLucid>>,
): NetworkNow {
  const slot = lucid.currentSlot();
  const network = lucid.config().network ?? getCliConfig().cardanoNetwork;
  const unixTimeMs = Number(slotToUnixTime(network, slot));

  return {
    slot,
    unixTimeMs,
    unixTimeSec: BigInt(Math.floor(unixTimeMs / 1000)),
  };
}

export function slotBackoffUnixTimeMs(
  lucid: Pick<LucidEvolution, "config">,
  slot: number,
  slotsBack: number = TX_VALIDITY_START_BACK_SLOTS,
): number {
  const network = lucid.config().network ?? getCliConfig().cardanoNetwork;
  const safeSlot = Math.max(0, slot - slotsBack);
  return Number(slotToUnixTime(network, safeSlot));
}

export function resolveIntentTimingFromNetwork(args: {
  lucid: Awaited<ReturnType<typeof import("./lucid.js").makeConfiguredLucid>>;
  expirySeconds: bigint;
  nonceBump?: bigint;
}): {
  timestamp: string;
  expiry: string;
  nonce: string;
} {
  const now = getNetworkNow(args.lucid);
  const nonceBump = args.nonceBump ?? 0n;
  const timestamp = now.unixTimeSec.toString();
  const expiry = (now.unixTimeSec + args.expirySeconds).toString();
  const nonce = (BigInt(now.unixTimeMs) + nonceBump).toString();

  return { timestamp, expiry, nonce };
}
