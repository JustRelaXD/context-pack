import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Minimal .env loader.
 *
 * Deliberately hand-rolled rather than pulled from a dependency, because the
 * whole behaviour we need is a dozen lines and we already have enough moving
 * parts. Two rules matter:
 *
 *  1. A real environment variable always wins. `export FOO=bar` in your shell
 *     beats `.env`, so nothing in the repo can surprise you.
 *  2. A missing .env is normal, not an error.
 */

const MAX_LEVELS_UP = 4;

/** Walk up from the working directory to find the nearest .env. */
export function findEnvFiles(startDir = process.cwd()): string[] {
  const found: string[] = [];
  let current = resolve(startDir);
  for (let level = 0; level < MAX_LEVELS_UP; level += 1) {
    const candidate = resolve(current, ".env");
    if (existsSync(candidate)) {
      found.push(candidate);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

interface ParsedLine {
  key: string;
  value: string;
}

export function parseEnvFile(contents: string): ParsedLine[] {
  const entries: ParsedLine[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Tolerate `export KEY=value`, which is easy to copy in from .bashrc.
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    // Strip a single layer of matching quotes, including a trailing comment
    // after an unquoted value.
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2] ?? "";
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    entries.push({ key, value });
  }
  return entries;
}

export interface EnvLoadReport {
  files: string[];
  appliedKeys: string[];
  /** Keys present in a file but left alone because the shell already set them. */
  shadowedKeys: string[];
}

export function loadEnvFile(startDir = process.cwd()): EnvLoadReport {
  const files = findEnvFiles(startDir);
  const appliedKeys: string[] = [];
  const shadowedKeys: string[] = [];

  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { key, value } of parseEnvFile(contents)) {
      const existing = process.env[key];
      if (existing !== undefined && existing !== "") {
        shadowedKeys.push(key);
        continue;
      }
      process.env[key] = value;
      appliedKeys.push(key);
    }
  }

  return { files, appliedKeys, shadowedKeys };
}
