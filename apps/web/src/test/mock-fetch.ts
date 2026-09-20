import { vi } from "vitest";
import { catalog, diagnostics as diagnosticsFixture, learning as learningFixture } from "./fixtures";

/**
 * A fetch stand-in that answers the API's real routes.
 *
 * The point is to exercise the UI's own wiring — tabs, loading, optimistic taps,
 * error handling — without a server or a browser. Responses are shaped exactly
 * like the server's, because they are typed with the same shared contract.
 */
export interface MockApiOptions {
  trips?: unknown;
  startTrip?: unknown;
  feedback?: unknown;
  getTrip?: unknown;
  interpret?: unknown;
  learning?: unknown;
  exceptions?: unknown;
  diagnostics?: unknown;
  /** GET /api/items — the list. */
  items?: unknown;
  /** POST /api/items — the single created item. */
  createdItem?: unknown;
  suggestions?: unknown;
  demo?: unknown;
  reset?: unknown;
  /** Fail every request, to check the UI surfaces the server's message. */
  failWith?: string;
}

export function installMockFetch(options: MockApiOptions = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];

  const respond = (body: unknown, status = 200) =>
    Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    } as Response);

  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    if (options.failWith) {
      return respond({ error: options.failWith }, 400);
    }

    // Defaults are the real shapes, never `{}`. A mock that returns an empty
    // object is a mock that lies, and it hides wiring bugs — one of these
    // defaults crashed the whole app when it was `{}`.
    if (url.startsWith("/api/diagnostics")) return respond(options.diagnostics ?? diagnosticsFixture());
    if (url.startsWith("/api/learning")) return respond(options.learning ?? learningFixture());
    if (url.startsWith("/api/exceptions")) return respond(options.exceptions ?? { exceptions: [] });
    if (url.startsWith("/api/items")) {
      if (method === "POST") {
        return respond(options.createdItem ?? { item: catalog()[0], created: true }, 201);
      }
      return respond(options.items ?? { items: catalog() });
    }
    if (url.startsWith("/api/demo")) return respond(options.demo ?? { created: { trips: 56, decisions: 304 }, contextGroups: 4 }, 201);
    if (url.startsWith("/api/reset")) return respond(options.reset ?? { ok: true });
    if (url.includes("/exception")) return respond(options.interpret ?? { parsed: null, view: {} });
    if (url.includes("/suggestions")) {
      return respond(options.suggestions ?? { suggestions: [], source: "heuristic" });
    }
    if (url.includes("/feedback")) return respond(options.feedback ?? {});
    if (url.startsWith("/api/trips?")) return respond(options.trips ?? { trips: [] });
    if (url === "/api/trips") {
      if (method === "POST") return respond(options.startTrip ?? {}, 201);
      return respond(options.trips ?? { trips: [] });
    }
    if (url.startsWith("/api/trips/")) return respond(options.getTrip ?? options.feedback ?? {});
    return respond({ error: `unmocked ${method} ${url}` }, 404);
  });

  vi.stubGlobal("fetch", impl);
  return { calls, impl };
}
