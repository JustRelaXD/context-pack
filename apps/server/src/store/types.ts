import type {
  ContextException,
  Item,
  LearningSample,
  Trip,
  TripItem,
  User,
  UserPreferences,
} from "@contextpack/shared";

/** An item the user added themselves, scoped to them. */
export interface CustomItemRecord {
  userId: string;
  item: Item;
  createdAt: string;
}

/**
 * The whole persisted world, as one value.
 *
 * Both durable adapters (json and dynamodb) store exactly this, which is what
 * keeps the deployed app and the local app the same program rather than two
 * implementations that agree by inspection.
 */
export interface StoreSnapshot {
  version: 1;
  users: User[];
  trips: Trip[];
  tripItems: TripItem[];
  exceptions: ContextException[];
  /** Added later; older stores simply have none. */
  customItems?: CustomItemRecord[];
}

/** Which adapter actually got constructed, for logging and diagnostics. */
export interface StoreDescription {
  adapter: string;
  file?: string;
  /** Present for the DynamoDB adapter. */
  table?: string;
  /** False when the data lives only in this process and will vanish. */
  durable: boolean;
}

/**
 * Everything the app persists, behind one interface.
 *
 * This exists so the deployed version can swap in DynamoDB without the
 * prediction engine or the routes noticing. Every method is async and takes a
 * plain key — no `QueryCommand` shapes, no partition-key concepts — because
 * those are DynamoDB details and they belong in the DynamoDB adapter.
 */
export interface Store {
  getUser(userId: string): Promise<User | null>;
  putUser(user: User): Promise<User>;
  updatePreferences(userId: string, preferences: UserPreferences): Promise<User | null>;

  /**
   * Most recent first. `limit` is a storage-level hint, not a correctness
   * requirement: callers must not assume more trips exist than are returned,
   * but learning always reads `listSamples` rather than this.
   */
  listTrips(userId: string, limit?: number): Promise<Trip[]>;
  getTrip(tripId: string): Promise<Trip | null>;
  putTrip(trip: Trip): Promise<Trip>;

  listTripItems(tripId: string): Promise<TripItem[]>;
  putTripItem(item: TripItem): Promise<TripItem>;

  /**
   * The raw material for learning: every past trip reduced to the decisions the
   * engine is actually allowed to reason from. Kept as one call because the
   * JSON and DynamoDB adapters would fetch this very differently.
   */
  listSamples(userId: string, limit?: number): Promise<LearningSample[]>;

  listCustomItems(userId: string): Promise<Item[]>;
  putCustomItem(userId: string, item: Item): Promise<Item>;

  listExceptions(userId: string): Promise<ContextException[]>;
  putException(exception: ContextException): Promise<ContextException>;
  deleteException(userId: string, exceptionId: string): Promise<boolean>;

  /** Test/seed helper. Never exposed over HTTP. */
  reset(): Promise<void>;
}

/** Composite key for a trip item. Items are only ever addressed in a trip. */
export function tripItemKey(tripId: string, itemId: string): string {
  return `${tripId}::${itemId}`;
}
