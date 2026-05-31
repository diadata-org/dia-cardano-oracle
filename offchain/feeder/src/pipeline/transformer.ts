// Transformer — applies a sequence of data-transformation operations to a
// pipeline context object (a plain `Record<string, unknown>`).
//
// Operations mirror those in Spectra's `internal/pipeline/transformer.go`:
//   slice, concat, hash, encode, to_bigint, to_address, to_hex, to_string
//
// Each operation reads from named fields in the context and writes its
// result back into the context under `op.field`. Operations are applied
// in declaration order; later operations may read fields written by
// earlier ones.
//
// viem is used for the crypto/ABI operations because it is already a
// direct dependency of this package.

import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  toHex,
} from "viem";

import type { ExtractedEvent } from "../source/types.js";
import type { OracleIntent } from "../source/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TransformationOp = {
  operation:
    | "slice"
    | "concat"
    | "hash"
    | "encode"
    | "to_bigint"
    | "to_address"
    | "to_hex"
    | "to_string";
  /** Name of the output field written into the context. */
  field: string;
  /** Name(s) of the input field(s) read from the context. */
  input: string | string[];
  // op-specific params
  /** For `slice`: start index (inclusive, default 0). */
  start?: number;
  /** For `slice`: end index (exclusive, default string length). */
  end?: number;
  /** For `concat`: separator placed between input values (default ""). */
  separator?: string;
  /** For `encode`: ABI type strings (e.g. ["uint256", "address"]). */
  types?: string[];
};

/** A transformer takes a context map and returns an updated copy. */
export type Transformer = (context: Record<string, unknown>) => Record<string, unknown>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a transformer that applies `ops` in order. Each operation reads
 * named fields from the running context and writes its result back to
 * `op.field`. The input context is not mutated; a shallow copy is made
 * before the first operation is applied.
 *
 * Throws immediately when `ops` is empty or when an op references an
 * input field that is absent from the context at execution time.
 */
export function createTransformer(ops: TransformationOp[]): Transformer {
  if (ops.length === 0) {
    return identityTransformer;
  }

  return (context: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...context };
    for (const op of ops) {
      result[op.field] = applyOp(op, result);
    }
    return result;
  };
}

/** Identity transformer — returned by `createTransformer([])`. */
/** Identity transformer — passes the input through unchanged.
 * Typed as a generic function so callers that pass a typed subtype
 * (e.g. `EnrichedIntent`) receive the same type back. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const identityTransformer: <T extends Record<string, unknown>>(context: T) => T =
  (context) => context;

// ---------------------------------------------------------------------------
// Operation implementations
// ---------------------------------------------------------------------------

function applyOp(op: TransformationOp, ctx: Record<string, unknown>): unknown {
  switch (op.operation) {
    case "slice":
      return applySlice(op, ctx);
    case "concat":
      return applyConcat(op, ctx);
    case "hash":
      return applyHash(op, ctx);
    case "encode":
      return applyEncode(op, ctx);
    case "to_bigint":
      return applyToBigint(op, ctx);
    case "to_address":
      return applyToAddress(op, ctx);
    case "to_hex":
      return applyToHex(op, ctx);
    case "to_string":
      return applyToString(op, ctx);
    default: {
      // Exhaustiveness check.
      const _never: never = op.operation;
      throw new Error(`Unknown transformation operation: ${String(_never)}`);
    }
  }
}

function readField(ctx: Record<string, unknown>, name: string): unknown {
  if (!(name in ctx)) {
    throw new Error(`Transformation input field "${name}" not found in context.`);
  }
  return ctx[name];
}

function readSingleInput(op: TransformationOp, ctx: Record<string, unknown>): unknown {
  const inputName = Array.isArray(op.input) ? op.input[0] : op.input;
  if (!inputName) {
    throw new Error(`Operation "${op.operation}" on field "${op.field}" has no input.`);
  }
  return readField(ctx, inputName);
}

// `slice`: slice a string field at [start:end].
function applySlice(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): string {
  const value = String(readSingleInput(op, ctx));
  const start = op.start ?? 0;
  const end = op.end ?? value.length;
  return value.slice(start, end);
}

// `concat`: join one or more input fields with a separator.
function applyConcat(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): string {
  const inputs = Array.isArray(op.input) ? op.input : [op.input];
  const separator = op.separator ?? "";
  return inputs.map((name) => String(readField(ctx, name))).join(separator);
}

// `hash`: keccak256 of the UTF-8 encoding of the input string field.
function applyHash(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): `0x${string}` {
  const value = String(readSingleInput(op, ctx));
  return keccak256(toHex(value));
}

// `encode`: ABI-encode the input field(s) according to `op.types`.
function applyEncode(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): `0x${string}` {
  if (!op.types || op.types.length === 0) {
    throw new Error(`Operation "encode" on field "${op.field}" requires a non-empty \`types\` array.`);
  }
  const inputs = Array.isArray(op.input) ? op.input : [op.input];
  if (inputs.length !== op.types.length) {
    throw new Error(
      `Operation "encode" on field "${op.field}": \`types\` length (${op.types.length}) ` +
      `must equal \`input\` length (${inputs.length}).`,
    );
  }
  const abiParams = parseAbiParameters(op.types.join(", "));
  const values = inputs.map((name) => readField(ctx, name));
  return encodeAbiParameters(abiParams, values);
}

// `to_bigint`: convert a string or number to a decimal-string bigint.
function applyToBigint(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): string {
  const value = readSingleInput(op, ctx);
  try {
    return BigInt(value as string | number | bigint).toString();
  } catch {
    throw new Error(
      `Operation "to_bigint" on field "${op.field}": cannot convert ${JSON.stringify(value)} to bigint.`,
    );
  }
}

// `to_address`: convert a bytes32 hex string to a checksummed EVM address.
function applyToAddress(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): string {
  const value = String(readSingleInput(op, ctx));
  // Take the last 20 bytes (40 hex chars) from a bytes32 value.
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  const addressHex = hex.slice(-40);
  return getAddress(`0x${addressHex}`);
}

// `to_hex`: convert a value to a 0x-prefixed hex string.
function applyToHex(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): `0x${string}` {
  const value = readSingleInput(op, ctx);
  if (typeof value === "string" && value.startsWith("0x")) {
    return value as `0x${string}`;
  }
  return toHex(value as string | number | bigint | boolean | Uint8Array);
}

// `to_string`: convert a value to its string representation.
function applyToString(
  op: TransformationOp,
  ctx: Record<string, unknown>,
): string {
  return String(readSingleInput(op, ctx));
}

// ---------------------------------------------------------------------------
// Context builders
// ---------------------------------------------------------------------------

/**
 * Build a transform context from pipeline data.
 *
 * Three datasource layers, applied cumulatively:
 *   - `event`:       raw `ExtractedEvent` fields (origin coordinates + hashed fields)
 *   - `enrichment`:  full `OracleIntent` fields merged on top
 *   - `processed`:   union of both (same as `enrichment`; used as the
 *                    starting point for transformation output)
 *
 * All `bigint` values are preserved as-is so transformation ops like
 * `to_bigint` and `to_hex` can operate on them directly.
 */
