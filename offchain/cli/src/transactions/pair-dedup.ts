/**
 * `pair:dedup` — scan the pair validator address for duplicate Pair NFT UTxOs
 * and burn the stale ones, keeping the most recent (highest datum nonce).
 *
 * Duplicate pair UTxOs can appear when the feeder submits a valid oracle-update
 * tx but its `waitForUnitUtxoReplacement` times out or the process is killed
 * before the local pair-state file is updated. On the next startup, if
 * `isCreate` is incorrectly evaluated (e.g. indexer lag hid the existing pair),
 * a second Pair NFT gets minted for the same symbol.
 *
 * This command:
 *   1. Scans every UTxO at the pair validator address.
 *   2. Groups UTxOs by their pair unit (`pairPolicyId + assetName`).
 *   3. For each group with > 1 UTxO: sorts by datum nonce descending,
 *      keeps the highest-nonce one, burns the rest.
 *
 * Admin-gated: requires the configured wallet to be a `config_admins` signer.
 */

import {
  mintingPolicyFromCompiledScript,
  spendingValidatorFromCompiledScript,
} from "../core/contracts.js";
import {
  makeConfiguredLucid,
  selectConfiguredWallet,
} from "../core/lucid.js";
import {
  readClientState,
  readConfigState,
} from "../core/state.js";
import {
  findSingleUtxoAtUnit,
  decodePairDatum,
} from "../core/chain-helpers.js";
import { deriveConfiguredWalletDefaults } from "../wallet/wallet.js";
import {
  assertPaymentKeyHashIsConfigSigner,
  assertConfigUtxoLivesAtValidatorAddress,
} from "../preflight/index.js";
import { burnSpecificPairUtxo } from "./pair-burn.js";
import { getCliConfig } from "../core/config.js";

import type { UTxO } from "@lucid-evolution/lucid";

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export type PairDedupResult = {
  /** Total pair UTxOs found at the validator address. */
  scanned: number;
  /** Number of distinct pair units with > 1 UTxO. */
  duplicateUnits: number;
  /** Number of UTxOs burned to restore the singleton invariant. */
  burned: number;
  /** Burned outRefs, keyed by pair unit. */
  details: Record<string, { kept: string; burned: string[] }>;
};

/**
 * Scan the pair validator address for duplicate Pair NFT UTxOs and burn
 * the stale ones (all but the highest-nonce copy per unit).
 *
 * Idempotent: if called when there are no duplicates, it exits cleanly after
 * reporting `"No duplicate pair UTxOs found"`.
 */
