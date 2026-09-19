import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { CATALOG } from "@contextpack/shared";
import type { Service } from "./service";
import { DEFAULT_USER_ID } from "./service";
import { describeStore, findRepoRoot, type Store } from "./store";

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

  /**
   * Which layer is answering, and whether each key is present.
   *
   * Reports presence, never values: this endpoint is the one a judge or a
   * screen recording is most likely to open.
   */
  app.get("/api/diagnostics", (_req, res) => {
    const diagnostics = service.diagnostics();
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
    });
  });

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
    const status = /Unknown trip|not in the item catalog|Tell me where/.test(error.message) ? 400 : 500;
    res.status(status).json({ error: error.message });
  });

  return app;
}
