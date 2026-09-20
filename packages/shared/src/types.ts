/**
 * ContextPack domain model.
 *
 * Design note: everything the UI claims about the user's behaviour must be
 * derivable from these records. Nothing in the prediction path may invent a
 * historical fact, so every stored decision records *how* we came to believe it
 * (see `ConfirmationSource`).
 */

/** How we came to believe an item was actually present on a trip. */
export type ConfirmationSource =
  /** The user explicitly told us. The only source we trust for statistics. */
  | "confirmed"
  /** External evidence (barcode scan, smart tag). Reserved for later. */
  | "detected"
  /** We believe it was probably there based on context. Never counted as fact. */
  | "inferred";

export type UserAction =
  | "packed"
  | "not_needed"
  | "remind_later"
  /** Predicted, shown, but the user never responded. */
  | "unanswered";

export interface UserPreferences {
  /** Probability at or above which we proactively interrupt before leaving. */
  alertThreshold: number;
  /** Minimum number of observed trips before an alert is allowed. */
  minObservations: number;
  /** Whether weather tags may influence predictions. */
  useWeather: boolean;
}

export const defaultPreferences: UserPreferences = {
  alertThreshold: 0.75,
  minObservations: 2,
  useWeather: true,
};

export interface User {
  id: string;
  displayName: string;
  createdAt: string;
  preferences: UserPreferences;
}

export type ItemCategory =
  | "tech"
  | "identity"
  | "stationery"
  | "clothing"
  | "food"
  | "sports"
  | "misc";

export interface Item {
  id: string;
  name: string;
  category: ItemCategory;
  emoji: string;
  /**
   * True when the user added this themselves.
   *
   * The shared catalog stays closed so the agent cannot invent items, but a real
   * person carries things we did not think of — a projector remote, a retainer.
   * Those live alongside the catalog as user items, which keeps the guarantee
   * (nothing appears that a person did not name) without capping the product at
   * twenty objects.
   */
  custom?: boolean;
}

/** Fallback emoji per category, so a generated or added item is never a blank row. */
export const DEFAULT_ITEM_EMOJI: Record<ItemCategory, string> = {
  tech: "🔌",
  identity: "🪪",
  stationery: "📝",
  clothing: "👕",
  food: "🍫",
  sports: "🏸",
  misc: "📦",
};

export const ITEM_CATEGORIES: readonly ItemCategory[] = [
  "tech",
  "identity",
  "stationery",
  "clothing",
  "food",
  "sports",
  "misc",
];

/**
 * A candidate item for an outing, proposed rather than predicted.
 *
 * This is the bootstrap for a context we have no history in. It carries no
 * probability and never will: a generated item has no observations behind it, so
 * a percentage would be a made-up number wearing the same clothes as a real one.
 * `plausibility` is the agent's judgement of the item for this outing, which is a
 * different claim, and it is labelled as such in the UI.
 */
export interface ItemSuggestion {
  /** What the item would be called if the user keeps it. */
  id: string;
  name: string;
  emoji: string;
  category: ItemCategory;
  /** 0…1 from Jev's rubric. Absent when nothing scored it. */
  plausibility?: number;
  /** Which layer proposed it, so the UI can say where the list came from. */
  source: "groq" | "heuristic";
}

export type WeatherCondition = "clear" | "rain" | "snow" | "hot" | "cold";

export interface WeatherSnapshot {
  condition: WeatherCondition;
  tempC?: number;
  source: "manual" | "api" | "none";
}

/**
 * The structured situation a trip happens in.
 *
 * `destination` and `purpose` are canonical and lowercased. `tags` are the
 * flexible hinge of the whole system: they are what let a *new* destination
 * ("campus hackathon") be recognised as similar to an old one ("college"),
 * which is where analogous-context prediction comes from.
 */
export interface TripContext {
  destination: string;
  purpose?: string;
  tags: string[];
  weather?: WeatherSnapshot;
}

export interface Trip {
  id: string;
  userId: string;
  /** Exactly what the user typed, kept verbatim for the history view. */
  rawInput: string;
  context: TripContext;
  startedAt: string;
  endedAt?: string;
  /**
   * Which implementation read the context out of `rawInput`. Stored so the
   * history view can be honest about whether a line came from a model or from
   * keyword parsing, months after the fact.
   */
  contextSource?: "jev" | "heuristic";
}

export interface TripItem {
  tripId: string;
  itemId: string;
  /** The probability the engine assigned *at prediction time*. */
  predictedProbability: number;
  userAction: UserAction;
  confirmationSource: ConfirmationSource;
  decidedAt?: string;
}

/** How specific a historical sample is relative to the current context. */
export type EvidenceScope = "exact" | "destination" | "sibling" | "global";

export interface CoOccurrenceEvidence {
  itemId: string;
  itemName: string;
  /** Number of trips where both items were confirmed together. */
  trips: number;
}

export interface ItemEvidence {
  itemId: string;
  /** The slice of history that carried the most weight. */
  primaryScope: EvidenceScope;
  probability: number;
  /**
   * Raw counts at the primary scope — these are what prose may quote. When
   * `weatherRelevant` is set these are narrowed to the weather-matched subset,
   * so an explanation can never misstate the user's history.
   */
  observations: number;
  confirmations: number;
  /** Weighted evidence mass, drives the confidence tier. */
  evidenceMass: number;
  /** Recurring exceptions that dampened this prediction. */
  exceptions: number;
  weatherRelevant: boolean;
  coOccurrence?: CoOccurrenceEvidence;
}

export type ConfidenceTier = "high" | "medium" | "low";

export interface Prediction {
  itemId: string;
  item: Item;
  probability: number;
  confidence: ConfidenceTier;
  /** Should we actively interrupt the user before they leave? */
  alert: boolean;
  /** Support came from a *different* destination whose tags/purpose matched. */
  analogous: boolean;
  /** A same-day "not needed" exception is currently suppressing this alert. */
  alertSuppressed: boolean;
  reason: string;
  /**
   * Who phrased `reason`. `engine` means the deterministic template; `rewritten`
   * means a model rephrased it. The *numbers* always come from `evidence`
   * either way, which is why this is a label and not a separate code path.
   */
  reasonSource: "engine" | "rewritten";
  evidence: ItemEvidence;
}

export type ExceptionScope =
  /** Applies to today's trip only. */
  | "once"
  /** A durable rule, e.g. "Fridays: no laptop". */
  | "recurring";

export interface ContextException {
  id: string;
  userId: string;
  itemId: string;
  /** Canonical context key this exception belongs to. */
  contextKey: string;
  scope: ExceptionScope;
  reason: string;
  createdAt: string;
}

/** A past trip reduced to just the facts the engine learns from. */
export interface LearningSample {
  tripId: string;
  context: TripContext;
  startedAt: string;
  items: SampleItem[];
}

export interface SampleItem {
  itemId: string;
  action: UserAction;
  source: ConfirmationSource;
}

/** Aggregated learning, surfaced on the "what I've learned" screen. */
export interface Pattern {
  userId: string;
  itemId: string;
  contextKey: string;
  observations: number;
  confirmations: number;
  probability: number;
  updatedAt: string;
}
