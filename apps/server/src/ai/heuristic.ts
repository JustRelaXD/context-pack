import { normalizeToken, type Item } from "@contextpack/shared";
import { inferTags, KNOWN_PURPOSES } from "./tags";
import type {
  ContextExtractor,
  ExceptionParser,
  ExtractedContext,
  KnownContexts,
  ParsedException,
  ReasonPhraser,
} from "./types";

/**
 * The rule-based path.
 *
 * This is not a degraded stub — it is the default. It means the app is fully
 * functional with no API keys at all, which is what stops a rate limit or a
 * missing key from killing a live demo. The Jev and Groq adapters are upgrades
 * layered on top of it, not replacements for it.
 */

/** "I'm going to college for a lab" -> destination "college". */
const DESTINATION_PATTERNS: readonly RegExp[] = [
  /(?:going|heading|off|leaving|walking|cycling|driving|commuting)\s+(?:to|for|into)\s+(?:the\s+|my\s+|a\s+)?([a-z0-9][a-z0-9\- ]{1,40}?)(?:\s+(?:for|to|at|in|on|with|today|tomorrow|tonight|because|since|but|and)\b|[.,!?]|$)/,
  /(?:^|\s)(?:to|at)\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9\- ]{1,40}?)(?:\s+(?:for|to|at|today|tomorrow)\b|[.,!?]|$)/,
];

/** "college for a lab" -> purpose "lab". */
/** "college for a lab" -> purpose "lab". */
const PURPOSE_PATTERN =
  /\bfor\s+(?:my\s+|a\s+|an\s+|the\s+)?([a-z0-9][a-z0-9\- ]{1,30}?)(?:\s+(?:today|tomorrow|tonight|at|in|to|this)\b|[.,!?]|$)/;

/**
 * Last-resort destination: the phrase before "for" ("college for a lab").
 *
 * People type the shortest thing that makes sense to them, and the demo's main
 * input — just a destination and a purpose, with no verb — has to work. Without
 * this fallback "college for a lab" extracts no destination at all.
 */
const BARE_DESTINATION_PATTERN =
  /^(?:i(?:'m| am)\s+)?(?:going\s+to\s+|heading\s+(?:to\s+)?|off\s+to\s+)?(?:the\s+|my\s+|a\s+|an\s+)?([a-z0-9][a-z0-9\- ]{1,40}?)\s+for\b/;

const NEGATION_PATTERNS: readonly RegExp[] = [
  /\b(?:don'?t|do not|won'?t|will not|never)\s+(?:need|take|bring|carry|have|pack)\b/,
  /\b(?:not|no)\s+(?:need|needed|taking|bringing|carrying)\b/,
  /\b(?:skipping|without|leave behind|leaving behind|lost|forgot)\b/,
];

const RECURRING_HINTS: readonly string[] = [
  "always",
  "never",
  "every",
  "usually",
  "on fridays",
  "on mondays",
  "on tuesdays",
  "on wednesdays",
  "on thursdays",
  "on saturdays",
  "on sundays",
  "from now on",
];

const ONCE_HINTS: readonly string[] = ["today", "tonight", "this once", "just this", "right now"];

/**
 * Find an item mentioned in free text. Matches on whole words and simple
 * plurals so "chargers" still resolves to "charger".
 */
export function findMentionedItem(rawInput: string, candidates: Item[]): Item | undefined {
  const text = ` ${rawInput.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  let best: { item: Item; length: number } | undefined;
  for (const item of candidates) {
    const name = item.name.toLowerCase();
    const variants = [name, `${name}s`, item.id.replace(/-/g, " ")];
    for (const variant of variants) {
      if (text.includes(` ${variant} `) && (!best || variant.length > best.length)) {
        best = { item, length: variant.length };
      }
    }
  }
  return best?.item;
}

export function heuristicExtractContext(rawInput: string, known: KnownContexts): ExtractedContext {
  const text = rawInput.toLowerCase();

  // A destination we have seen before always wins, longest match first, so
  // "college library" does not get truncated to "college library".
  const knownMatch = [...known.destinations]
    .filter((destination) => destination.length > 1)
    .sort((a, b) => b.length - a.length)
    .find((destination) => text.includes(destination.toLowerCase()));

  const purposeMatch = PURPOSE_PATTERN.exec(text);
  const purpose = purposeMatch?.[1] ? normalizeToken(purposeMatch[1]) : undefined;

  let destination = knownMatch ?? "";
  if (!destination) {
    for (const pattern of [...DESTINATION_PATTERNS, BARE_DESTINATION_PATTERN]) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        destination = normalizeToken(match[1]);
        break;
      }
    }
  }
  // A bare destination must not swallow the purpose we just found: in
  // "college for a lab", the fallback should yield "college", not "lab".
  if (destination && (destination === purpose || destination.length < 2)) destination = "";
  if (!destination) destination = "somewhere";

  return {
    destination,
    ...(purpose ? { purpose } : {}),
    tags: inferTags(rawInput),
    isNewDestination: !knownMatch,
    source: "heuristic",
  };
}

export function heuristicParseException(
  rawInput: string,
  candidates: Item[],
): ParsedException | null {
  const text = rawInput.toLowerCase();
  if (!NEGATION_PATTERNS.some((pattern) => pattern.test(text))) return null;

  const item = findMentionedItem(rawInput, candidates);
  if (!item) return null;

  const recurring = RECURRING_HINTS.some((hint) => text.includes(hint));
  const once = ONCE_HINTS.some((hint) => text.includes(hint));

  return {
    itemId: item.id,
    action: text.includes("remind") ? "remind_later" : "mark_not_needed",
    // Absent an explicit cue, assume today only. Silently generalising "I don't
    // need this today" into a permanent rule would be the worst possible error.
    scope: recurring && !once ? "recurring" : "once",
    reason: rawInput.trim(),
    source: "heuristic",
  };
}

export const heuristicContextExtractor: ContextExtractor = {
  name: "heuristic",
  available: true,
  async extract(rawInput, known) {
    return heuristicExtractContext(rawInput, known);
  },
};

export const heuristicExceptionParser: ExceptionParser = {
  name: "heuristic",
  available: true,
  async parse(rawInput, candidates) {
    return heuristicParseException(rawInput, candidates);
  },
};

export const heuristicReasonPhraser: ReasonPhraser = {
  name: "heuristic",
  available: true,
  // The templated sentence is already correct and already quotes real numbers.
  async phrase(templated) {
    return templated;
  },
};

export { KNOWN_PURPOSES };
