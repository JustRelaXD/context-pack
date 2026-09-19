import type { PatternGroup } from "./patterns";
import type {
  ConfidenceTier,
  ConfirmationSource,
  ContextException,
  Item,
  ItemEvidence,
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
  component: "context" | "exceptions" | "reasoning";
  active: ContextSource;
  detail: string;
}

export interface DiagnosticsResponse {
  /** `durable: false` means storage lives in the process and will not survive. */
  store: { adapter: string; file?: string; durable: boolean };
  weather: string;
  agent: AgentDiagnostic[];
  keys: Record<string, boolean | string>;
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
