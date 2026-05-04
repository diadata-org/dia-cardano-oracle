# Off-chain helpers catalog and conventions

This document is the canonical reference for **what every helper in
`offchain/cli/src/` does, where it lives, and who owns it**, plus the
naming and layering conventions that the codebase is expected to
follow.

It exists to prevent the class of bug where the same helper gets
re-implemented in two files and the local copy silently drifts away
from the on-chain contract (we have hit this three times:
`buildReceiverDatumCbor` in `receiver-bootstrap.ts`, and
`buildConfigDatumCbor` in **two** different deploy files).

The catalog has four sections:

1. **Layering and naming conventions** — the rules new code is
   expected to follow.
2. **Canonical owners** — for every category of helper, the one file
   that owns the canonical implementation.
3. **Per-file inventory** — for every TypeScript file under
   `offchain/cli/src/`, every export and every file-local helper.
4. **De-duplication findings** — every duplicate / drifted helper that
   was found and the action taken.

This catalog reflects the codebase **after** the de-duplication pass.

---

## 1. Layering and naming conventions

### 1.1 Folder layout

```
offchain/cli/src/
  core/                Domain modules. Each file owns one concern.
    primitives.ts      Zero-dep pure utilities. Bottom of the graph.
    dia-intent.ts      DIA EIP-712 intent: types, sign, recover, hash, hex.
    state.ts           Artifact / on-chain state TypeScript models and JSON I/O.
    blueprint.ts       plutus.json reader.
    contracts.ts       Validator factories and script identity helpers.
    chain-helpers.ts   Cardano / Lucid runtime helpers used by tx code.
    lucid.ts           Lucid provider / wallet bootstrap.
    config.ts          CLI environment (network, provider URLs).
    protocol.ts        Protocol parameters wrapper.
    reference-scripts.ts   Loading on-chain reference UTxOs.
    intent-paths.ts    File path conventions for intent JSON files.
    artifact-context.ts    Multi-artifact loaders.
  wallet/              Wallet helpers and the wallet creation CLI flow.
  oracle/              EVM key creation + intent prompt/sign flows.
  init/                Draft / initial artifact builders (one per artifact).
  deploys/             Bootstrap / parameterize / publish steps (one per step).
  transactions/        CLI transactions (one per CLI verb).
  __tests__/           Off-chain unit tests.
  index.ts             CLI dispatcher.
```

### 1.2 Layering rules

The dependency graph is strictly bottom-up. A higher layer may import
from any lower layer; a lower layer must NOT import from a higher
layer.

```
primitives  →  dia-intent   →  chain-helpers  →  transactions / deploys
            →  state         ↗                  ↘  init
            →  blueprint     ↗
            →  contracts     ↗
            →  lucid, config, protocol, reference-scripts, intent-paths,
               artifact-context  (all peer modules under core/)
```

Concretely:

- `primitives.ts` imports from nothing inside the project.
- `dia-intent.ts`, `state.ts`, `blueprint.ts`, `contracts.ts`,
  `lucid.ts` may import from `primitives.ts` only (and from external
  packages).
- `chain-helpers.ts` may import from any other `core/` module.
- `transactions/`, `deploys/`, `init/`, `oracle/`, `wallet/` may
  import from any `core/` module.
- `transactions/`, `deploys/`, `init/` MUST NOT import from each
  other. If you find yourself wanting to do that, the helper belongs
  in `core/`.
- There are NO files named `_shared.ts`, `utils.ts`, `helpers.ts`, or
  similar generic dumping-grounds. Every shared helper lives in the
  `core/` module that owns its concern.

### 1.3 One canonical implementation per symbol

A given symbol name (function, type, constant) must have exactly one
top-level definition in the entire codebase. Re-exports
(`export { foo } from "./other.js"`) are allowed for ergonomics
(e.g. `chain-helpers.ts` re-exports `splitUnit` and `toBigInt` from
`primitives.ts` so that Cardano-side callers can grab them from a
single import) but are NOT a second implementation.

The only exceptions allowed are:

- `reportProgress` — a per-file logger that carries its own
  `[preview:…]` tag. Each tx / deploy file owns its own.
