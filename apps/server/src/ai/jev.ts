import { TypeSafeClient, choice, noul, type Questions } from "@typesafe-ai/sdk";
import type { Item } from "@contextpack/shared";
import { heuristicExtractContext, heuristicParseException } from "./heuristic";
import { KNOWN_PURPOSES, TAG_GUIDANCE, TAG_VOCABULARY } from "./tags";
import type {
  ContextExtractor,
  ExceptionParser,
  ExtractedContext,
  KnownContexts,
  ParsedException,
} from "./types";

/**
 * Jev, TypeSafe's System One model.
 *
 * Jev is the *decision* layer and nothing more. It takes structured state plus
 * typed questions and returns calibrated probabilities — it cannot write a
 * sentence, which is exactly why we trust it with labels and noul verdicts and
 * never with prose or arithmetic. Every number the user sees still comes from
 * the deterministic engine.
 *
 * The client is base-URL configurable, so both the TypeSafe endpoint and any
 * compatible gateway work through this same code path with no code changes.
 */

/** Below this we would rather show the user nothing than show a guess. */
const MIN_DESTINATION_CONFIDENCE = 0.35;

/**
 * Tag acceptance is deliberately strict.
 *
 * Tags are what decide whether two outings count as the same kind of trip, so
 * a false tag manufactures a false match — strictly worse than a missed tag,
 * which only costs us a weaker suggestion. A casual "going to college for a
 * lab" scores `event` and `travel` around 0.5-0.6; those must not be admitted,
 * or the exact-context bucket fills with noise and every prediction regresses
 * toward a vague average.
 */
const MIN_TAG_PROBABILITY = 0.75;

/** Hard cap, strongest first, so one chatty response cannot dilute the signal. */
const MAX_AGENT_TAGS = 4;

export interface ChoiceReading {
  label: string;
  confidence: number;
}

export function readChoice(answer: unknown): ChoiceReading | undefined {
  const value = answer as { type?: string; choice?: string; confidence?: number } | undefined;
  if (!value || value.type !== "choice" || typeof value.choice !== "string") return undefined;
  return {
    label: value.choice,
    confidence: typeof value.confidence === "number" ? value.confidence : 0,
  };
}

export function readNoul(answer: unknown): number | undefined {
  const value = answer as { type?: string; noul?: number } | undefined;
  if (!value || value.type !== "noul" || typeof value.noul !== "number") return undefined;
  return value.noul;
}

/**
 * Build a `choice` criteria map.
 *
 * Labels are synthetic (`v0`, `v1`) so user-supplied strings can never collide
 * with or break the label keys, and we keep a map back to the real value.
 */
function buildChoiceCriteria(values: readonly string[], otherLabel: string, otherDescription: string) {
  const criteria: Record<string, string> = { [otherLabel]: otherDescription };
  const labelToValue = new Map<string, string>();
  values.forEach((value, index) => {
    const label = `v${index}`;
    criteria[label] = value;
    labelToValue.set(label, value);
  });
  return { criteria, labelToValue };
}

function uniqueNormalised(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalised = value.trim().toLowerCase();
    if (!normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    output.push(normalised);
  }
  return output;
}

export interface JevOptions {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  defaultModel?: string | undefined;
  /** Rendered in diagnostics so the same key can't be confused across gateways. */
  label?: string;
}

export function createJevClient(options: JevOptions = {}): TypeSafeClient {
  const config: ConstructorParameters<typeof TypeSafeClient>[0] = {
    timeout: 15000,
    logLevel: "warn",
  };
  if (options.apiKey) config.apiKey = options.apiKey;
  if (options.baseURL) config.baseURL = options.baseURL;
  if (options.defaultModel) config.defaultModel = options.defaultModel;
  return new TypeSafeClient(config);
}

/**
 * Context extraction: free text plus the user's known destinations in, one
 * structured context out.
 *
 * Note the deliberate split: the *string* of a new destination is produced by
 * the heuristic parser, because Jev cannot generate strings. Jev's job is to
 * judge whether that draft matches a place we already know, and to classify the
 * tags. That is the only division of labour the two can honestly have.
 */
