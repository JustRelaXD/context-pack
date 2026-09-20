import { describe, expect, it } from "vitest";
import type { ContextException, Item, Trip, TripItem } from "@contextpack/shared";
import { createDynamoStore, ItemTooLargeError, type DynamoCommandClient } from "./dynamodb";
import type { StoreSnapshot } from "./types";

/**
 * A faithful-enough DynamoDB for the four commands this adapter uses.
 *
 * The point of testing against a fake *client* rather than a fake adapter is that
 * the real command construction is exercised: the key layout, `ConsistentRead`,
 * and above all the conditional write that stops one instance from silently
 * overwriting another's work. Those are the parts that would fail in production,
 * and they are the parts a stub would skip.
 *
 * What this cannot tell you is whether the AWS SDK's own wire behaviour is right.
 * Only a real table can, which is what `npm run setup:aws` verifies.
 */
class FakeDynamo implements DynamoCommandClient {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly commands: Array<{ name: string; input: Record<string, unknown> }> = [];

  /** Runs before a put is applied; used to simulate a competing writer. */
  onPut?: () => void;

  async send(command: unknown): Promise<Record<string, unknown>> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.commands.push({ name, input });

    if (name === "GetCommand") {
      const key = (input.Key as { id: string }).id;
      const found = this.items.get(key);
      return found ? { Item: structuredClone(found) } : {};
    }

    if (name === "PutCommand") {
      this.onPut?.();
      const item = input.Item as Record<string, unknown>;
      const key = item.id as string;
      const existing = this.items.get(key);
      const expected = (input.ExpressionAttributeValues as { ":expected": number })?.[":expected"];

      if (input.ConditionExpression) {
        const matches = existing === undefined ? expected === 0 : existing.version === expected;
        if (!matches) {
          const error = new Error("The conditional request failed");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
      }

      this.items.set(key, structuredClone(item));
      return {};
    }

    if (name === "DeleteCommand") {
      this.items.delete((input.Key as { id: string }).id);
      return {};
    }

    if (name === "ScanCommand") {
      return { Items: [...this.items.values()].map((item) => ({ id: item.id })) };
    }

    throw new Error(`FakeDynamo got an unexpected command: ${name}`);
  }

  get commandNames(): string[] {
    return this.commands.map((entry) => entry.name);
  }
}

const TABLE = "contextpack-test";

function storeWith(fake: FakeDynamo) {
  return createDynamoStore({ table: TABLE, client: fake });
}

const trip = (id: string, startedAt: string, userId = "u1", destination = "college"): Trip => ({
  id,
  userId,
  rawInput: `going to ${destination}`,
  context: { destination, tags: ["academic"] },
  startedAt,
});

const tripItem = (tripId: string, itemId: string, action: TripItem["userAction"]): TripItem => ({
  tripId,
  itemId,
  predictedProbability: 0.9,
  userAction: action,
  confirmationSource: action === "packed" ? "confirmed" : "inferred",
});

const item = (id: string, name: string): Item => ({
  id,
  name,
  category: "misc",
  emoji: "📦",
  custom: true,
});

