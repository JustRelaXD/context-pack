import { score, type Questions, type TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_ITEM_EMOJI, ITEM_CATEGORIES, type ItemCategory } from "@contextpack/shared";
import { heuristicSuggestItems } from "./heuristic";
import { readScore } from "./jev";
import type { ItemSuggester, SuggestedItem, SuggestionRequest } from "./types";

/**
 * Propose items for an outing, without the user typing a list.
 *
 * This is the one job in the app that genuinely needs a *generative* model, which
 * is why it is the one place Groq is load-bearing rather than cosmetic: Jev cannot
 * write strings at all, so it cannot name a lab coat, and the closed catalog means
 * nothing else could either. Groq supplies the breadth; the engine still supplies
 * every number the user reads.
 *
 * Jev's part is the second half of the pipeline and is the same primitive as
 * everywhere else — except it is `score` rather than `noul`, because "is this
 * plausible for a lab" has three answers, not two, and an expected score carries
 * the model's uncertainty instead of hiding it behind a coin flip.
 *
 * The trust rule this feature has to protect: a suggestion is *never* evidence. It
 * carries no probability, it is not stored on the trip, and it teaches the engine
 * nothing until the user taps it. That is what keeps "nothing appears that you did
 * not confirm" true while still letting the app propose something new.
 */

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * The rubric Jev scores against, low to high.
 *
 * Deliberately about *this outing* and not about usefulness in general: "a
 * laptop would be useful" is true of almost every trip and would rank everything
 * first, which is the failure mode of a model asked a vague question.
 */
const PLAUSIBILITY_RUBRIC = [
  "Unlikely — most people would not need this on this particular outing",
  "Plausible — some people would take this on this outing",
  "Likely — most people would take this on this outing",
] as const;

/** Below this, Jev's own answer was closer to "no" than to "maybe". */
const MIN_PLAUSIBILITY = 0.5;

/**
 * Every request sends this many scoring questions, so this bounds the batch size.
 *
 * Slightly more than the number of suggestions we display, because the most
 * useful proposals for a well-learned context are the ones history left out — and
 * the rest get filtered for being already on screen.
 */
const MAX_SCORED = 12;

const GENERATE_PROMPT = [
  "You list the physical objects a person carries with them on a specific outing.",
  "Rules:",
  '- Reply with a JSON object of the shape {"items": [{"name": string, "category": string}]}.',
  `- The category is one of: ${ITEM_CATEGORIES.join(", ")}.`,
  '- 8 to 10 items, most likely first, each 1-3 words in title case ("Lab coat", "Batteries").',
  "- Only small things a person carries. Never furniture, appliances, or large objects.",
  "- Never actions, advice, or sentences.",
  "- Do not include anything listed as already owned.",
  "- No commentary, no code fences, no markdown.",
].join("\n");

/**
 * Two provider quirks, both found by measuring rather than reading docs.
 *
 * JSON mode is what stops the model writing a chatty answer we then have to
 * parse around, and `reasoning_effort: low` is what stops it spending the whole
 * token budget thinking: at the default effort, gpt-oss-20b burned all 600
 * completion tokens on reasoning and returned *empty* content, roughly one call
 * in three. With both set, the same prompt comes back in ~80 tokens with
 * `finish_reason: stop` instead of `length`. That failure was invisible in the
 * UI because the rule-based list silently covered for it — a whole feature
 * quietly degrading to generic advice.
 */
const REQUEST_TUNING: Record<string, unknown> = {
  response_format: { type: "json_object" },
  reasoning_effort: "low",
};

export interface ItemSuggesterOptions {
  groq?: { apiKey?: string | undefined; model?: string | undefined; fetchImpl?: typeof fetch } | undefined;
  jevClient?: TypeSafeClient | undefined;
}

/**
 * The composite that the rest of the app sees.
 *
 * Order of operations matters and is deliberate: generate, then constrain, then
 * score, then fall back at every step. The only outcome that is not allowed is
 * throwing, because this runs while someone is on their way out of the door.
 */
export function createItemSuggester(options: ItemSuggesterOptions = {}): ItemSuggester {
  const groq = options.groq;
  const canGenerate = Boolean(groq?.apiKey);

  async function generate(request: SuggestionRequest): Promise<SuggestedItem[]> {
    if (!canGenerate || !groq) return [];
    try {
      const doFetch = groq.fetchImpl ?? fetch;
      const model = groq.model ?? "openai/gpt-oss-20b";
      const messages = [
        { role: "system", content: GENERATE_PROMPT },
        {
          role: "user",
          content: [
            `Outing: ${describeOuting(request)}`,
            `Already owned (do not repeat): ${
              request.exclude.length > 0 ? request.exclude.join(", ") : "nothing"
            }`,
          ].join("\n"),
        },
      ];

      // Send the tuned request, and if the provider rejects one of those fields
      // (they are Groq extensions, not part of every OpenAI-compatible API), ask
      // again without them rather than losing the feature to a 400.
      for (const tuning of [REQUEST_TUNING, {}]) {
        const response = await doFetch(GROQ_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${groq.apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            max_tokens: 900,
            ...tuning,
            messages,
          }),
          signal: AbortSignal.timeout(9000),
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const items = parseCandidates(payload.choices?.[0]?.message?.content ?? "");
        if (items.length > 0) return items;
      }
      return [];
    } catch {
      // No key, rate limit, timeout, a model rename — all of it lands here, and
      // the rule-based list below is a perfectly good answer.
      return [];
    }
  }

  return {
    name: canGenerate ? "groq" : "heuristic",
    available: canGenerate,
    async suggest(request: SuggestionRequest): Promise<SuggestedItem[]> {
      const generated = await generate(request);
      // The rule-based list is the answer to "generation failed", not to "nothing
      // new was left". Falling back in the second case would quietly overrule the
      // model and hand back the same generic items for every kind of outing.
      if (generated.length === 0) return heuristicSuggestItems(request).slice(0, request.limit);

      // Enforced here rather than trusted to a prompt: a model that repeats an
      // item the user already has must not be able to put it back on screen.
      const capped = generated
        .filter((item) => !isExcluded(item.name, request.exclude))
        .slice(0, MAX_SCORED);
      if (capped.length === 0) return [];

      if (!options.jevClient) return capped.slice(0, request.limit);

      const scored = await scoreWithJev(options.jevClient, request, capped);
      // An *unscored* item is kept, because "Jev was unreachable" is not the same
      // claim as "Jev said no" — and dropping the list on a rate limit would turn
      // a degraded response into an empty one. A scored item below the threshold
      // is dropped, since there the model did answer.
      return scored
        .filter((item) => item.plausibility === undefined || item.plausibility >= MIN_PLAUSIBILITY)
        .slice(0, request.limit);
    },
  };
}

