import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { createAgentLayer } from "./ai";
import { createApp } from "./app";
import { createService } from "./service";
import { createStore, describeStore } from "./store";
import { createWeatherProviderFromEnv } from "./weather";

/**
 * Serverless entry point (Vercel).
 *
 * This exists separately from `index.ts` because the two have opposite
 * requirements. `index.ts` is a long-lived process: it binds a port, loads a
 * `.env` file, traps signals and flushes a file store on exit. None of that
 * exists in a serverless invocation, where the platform hands us a request and
 * expects a response from an exported value. Importing `index.ts` into a
 * function would try to `listen()` on a port nobody is watching and export
 * nothing — which is exactly the `FUNCTION_INVOCATION_FAILED` this file fixes.
 *
 * Two deliberate choices:
 *
 *  1. **Lazy construction.** The app is built on the first invocation, not at
 *     import. A throw during a module-level import is swallowed by the platform
 *     into an opaque 500; building inside the handler means we can return the
 *     actual message, which is the difference between a two-minute fix and an
 *     hour of guessing. The result is cached, so it is still built once per
 *     warm instance.
 *  2. **No `serveWeb`.** Static assets are not part of a function bundle. Vercel
 *     serves the built UI from its CDN (see `vercel.json`); this handler only
 *     answers `/api/*`.
 */

let cached: Express | null = null;

function build(): Express {
  const store = createStore();
  const agent = createAgentLayer();
  const weather = createWeatherProviderFromEnv();
  const service = createService({ store, agent, weather });
  const described = describeStore(store);

  console.log(
    `[contextpack] serverless store=${described.adapter}` +
      `${described.durable ? "" : " (volatile — state does not persist between invocations)"}`,
  );

  return createApp({ service, store, serveWeb: false });
}

function application(): Express {
  if (!cached) cached = build();
  return cached;
}

/**
 * Make the incoming path look the way the Express routes expect.
 *
 * The platform's rewrite sends `/api/*` to this function, but a rewrite is
 * allowed to hand the function the *destination* path instead of the original
 * one. Express routes here are absolute (`/api/health`), so normalising once at
 * the entry is better than registering every route twice or discovering the
 * difference as a wall of 404s after deploying.
 */
function withApiPrefix(url: string | undefined): string {
  if (!url || url === "/") return "/api";
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) return url;
  return `/api${url.startsWith("/") ? url : `/${url}`}`;
}

/** Vercel's Node runtime calls this with Node's request and response objects. */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  req.url = withApiPrefix(req.url);
  try {
    // An Express app *is* a request listener; the cast is only because Express
    // types its own Request/Response subtypes more narrowly than the platform
    // hands them to us.
    (application() as unknown as (request: IncomingMessage, response: ServerResponse) => void)(
      req,
      res,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[contextpack] failed to handle request:", detail);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: "ContextPack failed to start in this environment.",
          detail,
          hints: [
            "A read-only filesystem cannot use CONTEXTPACK_STORE=json; use memory.",
            "Set TYPESAFE_API_KEY and GROQ_API_KEY as environment variables if you want them.",
          ],
        }),
      );
    }
  }
}

/** Exposed so the entry can be exercised in tests without a platform. */
export { application as createServerlessApp };

/** Exposed so the prefix handling can be tested directly. */
export { withApiPrefix };
