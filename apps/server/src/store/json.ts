import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Store } from "./types";
import { createMemoryStore, emptySnapshot, type MemoryStore, type StoreSnapshot } from "./memory";

/**
 * JSON-file store — the local-first default.
 *
 * A single file is genuinely enough here: one user, a few hundred trips, and a
 * read pattern that always wants *all* of a user's history anyway. Writes are
 * serialised through a promise chain so two concurrent requests cannot clobber
 * each other, and we write to a temp file then rename, so an interrupted write
 * cannot leave a half-parsed store behind.
 *
 * When this is deployed the swap is `CONTEXTPACK_STORE=dynamodb` and nothing
 * else in the codebase changes.
 */
export interface JsonStoreOptions {
  file: string;
  /** Persist on every mutation. Tests turn this off and call flush() manually. */
  autosave?: boolean;
}

export interface JsonStore extends Store {
  /** Path of the backing file, for logging and the diagnostics endpoint. */
  readonly file: string;
  /** Force a write and await it. Used by the seed script and on shutdown. */
  flush(): Promise<void>;
  /** Where the file lives right now, or null if it has never been written. */
  loadError(): string | null;
}

function readSnapshot(file: string): { snapshot: StoreSnapshot; error: string | null } {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreSnapshot>;
    // Tolerate a partial file rather than crashing the server on boot: missing
    // collections are simply empty.
    return {
      snapshot: {
        version: 1,
        users: parsed.users ?? [],
        trips: parsed.trips ?? [],
        tripItems: parsed.tripItems ?? [],
        exceptions: parsed.exceptions ?? [],
      },
      error: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { snapshot: emptySnapshot(), error: null };
    return { snapshot: emptySnapshot(), error: (error as Error).message };
  }
}

export function createJsonStore(options: JsonStoreOptions): JsonStore {
  const file = resolve(options.file);
  const autosave = options.autosave ?? true;
  const loaded = readSnapshot(file);
  const memory: MemoryStore = createMemoryStore(loaded.snapshot);

  let pending: Promise<void> = Promise.resolve();
  let lastError: string | null = loaded.error;

  async function persist(): Promise<void> {
    // Serialise writes: each one chains onto the previous, so the last snapshot
    // to be written is always the newest state.
    pending = pending.then(async () => {
      const payload = JSON.stringify(memory.snapshot(), null, 2);
      const temp = `${file}.${process.pid}.tmp`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temp, payload, "utf8");
      renameSync(temp, file);
      lastError = null;
    });
    return pending;
  }

  function after<T>(value: T): Promise<T> {
    if (autosave) void persist();
    return Promise.resolve(value);
  }

  return {
    file,

    loadError: () => lastError,

    async flush() {
      if (!autosave) await persist();
      else await pending;
    },

    async getUser(userId) {
      return memory.getUser(userId);
    },
    async putUser(user) {
      return after(await memory.putUser(user));
    },
    async updatePreferences(userId, preferences) {
      return after(await memory.updatePreferences(userId, preferences));
    },

    async listTrips(userId, limit) {
      return memory.listTrips(userId, limit);
    },
    async getTrip(tripId) {
      return memory.getTrip(tripId);
    },
    async putTrip(trip) {
      return after(await memory.putTrip(trip));
    },

    async listTripItems(tripId) {
      return memory.listTripItems(tripId);
    },
    async putTripItem(item) {
      return after(await memory.putTripItem(item));
    },

    async listSamples(userId, limit) {
      return memory.listSamples(userId, limit);
    },

    async listExceptions(userId) {
      return memory.listExceptions(userId);
    },
    async putException(exception) {
      return after(await memory.putException(exception));
    },
    async deleteException(userId, exceptionId) {
      return after(await memory.deleteException(userId, exceptionId));
    },

    async reset() {
      await memory.reset();
      await persist();
    },
  };
}
