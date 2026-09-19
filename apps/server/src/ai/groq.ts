import { numbersIntroduced, type ReasonPhraser } from "./types";

/**
 * Groq handles the one job Jev structurally cannot: writing a sentence.
 *
 * The contract is deliberately narrow. It receives an already-correct sentence
 * and the complete set of numbers it is permitted to use. Anything it returns
 * that contains a number we did not supply is thrown away, because a reminder
 * app that misquotes your own history has destroyed the only thing it had.
 */

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Overridable so a model rename can't take the demo down.
 *
 * Groq retires models, so this is verified against the live model list by
 * `npm run doctor`. At time of writing that account serves gpt-oss-20b/120b,
 * qwen3.8-27b and groq/compound; 20b is ample for rewriting one sentence.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

const SYSTEM_PROMPT = [
  "You rewrite a single sentence of a packing-reminder app.",
  "Rules:",
  "- Keep every number exactly as given. Never add, round, or invent a number.",
  "  If you would need a new number, rephrase so you don't.",
  "- Never add facts, items, or reasons that are not already in the sentence.",
  "- Never claim certainty. The app is explicit about uncertainty.",
  "- 40 words maximum, one sentence, no preamble, no quotes.",
  "- Reply with the rewritten sentence only.",
].join("\n");

export interface GroqOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createGroqReasonPhraser(options: GroqOptions): ReasonPhraser {
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_GROQ_MODEL;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "groq",
    available: Boolean(apiKey),
    async phrase(templated: string, allowedNumbers: number[]): Promise<string> {
      if (!apiKey) return templated;
      try {
        const response = await doFetch(GROQ_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 120,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: [
                  `Sentence: ${templated}`,
                  `Numbers you may use (and no others): ${
                    allowedNumbers.length > 0 ? allowedNumbers.join(", ") : "none"
                  }`,
                ].join("\n"),
              },
            ],
          }),
          signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) return templated;

        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const candidate = payload.choices?.[0]?.message?.content?.trim();
        if (!candidate) return templated;
        if (numbersIntroduced(candidate, allowedNumbers).length > 0) return templated;
        // Guard against a model that "helpfully" answers at length.
        if (candidate.length > 400) return templated;
        return candidate;
      } catch {
        return templated;
      }
    },
  };
}