describe("dynamodb adapter", () => {
  it("keeps state across separate store instances, which is the whole point", async () => {
    // Two instances stand in for two serverless invocations: the bug being fixed
    // was state living in one process and the next request landing in another.
    const fake = new FakeDynamo();
    await storeWith(fake).putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));

    const secondInstance = storeWith(fake);
    const found = await secondInstance.getTrip("t1");
    expect(found?.id).toBe("t1");
    expect(found?.context.destination).toBe("college");

    // The trip is also listed for its owner, from either instance.
    expect((await secondInstance.listTrips("u1")).map((t) => t.id)).toEqual(["t1"]);
  });

  it("reads consistently, so a trip written a moment ago is not invisible", async () => {
    // An eventually consistent read can return a stale snapshot right after a
    // write, which would recreate the exact "Unknown trip" failure in production.
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));

    const reads = fake.commands.filter((entry) => entry.name === "GetCommand");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.input.ConsistentRead).toBe(true);
  });

  it("lists trips newest first and honours the limit", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("old", "2026-08-01T08:00:00.000Z"));
    await store.putTrip(trip("new", "2026-09-10T08:00:00.000Z"));
    await store.putTrip(trip("middle", "2026-09-01T08:00:00.000Z"));

    expect((await store.listTrips("u1")).map((t) => t.id)).toEqual(["new", "middle", "old"]);
    expect((await store.listTrips("u1", 2)).map((t) => t.id)).toEqual(["new", "middle"]);
  });

  it("keeps decisions separate from other users", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z", "u1"));
    await store.putTrip(trip("t2", "2026-09-01T08:00:00.000Z", "u2"));
    await store.putTripItem(tripItem("t1", "laptop", "packed"));

    expect((await store.listTripItems("t1")).map((i) => i.itemId)).toEqual(["laptop"]);
    expect(await store.listTripItems("t2")).toEqual([]);
    expect(await store.listSamples("u2")).toHaveLength(1);
    expect((await store.listSamples("u2"))[0]?.items).toEqual([]);
  });

  it("feeds learning with the decisions that were recorded", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));
    await store.putTripItem(tripItem("t1", "laptop", "packed"));
    await store.putTripItem(tripItem("t1", "umbrella", "not_needed"));

    const samples = await store.listSamples("u1");
    expect(samples).toHaveLength(1);
    expect(samples[0]!.items).toEqual([
      { itemId: "laptop", action: "packed", source: "confirmed" },
      { itemId: "umbrella", action: "not_needed", source: "inferred" },
    ]);
  });

  it("refuses a decision for a trip it has never seen", async () => {
    const fake = new FakeDynamo();
    await expect(storeWith(fake).putTripItem(tripItem("ghost", "laptop", "packed"))).rejects.toThrow(
      /Unknown trip/,
    );
  });

  it("stores exceptions and forgets them on request", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    const exception: ContextException = {
      id: "e1",
      userId: "u1",
      itemId: "laptop",
      contextKey: "college",
      scope: "once",
      reason: "said so",
      createdAt: "2026-09-01T08:00:00.000Z",
    };

    await store.putException(exception);
    expect(await store.listExceptions("u1")).toHaveLength(1);
    expect(await store.deleteException("u1", "e1")).toBe(true);
    expect(await store.listExceptions("u1")).toEqual([]);
    expect(await store.deleteException("u1", "e1")).toBe(false);
  });

  it("remembers items the user added themselves", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putCustomItem("u1", item("retainer", "Retainer"));
    expect((await store.listCustomItems("u1")).map((i) => i.id)).toEqual(["retainer"]);
    expect(await store.listCustomItems("u2")).toEqual([]);
  });

  it("re-applies a change instead of overwriting when another writer got there first", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));

    // A competing instance writes between our load and our save, exactly once.
    let interfered = false;
    fake.onPut = () => {
      fake.onPut = undefined;
      if (interfered) return;
      interfered = true;
      const current = fake.items.get("user#u1")!;
      const other = structuredClone(current) as { state: StoreSnapshot; version: number };
      other.state.trips.push(trip("theirs", "2026-09-02T08:00:00.000Z"));
      other.version += 1;
      fake.items.set("user#u1", other);
    };

    await store.putTrip(trip("t2", "2026-09-03T08:00:00.000Z"));

    const ids = (await storeWith(fake).listTrips("u1")).map((t) => t.id);
    // Both survive: the retry re-applied our write to their newer state rather
    // than clobbering it.
    expect(ids).toContain("t2");
    expect(ids).toContain("theirs");
    expect(ids).toContain("t1");
  });

  it("reports an oversized history in kilobytes instead of letting AWS reject it", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    const big = "x".repeat(400_000);
    await expect(
      store.putCustomItem("u1", { ...item("huge", "Huge"), name: big }),
    ).rejects.toThrow(ItemTooLargeError);
    await expect(
      store.putCustomItem("u1", { ...item("huge", "Huge"), name: big }),
    ).rejects.toThrow(/KB/);
  });

  it("clears every item on reset, pointers included", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));
    await store.putTripItem(tripItem("t1", "laptop", "packed"));

    await store.reset();

    expect(fake.items.size).toBe(0);
    expect(await store.listTrips("u1")).toEqual([]);
    expect(await store.getTrip("t1")).toBeNull();
  });

  it("is not chatty: a decision costs a handful of round trips, not a scan", async () => {
    const fake = new FakeDynamo();
    const store = storeWith(fake);
    await store.putTrip(trip("t1", "2026-09-01T08:00:00.000Z"));

    const before = fake.commands.length;
    await store.putTripItem(tripItem("t1", "laptop", "packed"));
    const used = fake.commands.length - before;

    // Owner lookup, load, save. A normalised layout would need a query per trip
    // here, which is why this adapter stores a user's history as one item.
    expect(used).toBeLessThanOrEqual(3);
    expect(fake.commandNames).not.toContain("ScanCommand");
  });
});
