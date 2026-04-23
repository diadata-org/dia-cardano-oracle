import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCliConfig } from "./config.js";
import {
  getDefaultBlueprintPath,
  listBlueprintValidators,
} from "./blueprint.js";

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ),
  );
}

function printUsage(): void {
  console.log(`Usage:
  npm run cli -- blueprint:list
  npm run cli -- preview:protocol
  npm run cli -- preview:wallet:create
  npm run cli -- preview:wallet
  npm run cli -- preview:wallet:utxos
  npm run cli -- preview:wallet:defaults
  npm run cli -- preview:config:bootstrap --input ./examples/preview/config-bootstrap.example.json [--build-only] [--out ./tmp/config-bootstrap.json]
  npm run cli -- preview:payment-hook:bootstrap --input ./examples/preview/payment-hook-bootstrap.example.json [--state ./state/preview/config-bootstrap.json] [--build-only] [--out ./tmp/config-bootstrap.json]
  npm run cli -- preview:pair:bootstrap --input ./examples/preview/pair-bootstrap.example.json [--state ./state/preview/config-bootstrap.json] [--build-only] [--out ./tmp/pair-bootstrap.json]
  npm run cli -- preview:update --input ./examples/preview/update.example.json --state ./state/preview/pairs/usdc-usd.json [--build-only] [--out ./state/preview/pairs/usdc-usd.json]`);
}

function requireInputPath(): string {
  const args = process.argv.slice(3);
  const inputFlagIndex = args.findIndex((arg) => arg === "--input");

  if (inputFlagIndex === -1 || !args[inputFlagIndex + 1]) {
    throw new Error("Missing required argument: --input <path>");
  }

  return args[inputFlagIndex + 1];
}

function hasBuildOnlyFlag(): boolean {
  return process.argv.slice(3).includes("--build-only");
}

function optionalFlagValue(flag: string): string | undefined {
  const args = process.argv.slice(3);
  const index = args.findIndex((arg) => arg === flag);

  if (index === -1) {
    return undefined;
  }

  if (!args[index + 1]) {
    throw new Error(`Missing required value for ${flag}.`);
  }

  return args[index + 1];
}

async function writeJsonOutput(outPath: string, value: unknown): Promise<void> {
  const resolvedPath = path.resolve(outPath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    JSON.stringify(
      value,
      (_key, currentValue) =>
        typeof currentValue === "bigint"
          ? currentValue.toString()
          : currentValue,
      2,
    ) + "\n",
    "utf8",
  );
  console.error(`[cli] Wrote JSON output to ${resolvedPath}`);
}

async function run(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "blueprint:list": {
      const validators = await listBlueprintValidators();

      printJson({
        blueprintPath: getDefaultBlueprintPath(),
        validatorCount: validators.length,
        validators: validators.map((validator) => ({
          title: validator.title,
          hasCompiledCode: Boolean(validator.compiledCode),
          hash: validator.hash ?? null,
        })),
      });
      return;
    }

    case "preview:protocol": {
      const { getProtocolParameters } = await import("./protocol.js");
      getCliConfig();
      const result = await getProtocolParameters();
      printJson(result);
      return;
    }

    case "preview:wallet": {
      const { walletSummary } = await import("./wallet.js");
      getCliConfig();
      const result = await walletSummary();
      printJson(result);
      return;
    }

    case "preview:wallet:utxos": {
      const { walletUtxos } = await import("./wallet.js");
      getCliConfig();
      const result = await walletUtxos();
      printJson(result);
      return;
    }

    case "preview:wallet:defaults": {
      const { walletDefaults } = await import("./wallet.js");
      getCliConfig();
      const result = await walletDefaults();
      printJson(result);
      return;
    }

    case "preview:wallet:create": {
      const { createWallet } = await import("./wallet-create.js");
      const result = createWallet();
      printJson(result);
      return;
    }

    case "preview:config:bootstrap": {
      const { configBootstrap } = await import(
        "./config-bootstrap.js"
      );
      getCliConfig();
      const result = await configBootstrap({
        inputPath: requireInputPath(),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:payment-hook:bootstrap": {
      const { paymentHookBootstrap } = await import(
        "./payment-hook-bootstrap.js"
      );
      getCliConfig();
      const result = await paymentHookBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:pair:bootstrap": {
      const { pairBootstrap } = await import(
        "./pair-bootstrap.js"
      );
      getCliConfig();
      const result = await pairBootstrap({
        inputPath: requireInputPath(),
        statePath: optionalFlagValue("--state"),
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case "preview:update": {
      const { submitOracleUpdate } = await import("./update.js");
      getCliConfig();
      const statePath = optionalFlagValue("--state");
      if (!statePath) {
        throw new Error("Missing required argument: --state <path>");
      }
      const result = await submitOracleUpdate({
        inputPath: requireInputPath(),
        statePath,
        buildOnly: hasBuildOnlyFlag(),
      });
      const outPath = optionalFlagValue("--out");
      if (outPath) {
        await writeJsonOutput(outPath, result);
      }
      printJson(result);
      return;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
