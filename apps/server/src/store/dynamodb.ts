import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Store, StoreDescription, StoreSnapshot } from "./types";
import { createMemoryStore, emptySnapshot } from "./memory";

/**
 * DynamoDB store — the deployment adapter.
 *
 * It persists *the same working set the JSON adapter writes*, one item per user,
 * rather than modelling each trip as its own item. That is a deliberate choice,
 * not a shortcut:
 *
 *  - The app's read pattern always wants all of a user's history. Learning reads
 *    every past decision on every prediction, so a normalised layout would ask
 *    DynamoDB for *N* round trips per request and still reassemble the same
 *    snapshot in memory. One item per user is one consistent read.
 *  - This app is single-user by construction (no auth; `DEFAULT_USER_ID`), so a
 *    per-user document is the natural unit of consistency.
 *  - Keeping the shape identical to the JSON adapter means the deployed app and
 *    the local app are the same program. A prediction cannot be right locally
 *    and wrong in production because the storage layer decided something extra.
 *
 * The cost, stated plainly rather than discovered later: a DynamoDB item is
 * capped at 400 KB. A snapshot with ~50 trips and ~350 decisions is about 110 KB,
 * so there is real headroom for one person's history but this is not the layout
 * for many users or many years. `assertFits` names the limit and the actual size
 * rather than letting DynamoDB reject the write with a generic error. The scaling
 * path is to normalise trips into their own items with a denormalised per-trip
 * sample row for learning to read in one query — the access pattern above is what
 * shapes that design.
 *
 * Concurrency is handled with a version attribute and a conditional write: a
 * second writer gets a failed condition rather than silently overwriting the
 * first. Reads use `ConsistentRead` — without it DynamoDB may serve a stale
 * snapshot immediately after a write, which recreates exactly the "Unknown trip"
 * bug this adapter exists to fix.
 */

/** The DynamoDB item limit, with margin so the error arrives before AWS does. */
const ITEM_LIMIT_BYTES = 350_000;
const MAX_WRITE_ATTEMPTS = 3;

/** Just enough of the SDK's shape to let a test supply its own client. */
export interface DynamoCommandClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

export interface DynamoStoreOptions {
  table: string;
  /** Injected in tests. Production builds the AWS document client. */
  client?: DynamoCommandClient;
  /** Falls back to the SDK's own resolution (AWS_REGION, ~/.aws/config, roles). */
  region?: string;
  /** Point at LocalStack or DynamoDB Local instead of AWS. */
  endpoint?: string;
}

export interface DynamoStore extends Store {
  readonly table: string;
  /** Round trips performed. Exposed so tests can assert we are not chatty. */
  readonly calls: number;
}

interface StoredState {
  snapshot: StoreSnapshot;
  version: number;
}

export class ItemTooLargeError extends Error {
  constructor(size: number) {
    super(
      `A user's stored history is ${Math.round(size / 1024)} KB, over this adapter's ` +
        `${Math.round(ITEM_LIMIT_BYTES / 1024)} KB guard (DynamoDB's item limit is 400 KB). ` +
        `Split trips into their own items before adding more history.`,
    );
    this.name = "ItemTooLargeError";
  }
}

function documentClient(options: DynamoStoreOptions): DynamoCommandClient {
  const config: DynamoDBClientConfig = {};
  if (options.region) config.region = options.region;
  if (options.endpoint) config.endpoint = options.endpoint;

  const base = new DynamoDBClient(config);
  const marshallOptions = { removeUndefinedValues: true, convertClassInstanceToMap: false };
  return DynamoDBDocumentClient.from(base, { marshallOptions }) as unknown as DynamoCommandClient;
}

const stateKey = (userId: string) => `user#${userId}`;
const tripPointerKey = (tripId: string) => `trip#${tripId}`;

