// Log injection sanitizer.
//
// Use when interpolating request-sourced values into log lines to prevent
// newline/tab injection that could corrupt structured logs.

/**
 * Strip CR, LF, and tab characters from a string and cap it at 8 KiB.
 * Always pass request-sourced values (URL path segments, query params,
 * body fields) through this function before writing them to a log line.
 */
export function sanitizeLogLine(line: string): string {
  return line.replace(/[\r\n\t]+/g, " ").slice(0, 8 * 1024);
}