export async function pairDedup(args: {
  protocolStatePath: string;
  clientStatePath: string;
  /** When true, build the burn txs but do not submit or wait for confirmation. */
  buildOnly: boolean;
}): Promise<PairDedupResult> {
  reportProgress("Loading protocol and client state");
  const protocol = await readConfigState(args.protocolStatePath);
  const client = await readClientState(args.clientStatePath);

  if (!client.compiledScripts?.pairValidator) {
    throw new Error("pairValidator compiled script not found in client state. Run client:init first.");
  }
  if (!client.compiledScripts?.pairMintPolicy) {
    throw new Error("pairMintPolicy compiled script not found in client state. Run client:init first.");
  }

  const pairValidator = spendingValidatorFromCompiledScript(client.compiledScripts.pairValidator);
  const pairMintPolicy = mintingPolicyFromCompiledScript(client.compiledScripts.pairMintPolicy);
  const pairPolicyId = client.scripts.pairPolicyId;
  const pairValidatorAddress = client.scripts.pairValidatorAddress;

  reportProgress(`Connecting to ${getCliConfig().cardanoNetwork} and selecting the configured wallet`);
  const lucid = await makeConfiguredLucid();
  const source = await selectConfiguredWallet(lucid);
  const wallet = lucid.wallet();
  const [walletAddress, walletUtxos] = await Promise.all([
    wallet.address(),
    wallet.getUtxos(),
  ]);
  const walletDefaults = deriveConfiguredWalletDefaults({ source, address: walletAddress });

  assertPaymentKeyHashIsConfigSigner(
    walletDefaults.paymentKeyHash,
    protocol.configState.validConfigSigners,
    {
      unauthorizedMessage:
        "pair:dedup requires the configured wallet to be a config admin (config_admins).",
    },
  );

  reportProgress("Finding Config UTxO");
  const configUtxo = await findSingleUtxoAtUnit(
    lucid,
    protocol.scripts.configValidatorAddress,
    protocol.scripts.configUnit,
    "config",
  );
  assertConfigUtxoLivesAtValidatorAddress(
    configUtxo.address,
    protocol.scripts.configValidatorAddress,
  );

  // -------------------------------------------------------------------------
  // Scan: all UTxOs at the pair validator address
  // -------------------------------------------------------------------------
  reportProgress(`Scanning pair validator address ${pairValidatorAddress} …`);
  const allUtxos: UTxO[] = await lucid.utxosAt(pairValidatorAddress);
  reportProgress(`Found ${allUtxos.length} UTxO(s) at the pair validator address.`);

  // Keep only UTxOs that carry a pair NFT (unit starts with pairPolicyId).
  const pairUtxos = allUtxos.filter((utxo) =>
    Object.keys(utxo.assets).some((unit) => unit.startsWith(pairPolicyId)),
  );

  // Group by pair unit.
  const byUnit = new Map<string, UTxO[]>();
  for (const utxo of pairUtxos) {
    const unit = Object.keys(utxo.assets).find((u) => u.startsWith(pairPolicyId))!;
    const group = byUnit.get(unit) ?? [];
    group.push(utxo);
    byUnit.set(unit, group);
  }

  // -------------------------------------------------------------------------
  // Identify duplicates
  // -------------------------------------------------------------------------
  const duplicates = [...byUnit.entries()].filter(([, group]) => group.length > 1);

  if (duplicates.length === 0) {
    reportProgress("No duplicate pair UTxOs found. Chain state is clean.");
    return {
      scanned: pairUtxos.length,
      duplicateUnits: 0,
      burned: 0,
      details: {},
    };
  }

  reportProgress(
    `Found ${duplicates.length} unit(s) with duplicate UTxOs — will burn the stale ones.`,
  );

  // -------------------------------------------------------------------------
  // Burn: for each duplicate group keep the highest-nonce UTxO
  // -------------------------------------------------------------------------
  const result: PairDedupResult = {
    scanned: pairUtxos.length,
    duplicateUnits: duplicates.length,
    burned: 0,
    details: {},
  };

  for (const [unit, group] of duplicates) {
    // Decode nonce from each UTxO's inline datum. UTxOs without a parseable
    // datum are treated as nonce 0 (burn them first, they are certainly stale).
    const withNonce = group.map((utxo) => {
      let nonce = 0n;
      try {
        if (utxo.datum) nonce = BigInt(decodePairDatum(utxo.datum).nonce);
      } catch {
        // stale/unreadable datum — nonce stays 0
      }
      return { utxo, nonce };
    });

    // Sort descending: highest nonce first = most recent = keep.
    withNonce.sort((a, b) => (b.nonce > a.nonce ? 1 : b.nonce < a.nonce ? -1 : 0));

    const [keep, ...toBurn] = withNonce;

    reportProgress(`Unit: ${unit}`);
    reportProgress(
      `  Keeping:  ${keep.utxo.txHash}#${keep.utxo.outputIndex} (nonce=${keep.nonce})`,
    );
    for (const { utxo, nonce } of toBurn) {
      reportProgress(
        `  Burning:  ${utxo.txHash}#${utxo.outputIndex} (nonce=${nonce})`,
      );
    }

    const burnedRefs: string[] = [];

    for (const { utxo } of toBurn) {
      const outRef = `${utxo.txHash}#${utxo.outputIndex}`;
      const txHash = await burnSpecificPairUtxo({
        lucid,
        wallet,
        walletUtxos,
        paymentKeyHash: walletDefaults.paymentKeyHash,
        configUtxo,
        pairUtxo: utxo,
        pairUnit: unit,
        pairValidator,
        pairMintPolicy,
        client,
        buildOnly: args.buildOnly,
        label: `pair:dedup [${unit.slice(0, 12)}…]`,
      });

      burnedRefs.push(outRef);
      result.burned += 1;

      if (txHash) {
        reportProgress(`  Burned ${outRef} → tx ${txHash}`);
      }
    }

    result.details[unit] = {
      kept: `${keep.utxo.txHash}#${keep.utxo.outputIndex}`,
      burned: burnedRefs,
    };
  }

  reportProgress(
    `Done. Burned ${result.burned} duplicate UTxO(s) across ${result.duplicateUnits} pair unit(s).`,
  );
  return result;
}

function reportProgress(message: string): void {
  console.error(`[pair:dedup] ${message}`);
}
