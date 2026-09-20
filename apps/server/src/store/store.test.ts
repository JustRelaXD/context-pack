import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Trip } from "@contextpack/shared";
import { createJsonStore } from "./json";
import { createStore, describeStore } from "./index";

/** Adapter behaviour, including the serverless default that broke deployment. */

const created: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "contextpack-"));
  created.push(dir);
  return join(dir, "store.json");
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.VERCEL;
  delete process.env.CONTEXTPACK_STORE;
});

function trip(id: string): Trip {
  return {
    id,
    userId: "local-user",
    rawInput: "college for a lab",
    context: { destination: "college", purpose: "lab", tags: ["academic", "lab"] },
    startedAt: "2026-09-19T07:40:00.000Z",
  };
}

describe("adapter selection", () => {
  it("defaults to the file store locally", () => {
    expect(describeStore(createStore({ file: tempFile() }))).toMatchObject({
      adapter: "json",
      durable: true,
    });
  });

  it("falls back to memory on a serverless platform, where the filesystem is read-only", () => {
    process.env.VERCEL = "1";
    const described = describeStore(createStore());
    expect(described.adapter).toBe("memory");
    // The important part: it admits the data will not survive.
    expect(described.durable).toBe(false);
  });

  it("lets an explicit choice override the platform default", () => {
    process.env.VERCEL = "1";
    process.env.CONTEXTPACK_STORE = "json";
    expect(describeStore(createStore({ file: tempFile() })).durable).toBe(true);
  });

  it("rejects an unknown adapter by name rather than silently guessing", () => {
    expect(() => createStore({ kind: "postgres" })).toThrow(/Unknown CONTEXTPACK_STORE/);
  });

  it("refuses dynamodb without a table name, and names the variable to set", () => {
    // Naming the missing setting matters: the alternative is a deploy that boots
    // and then fails every request against a table called "undefined".
    expect(() => createStore({ kind: "dynamodb", table: "" })).toThrow(/CONTEXTPACK_TABLE/);
  });

  it("reports dynamodb as durable and names the table", () => {
    // Constructing the client does not call AWS, so this needs no credentials.
    const described = describeStore(createStore({ kind: "dynamodb", table: "contextpack-test" }));
    expect(described.adapter).toBe("dynamodb");
    expect(described.table).toBe("contextpack-test");
    expect(described.durable).toBe(true);
  });
});

describe("json adapter", () => {
  it("survives a restart, because that is the whole point of a file", async () => {
    const file = tempFile();

    const first = createJsonStore({ file });
    await first.putTrip(trip("t1"));
    await first.putTripItem({
      tripId: "t1",
      itemId: "laptop",
      predictedProbability: 0.9,
      userAction: "packed",
      confirmationSource: "confirmed",
    });
    await first.flush();

    const reopened = createJsonStore({ file });
    expect((await reopened.getTrip("t1"))?.rawInput).toBe("college for a lab");
    const samples = await reopened.listSamples("local-user");
    expect(samples).toHaveLength(1);
    expect(samples[0]?.items[0]).toMatchObject({ itemId: "laptop", action: "packed" });
  });

  it("starts empty instead of crashing when there is no file yet", async () => {
    const store = createJsonStore({ file: tempFile() });
    expect(await store.listTrips("local-user")).toEqual([]);
    expect(store.loadError()).toBeNull();
  });
});

describe("memory adapter", () => {
  it("reports the samples the engine learns from, newest first", async () => {
    const store = createStore({ kind: "memory" });
    await store.putTrip(trip("older"));
    await store.putTrip({ ...trip("newer"), startedAt: "2026-09-20T07:40:00.000Z" });

    const trips = await store.listTrips("local-user");
    expect(trips.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });
});
