import { randomUUID } from "node:crypto";
import {
  CATALOG,
  CATALOG_BY_ID,
  computePatternGroups,
  contextKey,
  contextLabel,
  defaultPreferences,
  predictForContext,
  unknownItemIds,
  type ConfidenceTier,
  type ConfirmationSource,
  type ContextException,
  type ItemEvidence,
  type Item,
  type LearningOverview,
  type LearningSample,
  type ParsedExceptionView,
  type PatternGroup,
  type Prediction,
  type Trip,
  type TripContext,
  type TripItem,
  type TripItemView,
  type TripSummary,
  type TripView,
  type User,
  type UserAction,
  type WeatherSnapshot,
} from "@contextpack/shared";
import {
  createAgentLayer,
  numbersIntroduced,
  type AgentLayer,
  type AgentSource,
  type ParsedException,
} from "./ai";
import type { Store } from "./store";
import { nullWeatherProvider, weatherTagsFor, type WeatherProvider } from "./weather";

/**
 * The trip lifecycle.
 *
 * This is the only place that writes trips, and the only place that decides how
 * much of the engine's output is worth persisting. Two invariants are enforced
 * here rather than trusted to callers:
 *
 *  1. Predicted probabilities are captured **at prediction time** and stored. If
 *     we recomputed them later from newer history, the history view would
 *     quietly rewrite what the app actually told the user that morning — and the
 *     whole "did it warn me correctly?" question would become unanswerable.
 *  2. Only user decisions count as evidence. Rows we created on the user's
 *     behalf are written as `unanswered` + `inferred` and never reach the
 *     predictor's statistics.
 */

export const DEFAULT_USER_ID = "local-user";

/** How many predictions we show and therefore persist on a trip. */
export const DISPLAY_LIMIT = 12;

/** Below this we do not even store the row; it would be noise in history. */
const STORE_FLOOR = 0.4;

/** At most this many alerts get a model-phrased reason, to bound latency. */
const MAX_REWRITES = 3;

// The response shapes live in `shared` so the UI compiles against the exact
// contract the server produces. Re-exported here because most callers import
// them from the service they got them from.
export type { TripItemView, TripSummary, TripView, LearningOverview };

export interface ServiceDeps {
  store: Store;
  agent?: AgentLayer;
  weather?: WeatherProvider;
  now?: () => Date;
  /** Deterministic ids make the seed script reproducible. */
  newId?: () => string;
}

export interface RecordFeedbackInput {
  userId?: string;
  tripId: string;
  itemId: string;
  action: UserAction;
  /** Only meaningful for `not_needed`. Defaults to today only. */
  scope?: "once" | "recurring";
  reason?: string;
}

export interface StartTripInput {
  rawInput: string;
  userId?: string;
  /** Explicit overrides, for when the UI already knows the answer. */
  destination?: string;
  purpose?: string;
  /** Ask Open-Meteo for conditions at the destination. */
  withWeather?: boolean;
  /**
   * Force a specific weather snapshot instead of looking it up. Used by the seed
   * script and by the demo when we need rain on demand, since a live forecast is
   * not something you can rehearse. Passing `null` means "no weather today".
   */
  weather?: WeatherSnapshot | null;
}

