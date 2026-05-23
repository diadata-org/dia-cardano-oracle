// Cardano write client — builds, signs, submits, and confirms one
// oracle-update tx per `SubmitRequest`.
//
// This module is the Cardano-side analogue of Spectra's EVM tx sender.
// It is a thin orchestrator: the heavy lifting (UTxO selection, datum
// encoding, script attachment) is done by `buildOracleUpdateTx` from
// `lib-bridge`, which re-uses the same builder the CLI uses.
//
// Design choices:
//
//   - The client is stateless: it reads the Cardano chain every time
//     it needs a UTxO instead of maintaining local state. This makes
//     the client robust to feeder restarts without a persistence layer.
//     Phase 3.5 adds an optional DB-backed UTxO cache for performance.
//
//   - All Lucid / Cardano types are hidden behind the interfaces
//     declared in `types.ts`. The feeder process that imports this
//     module only sees those interfaces; the actual
//     `@lucid-evolution/lucid` types live in the `lib-bridge` layer.
//
//   - `createCardanoWriteClient` takes a `CardanoWriteClientDeps`
//     bundle so tests can inject a fake Lucid + fake builder without
//     pulling in Lucid itself.

import type { CardanoWriteClient, SubmitRequest, SubmitResult } from "./types.js";
import type { OracleIntentBridge } from "../lib-bridge/index.js";

// ---------------------------------------------------------------------------
// Dependency-injection bundle.
// ---------------------------------------------------------------------------

/**
 * Everything the write client needs that it cannot construct itself.
 *
 * - `bridge`    — wired by the feeder entry-point from `lib-bridge`;
 *                  in tests, a fake that returns canned results.
 * - `log`       — simple line emitter so the client stays decoupled
 *                  from any particular logger.
 */
export type CardanoWriteClientDeps = {
  bridge: OracleIntentBridge;
  log?: (line: string) => void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a write client for the given destination files. The same
 * `CardanoWriteClientDeps` can be shared across multiple clients since
 * the bridge is stateless.
 *
 * @param clientStatePath    — absolute or relative path to the
 *   `client-state.json` produced by the CLI's `receiver:bootstrap`.
 * @param protocolStatePath  — absolute path to the
 *   `config-bootstrap.json` produced by `config:bootstrap`.
 * @param deps               — injected Lucid + builder bundle.
 */
export function createCardanoWriteClient(
  clientStatePath: string,
  protocolStatePath: string,
  deps: CardanoWriteClientDeps,
): CardanoWriteClient {
  const { bridge, log = () => {} } = deps;
  const label = `${clientStatePath.split("/").slice(-2).join("/")}`;

  return {
    label,

    async submit(request: SubmitRequest): Promise<SubmitResult> {
      const { intentHash, enriched } = request;
      log(`[${label}] submit: intentHash=${intentHash} symbol=${enriched.fullIntent.symbol}`);

      try {
        const txHash = await bridge.submitOracleUpdate({
          clientStatePath,
          protocolStatePath,
          enriched,
          intentHash,
        });

        log(`[${label}] confirmed: txHash=${txHash} intentHash=${intentHash}`);
        return { ok: true, cardanoTxHash: txHash, intentHash };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log(`[${label}] submit failed: intentHash=${intentHash} error=${error.message}`);
        return { ok: false, intentHash, error };
      }
    },
  };
}
