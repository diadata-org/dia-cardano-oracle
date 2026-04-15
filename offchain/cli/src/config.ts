import { config as loadDotenv } from "dotenv";

loadDotenv();

export type CliConfig = {
  cardanoNetwork: "Preview";
  blockfrostProjectId: string;
  blockfrostApiUrl: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function requireSupportedNetwork(value: string): "Preview" {
  if (value !== "Preview") {
    throw new Error(
      `Unsupported CARDANO_NETWORK "${value}". This CLI is currently restricted to Preview.`,
    );
  }

  return "Preview";
}

export function getCliConfig(): CliConfig {
  return {
    cardanoNetwork: requireSupportedNetwork(
      process.env.CARDANO_NETWORK?.trim() ?? "Preview",
    ),
    blockfrostProjectId: required("BLOCKFROST_PROJECT_ID"),
    blockfrostApiUrl:
      process.env.BLOCKFROST_API_URL?.trim() ??
      "https://cardano-preview.blockfrost.io/api/v0",
  };
}
