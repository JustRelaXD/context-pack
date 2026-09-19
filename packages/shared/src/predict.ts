import { BOOTSTRAP_ITEM_IDS } from "./catalog";
import { explainPrediction } from "./explain";
import { contextKey, contextLabel, destinationOf, normalizeToken, scopeOf, weatherTag } from "./normalize";
import type {
  ConfidenceTier,
  ContextException,
  CoOccurrenceEvidence,
  EvidenceScope,
  Item,
  LearningSample,
  Prediction,
  TripContext,
  UserPreferences,
} from "./types";

/**
 * How much each evidence scope counts for.
 *
 * These weights are the whole learning model. They are deliberately simple and
 * readable: a lab trip you logged yesterday should not be outvoted by a
 * thousand unrelated trips, but unrelated trips should still nudge a guess for
 * a destination we have never seen.
 *
 * `sibling` outranks `destination` on purpose. Same *kind of outing* at a new
 * place is a better guide to what you carry than the same building for a
 * different reason — a hackathon you have never attended predicts your project
 * night habits better than your campus sports trips do.
 */
export const SCOPE_WEIGHTS: Record<EvidenceScope, number> = {
  exact: 1,
  sibling: 0.5,
  destination: 0.35,
  global: 0.15,
};

/** Fallback rate for an item we have never observed anywhere. */
const DEFAULT_PRIOR = 0.35;

/**
 * How strongly the global rate is itself pulled toward `DEFAULT_PRIOR`.
 *
 * Without this, an item packed on every trip so far would produce a prior of
 * exactly 1.0 and the app would claim 100% certainty. Keeping a small neutral
 * residue means we never quite reach certainty, which is the honest position.
 */
const GLOBAL_PRIOR_WEIGHT = 2;

const HIGH_EVIDENCE_MASS = 6;
const MEDIUM_EVIDENCE_MASS = 2.5;

/** Cold start: an honest coin-flip, not a recommendation. */
const COLD_START_PROBABILITY = 0.5;

/** A recurring exception multiplies the probability by this factor. */
const EXACT_EXCEPTION_DAMPING = 0.5;
const RELATED_EXCEPTION_DAMPING = 0.85;

/** Co-occurrence is only worth mentioning once it has happened a few times. */
const MIN_CO_OCCURRENCE_TRIPS = 2;

/**
 * How many weather-matched trips we need before conditioning on the weather.
 *
 * Below this we keep the all-weather estimate. A single rainy trip is not a
 * pattern, and — just as important — a number that moved because of the weather
 * must be a number the explanation can justify mentioning it for.
 */
const MIN_WEATHER_OBSERVATIONS = 2;

/** The weather states we can condition on. `undefined` means "not known". */
export type WeatherState = "clear" | "rain" | "snow" | "hot" | "cold";

export interface PredictInput {
  context: TripContext;
  history: LearningSample[];
  catalog: Item[];
  exceptions?: ContextException[];
  preferences: UserPreferences;
  now?: Date;
}

interface ScopeCounts {
  weightedObserved: number;
  weightedConfirmed: number;
  rawObserved: number;
  rawConfirmed: number;
}

/** Scopes ordered most specific first. Order matters — see `primaryScope`. */
const ALL_SCOPES = ["exact", "destination", "sibling", "global"] as const;

function emptyScopeCounts(): Record<EvidenceScope, ScopeCounts> {
  return {
    exact: { weightedObserved: 0, weightedConfirmed: 0, rawObserved: 0, rawConfirmed: 0 },
    destination: { weightedObserved: 0, weightedConfirmed: 0, rawObserved: 0, rawConfirmed: 0 },
    sibling: { weightedObserved: 0, weightedConfirmed: 0, rawObserved: 0, rawConfirmed: 0 },
    global: { weightedObserved: 0, weightedConfirmed: 0, rawObserved: 0, rawConfirmed: 0 },
  };
}

/** Actions that tell us something. `remind_later` / `unanswered` tell us nothing. */
function isDecided(action: string): boolean {
  return action === "packed" || action === "not_needed";
}

