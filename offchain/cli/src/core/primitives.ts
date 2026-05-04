// Zero-dep pure utilities. This module sits at the bottom of the
// dependency graph: it must not import from any other module under
// offchain/cli/src/. Every other module is allowed to depend on it.
//
// Anything pure that is needed by both `dia-intent.ts` (intent / EVM
// layer) and `chain-helpers.ts` (Cardano / Lucid layer) belongs here.
// Putting it here avoids "duplicated to avoid an import cycle" hacks.

export function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }
  return BigInt(normalized);
}

export function normalizeHex(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Expected ${label} to be an even-length hex string.`);
  }

  return normalized;
}

export function normalizeEthereumAddressHex(value: string, label: string): string {
  const normalized = normalizeHex(value, label);
  if (normalized.length !== 40) {
    throw new Error(`Expected ${label} to be a 20-byte Ethereum address.`);
  }
  return normalized;
}

export function parseCommaSeparatedHexList(raw: string, label: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizeHex(value, label));
}

export function utf8ToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

export function splitUnit(unit: string): { policyId: string; assetName: string } {
  const normalizedUnit = normalizeHex(unit, "unit");
  return {
    policyId: normalizedUnit.slice(0, 56),
    assetName: normalizedUnit.slice(56),
  };
}
