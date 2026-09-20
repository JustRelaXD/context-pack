import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import {
  CATALOG,
  type CreateItemResponse,
  type DemoDataResponse,
  type ItemCategory,
} from "@contextpack/shared";
import type { Service } from "./service";
import { DEFAULT_USER_ID } from "./service";
import { createOfflineService, generateDemoHistory } from "./demo";
import { describeStore, findRepoRoot, type JsonStore, type Store } from "./store";

/**
 * The HTTP surface.
 *
 * Deliberately thin: every route is a couple of lines over `service`, because
 * the interesting logic is the learning loop and it should be readable in one
 * file. Errors are turned into `{ error }` with a real message, since the UI
 * shows them verbatim and a generic 500 would be a worse demo.
 */
export interface AppOptions {
  service: Service;
  store: Store;
  /** Serve the built web app if it exists. Used for single-process demos. */
  serveWeb?: boolean;
}

export function createApp(options: AppOptions) {
  const { service, store } = options;
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "64kb" }));

  const asyncRoute =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };

  const userIdOf = (req: Request): string => {
    const fromQuery = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const fromBody =
      typeof req.body === "object" && req.body !== null && "userId" in req.body
        ? (req.body as { userId?: string }).userId
        : undefined;
    return fromQuery ?? fromBody ?? DEFAULT_USER_ID;
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, store: describeStore(store), now: new Date().toISOString() });
  });

  app.get("/api/catalog", (_req, res) => {
    res.json({ items: CATALOG });
  });

  /** The catalog plus the user's own items — everything the picker offers. */
  app.get(
    "/api/items",
    asyncRoute(async (req, res) => {
      res.json({ items: await service.listItems(userIdOf(req)) });
    }),
  );

  /**
   * Add an item of your own.
   *
   * Answers 201 when a new item was created and 200 when the name matched one
   * that already existed, so the client can say "added" or "you already have
   * that" without a second round trip.
   */
  app.post(
    "/api/items",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { name?: string; emoji?: string; category?: string };
      if (typeof body.name !== "string" || !body.name.trim()) {
        res.status(400).json({ error: "name is required." });
        return;
      }
      const result = await service.createItem({
        userId: userIdOf(req),
        name: body.name,
        ...(typeof body.emoji === "string" ? { emoji: body.emoji } : {}),
        ...(typeof body.category === "string" && isItemCategory(body.category)
          ? { category: body.category }
          : {}),
      });
      const payload: CreateItemResponse = result;
      res.status(result.created ? 201 : 200).json(payload);
    }),
  );

  /**
   * Which layer is answering, and whether each key is present.
   *
   * Reports presence, never values: this endpoint is the one a judge or a
   * screen recording is most likely to open.
   */
  app.get(
    "/api/diagnostics",
    asyncRoute(async (req, res) => {
      const diagnostics = service.diagnostics();
      // "Can I load the example history?" is decided by whether this user has
      // ever decided anything. Asking here means the UI never has to guess and
      // never shows an action that would be refused.
      const learning = await service.learning(userIdOf(req));
      res.json({
        store: describeStore(store),
        weather: diagnostics.weather,
        agent: diagnostics.agent,
        keys: {
          TYPESAFE_API_KEY: Boolean(process.env.TYPESAFE_API_KEY?.trim()),
          TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai",
          GROQ_API_KEY: Boolean((process.env.GROQ_API_KEY ?? process.env.GROK_API_KEY)?.trim()),
          GROQ_MODEL: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-20b",
        },
        resetEnabled: process.env.CONTEXTPACK_ALLOW_RESET === "1",
        canLoadExample: learning.decided === 0,
      });
    }),
  );

  /**
   * Load the example history.
   *
   * This is the answer to "the app is empty and I have nothing to demo". It is
   * refused once the user has decided anything themselves, because mixing a
   * fabricated history into their own would make every count in the app a
   * mixture of truth and fiction.
   *
   * The generator runs through an *offline* service — rule-based parsing, no
   * model calls, explicit weather — so it is a couple of seconds of pure CPU
   * rather than a hundred network round trips, and it produces the same result
   * every time. It shares this app's store, so the data lands where the routes
   * will read it.
   */
  app.post(
    "/api/demo",
    asyncRoute(async (req, res) => {
      const userId = userIdOf(req);
      const existing = await service.learning(userId);
      if (existing.decided > 0) {
        res.status(409).json({
          error: "You already have history of your own, so I won't mix example data into it.",
        });
        return;
      }

      const offline = createOfflineService(store, `demo-${Date.now().toString(36)}`);
      const result = await generateDemoHistory({ service: offline, userId });

      const json = store as Partial<JsonStore>;
      if (typeof json.flush === "function") await json.flush();

      const payload: DemoDataResponse = {
        created: { trips: result.trips, decisions: result.decisions },
        contextGroups: result.contextGroups,
      };
      res.status(201).json(payload);
    }),
  );

  app.post(
    "/api/trips",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as {
        rawInput?: string;
        destination?: string;
        purpose?: string;
        withWeather?: boolean;
      };
      const view = await service.startTrip({
        userId: userIdOf(req),
        rawInput: typeof body.rawInput === "string" ? body.rawInput : "",
        ...(typeof body.destination === "string" ? { destination: body.destination } : {}),
        ...(typeof body.purpose === "string" ? { purpose: body.purpose } : {}),
        ...(typeof body.withWeather === "boolean" ? { withWeather: body.withWeather } : {}),
      });
      res.status(201).json(view);
    }),
  );

  app.get(
    "/api/trips",
    asyncRoute(async (req, res) => {
      const limit = Number(req.query.limit);
      res.json({
        trips: await service.listHistory(
          userIdOf(req),
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 30,
        ),
      });
    }),
  );

  app.get(
    "/api/trips/:id",
    asyncRoute(async (req, res) => {
      const view = await service.getTrip(req.params.id ?? "", userIdOf(req));
      if (!view) {
        res.status(404).json({ error: "No such trip." });
        return;
      }
      res.json(view);
    }),
  );

  /**
   * Candidate items the agent proposes for this trip.
   *
   * Scoped to the trip rather than to a query string on purpose: the context that
   * was actually stored is the one that should be reasoned about, and a client
   * that passed its own destination could drift from what the trip says.
   */
  app.get(
    "/api/trips/:id/suggestions",
    asyncRoute(async (req, res) => {
      res.json(await service.suggestItems({ userId: userIdOf(req), tripId: req.params.id ?? "" }));
    }),
  );

  app.post(
    "/api/trips/:id/feedback",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as {
        itemId?: string;
        action?: string;
        scope?: string;
        reason?: string;
      };
      if (!body.itemId || !body.action) {
        res.status(400).json({ error: "itemId and action are required." });
        return;
      }
      const view = await service.recordFeedback({
        userId: userIdOf(req),
        tripId: req.params.id ?? "",
        itemId: body.itemId,
        action: body.action as "packed" | "not_needed" | "remind_later" | "unanswered",
        ...(body.scope === "recurring" || body.scope === "once" ? { scope: body.scope } : {}),
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
      });
      res.json(view);
    }),
  );

  app.post(
    "/api/trips/:id/exception",
    asyncRoute(async (req, res) => {
      const body = (req.body ?? {}) as { rawInput?: string };
      const result = await service.interpretException({
        userId: userIdOf(req),
        tripId: req.params.id ?? "",
        rawInput: typeof body.rawInput === "string" ? body.rawInput : "",
      });
      res.json(result);
    }),
  );

  app.get(
    "/api/learning",
    asyncRoute(async (req, res) => {
      res.json(await service.learning(userIdOf(req)));
    }),
  );

  app.get(
    "/api/exceptions",
    asyncRoute(async (req, res) => {
      res.json({ exceptions: await service.listExceptions(userIdOf(req)) });
    }),
  );

  app.delete(
    "/api/exceptions/:id",
    asyncRoute(async (req, res) => {
      const removed = await service.clearException(userIdOf(req), req.params.id ?? "");
      if (!removed) {
        res.status(404).json({ error: "No such exception." });
        return;
      }
      res.json({ ok: true });
    }),
  );

  // Wiping the store is a demo convenience, so it is off unless explicitly
  // enabled — an endpoint that deletes everything should never be reachable by
  // default.
  app.post(
    "/api/reset",
    asyncRoute(async (_req, res) => {
      if (process.env.CONTEXTPACK_ALLOW_RESET !== "1") {
        res.status(403).json({
          error: "Reset is disabled. Start the server with CONTEXTPACK_ALLOW_RESET=1 to enable it.",
        });
        return;
      }
      await store.reset();
      res.json({ ok: true });
    }),
  );

  /**
   * Unknown API paths must answer in JSON.
   *
   * Every client call parses its response as JSON, so Express's default HTML
   * 404 page arrives as a confusing parse error in the UI instead of "no such
   * route" — and on a serverless deployment it is indistinguishable from the
   * app being broken. Registered before the static fallback, which deliberately
   * excludes `/api/` anyway.
   */
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "No such API route." });
  });

  if (options.serveWeb) {
    const dist = resolve(findRepoRoot(), "apps", "web", "dist");
    if (existsSync(dist)) {
      app.use(express.static(dist));
      // SPA fallback: anything not under /api is the client's problem to route.
      app.get(/^(?!\/api\/).*/, (_req, res) => {
        res.sendFile(resolve(dist, "index.html"));
      });
    }
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(statusFor(error)).json({ error: error.message });
  });

  return app;
}

/**
 * Which failures are the caller's fault.
 *
 * The service throws plain `Error`s, and most of them are things the user did
 * (a one-letter item name, a trip that doesn't exist) rather than a server fault.
 * Answering 500 to those is not just wrong for monitoring: the UI shows the
 * message either way, so the only effect of the wrong status is a red herring for
 * whoever is debugging the app.
 */
const CLIENT_ERROR = new RegExp(
  [
    "Tell me where",
    "Unknown trip",
    "not in the item catalog",
    "Give the item a name",
    "That name is too long",
    "itemId and action",
  ].join("|"),
);

function statusFor(error: Error): number {
  return CLIENT_ERROR.test(error.message) ? 400 : 500;
}

const ITEM_CATEGORIES: ItemCategory[] = [
  "tech",
  "identity",
  "stationery",
  "clothing",
  "food",
  "sports",
  "misc",
];

function isItemCategory(value: string): value is ItemCategory {
  return (ITEM_CATEGORIES as string[]).includes(value);
}
