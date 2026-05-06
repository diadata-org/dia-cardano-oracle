import {
  type Assets,
  type Script,
  type TxSignBuilder,
  type UTxO,
} from "@lucid-evolution/lucid";
import {
  calculateMinLovelaceFromUTxO,
  fromScriptRef,
  valueToAssets,
} from "@lucid-evolution/utils";

const FAKE_TX_HASH = "0".repeat(64);

export function computeMinUtxoForScriptOutput(args: {
  coinsPerUtxoByte: bigint;
  address: string;
  scriptRef: Script;
  extraAssets?: Assets;
}): bigint {
  const utxo: UTxO = {
    txHash: FAKE_TX_HASH,
    outputIndex: 0,
    address: args.address,
    assets: { lovelace: 0n, ...(args.extraAssets ?? {}) },
    scriptRef: args.scriptRef,
  };
  return calculateMinLovelaceFromUTxO(args.coinsPerUtxoByte, utxo);
}

export function logEffectiveOutputs(
  txSignBuilder: TxSignBuilder,
  reportProgress: (message: string) => void,
): void {
  const tx = txSignBuilder.toTransaction();
  const outputs = tx.body().outputs();
  const total = Number(outputs.len());
  for (let index = 0; index < total; index += 1) {
    const out = outputs.get(index);
    const address = out.address().to_bech32(undefined);
    const value = out.amount();
    const lovelace = BigInt(value.coin().toString());
    const otherAssets = stripLovelace(valueToAssets(value));

    const parts: string[] = [
      `Output[${index}]`,
      `addr=${shortenAddress(address)}`,
      `lovelace=${formatAda(lovelace)} ADA (${lovelace})`,
    ];

    if (Object.keys(otherAssets).length > 0) {
      parts.push(`assets=${formatAssets(otherAssets)}`);
    }

    const scriptRef = out.script_ref();
    if (scriptRef) {
      const cborBytes = scriptRef.to_cbor_bytes().length;
      const lucidScript = fromScriptRef(scriptRef);
      parts.push(`scriptRef=${cborBytes}B(${lucidScript.type})`);
    }

    const datum = out.datum();
    if (datum) {
      const inline = datum.as_datum();
      const hash = datum.as_hash();
      if (inline) {
        const datumBytes = inline.to_cbor_bytes().length;
        parts.push(`datum=inline(${datumBytes}B)`);
      } else if (hash) {
        parts.push(`datum=hash(${hash.to_hex()})`);
      }
    }

    reportProgress(parts.join(" | "));
  }
}

function stripLovelace(assets: Assets): Assets {
  const { lovelace: _lovelace, ...rest } = assets;
  return rest;
}

function formatAssets(assets: Assets): string {
  const entries = Object.entries(assets).map(([unit, qty]) => {
    const shortUnit = unit.length > 20 ? `${unit.slice(0, 12)}...${unit.slice(-6)}` : unit;
    return `${shortUnit}=${qty}`;
  });
  return entries.join(",");
}

function shortenAddress(addr: string): string {
  if (addr.length <= 24) return addr;
  return `${addr.slice(0, 14)}...${addr.slice(-6)}`;
}

function formatAda(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const fractional = (lovelace % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fractional}`;
}