- `promptForText` — a per-file inquirer wrapper with file-specific
  validation. Each interactive init / oracle file owns its own.

These two are documented as deliberate file-locals; they have the same
*name* but are not duplicates of a single semantic helper.

### 1.4 Where does my new helper go?

Decision tree:

1. Is it a pure TS utility with no Cardano / Lucid / EVM dependency
   (string / hex / number)? → `core/primitives.ts`.
2. Is it about an EIP-712 intent (sign, recover, hash, file I/O,
   normalize)? → `core/dia-intent.ts`.
3. Is it a TypeScript model of an artifact / on-chain state, or its
   JSON I/O? → `core/state.ts`.
4. Is it a validator / minting policy factory or a script-identity
   helper? → `core/contracts.ts`.
5. Is it a Lucid / Cardano runtime helper that any tx builder or
   deploy step might want (datum encoder/decoder, UTxO selection,
   polling, address conversion, witness encoding)? →
   `core/chain-helpers.ts`.
6. Is it shared by two or more files in `transactions/`, `deploys/`,
   or `init/`? → it belongs in `core/`. Pick the right `core/` module
   from the steps above. Never create a file under
   `transactions/_shared.ts` or similar.
7. Is it private to a single tx / deploy / init file? → keep it
   file-local. Add a short comment stating *why* it is local (e.g.
   "private to this batch builder, not for reuse").

### 1.5 Datum encoders and decoders are sacred

Every `build*DatumCbor` / `decode*Datum` function mirrors a Plutus
type defined in `contracts/aiken/lib/dia_cardano_oracle/*.ak`. The
field order in the TypeScript encoder MUST match the field order in
the Aiken `pub type` declaration exactly. There is exactly one
encoder per on-chain datum and it lives in
`core/chain-helpers.ts`. Do NOT re-implement these locally — three
separate bugs were caused by exactly that.

If the on-chain type changes, update `core/chain-helpers.ts` and run
`npm run build && npm test`. A grep for `Constr<PlutusData>(0, [` in
any file other than `chain-helpers.ts` is a code smell.

---

## 2. Canonical owners

| Category | Canonical file | Notes |
| --- | --- | --- |
| Pure TS utilities (`toBigInt`, `splitUnit`, `normalizeHex`, `normalizeEthereumAddressHex`, `parseCommaSeparatedHexList`, `utf8ToHex`) | `core/primitives.ts` | Zero deps. Bottom of the graph. |
| DIA EIP-712 intent: types, sign, recover, hash, normalize, file I/O (`readSignedIntentInput`) | `core/dia-intent.ts` | Imports primitives. Re-exports `normalizeHex`, `normalizeEthereumAddressHex`, `parseCommaSeparatedHexList`, `utf8ToHex` for callers that already group hex helpers with intent helpers. |
| Datum encoders (`buildConfigDatumCbor`, `buildPaymentHookDatumCbor`, `buildReceiverDatumCbor`, `buildPairDatumCbor`) | `core/chain-helpers.ts` | Mirror the field order in `contracts/aiken/lib/dia_cardano_oracle/*.ak` exactly. |
| Datum decoders (`decodeReceiverDatum`, `decodePaymentHookDatum`) | `core/chain-helpers.ts` | |
| Address ↔ Plutus | `core/chain-helpers.ts` | `addressToPlutusData`. |
| Coordinator witness encoder | `core/chain-helpers.ts` | `updateWitnessData` is the only public surface; the inner `diaIntentData` is file-local because the wire shape is internal. |
| Wallet UTxO selection | `core/chain-helpers.ts` | `selectFundingUtxo`, `selectBootstrapUtxo`, `findUtxoByOutRef`, `findSingleUtxoAtUnit`. |
| Confirmation polling | `core/chain-helpers.ts` | `waitForUnitUtxoReplacement`, `waitForWalletSettlement`. |
| UTxO datum guard | `core/chain-helpers.ts` | `requireInlineDatum`. |
| Re-exports of pure utilities used by Cardano callers | `core/chain-helpers.ts` | `splitUnit`, `toBigInt` re-exported from primitives. |
| JSON write helper | `core/chain-helpers.ts` | `writeJsonFile`. |
| Validator factories (`makeXValidator`, `makeXMintingPolicy`) and script identities | `core/contracts.ts` | All `applyParamsToScript` calls. |
| Compiled-script wrappers (`spendingValidatorFromCompiledScript`, …) | `core/contracts.ts` | |
| Blueprint I/O | `core/blueprint.ts` | `plutus.json` reads and validator lookup. |
| State artifact types and JSON I/O | `core/state.ts` | All `*Artifact` / `*State` types, `readConfigState`, `readClientState`, `readPairState`, `readOptionalPairState`, `appendTransactionRecord`, `emptyProtocolCompiledScripts`, `emptyClientCompiledScripts`, `emptyReferenceScriptUtxo`. |
| Multi-artifact loaders | `core/artifact-context.ts` | `readClientContext`, `readPairContext`. |
| Intent file paths | `core/intent-paths.ts` | Filename conventions for intent JSON files. |
| Reference script loading | `core/reference-scripts.ts` | `loadReferenceScriptUtxos`. |
| Lucid bootstrap (provider, network, wallet selection) | `core/lucid.ts` | |
| Protocol params | `core/protocol.ts` | |
| CLI config (env, network) | `core/config.ts` | |
| Wallet defaults / summary | `wallet/wallet.ts` | `deriveConfiguredWalletDefaults`, `walletSummary`, `walletDefaults`, `walletUtxos`. |
| Wallet creation | `wallet/wallet-create.ts`, `oracle/ethereum-wallet-create.ts` | |
| Tx builders | `transactions/<verb>.ts` | One file per CLI tx; one exported `submit*` / `build*`. |
| Deploy / bootstrap orchestrators | `deploys/<step>.ts` | One file per bootstrap / parameterize / publish step. |
| Init / draft creators | `init/<artifact>.ts` | One file per draft. |
| CLI dispatch | `index.ts` | The only place that reads `process.argv` and routes. |

