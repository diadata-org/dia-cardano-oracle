/**
 * Ensures bootstrap builders never park identity NFTs on the funding wallet
 * (defence in depth if `pay.ToAddress` is mistakenly used instead of `pay.ToContract`).
 */
export function assertNftBootstrapDestinationIsNotFundingWallet(
  destinationAddress: string,
  fundingWalletAddress: string,
  context: string,
): void {
  if (destinationAddress === fundingWalletAddress) {
    throw new Error(
      `${context}: protocol NFT output must pay to the validator script address, not the funding wallet.`,
    );
  }
}