export function predictForContext(input: PredictInput): Prediction[] {
  const { context, history, catalog, preferences } = input;
  const exceptions = input.exceptions ?? [];
  const now = input.now ?? new Date();

  const itemsById = new Map(catalog.map((item) => [item.id, item] as const));
  const usable = history.filter((sample) => sample.items.some((item) => isDecided(item.action)));

  if (usable.length === 0) return coldStart(context, catalog);

  const globalStats = tallyGlobal(usable);

  const candidateIds = new Set<string>(BOOTSTRAP_ITEM_IDS);
  for (const sample of usable) {
    for (const entry of sample.items) {
      if (isDecided(entry.action)) candidateIds.add(entry.itemId);
    }
  }

  const predictions: Prediction[] = [];
  for (const itemId of candidateIds) {
    const item = itemsById.get(itemId);
    if (!item) continue;
    const prediction = scoreItem({
      item,
      context,
      usable,
      itemsById,
      exceptions,
      preferences,
      globalStats,
      now,
    });
    if (prediction) predictions.push(prediction);
  }

  return predictions.sort((a, b) => b.probability - a.probability);
}

function tallyGlobal(
  samples: LearningSample[],
): Map<string, { rawObserved: number; rawConfirmed: number }> {
  const stats = new Map<string, { rawObserved: number; rawConfirmed: number }>();
  for (const sample of samples) {
    for (const entry of sample.items) {
      if (!isDecided(entry.action)) continue;
      const current = stats.get(entry.itemId) ?? { rawObserved: 0, rawConfirmed: 0 };
      current.rawObserved += 1;
      if (entry.action === "packed") current.rawConfirmed += 1;
      stats.set(entry.itemId, current);
    }
  }
  return stats;
}

interface ScoreItemInput {
  item: Item;
  context: TripContext;
  usable: LearningSample[];
  itemsById: Map<string, Item>;
  exceptions: ContextException[];
  preferences: UserPreferences;
  globalStats: Map<string, { rawObserved: number; rawConfirmed: number }>;
  now: Date;
}