export function createJevContextExtractor(client: TypeSafeClient): ContextExtractor {
  return {
    name: "jev",
    available: true,
    async extract(rawInput: string, known: KnownContexts): Promise<ExtractedContext> {
      const fallback = heuristicExtractContext(rawInput, known);
      try {
        const destinations = uniqueNormalised(known.destinations).slice(0, 150);
        const purposes = uniqueNormalised([...known.purposes, ...KNOWN_PURPOSES]).slice(0, 100);

        const { criteria: destinationCriteria, labelToValue } = buildChoiceCriteria(
          destinations,
          "__other",
          "A place not listed above",
        );
        const { criteria: purposeCriteria, labelToValue: purposeLabels } = buildChoiceCriteria(
          purposes,
          "__none",
          "No particular purpose was stated",
        );

        const questions: Questions = {
          destination: choice("Which of these places is the user going to?", destinationCriteria),
          purpose: choice("What are they going there to do?", purposeCriteria),
          ...Object.fromEntries(
            TAG_VOCABULARY.map((tag) => {
              const guidance = TAG_GUIDANCE[tag];
              return guidance
                ? [tag, noul(guidance.question, { true: guidance.yes, false: guidance.no })]
                : [tag, noul(`This outing involves: ${tag}`)];
            }),
          ),
          mentionsWeather: noul("The user mentions rain, snow, or the weather"),
        };

        const { answers } = await client.systemOne({
          state: {
            userMessage: rawInput,
            note: "Classify the outing. Choose the closest destination, or __other when none fit.",
          },
          questions,
        });

        const destinationReading = readChoice(answers.destination);
        const purposeReading = readChoice(answers.purpose);

        let destination = fallback.destination;
        if (
          destinationReading &&
          destinationReading.label !== "__other" &&
          destinationReading.confidence >= MIN_DESTINATION_CONFIDENCE
        ) {
          destination = labelToValue.get(destinationReading.label) ?? destination;
        }

        const purpose =
          purposeReading && purposeReading.label !== "__none"
            ? purposeLabels.get(purposeReading.label)
            : fallback.purpose;

        // Tags are a union of two independent signals rather than an override:
        // Jev may miss a keyword that the heuristic caught, and vice versa.
        // The heuristic's keyword hits are exact, so they are always kept and
        // never count against the cap on the model's more speculative calls.
        const tags = new Set(fallback.tags);
        const scored = TAG_VOCABULARY.map((tag) => ({ tag, probability: readNoul(answers[tag]) }))
          .filter(
            (entry): entry is { tag: string; probability: number } =>
              typeof entry.probability === "number" && entry.probability >= MIN_TAG_PROBABILITY,
          )
          .sort((a, b) => b.probability - a.probability)
          .slice(0, MAX_AGENT_TAGS);
        for (const entry of scored) tags.add(entry.tag);

        const isNewDestination =
          destinationReading === undefined ||
          destinationReading.label === "__other" ||
          !destinations.includes(destination);

        return {
          destination,
          ...(purpose ? { purpose } : {}),
          tags: [...tags],
          isNewDestination,
          source: "jev",
        };
      } catch {
        // Any failure at all — no key, rate limit, timeout, bad gateway — falls
        // back silently. A demo must never die on a model call.
        return fallback;
      }
    },
  };
}

/**
 * Natural-language exceptions.
 *
 * Scope is modelled as an explicit choice rather than inferred from wording,
 * because the cost of the two errors is wildly asymmetric: forgetting "today"
 * is an annoyance, silently turning it into a permanent rule loses a real habit.
 */
export function createJevExceptionParser(client: TypeSafeClient): ExceptionParser {
  return {
    name: "jev",
    available: true,
    async parse(rawInput: string, candidates: Item[]): Promise<ParsedException | null> {
      const fallback = heuristicParseException(rawInput, candidates);
      if (candidates.length === 0) return fallback;
      try {
        const { criteria: itemCriteria, labelToValue } = buildChoiceCriteria(
          candidates.map((item) => item.id),
          "__none",
          "No specific item was mentioned",
        );

        const questions: Questions = {
          targetItem: choice("Which item is the user talking about?", itemCriteria),
          action: choice("What is the user saying about it?", {
            mark_not_needed: "They do not need it, or are deliberately leaving it behind",
            mark_needed: "They do need it, or are confirming they will take it",
            remind_later: "They want to be reminded about it later",
          }),
          scope: choice("How long should this apply?", {
            once: "Only for this trip today",
            recurring: "A durable rule for future similar trips",
          }),
        };

        const { answers } = await client.systemOne({
          state: {
            userMessage: rawInput,
            knownCandidates: candidates.map((item) => ({ id: item.id, name: item.name })),
            note: "Decide whether the user is excluding or including an item.",
          },
          questions,
        });

        const itemReading = readChoice(answers.targetItem);
        if (!itemReading || itemReading.label === "__none") return fallback;
        const itemId = labelToValue.get(itemReading.label);
        if (!itemId) return fallback;

        const actionReading = readChoice(answers.action);
        const scopeReading = readChoice(answers.scope);
        const action = actionReading?.label;
        if (action !== "mark_not_needed" && action !== "mark_needed" && action !== "remind_later") {
          return fallback;
        }

        return {
          itemId,
          action,
          // Defaults to `once` when unsure, matching the heuristic's bias.
          scope: scopeReading?.label === "recurring" ? "recurring" : "once",
          reason: rawInput.trim(),
          source: "jev",
        };
      } catch {
        return fallback;
      }
    },
  };
}