export function buildTransformContext(
  event: ExtractedEvent,
  intent: OracleIntent | null,
  datasource: "event" | "enrichment" | "processed",
): Record<string, unknown> {
  const eventCtx: Record<string, unknown> = {
    intentHash: event.intentHash,
    symbolHash: event.symbolHash,
    price: event.price,
    timestamp: event.timestamp,
    signer: event.signer,
    blockNumber: event.blockNumber,
    txHash: event.txHash,
    logIndex: event.logIndex,
    blockTimestamp: event.blockTimestamp,
  };

  if (datasource === "event") {
    return eventCtx;
  }

  const enrichmentCtx: Record<string, unknown> = intent
    ? {
        intentType: intent.intentType,
        version: intent.version,
        chainId: intent.chainId,
        nonce: intent.nonce,
        expiry: intent.expiry,
        symbol: intent.symbol,
        price: intent.price,
        timestamp: intent.timestamp,
        source: intent.source,
        signature: intent.signature,
        signer: intent.signer,
      }
    : {};

  // `enrichment` and `processed` both produce the merged context;
  // `processed` signals that subsequent ops will write their output
  // back into this same map.
  return { ...eventCtx, ...enrichmentCtx };
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a simple condition string against a context map.
 *
 * Supported forms:
 *   - empty / undefined → always true
 *   - `"field == value"` — equality check
 *   - `"field != value"` — inequality check
 *   - Template tokens `${fieldName}` in either operand are resolved from
 *     the context before comparison.
 *
 * Returns `true` if the condition passes.
 */
export function evaluateCondition(
  condition: string | undefined,
  context: Record<string, unknown>,
): boolean {
  if (!condition || condition.trim() === "") return true;

  function resolveTemplates(s: string): string {
    return s.replace(/\$\{([^}]+)\}/g, (_, fieldName: string) => {
      const val = context[fieldName.trim()];
      return val !== undefined ? String(val) : "";
    });
  }

  const eqMatch = condition.match(/^(.+?)\s*(==|!=)\s*(.+)$/);
  if (eqMatch) {
    const lhsRaw = eqMatch[1]!.trim();
    const op = eqMatch[2]!;
    const rhsRaw = eqMatch[3]!.trim();
    // Resolve: ${field} templates first, then bare identifiers as field lookups.
    const resolve = (s: string): string => {
      const withTemplates = resolveTemplates(s);
      // If the string changed by template resolution, use the resolved value.
      if (withTemplates !== s) return withTemplates;
      // Bare identifier: look up in context first, then fall back to literal.
      const contextVal = context[s];
      return contextVal !== undefined ? String(contextVal) : s;
    };
    const lhs = resolve(lhsRaw);
    const rhs = resolve(rhsRaw);
    return op === "==" ? lhs === rhs : lhs !== rhs;
  }

  // Unknown form — pass through to avoid silently dropping events.
  return true;
}
