import type {
  ContextException,
  LearningSample,
  Trip,
  TripItem,
  User,
  UserPreferences,
} from "@contextpack/shared";
import { tripItemKey, type Store } from "./types";

export interface StoreSnapshot {
  version: 1;
  users: User[];
  trips: Trip[];
  tripItems: TripItem[];
  exceptions: ContextException[];
}

export function emptySnapshot(): StoreSnapshot {
  return { version: 1, users: [], trips: [], tripItems: [], exceptions: [] };
}

/**
 * A store that can also hand back its whole state.
 *
 * Only the persistence adapters need this — it is how the JSON adapter writes
 * the working set to disk without reimplementing any of the query logic below.
 */
export type MemoryStore = Store & { snapshot(): StoreSnapshot };

/**
 * In-memory store.
 *
 * Used directly by the API tests and as the working set that the JSON adapter
 * persists. It is also the shape a DynamoDB adapter would produce, which keeps
 * the two honest about the same contract.
 */
export function createMemoryStore(initial: StoreSnapshot = emptySnapshot()): MemoryStore {
  const state: StoreSnapshot = structuredClone(initial);

  const byStartedAtDesc = (a: Trip, b: Trip) => b.startedAt.localeCompare(a.startedAt);

  return {
    async getUser(userId) {
      return state.users.find((user) => user.id === userId) ?? null;
    },

    async putUser(user) {
      const index = state.users.findIndex((candidate) => candidate.id === user.id);
      if (index === -1) state.users.push(user);
      else state.users[index] = user;
      return user;
    },

    async updatePreferences(userId, preferences: UserPreferences) {
      const user = state.users.find((candidate) => candidate.id === userId);
      if (!user) return null;
      user.preferences = preferences;
      return user;
    },

    async listTrips(userId, limit) {
      const trips = state.trips
        .filter((trip) => trip.userId === userId)
        .sort(byStartedAtDesc);
      return typeof limit === "number" ? trips.slice(0, limit) : trips;
    },

    async getTrip(tripId) {
      return state.trips.find((trip) => trip.id === tripId) ?? null;
    },

    async putTrip(trip) {
      const index = state.trips.findIndex((candidate) => candidate.id === trip.id);
      if (index === -1) state.trips.push(trip);
      else state.trips[index] = trip;
      return trip;
    },

    async listTripItems(tripId) {
      return state.tripItems.filter((item) => item.tripId === tripId);
    },

    async putTripItem(item) {
      const key = tripItemKey(item.tripId, item.itemId);
      const index = state.tripItems.findIndex(
        (candidate) => tripItemKey(candidate.tripId, candidate.itemId) === key,
      );
      if (index === -1) state.tripItems.push(item);
      else state.tripItems[index] = item;
      return item;
    },

    async listSamples(userId, limit) {
      const trips = state.trips
        .filter((trip) => trip.userId === userId)
        .sort(byStartedAtDesc);
      const scoped = typeof limit === "number" ? trips.slice(0, limit) : trips;

      const itemsByTrip = new Map<string, TripItem[]>();
      for (const item of state.tripItems) {
        const bucket = itemsByTrip.get(item.tripId);
        if (bucket) bucket.push(item);
        else itemsByTrip.set(item.tripId, [item]);
      }

      return scoped.map(
        (trip): LearningSample => ({
          tripId: trip.id,
          context: trip.context,
          startedAt: trip.startedAt,
          items: (itemsByTrip.get(trip.id) ?? []).map((item) => ({
            itemId: item.itemId,
            action: item.userAction,
            source: item.confirmationSource,
          })),
        }),
      );
    },

    async listExceptions(userId) {
      return state.exceptions.filter((exception) => exception.userId === userId);
    },

    async putException(exception) {
      const index = state.exceptions.findIndex((candidate) => candidate.id === exception.id);
      if (index === -1) state.exceptions.push(exception);
      else state.exceptions[index] = exception;
      return exception;
    },

    async deleteException(userId, exceptionId) {
      const index = state.exceptions.findIndex(
        (candidate) => candidate.id === exceptionId && candidate.userId === userId,
      );
      if (index === -1) return false;
      state.exceptions.splice(index, 1);
      return true;
    },

    async reset() {
      state.users = [];
      state.trips = [];
      state.tripItems = [];
      state.exceptions = [];
    },

    snapshot() {
      return state;
    },
  };
}
