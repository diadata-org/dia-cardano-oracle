import { randomBytes } from "node:crypto";

import { getAddressDetails } from "@lucid-evolution/lucid";
import { entropyToMnemonic } from "bip39";
import { walletFromSeed } from "@lucid-evolution/wallet";

export function createWallet(): {
  mnemonic: string;
  address: string;
  rewardAddress: string | null;
  paymentKeyHash: string;
  paymentPrivateKey: string;
  stakePrivateKey: string | null;
  env: {
    CARDANO_NETWORK: "Preview";
    CARDANO_WALLET_SEED: string;
  };
} {
  const mnemonic = entropyToMnemonic(randomBytes(32));
  const wallet = walletFromSeed(mnemonic, { network: "Preview" });
  const details = getAddressDetails(wallet.address);

  if (!details.paymentCredential || details.paymentCredential.type !== "Key") {
    throw new Error("Generated wallet address does not expose a key-based payment credential.");
  }

  return {
    mnemonic,
    address: wallet.address,
    rewardAddress: wallet.rewardAddress,
    paymentKeyHash: details.paymentCredential.hash,
    paymentPrivateKey: wallet.paymentKey,
    stakePrivateKey: wallet.stakeKey,
    env: {
      CARDANO_NETWORK: "Preview",
      CARDANO_WALLET_SEED: mnemonic,
    },
  };
}
