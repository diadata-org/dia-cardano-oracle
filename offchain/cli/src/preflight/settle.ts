import {
  assertSettleManifestReceiversNonEmptyAndUnique,
  type SettleManifestReceiverRef,
} from "./settle-manifest.js";

export function assertSettleReceiverAccruedPositive(
  accruedToHookLovelace: bigint,
  accruedDisplay: string,
  receiverUnit: string,
): void {
  if (accruedToHookLovelace <= 0n) {
    throw new Error(
      `Receiver ${receiverUnit} has no accrued fees to settle (accruedToHookLovelace=${accruedDisplay}).`,
    );
  }
}

/**
 * Single-client settle path: manifest must be non-empty, unique, length 1,
 * and match the client receiver (avoids building a mismatched coordinator witness).
 */
export function assertSettleManifestMatchesSingleClientReceiver(
  manifest: SettleManifestReceiverRef[],
  client: { receiverPolicyId: string; receiverAssetName: string },
): void {
  assertSettleManifestReceiversNonEmptyAndUnique(manifest);
  if (manifest.length !== 1) {
    throw new Error(
      "This settle command currently supports exactly one receiver in the coordinator settle manifest.",
    );
  }
  const row = manifest[0]!;
  if (
    row.receiverPolicyId !== client.receiverPolicyId ||
    row.receiverAssetName !== client.receiverAssetName
  ) {
    throw new Error(
      "Settle manifest receiver does not match the loaded client receiver (policy id / asset name).",
    );
  }
}
