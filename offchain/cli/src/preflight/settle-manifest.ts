/**
 * Coordinator `ApplySettle` manifest receiver list (mirrors on-chain uniqueness + non-empty).
 */
export type SettleManifestReceiverRef = {
  receiverPolicyId: string;
  receiverAssetName: string;
};

export function assertSettleManifestReceiversNonEmptyAndUnique(
  receivers: SettleManifestReceiverRef[],
): void {
  if (receivers.length === 0) {
    throw new Error("Settle manifest must list at least one receiver.");
  }
  const seen = new Set<string>();
  for (const r of receivers) {
    const key = `${r.receiverPolicyId}#${r.receiverAssetName}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate settle receiver in manifest: ${key}`);
    }
    seen.add(key);
  }
}
