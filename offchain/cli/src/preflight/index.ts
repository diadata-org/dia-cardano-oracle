/**
 * Transaction preflight: pure checks before Lucid builds or signs a transaction.
 *
 * These are **runtime validation** used by the CLI, not test-only helpers. Tests
 * import the same functions so rules are defined once and exercised under `npm test`.
 *
 * Layout (by responsibility):
 * - `config-state.ts` — config datum rules, config signer wallet, config UTxO binding
 * - `init-artifacts.ts` — protocol / client JSON artifact shape before bootstrap
 * - `bootstrap-pay.ts` — bootstrap outputs must not target the funding wallet
 * - `oracle-update.ts` — oracle update / batch bootstrap + monotonicity
 * - `receiver-transactions.ts` — receiver top-up / withdraw amounts
 * - `payment-hook.ts` — payment-hook withdraw amounts
 * - `settle-manifest.ts` — coordinator settle manifest list shape
 * - `settle.ts` — settle flow (accrued > 0, single-client manifest match)
 */
export * from "./bootstrap-pay.js";
export * from "./config-state.js";
export * from "./init-artifacts.js";
export * from "./oracle-update.js";
export * from "./payment-hook.js";
export * from "./receiver-transactions.js";
export * from "./settle-manifest.js";
export * from "./settle.js";
