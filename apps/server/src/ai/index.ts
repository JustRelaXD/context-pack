import {
  heuristicContextExtractor,
  heuristicExceptionParser,
  heuristicItemSuggester,
  heuristicReasonPhraser,
} from "./heuristic";
import { createGroqReasonPhraser } from "./groq";
import { createJevClient, createJevContextExtractor, createJevExceptionParser } from "./jev";
import { createItemSuggester } from "./suggest";
import type { AgentSource, ContextExtractor, ExceptionParser, ItemSuggester, ReasonPhraser } from "./types";

export * from "./types";
export { TAG_VOCABULARY, KNOWN_PURPOSES, inferTags } from "./tags";
export { heuristicExtractContext, heuristicParseException, heuristicSuggestItems, findMentionedItem } from "./heuristic";
export { createGroqReasonPhraser } from "./groq";
export { createJevClient, createJevContextExtractor, createJevExceptionParser, readScore } from "./jev";
export { createItemSuggester, parseCandidates, cleanName } from "./suggest";

export interface AgentEnv {
  TYPESAFE_API_KEY?: string | undefined;
  TYPESAFE_BASE_URL?: string | undefined;
  TYPESAFE_DEFAULT_MODEL?: string | undefined;
  GROQ_API_KEY?: string | undefined;
  /** Accepted because the local shell exports this spelling. */
  GROK_API_KEY?: string | undefined;
  GROQ_MODEL?: string | undefined;
  /** Set to "heuristic" to force the fully offline path. */
  CONTEXTPACK_AGENT?: string | undefined;
}

export interface AgentDiagnostic {
  component: "context" | "exceptions" | "reasoning" | "suggestions";
  active: AgentSource;
  detail: string;
}

export interface AgentLayer {
  contextExtractor: ContextExtractor;
  exceptionParser: ExceptionParser;
  reasonPhraser: ReasonPhraser;
  itemSuggester: ItemSuggester;
  diagnostics(): AgentDiagnostic[];
}

/**
 * The one place provider choice happens.
 *
 * Every component independently falls back to the rule-based path, so a missing
 * key, an expired credit, or a rate limit degrades quality rather than breaking
 * the app. Running with `CONTEXTPACK_AGENT=heuristic` produces a fully offline,
 * fully deterministic build — which is also what the test suite uses.
 *
 * "Fully offline" means *all three* components, reasoning included. It would be
 * easy to read the flag as "skip Jev" and leave Groq phrasing switched on, but
 * then a build advertised as offline would still make a network call per alert —
 * which is how generating example history took 23 seconds instead of two.
 */
export function createAgentLayer(env: AgentEnv = process.env): AgentLayer {
  const forceHeuristic = env.CONTEXTPACK_AGENT?.trim().toLowerCase() === "heuristic";
  const typeSafeKey = env.TYPESAFE_API_KEY?.trim();
  const groqKey = (env.GROQ_API_KEY ?? env.GROK_API_KEY)?.trim();

  const jevEnabled = !forceHeuristic && Boolean(typeSafeKey);
  const jevClient = jevEnabled
    ? createJevClient({
        apiKey: typeSafeKey,
        baseURL: env.TYPESAFE_BASE_URL?.trim() || undefined,
        defaultModel: env.TYPESAFE_DEFAULT_MODEL?.trim() || undefined,
      })
    : undefined;

  const contextExtractor: ContextExtractor = jevClient
    ? createJevContextExtractor(jevClient)
    : heuristicContextExtractor;
  const exceptionParser: ExceptionParser = jevClient
    ? createJevExceptionParser(jevClient)
    : heuristicExceptionParser;

  const groqPhraser =
    groqKey && !forceHeuristic
      ? createGroqReasonPhraser({
          apiKey: groqKey,
          model: env.GROQ_MODEL?.trim() || undefined,
        })
      : undefined;
  const reasonPhraser: ReasonPhraser = groqPhraser ?? heuristicReasonPhraser;

  // Proposals come from Groq (it can write strings; Jev cannot) and are ranked by
  // Jev (it can judge; a chat model would just agree with itself). Either half
  // missing leaves a working path: generation falls back to the rules, scoring is
  // simply skipped, and the UI drops the ranking line rather than inventing one.
  const itemSuggester: ItemSuggester =
    groqKey && !forceHeuristic
      ? createItemSuggester({
          groq: { apiKey: groqKey, model: env.GROQ_MODEL?.trim() || undefined },
          jevClient,
        })
      : heuristicItemSuggester;

  return {
    contextExtractor,
    exceptionParser,
    reasonPhraser,
    itemSuggester,
    diagnostics() {
      return [
        {
          component: "context",
          active: contextExtractor.name,
          detail: jevEnabled
            ? `Jev via ${env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai"}`
            : forceHeuristic
              ? "Forced offline by CONTEXTPACK_AGENT=heuristic"
              : "No TYPESAFE_API_KEY set; using keyword parsing",
        },
        {
          component: "exceptions",
          active: exceptionParser.name,
          detail: jevEnabled ? "Jev judgement" : "Negation and keyword matching",
        },
        {
          component: "reasoning",
          active: reasonPhraser.name,
          detail: groqPhraser
            ? "Groq rewrites the engine's sentence, numbers validated"
            : forceHeuristic
              ? "Forced offline by CONTEXTPACK_AGENT=heuristic"
              : "No GROQ_API_KEY set; templated sentences from real evidence only",
        },
        {
          component: "suggestions",
          active: itemSuggester.name,
          detail:
            itemSuggester.name === "groq"
              ? jevClient
                ? "Groq proposes items, Jev scores how plausible each is"
                : "Groq proposes items; no TYPESAFE_API_KEY, so nothing scores them"
              : forceHeuristic
                ? "Forced offline by CONTEXTPACK_AGENT=heuristic"
                : "No GROQ_API_KEY set; common items by kind of outing",
        },
      ];
    },
  };
}
