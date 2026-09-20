import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import handler, { withApiPrefix } from "./vercel";

/**
 * These tests exist because this exact file was broken in production.
 *
 * The deployment returned `FUNCTION_INVOCATION_FAILED` on every path, including
 * `/api/health` — the signature of a function that dies while loading rather
 * than while handling. The cause was the entry point: importing the server's
 * `index.ts` starts a listener and exports nothing, and a serverless platform
 * needs an exported handler. Nothing in the suite caught it, because every other
 * test imported `createApp` directly and never went through the entry.
 *
 * So this goes through the entry, over a real socket, using the platform's own
 * calling convention: hand the exported default a request and a response.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  // The handler builds its store lazily on first invocation, so setting this
  // here is enough — and it keeps the test off the developer's real data file.
  process.env.CONTEXTPACK_STORE = "memory";
  process.env.CONTEXTPACK_WEATHER = "off";

  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("serverless entry point", () => {
  it("answers the health check instead of failing to invoke", async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; store: { adapter: string; durable: boolean } };
    expect(body.ok).toBe(true);
    // No filesystem in a function, so memory is the correct adapter here.
    expect(body.store.adapter).toBe("memory");
    expect(body.store.durable).toBe(false);
  });

  it("serves the catalog and diagnostics", async () => {
    const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as { items: unknown[] };
    expect(catalog.items.length).toBeGreaterThan(0);

    const diagnostics = await fetch(`${base}/api/diagnostics`);
    expect(diagnostics.status).toBe(200);
  });

  it("runs a whole trip through the deployed entry point", async () => {
    const started = await fetch(`${base}/api/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawInput: "college for a lab", withWeather: false }),
    });
    expect(started.status).toBe(201);

    const view = (await started.json()) as {
      trip: { id: string };
      items: Array<{ itemId: string; probability: number }>;
      coldStart: boolean;
    };
    expect(view.trip.id).toBeTruthy();
    expect(view.items.length).toBeGreaterThan(0);
    // Nothing learned in a fresh in-memory store, and it must say so.
    expect(view.coldStart).toBe(true);

    const decided = await fetch(`${base}/api/trips/${view.trip.id}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: "laptop", action: "packed" }),
    });
    expect(decided.status).toBe(200);
  });

  it("returns JSON errors rather than an HTML error page", async () => {
    const response = await fetch(`${base}/api/definitely-not-a-route`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  /**
   * The platform's rewrite routes `/api/*` here, but a rewrite is permitted to
   * pass the *destination* path, which would leave Express looking at `/health`
   * and 404ing everything. The entry normalises it, so the deploy is correct
   * whichever way the platform behaves — a difference worth pinning down here,
   * because it is invisible locally and unambiguous in production.
   */
  it("answers the same route with the /api prefix stripped off", async () => {
    const stripped = await fetch(`${base}/health`);
    expect(stripped.status).toBe(200);
    const body = (await stripped.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("withApiPrefix", () => {
  it.each([
    ["/api/health", "/api/health"],
    ["/api/trips/abc/feedback", "/api/trips/abc/feedback"],
    ["/api", "/api"],
    ["/api?limit=5", "/api?limit=5"],
    ["/health", "/api/health"],
    ["/trips/abc", "/api/trips/abc"],
    ["/", "/api"],
    [undefined, "/api"],
    ["health", "/api/health"],
  ])("normalises %s to %s", (input, expected) => {
    expect(withApiPrefix(input)).toBe(expected);
  });
});