/**
 * Read the model's JSON, and keep only what survives contact with the app.
 *
 * Everything here is a constraint the app owns rather than something we hope the
 * model respects: name length, category vocabulary, duplicates. A model that
 * returns prose, a fenced code block, or a 90-character "item" must not be able
 * to put a broken row on the screen — and the failure has to be silent, because
 * there is a working rule-based list to fall back to.
 */
export function parseCandidates(content: string): SuggestedItem[] {
  const entries = readEntries(content);
  if (entries.length === 0) return [];

  const seen = new Set<string>();
  const items: SuggestedItem[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { name?: unknown; category?: unknown };
    if (typeof record.name !== "string") continue;

    const name = cleanName(record.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const category = ITEM_CATEGORIES.includes(record.category as ItemCategory)
      ? (record.category as ItemCategory)
      : "misc";
    items.push({
      name,
      category,
      emoji: DEFAULT_ITEM_EMOJI[category],
      source: "groq",
    });
    if (items.length >= MAX_SCORED) break;
  }
  return items;
}

/**
 * Find the list, wherever the model decided to put it.
 *
 * Three shapes are tolerated because all three occur in practice: a bare array, a
 * `{ items: [...] }` object (what JSON mode produces), and an array cut off
 * mid-object when the model runs out of tokens. That last one is not hypothetical
 * — it is exactly how this failed when measured, and silently: the output looked
 * like a valid list right up to the point where it stopped.
 */
function readEntries(content: string): unknown[] {
  const objectStart = content.indexOf("{");
  const objectEnd = content.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      const value = JSON.parse(content.slice(objectStart, objectEnd + 1)) as { items?: unknown };
      if (Array.isArray(value.items)) return value.items;
    } catch {
      // Not a complete object — fall through and try it as an array.
    }
  }

  const start = content.indexOf("[");
  if (start === -1) return [];
  const end = content.lastIndexOf("]");
  if (end > start) {
    try {
      const value = JSON.parse(content.slice(start, end + 1)) as unknown;
      if (Array.isArray(value)) return value;
    } catch {
      // Truncated; salvage what is complete.
    }
  }
  return salvageObjects(content.slice(start));
}

/** Every complete `{…}` in a truncated array, braces balanced and strings respected. */
function salvageObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          found.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // A malformed object is simply skipped; the others still count.
        }
        start = -1;
      }
    }
  }
  return found;
}

/**
 * Tidy a generated name into something a person would accept as a row label.
 *
 * The 40-character cap is the same one `createItem` enforces, so a suggestion can
 * never be tapped and then rejected by the endpoint that saves it.
 */
export function cleanName(raw: string): string | null {
  const name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 40) return null;
  // A "name" with no letters is a stray number or symbol, not an object.
  if (!/\p{L}/u.test(name)) return null;
  return name;
}

async function scoreWithJev(
  client: TypeSafeClient,
  request: SuggestionRequest,
  items: SuggestedItem[],
): Promise<SuggestedItem[]> {
  try {
    // One request, one question per item: the SDK takes a map of questions, so
    // scoring ten candidates costs a single round trip rather than ten.
    const questions: Questions = Object.fromEntries(
      items.map((item, index) => [
        `item${index}`,
        score(`Would someone take this on this outing: ${item.name}?`, [...PLAUSIBILITY_RUBRIC]),
      ]),
    );

    const { answers } = await client.systemOne({
      state: {
        outing: {
          destination: request.destination,
          purpose: request.purpose ?? null,
          tags: request.tags,
        },
        note: "Judge each item for this specific outing, not for usefulness in general.",
      },
      questions,
    });

    return items.map((item, index) => {
      const plausibility = readScore(answers[`item${index}`], PLAUSIBILITY_RUBRIC.length);
      return plausibility === undefined ? item : { ...item, plausibility };
    });
  } catch {
    // Unscored suggestions are still useful, and the UI drops the ranking line
    // when there is nothing to rank by.
    return items;
  }
}

function isExcluded(name: string, exclude: readonly string[]): boolean {
  const target = name.trim().toLowerCase();
  return exclude.some((entry) => entry.trim().toLowerCase() === target);
}

/** The outing as one line, which is how a person would describe it too. */
function describeOuting(request: SuggestionRequest): string {
  const parts = [`going to ${request.destination}`];
  if (request.purpose) parts.push(`for ${request.purpose}`);
  if (request.tags.length > 0) parts.push(`(${request.tags.join(", ")})`);
  return parts.join(" ");
}
