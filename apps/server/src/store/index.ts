import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJsonStore, type JsonStore } from "./json";
import { createMemoryStore, type StoreSnapshot } from "./memory";
import type { Store } from "./types";

export * from "./types";
export { createMemoryStore, emptySnapshot } from "./memory";
export type { MemoryStore, StoreSnapshot } from "./memory";
export { createJsonStore } from "./json";
export type { JsonStore, JsonStoreOptions } from "./json";

/**
 * Walk up to the repo root so the data file has one predictable home no matter
 * which workspace directory npm happens to run us from.
 */
export function findRepoRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);
  for (let level = 0; level < 5; level += 1) {
    const manifest = resolve(current, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return current;
      } catch {
        // Unreadable manifest: keep walking rather than failing to boot.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir);
}

export function defaultDataFile(): string {
  return resolve(findRepoRoot(), "data", "store.json");
}

export interface CreateStoreOptions {
  /** Explicit store kind. Falls back to CONTEXTPACK_STORE, then "json". */
  kind?: string;
  /** Explicit data file for the json adapter. Falls back to CONTEXTPACK_DATA_FILE. */
  file?: string;
  /** Seed state for the memory adapter. */
  seed?: StoreSnapshot;
}

/**
 * The single place storage choice happens.
 *
 * `json` is the default because this is a local-first app; `dynamodb` is the
 * deployment swap and is deliberately not implemented yet — claiming support we
 * have not tested would be worse than a clear error.
 */
export function createStore(options: CreateStoreOptions = {}): Store {
  const kind = (options.kind ?? process.env.CONTEXTPACK_STORE ?? "json").trim().toLowerCase();

  if (kind === "memory") return createMemoryStore(options.seed);

  if (kind === "json" || kind === "") {
    const file = options.file ?? process.env.CONTEXTPACK_DATA_FILE ?? defaultDataFile();
    return createJsonStore({ file });
  }

  throw new Error(
    `Unknown CONTEXTPACK_STORE "${kind}". Supported: json (default), memory. ` +
      `A DynamoDB adapter is the next deploy step and is not wired up yet.`,
  );
}

/** Exposed for diagnostics: which adapter actually got constructed. */
export function describeStore(store: Store): { adapter: string; file?: string } {
  const json = store as Partial<JsonStore>;
  if (typeof json.flush === "function" && typeof json.file === "string") {
    return { adapter: "json", file: json.file };
  }
  return { adapter: "memory" };
}