function scoreItem(input: ScoreItemInput): Prediction | null {
  const { item, context, usable, itemsById, exceptions, preferences, globalStats, now } = input;

  const counts = emptyScopeCounts();
  const confirmedSamples: LearningSample[] = [];

  for (const sample of usable) {
    const entry = sample.items.find((candidate) => candidate.itemId === item.id);
    if (!entry || !isDecided(entry.action)) continue;

    const scope = scopeOf(context, sample.context);
    const weight = SCOPE_WEIGHTS[scope];
    const bucket = counts[scope];
    bucket.weightedObserved += weight;
    bucket.rawObserved += 1;

    if (entry.action === "packed") {
      bucket.weightedConfirmed += weight;
      bucket.rawConfirmed += 1;
      confirmedSamples.push(sample);
    }
  }

  let totalWeightedObserved = 0;
  let totalWeightedConfirmed = 0;
  for (const scope of ALL_SCOPES) {
    const bucket = counts[scope];
    totalWeightedObserved += bucket.weightedObserved;
    totalWeightedConfirmed += bucket.weightedConfirmed;
  }

  if (totalWeightedObserved === 0) return null;

  /**
   * The most *specific* scope we actually have evidence at.
   *
   * Chosen by specificity, not by weight. Weight favours whichever bucket has
   * accumulated the most, which means a long global history eventually outranks
   * the two lab trips that genuinely answer the question — and then the
   * explanation quotes the wrong thing and the alert gate closes on evidence we
   * do have. If nothing specific exists, this is `global` and we say so.
   */
  const primaryScope: EvidenceScope =
    ALL_SCOPES.find((scope) => counts[scope].rawObserved > 0) ?? "global";
  const rawObserved = counts[primaryScope].rawObserved;
  const rawConfirmed = counts[primaryScope].rawConfirmed;

  // Hierarchical smoothing: lean on the global rate when evidence is thin, and
  // step out of the way as real observations accumulate. This is what makes the
  // 50% -> 96% learning curve behave sensibly instead of jumping to 100%.
  const global = globalStats.get(item.id);
  const globalObserved = global?.rawObserved ?? 0;
  const globalConfirmed = global?.rawConfirmed ?? 0;
  // When the *only* evidence is the global rate, using that rate as its own
  // prior compounds one observation into false confidence — the estimator would
  // agree with itself. Shrink toward a neutral prior instead.
  const priorRate =
    primaryScope === "global"
      ? DEFAULT_PRIOR
      : (globalConfirmed + DEFAULT_PRIOR * GLOBAL_PRIOR_WEIGHT) /
        (globalObserved + GLOBAL_PRIOR_WEIGHT);
  const scopeObservedTotal = sumObserved(counts);
  const priorWeight = 1 + 1 / (1 + scopeObservedTotal);

  const baseProbability =
    (totalWeightedConfirmed + priorRate * priorWeight) /
    (totalWeightedObserved + priorWeight);
  let probability = baseProbability;

  // Condition on today's weather. This is the difference between "you usually
  // take an umbrella" and "you take an umbrella when it rains" — the second is
  // the claim we make on stage, so it has to be what the arithmetic does. The
  // all-weather estimate becomes the prior, so a thin weather subset shrinks
  // back toward it instead of swinging wildly on one wet afternoon.
  const weatherSubset = weatherSubsetCounts(item, context, usable);
  const weatherStats =
    preferences.useWeather && weatherSubset.observed >= MIN_WEATHER_OBSERVATIONS
      ? weatherConditionalStats(item, context, usable)
      : undefined;
  if (weatherStats) {
    const weatherPriorWeight = 1 + 1 / (1 + weatherStats.mass);
    probability =
      (weatherStats.confirmed + baseProbability * weatherPriorWeight) /
      (weatherStats.mass + weatherPriorWeight);
  }

  // Recurring exceptions ("Fridays: no laptop") damp a prediction rather than
  // erasing it, because the user might still want the reminder on other days.
  const key = contextKey(context);
  const exceptionsForItem = exceptions.filter((exception) => exception.itemId === item.id);
  let recurringMatches = 0;
  for (const exception of exceptionsForItem) {
    if (exception.scope !== "recurring") continue;
    if (exception.contextKey === key) {
      probability *= EXACT_EXCEPTION_DAMPING;
      recurringMatches += 1;
    } else if (destinationOf(exception.contextKey) === destinationOf(key)) {
      probability *= RELATED_EXCEPTION_DAMPING;
      recurringMatches += 1;
    }
  }

  const todayKey = now.toISOString().slice(0, 10);
  const alertSuppressed = exceptionsForItem.some(
    (exception) =>
      exception.scope === "once" &&
      exception.contextKey === key &&
      exception.createdAt.slice(0, 10) === todayKey,
  );

  const analogous = primaryScope === "sibling";

  // When weather is the story, the quoted counts must be the weather-matched
  // subset, or the explanation would misstate the user's actual history.
  const weatherRelevant = Boolean(weatherStats);

  let observations = rawObserved;
  let confirmations = rawConfirmed;
  if (weatherRelevant) {
    observations = weatherSubset.observed;
    confirmations = weatherSubset.confirmed;
  }

  const evidenceMass = totalWeightedObserved;
  const confidence = confidenceTier(evidenceMass);

  const evidence = {
    itemId: item.id,
    primaryScope,
    probability,
    observations,
    confirmations,
    evidenceMass,
    exceptions: recurringMatches,
    weatherRelevant,
    coOccurrence: findCoOccurrence(item, confirmedSamples, itemsById),
  };

  // Interrupting someone before they leave is expensive, so we only do it when
  // the evidence is about *this* kind of trip. Loose matches still surface in
  // the list, just quietly.
  const alert =
    !alertSuppressed &&
    !analogous &&
    primaryScope === "exact" &&
    probability >= preferences.alertThreshold &&
    rawObserved >= preferences.minObservations;

  const prediction: Prediction = {
    itemId: item.id,
    item,
    probability,
    confidence,
    alert,
    analogous,
    alertSuppressed,
    reason: "",
    reasonSource: "engine",
    evidence,
  };
  prediction.reason = explainPrediction(prediction, context);
  return prediction;
}

function sumObserved(counts: Record<EvidenceScope, ScopeCounts>): number {
  return (
    counts.exact.rawObserved +
    counts.destination.rawObserved +
    counts.sibling.rawObserved +
    counts.global.rawObserved
  );
}

function confidenceTier(evidenceMass: number): ConfidenceTier {
  if (evidenceMass >= HIGH_EVIDENCE_MASS) return "high";
  if (evidenceMass >= MEDIUM_EVIDENCE_MASS) return "medium";
  return "low";
}

/**
 * Raw counts of this item on weather-matched trips at the same context.
 *
 * Unlike `weatherConditionalStats` these are unweighted and narrowed to the
 * exact scope, because they are the numbers a sentence will quote verbatim.
 */
