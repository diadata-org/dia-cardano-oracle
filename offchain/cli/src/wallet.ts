import { CML, getAddressDetails } from "@lucid-evolution/lucid";
import { walletFromSeed } from "@lucid-evolution/wallet";

import { makeConfiguredLucid, selectConfiguredWallet } from "./lucid.js";

export type ConfiguredWalletDefaults = {
  paymentKeyHash: string;
  oraclePublicKey: string;
  feeAddress: string;
};

export type ConfiguredWalletOracleSignature = {
  publicKey: string;
  signature: string;
};

export async function walletSummary(): Promise<{
  source: "seed" | "private-key";
  address: string;
  rewardAddress: string | null;
  utxoCount: number;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, rewardAddress, utxos] = await Promise.all([
    wallet.address(),
    wallet.rewardAddress(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    rewardAddress,
    utxoCount: utxos.length,
  };
}

export async function walletDefaults(): Promise<{
  source: "seed" | "private-key";
  address: string;
  rewardAddress: string | null;
  utxoCount: number;
  defaults: ConfiguredWalletDefaults;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, rewardAddress, utxos] = await Promise.all([
    wallet.address(),
    wallet.rewardAddress(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    rewardAddress,
    utxoCount: utxos.length,
    defaults: deriveConfiguredWalletDefaults({ source, address }),
  };
}

export async function walletUtxos(): Promise<{
  source: "seed" | "private-key";
  address: string;
  utxoCount: number;
  utxos: Array<{
    txHash: string;
    outputIndex: number;
    lovelace: bigint;
    assets: Record<string, bigint>;
  }>;
}> {
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();

  const [address, utxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);

  return {
    source,
    address,
    utxoCount: utxos.length,
    utxos: utxos.map((utxo) => ({
      txHash: utxo.txHash,
      outputIndex: utxo.outputIndex,
      lovelace: utxo.assets.lovelace ?? 0n,
      assets: utxo.assets,
    })),
  };
}

export function deriveConfiguredWalletDefaults(args: {
  source: "seed" | "private-key";
  address: string;
}): ConfiguredWalletDefaults {
  const details = getAddressDetails(args.address);

  if (!details.paymentCredential || details.paymentCredential.type !== "Key") {
    throw new Error(
      "The configured wallet address does not expose a key-based payment credential.",
    );
  }

  return {
    paymentKeyHash: details.paymentCredential.hash,
    oraclePublicKey: deriveConfiguredWalletOraclePublicKey(args.source),
    feeAddress: args.address,
  };
}

export function signConfiguredWalletOracleMessage(args: {
  source: "seed" | "private-key";
  messageHex: string;
}): ConfiguredWalletOracleSignature {
  const message = Buffer.from(normalizeHex(args.messageHex, "messageHex"), "hex");
  const privateKey = configuredPaymentPrivateKey(args.source);
  const cmlPrivateKey = CML.PrivateKey.from_bech32(privateKey);
  const signature = cmlPrivateKey.sign(message);

  return {
    publicKey: privateKeyToPublicKeyHex(privateKey),
    signature: Buffer.from(signature.to_raw_bytes()).toString("hex"),
  };
}

function deriveConfiguredWalletOraclePublicKey(
  source: "seed" | "private-key",
): string {
  return privateKeyToPublicKeyHex(configuredPaymentPrivateKey(source));
}

function configuredPaymentPrivateKey(source: "seed" | "private-key"): string {
  if (source === "seed") {
    const seed = process.env.CARDANO_WALLET_SEED?.trim();

    if (!seed) {
      throw new Error(
        "Missing CARDANO_WALLET_SEED while deriving wallet defaults.",
      );
    }

    const derivedWallet = walletFromSeed(seed, { network: "Preview" });
    return derivedWallet.paymentKey;
  }

  const privateKey = process.env.CARDANO_PRIVATE_KEY?.trim();

  if (!privateKey) {
    throw new Error(
      "Missing CARDANO_PRIVATE_KEY while deriving wallet defaults.",
    );
  }

  return privateKey;
}

function privateKeyToPublicKeyHex(privateKey: string): string {
  const publicKey = CML.PrivateKey.from_bech32(privateKey).to_public();
  return Buffer.from(publicKey.to_raw_bytes()).toString("hex");
}

function normalizeHex(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();

  if (!/^[0-9a-f]*$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new Error(`Expected ${label} to be an even-length hex string.`);
  }

  return trimmed;
}
