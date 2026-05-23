// Issue collector — small builder that the per-section validators in
// `validate.ts` share so the call sites read as straight assertions
// without each one carrying the boilerplate of pushing into an array.
//
// Two severities only:
//
//   - `error`   — the config is unusable as-is. Caller exits non-zero.
//   - `warning` — the config is loadable but operator should look at it.
//
// The collector is scoped: `scope("path.prefix")` returns a child
// collector whose paths are prefixed automatically. That keeps the
// individual `require(...)` / `expect(...)` calls focused on the local
// field name instead of repeating the parent path.

export type IssueSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: IssueSeverity;
  path: string;
  message: string;
};

/** Builder that accumulates issues and exposes ergonomic helpers. */
export class IssueCollector {
  private readonly issues: ValidationIssue[];
  private readonly prefix: string;

  constructor(issues: ValidationIssue[] = [], prefix = "") {
    this.issues = issues;
    this.prefix = prefix;
  }

  /** Snapshot of every issue collected so far across all scopes. */
  all(): ValidationIssue[] {
    return [...this.issues];
  }

  /** Filtered view: just the errors. */
  errors(): ValidationIssue[] {
    return this.issues.filter((i) => i.severity === "error");
  }

  /** Filtered view: just the warnings. */
  warnings(): ValidationIssue[] {
    return this.issues.filter((i) => i.severity === "warning");
  }

  /**
   * Return a child collector whose paths are prefixed. The join is
   * dot-aware: bracket-indexed children (`[0]`, `[42]`) append without
   * a separator so the rendered path is `destinations[0]` rather than
   * `destinations.[0]`.
   */
  scope(sub: string): IssueCollector {
    return new IssueCollector(this.issues, joinPath(this.prefix, sub));
  }

  /** Record an error at `<prefix>.<field>` (or `<field>` if no prefix). */
  error(field: string, message: string): void {
    this.issues.push({ severity: "error", path: this.qualify(field), message });
  }

  /** Record a warning at `<prefix>.<field>`. */
  warn(field: string, message: string): void {
    this.issues.push({ severity: "warning", path: this.qualify(field), message });
  }

  /**
   * Assert that `value` is set (non-null, non-empty for strings/arrays);
   * record an error and return `false` otherwise. Lets the caller
   * short-circuit the rest of a section when a required field is
   * missing.
   */
  required<T>(field: string, value: T | null | undefined, message?: string): value is T {
    if (value === null || value === undefined) {
      this.error(field, message ?? "Required.");
      return false;
    }
    if (typeof value === "string" && value.length === 0) {
      this.error(field, message ?? "Required (non-empty string).");
      return false;
    }
    if (Array.isArray(value) && value.length === 0) {
      this.error(field, message ?? "Required (non-empty list).");
      return false;
    }
    return true;
  }

  /**
   * Assert that `value` belongs to a closed set. Reports a friendly
   * error listing the allowed options when it doesn't.
   */
  oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): value is T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.error(
        field,
        `Expected one of: ${allowed.join(" | ")}. Got ${JSON.stringify(value)}.`,
      );
      return false;
    }
    return true;
  }

  private qualify(field: string): string {
    if (!field) return this.prefix;
    return joinPath(this.prefix, field);
  }
}

/**
 * Join two path segments using dot notation, except when the right-hand
 * side starts with `[` (array index), in which case the segments are
 * concatenated directly so the result reads as `parent[0]`.
 */
function joinPath(parent: string, child: string): string {
  if (!parent) return child;
  if (!child) return parent;
  return child.startsWith("[") ? `${parent}${child}` : `${parent}.${child}`;
}