export function createDynamoStore(options: DynamoStoreOptions): DynamoStore {
  const table = options.table;
  const client = options.client ?? documentClient(options);
  let calls = 0;

  async function send(command: unknown): Promise<Record<string, unknown>> {
    calls += 1;
    return client.send(command);
  }

  /** One consistent read of a user's whole history. */
  async function load(userId: string): Promise<StoredState> {
    const result = await send(
      new GetCommand({ TableName: table, Key: { id: stateKey(userId) }, ConsistentRead: true }),
    );
    const item = result.Item as { state?: StoreSnapshot; version?: number } | undefined;
    if (!item?.state) return { snapshot: emptySnapshot(), version: 0 };
    return {
      // Tolerate a partial record rather than crashing on a field added later.
      snapshot: {
        version: 1,
        users: item.state.users ?? [],
        trips: item.state.trips ?? [],
        tripItems: item.state.tripItems ?? [],
        exceptions: item.state.exceptions ?? [],
        customItems: item.state.customItems ?? [],
      },
      version: typeof item.version === "number" ? item.version : 0,
    };
  }

  /**
   * Write the whole state back, but only if nobody else wrote in between.
   *
   * Returns false on a lost race so the caller can reload and re-apply, which is
   * why every mutation below is written as a function over a memory store rather
   * than a read-then-write pair.
   */
  async function save(userId: string, snapshot: StoreSnapshot, version: number): Promise<boolean> {
    const item = {
      id: stateKey(userId),
      state: snapshot,
      version: version + 1,
      updatedAt: new Date().toISOString(),
    };
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (size > ITEM_LIMIT_BYTES) throw new ItemTooLargeError(size);

    try {
      await send(
        new PutCommand({
          TableName: table,
          Item: item,
          ConditionExpression: "attribute_not_exists(#v) OR #v = :expected",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":expected": version },
        }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  /**
   * Apply a change to a user's state, retrying once if another writer won.
   *
   * The change is re-applied to the freshly loaded state rather than replayed
   * blindly, so a retry cannot lose the other writer's work or double-apply ours.
   */
  async function mutate<T>(userId: string, change: (memory: Store) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const { snapshot, version } = await load(userId);
      const memory = createMemoryStore(snapshot);
      const result = await change(memory);
      if (await save(userId, memory.snapshot(), version)) return result;
    }
    throw new Error(
      `Someone else kept writing to this user's history (${MAX_WRITE_ATTEMPTS} attempts). Retry the request.`,
    );
  }

  /** Read-only access, for the many methods that do not change anything. */
  async function read<T>(userId: string, use: (memory: Store) => Promise<T>): Promise<T> {
    const { snapshot } = await load(userId);
    return use(createMemoryStore(snapshot));
  }

  /** Which user owns a trip. Trips are only addressable by id over HTTP. */
  async function ownerOf(tripId: string): Promise<string | null> {
    const result = await send(
      new GetCommand({ TableName: table, Key: { id: tripPointerKey(tripId) }, ConsistentRead: true }),
    );
    const item = result.Item as { userId?: string } | undefined;
    return item?.userId ?? null;
  }

  return {
    table,
    get calls() {
      return calls;
    },

    async getUser(userId) {
      return read(userId, (memory) => memory.getUser(userId));
    },
    async putUser(user) {
      return mutate(user.id, (memory) => memory.putUser(user));
    },
    async updatePreferences(userId, preferences) {
      return mutate(userId, (memory) => memory.updatePreferences(userId, preferences));
    },

    async listTrips(userId, limit) {
      return read(userId, (memory) => memory.listTrips(userId, limit));
    },

    async getTrip(tripId) {
      const userId = await ownerOf(tripId);
      if (!userId) return null;
      return read(userId, (memory) => memory.getTrip(tripId));
    },

    async putTrip(trip) {
      // The pointer goes first: a trip that exists but is briefly unreachable by
      // id fails the same way as an unknown trip, whereas a pointer to a trip
      // that was never written would leave a permanent dangling reference.
      await send(
        new PutCommand({
          TableName: table,
          Item: {
            id: tripPointerKey(trip.id),
            userId: trip.userId,
            startedAt: trip.startedAt,
            updatedAt: new Date().toISOString(),
          },
        }),
      );
      return mutate(trip.userId, (memory) => memory.putTrip(trip));
    },

    async listTripItems(tripId) {
      const userId = await ownerOf(tripId);
      if (!userId) return [];
      return read(userId, (memory) => memory.listTripItems(tripId));
    },

    async putTripItem(item) {
      const userId = await ownerOf(item.tripId);
      if (!userId) throw new Error(`Unknown trip "${item.tripId}"; cannot record a decision against it.`);
      return mutate(userId, (memory) => memory.putTripItem(item));
    },

    async listSamples(userId, limit) {
      return read(userId, (memory) => memory.listSamples(userId, limit));
    },

    async listCustomItems(userId) {
      return read(userId, (memory) => memory.listCustomItems(userId));
    },
    async putCustomItem(userId, item) {
      return mutate(userId, (memory) => memory.putCustomItem(userId, item));
    },

    async listExceptions(userId) {
      return read(userId, (memory) => memory.listExceptions(userId));
    },
    async putException(exception) {
      return mutate(exception.userId, (memory) => memory.putException(exception));
    },
    async deleteException(userId, exceptionId) {
      return mutate(userId, (memory) => memory.deleteException(userId, exceptionId));
    },

    async reset() {
      // Only used by the seed script and tests. Scans, then deletes what it found.
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = (await send(
          new ScanCommand({
            TableName: table,
            ProjectionExpression: "id",
            ConsistentRead: true,
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        )) as { Items?: Array<{ id?: string }>; LastEvaluatedKey?: Record<string, unknown> };

        for (const item of page.Items ?? []) {
          if (item.id) {
            await send(new DeleteCommand({ TableName: table, Key: { id: item.id } }));
          }
        }
        startKey = page.LastEvaluatedKey;
      } while (startKey);
    },
  };
}

export function describeDynamoStore(store: DynamoStore): StoreDescription {
  return { adapter: "dynamodb", table: store.table, durable: true };
}