---

## 3. Per-file inventory (post-dedup)

Files that exactly match the standard pattern ("exports the obvious
public function plus one file-local `reportProgress`") are summarized
together at the end.

### `core/primitives.ts` (new)

**Exports:** `toBigInt`, `normalizeHex`, `normalizeEthereumAddressHex`,
`parseCommaSeparatedHexList`, `utf8ToHex`, `splitUnit`.

No imports from any other module under `offchain/cli/src/`. Everything
in here is pure and zero-dep by design.

### `core/dia-intent.ts`

**Imports from primitives:** `normalizeEthereumAddressHex`,
`normalizeHex`, `parseCommaSeparatedHexList`, `toBigInt`, `utf8ToHex`.

**Re-exports from primitives:** `normalizeEthereumAddressHex`,
`normalizeHex`, `parseCommaSeparatedHexList`, `utf8ToHex`. (Re-exports
are documented in the file header as ergonomic, not duplications.)

**Original exports:** all EIP-712 / intent types, `normalize*`
intent / domain functions, `build*Hash*`, `recoverDiaOracleIntentWitness`,
`signDiaOracleIntentInput`, `diaOracleIntent{ToData,ToCbor}`,
`diaOracleRedeemerToCbor`, `diaOracleDatumToCbor`, `diaPairIdHex`,
`diaIntentTokenNameFromSymbol`, `pairAssetNameFromPairIdHex`,
`diaIntentToState`, `deriveCompressedPublicKeyFromPrivateKey`,
`readSignedIntentInput`.

**File-local:** `abiCoder`, `DOMAIN_TYPE`, `ORACLE_INTENT_TYPE`,
`normalizeSignatureHex`, `normalizePrivateKey`, `strip0x`,
`blake2bHex`, `with0x`, `ZERO_32`. All pure-EIP-712 / pure-EVM helpers
that have no callers outside this file.

### `core/state.ts`

**Exports:** all artifact and on-chain state TypeScript models,
`readConfigState`, `readClientState`, `readPairState`,
`readOptionalPairState`, `getDefaultConfigStatePath`,
`emptyProtocolCompiledScripts`, `emptyClientCompiledScripts`,
`emptyReferenceScriptUtxo`, `appendTransactionRecord`.

**File-local:** `CURRENT_DIR`, `DEFAULT_PREVIEW_CONFIG_STATE_PATH`.

### `core/contracts.ts`

**Exports:**
`make{ConfigState,PairState,PaymentHook,Receiver}{MintingPolicy,Validator}`,
`makeCoordinatorValidator`, `makeReferenceHolderValidator`,
`scriptHashFromValidator`, `scriptAddressFromValidator`,
`policyIdFromMintingPolicy`, `mintingPolicyFromCompiledScript`,
`spendingValidatorFromCompiledScript`,
`withdrawalValidatorFromCompiledScript`, `scriptRewardAddress`,
`scriptCredentialState`, `scriptCredentialData`, `outRefToData`.

**File-local:** blueprint title constants only.

### `core/chain-helpers.ts`

**Imports from primitives:** `normalizeHex`, `splitUnit`, `toBigInt`.

**Re-exports from primitives:** `splitUnit`, `toBigInt`. (Re-exports
are documented in the file header as ergonomic.)

**Original exports:** `BOOTSTRAP_REF_MIN_LOVELACE`, `findSingleUtxoAtUnit`,
`requireInlineDatum`, `waitForUnitUtxoReplacement`, `findUtxoByOutRef`,
`OutRefLike`, `selectFundingUtxo`, `selectBootstrapUtxo`,
`waitForWalletSettlement`, `addressToPlutusData`, `buildConfigDatumCbor`,
`buildPaymentHookDatumCbor`, `buildReceiverDatumCbor`,
`buildPairDatumCbor`, `decodeReceiverDatum`, `decodePaymentHookDatum`,
`updateWitnessData`, `writeJsonFile`.

**File-local:** `WalletUtxoReader`, `selectablePureLovelaceUtxos`,
`diaIntentData`, `outRefKey`, `utxoSnapshot`, `sameSnapshot`.

`diaIntentData` is **deliberately file-local** — the inner Plutus
encoding of an intent inside the coordinator witness; callers must
always go through `updateWitnessData`.

### `transactions/update.ts`

**Exports:** `submitOracleUpdate`.

**File-local:** `reportProgress`.

After dedup: imports `requireInlineDatum`, `findSingleUtxoAtUnit`,
`splitUnit`, `selectFundingUtxo`, `buildPairDatumCbor`,
`buildReceiverDatumCbor`, `updateWitnessData` from
`core/chain-helpers.ts`; `readSignedIntentInput` from
`core/dia-intent.ts`; `readOptionalPairState` from `core/state.ts`.

### `transactions/update-batch.ts`

**Exports:** `submitBatchOracleUpdate`, `resolvePairArtifact`,
`ensureCompatibleBatch`.

**File-local:** internal batch types, `readBatchUpdateInput`,
`createPairArtifactFromIntent`, `reportProgress`.

`createPairArtifactFromIntent` is intentionally local — batch-only
pair skeleton used when a pair file does not yet exist.

### `transactions/settle.ts`

**Exports:** `settleAccruedFees`.

**File-local:** `SettleResult` return type, `reportProgress`.

### `transactions/{config-update,payment-hook-withdraw,receiver-top-up,receiver-withdraw}.ts`

Each exports its `submit*` / `build*` function plus a file-local
`reportProgress`. No other file-local helpers.

### `deploys/config-bootstrap.ts`, `deploys/payment-hook-bootstrap.ts`, `deploys/receiver-bootstrap.ts`

**Exports:** the corresponding `*Bootstrap` function.

**File-local:** `Resolved*Input` (where applicable), `resolve*Input`,
`reportProgress`.

After dedup: every datum encoder, every UTxO selector, and every
polling helper is imported from `core/chain-helpers.ts`. The previous
local `buildConfigDatumCbor` (in two of these files) and
`buildReceiverDatumCbor` (in receiver-bootstrap) all dropped fields
that the on-chain type expects — that is exactly the bug class the
catalog was created to prevent.

### `deploys/{config,payment-hook,receiver}-parameterize.ts`

Each exports its `parameterize*` function plus file-local
`resolveXParameterizeInput` and `reportProgress`. No other helpers.

### `deploys/{config,payment-hook,client}-reference-scripts.ts`

Each exports its `publish*` function plus file-local `reportProgress`.
`client-reference-scripts.ts` also has `resolveReceiverArtifact`.

### `init/protocol-init.ts`

**Exports:** `createProtocolStateArtifact`, `initializeProtocolState`.

**File-local:** `DEFAULT_*` constants, `ProtocolInitConfigInput`,
`defaultProtocolConfigInput`, `promptForText`,
`promptForProtocolConfigInput`.

After dedup: uses `emptyReferenceScriptUtxo` from `core/state.ts` and
`parseCommaSeparatedHexList` from `core/dia-intent.ts` (re-exported
from `core/primitives.ts`).

### `init/client-init.ts`

**Exports:** `createClientStateArtifact`, `initializeClientState`.

**File-local:** `DEFAULT_MIN_UTXO_LOVELACE`, naming helpers,
`promptForText`, `promptForReceiverDefaults`. Uses
`emptyReferenceScriptUtxo` from `core/state.ts`.

### `init/config-update-create.ts`

**Exports:** `ConfigUpdateDraft`, `createConfigUpdateDraft`.

**File-local:** `promptForText`. Uses `parseCommaSeparatedHexList`
from `core/dia-intent.ts`.

### `init/batch-update-create.ts`

**Exports:** `BatchUpdateManifest`, `createBatchUpdateManifest`.

**File-local:** `promptForText`, `listJsonFiles`,
`defaultIntentPathForPair`. Scoped to interactive prompts.

### `oracle/intent-create.ts`

**Exports:** `createPreviewOracleIntent`,
`signPreviewOracleIntentInteractive`, `createAndSignPreviewOracleIntent`,
`defaultUnsignedIntentOutputPath`, `defaultSignedIntentOutputPath`.

**File-local:** prompt-and-default helpers (`PromptDefaults`,
`DEFAULT_DOMAIN`, `toUnixSeconds`, `with0x`, `resolvePromptDefaults`,
`promptValue`, `validateIntegerString`, `promptExistingFilePath`).

### `oracle/intent-sign.ts`

**Exports:** `IntentSignInput`, `signPreviewOracleIntentFromInput`,
`signPreviewOracleIntent`.

**File-local:** `requireIntentSigningPrivateKey`, `readIntentSignInput`.

### `oracle/ethereum-wallet-create.ts`

**Exports:** `createEthereumWallet`. No file-local helpers.

### `wallet/wallet.ts`

**Exports:** `ConfiguredWalletDefaults`, `walletSummary`,
`walletDefaults`, `walletUtxos`, `deriveConfiguredWalletDefaults`. No
file-local helpers.

### `wallet/wallet-create.ts`

**Exports:** `createWallet`. No file-local helpers.

### `index.ts`

CLI entry. File-local: `printJson`, `printUsage`, `requireInputPath`,
`requireFlagValue`, `optionalFlagValue`, `hasBuildOnlyFlag`, `hasFlag`,
`promptForText`, `resolveTextFlag`, `writeJsonOutput`, `run`. All
scoped to argv parsing and dispatch.

### `__tests__/run-tests.ts`

Side-effect test runner. File-local test functions and fixture
builders.

---

## 4. De-duplication findings (executed)

Every duplicate that was found and the action taken. All actions kept
`npm run build && npx tsc --noEmit && npm test` green.

| Symbol | Was in | Action |
| --- | --- | --- |
| `buildReceiverDatumCbor` | `core/chain-helpers.ts` (canonical) + local copy in `deploys/receiver-bootstrap.ts` (encoded **only 2 of 3 fields** → on-chain bug) | Deleted local; import canonical. |
| `buildConfigDatumCbor` | `core/chain-helpers.ts` (canonical) + local copy in `deploys/config-bootstrap.ts` (**wrong field order** → on-chain bug) + local copy in `deploys/payment-hook-bootstrap.ts` (**missing `max_bootstrap_drift_seconds`** → on-chain bug) | Deleted both local; both deploys now use the canonical encoder. |
| `buildPaymentHookDatumCbor` | `core/chain-helpers.ts` (canonical) + local in `deploys/payment-hook-bootstrap.ts` | Deleted local. |
| `buildPairDatumCbor` | `core/chain-helpers.ts` (canonical) + local in `transactions/update.ts` | Deleted local. |
| `addressToPlutusData` | `core/chain-helpers.ts` (canonical) + locals in `transactions/update.ts`, `deploys/payment-hook-bootstrap.ts` | Deleted both local. |
| `updateWitnessData` + `diaIntentData` | `core/chain-helpers.ts` (canonical) + local in `transactions/update.ts` | Deleted local. |
| `findSingleUtxoAtUnit` | `core/chain-helpers.ts` (canonical) + locals in `transactions/update.ts`, `deploys/receiver-bootstrap.ts`, `deploys/payment-hook-bootstrap.ts` | Deleted three local. |
| `selectFundingUtxo` | `core/chain-helpers.ts` (canonical, throws when none) + local **drifted** copy in `transactions/update.ts` (returned null, ignored min lovelace) | Deleted local; call site now passes `5_000_000n` minimum and `"oracle update"` label. |
| `selectBootstrapUtxo` | `core/chain-helpers.ts` (canonical, `(utxos, minLovelace?, excluded?)`) + three drifted copies in `deploys/{config,receiver,payment-hook}-bootstrap.ts` | Deleted three local. |
| `waitForUtxoAtUnit` | local in `deploys/config-bootstrap.ts` (returned `{txHash,outputIndex}` only) | Deleted; replaced by canonical `findSingleUtxoAtUnit`, projecting the out-ref at the call site. |
| `splitUnit`, `toBigInt` | originally defined in both `core/chain-helpers.ts` and `core/dia-intent.ts`, with local copies in deploy / tx files | **Moved** to `core/primitives.ts` as the single canonical source. `chain-helpers.ts` and `dia-intent.ts` re-export them. All file-local copies deleted. |
| `normalizeHex`, `normalizeEthereumAddressHex`, `parseCommaSeparatedHexList`, `utf8ToHex` | originally defined in `core/dia-intent.ts` | **Moved** to `core/primitives.ts`. `dia-intent.ts` re-exports them so existing import sites do not need to change. |
| `requireInlineDatum` | local in `transactions/{update,update-batch,settle}.ts` (slight type drift) | **Moved** to `core/chain-helpers.ts` (it is a generic Lucid UTxO helper). All three import from there. |
| `readSignedIntentInput` | identical local in `transactions/{update,update-batch}.ts` | **Moved** to `core/dia-intent.ts` (it reads a signed intent JSON file → it belongs with the intent module). Both txs import from there. |
| `readOptionalPairState` | identical local in `transactions/{update,update-batch}.ts` | **Moved** to `core/state.ts` (next to `readPairState`). |
| `emptyReferenceScriptUtxo` | identical in `init/{protocol-init,client-init}.ts` | **Moved** to `core/state.ts` as exported helper. |
| `parseCommaSeparatedHexList` | identical in `init/{protocol-init,config-update-create}.ts` | **Moved** to `core/primitives.ts` (re-exported by `core/dia-intent.ts`). |
| `transactions/_shared.ts` | container for the three helpers above | **Deleted**. The "_shared" filename pattern is banned by the conventions in section 1.2. |
| `reportProgress` | one file-local copy per tx / deploy file, each with a different `[preview:…]` log tag | **Kept** as deliberately file-local. They differ only in the log prefix; centralizing would either lose the prefix-per-file or force a factory call at the top of every file with no real benefit. |
| `promptForText` | one per init / oracle file, each with slightly different inquirer config | **Kept** as deliberately file-local. They have different validation rules per prompt. |

### Result

After this pass, every helper has **exactly one canonical
implementation** in the codebase. The two same-named symbols that
remain across files (`reportProgress`, `promptForText`) are
intentional file-locals documented in section 1.3 as the only
allowed exceptions.

`transactions/_shared.ts` no longer exists; the conventions in
section 1.2 forbid bringing it back.

### Acceptance check

- `npx tsc --noEmit` → passes.
- `npm run build` → passes.
- `npm test` → 7 CLI tests pass.
- Search for any of the canonical helper names as a `function`
  declaration in any file other than the canonical owner returns no
  results.
