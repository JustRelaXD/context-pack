import type { Item } from "@contextpack/shared";

/**
 * Which implementation produced a result. Recorded so we can be honest in the
 * UI about whether a line came from a model or from plain code.
 */
export type AgentSource = "jev" | "groq" | "heuristic";

export interface ExtractedContext {
  destination: string;
  purpose?: string;
  tags: string[];
  /** True when we could not match the destination to anything in history. */
  isNewDestination: boolean;
  source: AgentSource;
}

export interface KnownContexts {
  destinations: string[];
  purposes: string[];
}

export interface ContextExtractor {
  readonly name: AgentSource;
  readonly available: boolean;
  extract(rawInput: string, known: KnownContexts): Promise<ExtractedContext>;
}

export type ExceptionAction = "mark_not_needed" | "mark_needed" | "remind_later";

export interface ParsedException {
  itemId: string;
  action: ExceptionAction;
  scope: "once" | "recurring";
  reason: string;
  source: AgentSource;
}

export interface ExceptionParser {
  readonly name: AgentSource;
  readonly available: boolean;
  /** Returns null when the utterance is not an exception at all. */
  parse(rawInput: string, candidates: Item[]): Promise<ParsedException | null>;
}

export interface ReasonPhraser {
  readonly name: AgentSource;
  readonly available: boolean;
  /**
   * Rewrite an explanation. Implementations MUST NOT introduce any number that
   * is not present in `allowedNumbers` — see `numbersIntroduced`.
   */
  phrase(templated: string, allowedNumbers: number[]): Promise<string>;
}

/** Every number appearing in a string, for the guardrail in `phrase`. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

/**
 * The trust guardrail: which numbers did a rephrased sentence invent?
 *
 * An empty array means the model only reused figures we supplied. Anything else
 * and we discard the model's version and keep the deterministic template.
 */
export function numbersIntroduced(candidate: string, allowed: readonly number[]): number[] {
  const permitted = new Set(allowed.map((value) => value.toString()));
  // Percentages are rendered from probabilities, so allow their rounded forms.
  for (const value of allowed) {
    permitted.add(Math.round(value * 100).toString());
  }
  return numbersIn(candidate).filter((value) => !permitted.has(value.toString()));
}
