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
 * Multi-client settle path: the coordinator `SettleManifest` is validated
 * on-chain for non-empty + unique receivers whose drained sum equals the
 * payment-hook accrued delta. Off-chain we assert the same shape before
 * building the witness so a malformed manifest fails fast with a clear CLI
 * error instead of an opaque Plutus rejection:
 *
 *   - non-empty + unique (delegated to
 *     `assertSettleManifestReceiversNonEmptyAndUnique`);
 *   - 1:1 with the loaded clients: every manifest row matches exactly one
 *     loaded client receiver (policy id / asset name) and vice versa, so the
 *     N receiver UTxOs the builder collects line up with the N manifest
 *     entries the coordinator walks.
 *
 * This generalises the previous single-client check to any N >= 1 receivers
 * settled in one transaction.
 */
export function assertSettleManifestMatchesClientReceivers(
  manifest: SettleManifestReceiverRef[],
  clients: Array<{ receiverPolicyId: string; receiverAssetName: string }>,
): void {
  assertSettleManifestReceiversNonEmptyAndUnique(manifest);

  if (manifest.length !== clients.length) {
    throw new Error(
      `Settle manifest length (${manifest.length}) does not match the number of loaded client receivers (${clients.length}).`,
    );
  }

  const manifestKeys = new Set(
    manifest.map((row) => `${row.receiverPolicyId}#${row.receiverAssetName}`),
  );
  for (const client of clients) {
    const key = `${client.receiverPolicyId}#${client.receiverAssetName}`;
    if (!manifestKeys.has(key)) {
      throw new Error(
        `Loaded client receiver ${key} is missing from the settle manifest.`,
      );
    }
  }

  const clientKeys = new Set(
    clients.map((client) => `${client.receiverPolicyId}#${client.receiverAssetName}`),
  );
  for (const row of manifest) {
    const key = `${row.receiverPolicyId}#${row.receiverAssetName}`;
    if (!clientKeys.has(key)) {
      throw new Error(
        `Settle manifest receiver ${key} does not match any loaded client receiver (policy id / asset name).`,
      );
    }
  }
}
