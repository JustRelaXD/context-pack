import type { PatternGroup } from "./patterns";
import type {
  ConfidenceTier,
  ConfirmationSource,
  ContextException,
  Item,
  ItemCategory,
  ItemEvidence,
  ItemSuggestion,
  Trip,
  TripContext,
  UserAction,
  WeatherSnapshot,
} from "./types";

/**
 * The contract between the server and the UI.
 *
 * These live in `shared` rather than in the server for one reason: a hand-written
 * copy on the client is a copy that drifts, and a drifted field is a silently
 * broken screen. Both sides now fail to compile together.
 */

/** Which implementation produced something. Mirror of the server's `AgentSource`. */
export type ContextSource = "jev" | "groq" | "heuristic";

export interface TripItemView {
  itemId: string;
  item: Item;
  /**
   * What the engine says *now*, given everything we know — including a
   * correction the user just made about this very trip.
   */
  probability: number;
  /**
   * What we told the user when the trip started. Never rewritten, so the history
   * view can be held to what it originally claimed.
   */
  predictedProbability: number;
  userAction: UserAction;
  confirmationSource: ConfirmationSource;
  decidedAt?: string;
  alert: boolean;
  analogous: boolean;
  alertSuppressed: boolean;
  confidence: ConfidenceTier;
  reason: string;
  reasonSource: "engine" | "rewritten";
  evidence: ItemEvidence;
  /** True when the row has no prediction behind it (the user added it). */
  unpredicted: boolean;
}

export interface TripView {
  trip: Trip;
  items: TripItemView[];
  /** The subset worth interrupting the user about. */
  alerts: TripItemView[];
  contextSource: ContextSource;
  weather: WeatherSnapshot | null;
  coldStart: boolean;
}

export interface TripSummary {
  id: string;
  rawInput: string;
  context: TripContext;
  startedAt: string;
  packed: number;
  notNeeded: number;
  unanswered: number;
  highlights: Array<{ itemId: string; name: string; emoji: string; probability: number }>;
}

export interface LearningOverview {
  trips: number;
  decided: number;
  confirmed: number;
  confirmRate: number;
  groups: PatternGroup[];
  unknownItems: string[];
}

export interface AgentDiagnostic {
  component: "context" | "exceptions" | "reasoning" | "suggestions";
  active: ContextSource;
  detail: string;
}

export interface DiagnosticsResponse {
  /** `durable: false` means storage lives in the process and will not survive. */
  store: { adapter: string; file?: string; table?: string; durable: boolean };
  /**
   * Present when the store could not be read: wrong credentials, a missing table,
   * or the wrong region. This endpoint exists to explain a broken deployment, so
   * it reports such a failure instead of becoming a 500 itself.
   */
  storeError?: string;
  weather: string;
  agent: AgentDiagnostic[];
  keys: Record<string, boolean | string>;
  /**
   * Whether `POST /api/reset` will be honoured.
   *
   * The UI hides its "start over" control unless this is true, so a disabled
   * endpoint shows up as an absent button rather than a button that errors.
   */
  resetEnabled: boolean;
  /**
   * Whether example history may be loaded (false once there is real history).
   * `null` when the store could not be read, so nothing can be claimed either
   * way — the UI treats that as "no", which hides the button rather than
   * offering an action that would fail.
   */
  canLoadExample: boolean | null;
}

/** One item's parsed correction, enriched for display. */
export interface ParsedExceptionView {
  itemId: string;
  itemName: string;
  action: "mark_not_needed" | "mark_needed" | "remind_later";
  scope: "once" | "recurring";
  reason: string;
  source: ContextSource;
}

export interface InterpretExceptionResponse {
  parsed: ParsedExceptionView | null;
  view: TripView;
}

export interface HistoryResponse {
  trips: TripSummary[];
}

export interface CatalogResponse {
  items: Item[];
}

export interface ExceptionsResponse {
  exceptions: ContextException[];
}

/**
 * Candidate items for a trip, from the agent rather than from history.
 *
 * These are deliberately not part of `TripView`. Generating them costs a model
 * call, and making the trip wait on one would mean a slower screen in exchange
 * for rows that arrive second anyway — the UI fetches this separately and lets
 * them appear underneath the real predictions.
 */
export interface SuggestionsResponse {
  suggestions: ItemSuggestion[];
  /** Which layer produced the list. */
  source: ContextSource;
  /** Why the list is empty, when it is. Shown verbatim. */
  note?: string;
}

export interface CreateItemRequest {
  name: string;
  /** Optional emoji; one is chosen from the category when omitted. */
  emoji?: string;
  category?: ItemCategory;
}

export interface CreateItemResponse {
  item: Item;
  /** False when this matched an item that already exists (including the catalog). */
  created: boolean;
}

/**
 * Example history, generated on request.
 *
 * This is what makes the app demonstrable on a fresh machine or a serverless
 * deployment with no database: the visitor gets a filled-in app in one tap
 * instead of staring at twenty coin flips. It is labelled as example data
 * everywhere it appears, and it is refused once you have real history of your
 * own — mixing the two would make every count untrustworthy.
 */
export interface DemoDataResponse {
  created: { trips: number; decisions: number };
  contextGroups: number;
}
