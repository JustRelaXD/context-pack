import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createJsonStore, type JsonStore } from "./json";
import { createMemoryStore } from "./memory";
import { createDynamoStore, type DynamoStore } from "./dynamodb";
import type { Store, StoreDescription, StoreSnapshot } from "./types";

export * from "./types";
export { createMemoryStore, emptySnapshot } from "./memory";
export type { MemoryStore } from "./memory";
export { createJsonStore } from "./json";
export type { JsonStore, JsonStoreOptions } from "./json";
export { createDynamoStore, ItemTooLargeError } from "./dynamodb";
export type { DynamoStore, DynamoStoreOptions } from "./dynamodb";

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
  /** Table name for the dynamodb adapter. Falls back to CONTEXTPACK_TABLE. */
  table?: string;
  /** Region for the dynamodb adapter. Falls back to AWS_REGION via the SDK. */
  region?: string;
  /** Override the DynamoDB endpoint, e.g. LocalStack or DynamoDB Local. */
  endpoint?: string;
}

/**
 * Which adapter to use when nobody said explicitly.
 *
 * On a serverless platform the filesystem is read-only apart from `/tmp`, so the
 * JSON file adapter cannot work — it would throw `EROFS` on the first write, or
 * worse, appear to save and lose everything between invocations. Defaulting to
 * memory there keeps the app *functional and honest* rather than crashing: the
 * trade-off is that state does not survive an invocation, which `describeStore`
 * reports and the UI surfaces. Durable serverless storage means a real managed
 * store (see the README), not a file.
 */
function resolveKind(options: CreateStoreOptions): string {
  const explicit = options.kind ?? process.env.CONTEXTPACK_STORE;
  if (explicit && explicit.trim()) return explicit.trim().toLowerCase();
  if (process.env.VERCEL) return "memory";
  return "json";
}

/**
 * The single place storage choice happens.
 *
 * `json` is the default locally because this is a local-first app; `dynamodb` is
 * the deployment swap and is deliberately not implemented yet — claiming support
 * we have not tested would be worse than a clear error.
 */
export function createStore(options: CreateStoreOptions = {}): Store {
  const kind = resolveKind(options);

  if (kind === "memory") return createMemoryStore(options.seed);

  if (kind === "json" || kind === "") {
    const file = options.file ?? process.env.CONTEXTPACK_DATA_FILE ?? defaultDataFile();
    return createJsonStore({ file });
  }

  if (kind === "dynamodb") {
    const table = options.table ?? process.env.CONTEXTPACK_TABLE;
    if (!table?.trim()) {
      throw new Error(
        "CONTEXTPACK_STORE=dynamodb needs the table name: set CONTEXTPACK_TABLE (or pass it explicitly).",
      );
    }
    return createDynamoStore({
      table: table.trim(),
      region: options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
      endpoint: options.endpoint ?? process.env.CONTEXTPACK_DYNAMODB_ENDPOINT,
    });
  }

  throw new Error(
    `Unknown CONTEXTPACK_STORE "${kind}". Supported: json (default), memory, dynamodb.`,
  );
}

/** Exposed for diagnostics: which adapter actually got constructed. */
export function describeStore(store: Store): StoreDescription {
  const dynamo = store as Partial<DynamoStore>;
  if (typeof dynamo.table === "string" && typeof dynamo.getTrip === "function") {
    return { adapter: "dynamodb", table: dynamo.table, durable: true };
  }

  const json = store as Partial<JsonStore>;
  if (typeof json.flush === "function" && typeof json.file === "string") {
    return { adapter: "json", file: json.file, durable: true };
  }

  return { adapter: "memory", durable: false };
}
