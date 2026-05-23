// Filesystem + YAML helpers shared by the modular config loader.
//
// Centralizes:
//   - existence checks (single point that converts ENOENT into `null`),
//   - YAML parsing with file-aware error messages,
//   - top-key extraction with a typed shape contract.
//
// Every loader path in `loader.ts` goes through these helpers so that
// error messages always carry the file path, and so YAML parsing
// behavior (strict mode, anchors, etc.) is configured in one place.

import { readFile, stat } from "node:fs/promises";

import { parse as parseYaml } from "yaml";

/**
 * Resolve to the file's stat entry, or `null` if the path does not
 * exist. Any other error (permission denied, etc.) is rethrown.
 */
export async function statOrNull(filePath: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  const info = await statOrNull(filePath);
  return info?.isFile() ?? false;
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  const info = await statOrNull(dirPath);
  return info?.isDirectory() ?? false;
}

/**
 * Parse a YAML file into the caller's expected shape. The file path is
 * embedded in any parse-error message so that downstream operators
 * always know which file to open.
 */
export async function readYaml<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, "utf8");
  try {
    return parseYaml(content) as T;
  } catch (error) {
    throw new Error(`Failed to parse YAML at ${filePath}: ${(error as Error).message}`);
  }
}

/**
 * Same as `readYaml` but returns `null` when the file does not exist.
 * Used by the loader to keep `infrastructure.<network>.yaml` and other
 * per-environment files optional.
 */
export async function readYamlIfExists<T>(filePath: string): Promise<T | null> {
  return (await fileExists(filePath)) ? readYaml<T>(filePath) : null;
}

/**
 * Read a YAML file shaped as `{ <topKey>: { <id>: <T>, ... } }` and
 * return the inner map. Returns `{}` if the file is missing or empty.
 * Throws if the top-level key is present but not an object.
 *
 * This mirrors how Spectra Bridge YAMLs nest their content under a
 * single top-level key (`chains:`, `contracts:`, `event_definitions:`,
 * `routers:`).
 */
export async function readYamlTopLevelMap<T>(
  filePath: string,
  topKey: string,
): Promise<Record<string, T>> {
  if (!(await fileExists(filePath))) {
    return {};
  }
  const file = await readYaml<Record<string, unknown>>(filePath);
  const inner = file?.[topKey];
  if (inner === undefined || inner === null) {
    return {};
  }
  if (typeof inner !== "object" || Array.isArray(inner)) {
    const got = Array.isArray(inner) ? "array" : typeof inner;
    throw new Error(
      `${filePath}: expected top-level key \`${topKey}\` to be a map, got ${got}.`,
    );
  }
  return inner as Record<string, T>;
}