export function createService(deps: ServiceDeps) {
  const { store } = deps;
  const agent = deps.agent ?? createAgentLayer();
  const weather = deps.weather ?? nullWeatherProvider;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());

  async function ensureUser(userId: string, displayName = "You"): Promise<User> {
    const existing = await store.getUser(userId);
    if (existing) return existing;
    const user: User = {
      id: userId,
      displayName,
      createdAt: now().toISOString(),
      preferences: { ...defaultPreferences },
    };
    return store.putUser(user);
  }

  /**
   * Run the engine over a context and attach the agent's phrasing where it is
   * allowed to affect what the user reads.
   */
  async function predictionsFor(
    context: TripContext,
    user: User,
    samples: LearningSample[],
    exceptions: ContextException[],
  ): Promise<{ predictions: Prediction[]; coldStart: boolean }> {
    const predictions = predictForContext({
      context,
      history: samples,
      catalog: CATALOG,
      exceptions,
      preferences: user.preferences,
      now: now(),
    });
    // "Cold start" means the engine had nothing to learn from, so every number
    // below is a stated guess of 50%. The UI says so rather than dressing it up.
    const coldStart = usableSamples(samples).length === 0;

    // Only the alerts are worth the latency of a rewrite: those are the only
    // ones we interrupt someone with.
    const toRewrite = predictions.filter((prediction) => prediction.alert).slice(0, MAX_REWRITES);
    await Promise.all(
      toRewrite.map(async (prediction) => {
        const allowed = allowedNumbers(prediction);
        try {
          const rewritten = await agent.reasonPhraser.phrase(prediction.reason, allowed);
          if (rewritten.trim() && numbersIntroduced(rewritten, allowed).length === 0) {
            prediction.reason = rewritten.trim();
            prediction.reasonSource = "rewritten";
          }
        } catch {
          // Keep the deterministic sentence. Never let phrasing break a trip.
        }
      }),
    );

    return { predictions, coldStart };
  }

  function allowedNumbers(prediction: Prediction): number[] {
    const numbers = [
      prediction.evidence.observations,
      prediction.evidence.confirmations,
      Math.round(prediction.probability * 100),
    ];
    if (prediction.evidence.coOccurrence) numbers.push(prediction.evidence.coOccurrence.trips);
    return numbers.filter((value) => Number.isFinite(value));
  }

  async function viewFor(tripId: string, userId: string): Promise<TripView | null> {
    const trip = await store.getTrip(tripId);
    if (!trip || trip.userId !== userId) return null;

    const [user, samples, exceptions, rows] = await Promise.all([
      ensureUser(userId),
      store.listSamples(userId),
      store.listExceptions(userId),
      store.listTripItems(tripId),
    ]);

    const { predictions, coldStart } = await predictionsFor(trip.context, user, samples, exceptions);
    const byId = new Map(predictions.map((prediction) => [prediction.itemId, prediction]));

    const items: TripItemView[] = [];
    for (const row of rows) {
      const item = CATALOG_BY_ID.get(row.itemId);
      if (!item) continue;
      const prediction = byId.get(row.itemId);
      items.push(toView(row, item, prediction));
    }
    items.sort((a, b) => b.predictedProbability - a.predictedProbability);

    return {
      trip,
      items,
      alerts: items.filter((item) => item.alert && item.userAction === "unanswered"),
      contextSource: tripContextSource(trip),
      weather: trip.context.weather ?? null,
      coldStart,
    };
  }

  function tripContextSource(trip: Trip): AgentSource {
    return trip.contextSource ?? "heuristic";
  }

  /**
   * Enrich a parsed correction with the item's display name.
   *
   * The UI says "Got it — no laptop today", and doing that lookup here keeps the
   * item catalog in one place instead of shipping it to the client twice.
   */
  function toParsedView(parsed: ParsedException | null): ParsedExceptionView | null {
    if (!parsed) return null;
    return {
      itemId: parsed.itemId,
      itemName: CATALOG_BY_ID.get(parsed.itemId)?.name ?? parsed.itemId,
      action: parsed.action,
      scope: parsed.scope,
      reason: parsed.reason,
      source: parsed.source,
    };
  }

  function toView(row: TripItem, item: Item, prediction: Prediction | undefined): TripItemView {
    return {
      itemId: row.itemId,
      item,
      probability: prediction?.probability ?? row.predictedProbability,
      predictedProbability: row.predictedProbability,
      userAction: row.userAction,
      confirmationSource: row.confirmationSource,
      ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
      alert: prediction?.alert ?? false,
      analogous: prediction?.analogous ?? false,
      alertSuppressed: prediction?.alertSuppressed ?? false,
      confidence: prediction?.confidence ?? "low",
      reason: prediction?.reason ?? "You added this yourself, so I have nothing to predict.",
      reasonSource: prediction?.reasonSource ?? "engine",
      evidence: prediction?.evidence ?? {
        itemId: row.itemId,
        primaryScope: "global",
        probability: row.predictedProbability,
        observations: 0,
        confirmations: 0,
        evidenceMass: 0,
        exceptions: 0,
        weatherRelevant: false,
      },
      unpredicted: !prediction,
    };
  }

  /**
   * Is this prediction actually about *this* trip?
   *
   * An item whose entire support comes from the global scope is a statement
   * about the person, not about the outing — "you generally carry headphones"
   * would otherwise surface as a 90% prediction for a lab, which is exactly the
   * kind of unfounded claim that makes people stop trusting the list. We keep
   * showing those items while we know nothing at all (`observations === 0` is
   * the cold-start bootstrap), and drop them once we have real history to use.
   */
  function isAboutThisTrip(prediction: Prediction): boolean {
    return prediction.evidence.observations === 0 || prediction.evidence.primaryScope !== "global";
  }

  /** Trips that have at least one decided row — the only ones that teach us anything. */
  function usableSamples(samples: LearningSample[]): LearningSample[] {
    return samples.filter((sample) =>
      sample.items.some((item) => item.action === "packed" || item.action === "not_needed"),
    );
  }

  /**
   * Record a decision on one item.
   *
   * `scope` only applies to "not needed": it decides whether we treat it as a
   * one-off for today or as a durable rule. Defaulting to today is deliberate —
   * generalising "not today" into "never" is the single most annoying thing a
   * system like this can do.
   */
  const recordFeedback = async (args: RecordFeedbackInput): Promise<TripView> => {
    const userId = args.userId ?? DEFAULT_USER_ID;
    const trip = await store.getTrip(args.tripId);
    if (!trip || trip.userId !== userId) throw new Error("Unknown trip.");
    const item = CATALOG_BY_ID.get(args.itemId);
    if (!item) throw new Error(`"${args.itemId}" is not in the item catalog.`);

    const existing = (await store.listTripItems(trip.id)).find(
      (row) => row.itemId === args.itemId,
    );

    // Re-derive the prediction so an item the user adds by hand still records
    // what the engine thought of it, instead of a misleading zero.
    let probability = existing?.predictedProbability ?? 0;
    if (!existing) {
      const [user, samples, exceptions] = await Promise.all([
        ensureUser(userId),
        store.listSamples(userId),
        store.listExceptions(userId),
      ]);
      const { predictions } = await predictionsFor(trip.context, user, samples, exceptions);
      probability =
        predictions.find((prediction) => prediction.itemId === args.itemId)?.probability ?? 0;
    }

    await store.putTripItem({
      tripId: trip.id,
      itemId: args.itemId,
      predictedProbability: probability,
      userAction: args.action,
      confirmationSource: confirmationSourceFor(args.action),
      ...(args.action === "remind_later" ? {} : { decidedAt: now().toISOString() }),
    });

    // "Not needed" is also an *exception*: it is what stops us re-alerting today
    // and what teaches the recurring patterns later.
    if (args.action === "not_needed") {
      await store.putException({
        id: newId(),
        userId,
        itemId: args.itemId,
        contextKey: contextKey(trip.context),
        scope: args.scope ?? "once",
        reason: args.reason ?? `Marked not needed for ${contextLabel(trip.context)}.`,
        createdAt: now().toISOString(),
      });
    }

    const view = await viewFor(trip.id, userId);
    if (!view) throw new Error("Trip disappeared while recording feedback.");
    return view;
  };

  return {
    ensureUser,

    /** Diagnostics for the UI banner: which layer is actually answering. */
    diagnostics() {
      return {
        agent: agent.diagnostics(),
        weather: weather.describe(),
      };
    },

    /**
     * Start a trip: understand the input, look outside if asked, predict, then
     * persist both the trip and the snapshot of what we told the user.
     */
    async startTrip(input: StartTripInput): Promise<TripView> {
      const userId = input.userId ?? DEFAULT_USER_ID;
      const user = await ensureUser(userId);
      const rawInput = input.rawInput.trim();
      if (!rawInput && !input.destination) {
        throw new Error("Tell me where you're going — for example \"college for a lab\".");
      }

      const samples = await store.listSamples(userId);
      const known = {
        destinations: [...new Set(samples.map((sample) => sample.context.destination))],
        purposes: [
          ...new Set(
            samples
              .map((sample) => sample.context.purpose)
              .filter((purpose): purpose is string => Boolean(purpose)),
          ),
        ],
      };

      let contextSource: AgentSource = "heuristic";
      let context: TripContext = {
        destination: "somewhere",
        tags: [],
      };

      if (rawInput) {
        try {
          const extracted = await agent.contextExtractor.extract(rawInput, known);
          context = {
            destination: extracted.destination,
            ...(extracted.purpose ? { purpose: extracted.purpose } : {}),
            tags: extracted.tags,
          };
          contextSource = extracted.source;
        } catch {
          // The heuristic extractor is the fallback, but if the *whole* layer
          // failed we still must not lose the trip: keep the raw text.
          context = { destination: rawInput.toLowerCase(), tags: [] };
        }
      }
      if (input.destination) {
        context.destination = input.destination.trim().toLowerCase();
        contextSource = "heuristic";
      }
      if (input.purpose !== undefined) {
        const purpose = input.purpose.trim().toLowerCase();
        if (purpose) context.purpose = purpose;
        else delete context.purpose;
      }

      let weatherSnapshot: WeatherSnapshot | null = null;
      if (input.weather !== undefined) {
        weatherSnapshot = input.weather;
      } else if (input.withWeather !== false) {
        weatherSnapshot = await weather.lookup(context.destination);
      }
      if (weatherSnapshot) {
        context.weather = weatherSnapshot;
        const tags = new Set(context.tags);
        for (const tag of weatherTagsFor(weatherSnapshot)) tags.add(tag);
        context.tags = [...tags];
      }

      const trip: Trip = {
        id: newId(),
        userId,
        rawInput: rawInput || contextLabel(context),
        context,
        startedAt: now().toISOString(),
        // The shared model only knows the two implementations that can read a
        // context; anything else is reported as the rule-based path.
        contextSource: contextSource === "jev" ? "jev" : "heuristic",
      };

      const exceptions = await store.listExceptions(userId);
      const { predictions, coldStart } = await predictionsFor(context, user, samples, exceptions);

      // Persist exactly what the user will see, plus anything the user has a
      // standing interest in. The floor keeps a 12%-probability guess out of the
      // record, where it would be indistinguishable from a real prediction.
      const toStore = predictions
        .filter((prediction, index) => index < DISPLAY_LIMIT || prediction.alert)
        .filter((prediction) => prediction.probability >= STORE_FLOOR)
        .filter(isAboutThisTrip);

      await store.putTrip(trip);
      for (const prediction of toStore) {
        await store.putTripItem({
          tripId: trip.id,
          itemId: prediction.itemId,
          predictedProbability: prediction.probability,
          userAction: "unanswered",
          confirmationSource: "inferred",
        });
      }

      const view = await viewFor(trip.id, userId);
      if (!view) throw new Error("Trip was written but could not be read back.");
      return { ...view, contextSource, weather: weatherSnapshot, coldStart };
    },

    getTrip: (tripId: string, userId: string = DEFAULT_USER_ID) => viewFor(tripId, userId),

    recordFeedback,

    /**
     * Understand a natural-language correction ("I don't need my laptop today")
     * and apply it. Returns `parsed: null` when the sentence was not an
     * exception, so the UI can say so rather than guessing.
     */
    async interpretException(args: {
      userId?: string;
      tripId: string;
      rawInput: string;
    }): Promise<{ parsed: ParsedExceptionView | null; view: TripView }> {
      const userId = args.userId ?? DEFAULT_USER_ID;
      const trip = await store.getTrip(args.tripId);
      if (!trip || trip.userId !== userId) throw new Error("Unknown trip.");

      let parsed: ParsedException | null = null;
      try {
        parsed = await agent.exceptionParser.parse(args.rawInput, CATALOG);
      } catch {
        parsed = null;
      }

      const view = await viewFor(trip.id, userId);
      if (!view) throw new Error("Trip disappeared while interpreting.");

      if (!parsed) return { parsed: null, view };

      if (parsed.action === "mark_not_needed") {
        const updated = await recordFeedback({
          userId,
          tripId: trip.id,
          itemId: parsed.itemId,
          action: "not_needed",
          scope: parsed.scope,
          reason: parsed.reason,
        });
        return { parsed: toParsedView(parsed), view: updated };
      }

      if (parsed.action === "mark_needed") {
        const updated = await recordFeedback({
          userId,
          tripId: trip.id,
          itemId: parsed.itemId,
          action: "packed",
          reason: parsed.reason,
        });
        return { parsed: toParsedView(parsed), view: updated };
      }

      return { parsed: toParsedView(parsed), view };
    },

    async listExceptions(userId = DEFAULT_USER_ID): Promise<ContextException[]> {
      return store.listExceptions(userId);
    },

    async clearException(userId: string, exceptionId: string): Promise<boolean> {
      return store.deleteException(userId, exceptionId);
    },

    async listHistory(userId = DEFAULT_USER_ID, limit = 30): Promise<TripSummary[]> {
      const trips = await store.listTrips(userId, limit);
      const summaries: TripSummary[] = [];
      for (const trip of trips) {
        const rows = await store.listTripItems(trip.id);
        summaries.push({
          id: trip.id,
          rawInput: trip.rawInput,
          context: trip.context,
          startedAt: trip.startedAt,
          packed: rows.filter((row) => row.userAction === "packed").length,
          notNeeded: rows.filter((row) => row.userAction === "not_needed").length,
          unanswered: rows.filter((row) => row.userAction === "unanswered").length,
          highlights: rows
            .filter((row) => row.userAction === "packed")
            .sort((a, b) => b.predictedProbability - a.predictedProbability)
            .slice(0, 4)
            .flatMap((row) => {
              const item = CATALOG_BY_ID.get(row.itemId);
              return item
                ? [
                    {
                      itemId: item.id,
                      name: item.name,
                      emoji: item.emoji,
                      probability: row.predictedProbability,
                    },
                  ]
                : [];
            }),
        });
      }
      return summaries;
    },

    /** The "what I've learned" screen, derived from the same records as predictions. */
    async learning(userId = DEFAULT_USER_ID): Promise<LearningOverview> {
      const samples = await store.listSamples(userId);
      const usable = usableSamples(samples);
      const groups = computePatternGroups(usable, CATALOG);

      let decided = 0;
      let confirmed = 0;
      for (const sample of usable) {
        for (const entry of sample.items) {
          if (entry.action !== "packed" && entry.action !== "not_needed") continue;
          decided += 1;
          if (entry.action === "packed") confirmed += 1;
        }
      }

      return {
        trips: usable.length,
        decided,
        confirmed,
        confirmRate: decided === 0 ? 0 : confirmed / decided,
        groups,
        unknownItems: unknownItemIds(samples, CATALOG),
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;

/**
 * How much we trust that an item was present.
 *
 * Only "the user told us they packed it" may be counted as fact. A "not needed"
 * is us inferring absence from their statement, and everything else is silence.
 * Keeping this distinction in one function is what stops a future refactor from
 * quietly claiming we detected physical objects.
 */
export function confirmationSourceFor(action: UserAction): ConfirmationSource {
  return action === "packed" ? "confirmed" : "inferred";
}