function weatherSubsetCounts(
  item: Item,
  context: TripContext,
  usable: LearningSample[],
): { observed: number; confirmed: number } {
  const state = weatherState(context);
  if (!state) return { observed: 0, confirmed: 0 };
  let observed = 0;
  let confirmed = 0;
  for (const sample of usable) {
    const entry = sample.items.find((candidate) => candidate.itemId === item.id);
    if (!entry || !isDecided(entry.action)) continue;
    if (scopeOf(context, sample.context) !== "exact") continue;
    if (weatherState(sample.context) !== state) continue;
    observed += 1;
    if (entry.action === "packed") confirmed += 1;
  }
  return { observed, confirmed };
}

/**
 * Today's weather state, from the snapshot if we have one and otherwise from
 * the context tags.
 *
 * Returning `undefined` for "unknown" matters: a trip logged before we ever
 * recorded weather must not be silently counted as a clear day, or we would
 * build a fake weather history out of our own gaps.
 */
function weatherState(context: TripContext): WeatherState | undefined {
  const snapshot = context.weather;
  if (snapshot && snapshot.source !== "none") return snapshot.condition;
  const tag = weatherTag(context);
  return tag === "rain" || tag === "snow" ? tag : undefined;
}

interface WeatherStats {
  /** Scope-weighted evidence mass in the weather-matched subset. */
  mass: number;
  /** Scope-weighted confirmations within that subset. */
  confirmed: number;
}

/**
 * The item's evidence restricted to trips in today's weather state.
 *
 * This is what makes "I always take an umbrella when it rains" a real number
 * rather than a turn of phrase: the same weighted evidence as the main
 * prediction, sliced by weather. Every scope is included, because "you take an
 * umbrella on rainy *project nights*" is exactly the transfer we want.
 */
function weatherConditionalStats(
  item: Item,
  context: TripContext,
  usable: LearningSample[],
): WeatherStats | undefined {
  const state = weatherState(context);
  if (!state) return undefined;

  let mass = 0;
  let confirmed = 0;
  for (const sample of usable) {
    const entry = sample.items.find((candidate) => candidate.itemId === item.id);
    if (!entry || !isDecided(entry.action)) continue;
    if (weatherState(sample.context) !== state) continue;
    const weight = SCOPE_WEIGHTS[scopeOf(context, sample.context)];
    mass += weight;
    if (entry.action === "packed") confirmed += weight;
  }

  if (mass === 0) return undefined;
  return { mass, confirmed };
}

/**
 * Which confirmed companion item best explains this prediction? Powers lines
 * like "...on 14 of your last 16 college trips where you also took your laptop."
 */
function findCoOccurrence(
  item: Item,
  confirmedSamples: LearningSample[],
  itemsById: Map<string, Item>,
): CoOccurrenceEvidence | undefined {
  if (confirmedSamples.length < MIN_CO_OCCURRENCE_TRIPS) return undefined;

  const tally = new Map<string, number>();
  for (const sample of confirmedSamples) {
    for (const entry of sample.items) {
      if (entry.itemId === item.id || entry.action !== "packed") continue;
      tally.set(entry.itemId, (tally.get(entry.itemId) ?? 0) + 1);
    }
  }

  let best: { itemId: string; trips: number } | undefined;
  for (const [itemId, trips] of tally) {
    if (trips < MIN_CO_OCCURRENCE_TRIPS) continue;
    if (!best || trips > best.trips) best = { itemId, trips };
  }
  if (!best) return undefined;

  const companion = itemsById.get(best.itemId);
  if (!companion) return undefined;
  return { itemId: companion.id, itemName: companion.name, trips: best.trips };
}

/**
 * Cold start. We have nothing learned, so we say so plainly instead of
 * pretending the bootstrap set is a recommendation.
 */
function coldStart(context: TripContext, catalog: Item[]): Prediction[] {
  const label = contextLabel(context);
  return catalog
    .filter((item) => BOOTSTRAP_ITEM_IDS.includes(item.id))
    .map((item) => ({
      itemId: item.id,
      item,
      probability: COLD_START_PROBABILITY,
      confidence: "low" as const,
      alert: false,
      analogous: false,
      alertSuppressed: false,
      reasonSource: "engine" as const,
      reason: `You haven't logged a "${label}" trip yet, so this is a starting guess rather than something learned. Confirm or skip it and I'll start noticing.`,
      evidence: {
        itemId: item.id,
        primaryScope: "global" as const,
        probability: COLD_START_PROBABILITY,
        observations: 0,
        confirmations: 0,
        evidenceMass: 0,
        exceptions: 0,
        weatherRelevant: false,
      },
    }))
    .sort((a, b) => b.probability - a.probability);
}
