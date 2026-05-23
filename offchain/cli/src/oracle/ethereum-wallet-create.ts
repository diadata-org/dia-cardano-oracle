import { Wallet, SigningKey } from "ethers";

import { getCliConfig } from "../core/config.js";

export function createEthereumWallet(): {
  address: string;
  privateKey: string;
  publicKey: string;
  env: { [evmKeyVar: string]: string };
} {
  const { networkSuffix } = getCliConfig();
  const wallet = Wallet.createRandom();
  const publicKey = SigningKey.computePublicKey(wallet.signingKey.publicKey, true);

  const evmKeyVar = `DIA_EVM_PRIVATE_KEY_${networkSuffix}`;

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    publicKey: publicKey.startsWith("0x") ? publicKey.slice(2) : publicKey,
    env: {
      [evmKeyVar]: wallet.privateKey,
    },
  };
}
