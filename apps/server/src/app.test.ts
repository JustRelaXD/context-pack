import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentLayer } from "./ai";
import { createApp } from "./app";
import { createService } from "./service";
import { createMemoryStore } from "./store";
import { nullWeatherProvider } from "./weather";

/**
 * The routes that set up data, driven over a real socket.
 *
 * The example-history action is the one path a judge or a first-time visitor will
 * take first, and it is the only place the app both writes a lot of records and
 * reads them back as predictions. Testing it at the service level would miss the
 * parts most likely to break: JSON in, JSON out, and the guard that refuses to
 * mix fabricated history into real history.
 */

let server: Server;
let base: string;

function buildApp() {
  const store = createMemoryStore();
  // Rule-based only: no keys, no network, same output every run.
  const service = createService({
    store,
    agent: createAgentLayer({ CONTEXTPACK_AGENT: "heuristic" }),
    weather: nullWeatherProvider,
  });
  return createApp({ service, store });
}

const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  server = createServer(buildApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("items", () => {
  it("starts as the built-in catalog and accepts a new item idempotently", async () => {
    const before = (await (await fetch(`${base}/api/items`)).json()) as { items: unknown[] };

    const created = await post("/api/items", { name: "Retainer" });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { item: { id: string; name: string; custom?: boolean }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.item.id).toBe("retainer");
    expect(body.item.custom).toBe(true);

    const after = (await (await fetch(`${base}/api/items`)).json()) as { items: unknown[] };
    expect(after.items.length).toBe(before.items.length + 1);

    // Typing the same name again must not fork the item's history in two.
    const again = await post("/api/items", { name: "retainer" });
    expect(again.status).toBe(200);
    expect((await again.json()) as { created: boolean }).toMatchObject({ created: false });
  });

  it("refuses a name that is too short to be useful", async () => {
    const response = await post("/api/items", { name: "a" });
    expect(response.status).toBe(400);
  });
});

describe("suggestions", () => {
  it("proposes items for a trip, without inventing a probability for any of them", async () => {
    const started = await post("/api/trips", { rawInput: "heading to the gym", withWeather: false });
    const view = (await started.json()) as {
      trip: { id: string };
      items: Array<{ item: { name: string } }>;
    };

    const response = await fetch(`${base}/api/trips/${view.trip.id}/suggestions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      suggestions: Array<Record<string, unknown>>;
      source: string;
      note?: string;
    };

    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.source).toBe("heuristic");

    // The whole point of the separation: a proposed item has no observations, so
    // it must not arrive wearing a percentage that looks like a real prediction.
    for (const suggestion of body.suggestions) {
      expect(suggestion).not.toHaveProperty("probability");
      expect(suggestion).toHaveProperty("name");
    }

    // Nothing already on the screen is proposed again.
    const shown = new Set(view.items.map((item) => item.item.name.toLowerCase()));
    for (const suggestion of body.suggestions) {
      expect(shown.has(String(suggestion.name).toLowerCase())).toBe(false);
    }
  });

  it("says so instead of returning an empty list with no explanation", async () => {
    const started = await post("/api/trips", { rawInput: "college for a lab", withWeather: false });
    const view = (await started.json()) as { trip: { id: string } };
    const body = (await (
      await fetch(`${base}/api/trips/${view.trip.id}/suggestions`)
    ).json()) as { suggestions: unknown[]; note?: string };

    if (body.suggestions.length === 0) expect(body.note).toBeTruthy();
  });
});

describe("example history", () => {
  it("loads, then predicts from what it generated, then refuses to load twice", async () => {
    const before = (await (await fetch(`${base}/api/diagnostics`)).json()) as {
      canLoadExample: boolean;
    };
    expect(before.canLoadExample).toBe(true);

    const loaded = await post("/api/demo");
    expect(loaded.status).toBe(201);
    const body = (await loaded.json()) as { created: { trips: number; decisions: number } };
    expect(body.created.trips).toBeGreaterThan(20);
    expect(body.created.decisions).toBeGreaterThan(100);

    // The point of generating it: a trip now gets real predictions rather than
    // twenty coin flips.
    const started = await post("/api/trips", { rawInput: "college for a lab", withWeather: false });
    const view = (await started.json()) as {
      coldStart: boolean;
      items: Array<{ itemId: string; probability: number; reason: string }>;
    };
    expect(view.coldStart).toBe(false);
    const idCard = view.items.find((item) => item.itemId === "id-card");
    expect(idCard?.probability).toBeGreaterThan(0.8);
    expect(idCard?.reason).toMatch(/confirmed/);

    const after = (await (await fetch(`${base}/api/diagnostics`)).json()) as {
      canLoadExample: boolean;
    };
    expect(after.canLoadExample).toBe(false);

    const again = await post("/api/demo");
    expect(again.status).toBe(409);
  });
});

describe("diagnostics when the store is unreachable", () => {
  it("reports the failure rather than returning a 500 itself", async () => {
    // The realistic cause of this is a deployed store with wrong credentials, a
    // missing table, or the wrong region — and the endpoint you reach for when a
    // deploy is misbehaving must not be the thing that breaks. A 500 here tells
    // you nothing; the message tells you which variable to fix.
    const working = createMemoryStore();
    const broken = {
      ...working,
      listSamples: async (): Promise<never> => {
        throw new Error("The security token included in the request is invalid.");
      },
    };

    const service = createService({
      store: broken,
      agent: createAgentLayer({ CONTEXTPACK_AGENT: "heuristic" }),
      weather: nullWeatherProvider,
    });

    const app = createServer(createApp({ service, store: broken }));
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const port = (app.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        storeError?: string;
        canLoadExample: boolean | null;
      };
      expect(body.storeError).toMatch(/security token/i);
      // History is unknowable while the store is down, so nothing is claimed either
      // way and the UI hides the action instead of offering one that would fail.
      expect(body.canLoadExample).toBeNull();
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
    }
  });
});
