import { heuristicContextExtractor, heuristicExceptionParser, heuristicReasonPhraser } from "./heuristic";
import { createGroqReasonPhraser } from "./groq";
import { createJevClient, createJevContextExtractor, createJevExceptionParser } from "./jev";
import type { AgentSource, ContextExtractor, ExceptionParser, ReasonPhraser } from "./types";

export * from "./types";
export { TAG_VOCABULARY, KNOWN_PURPOSES, inferTags } from "./tags";
export { heuristicExtractContext, heuristicParseException, findMentionedItem } from "./heuristic";
export { createGroqReasonPhraser } from "./groq";
export { createJevClient, createJevContextExtractor, createJevExceptionParser } from "./jev";

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
  component: "context" | "exceptions" | "reasoning";
  active: AgentSource;
  detail: string;
}

export interface AgentLayer {
  contextExtractor: ContextExtractor;
  exceptionParser: ExceptionParser;
  reasonPhraser: ReasonPhraser;
  diagnostics(): AgentDiagnostic[];
}

/**
 * The one place provider choice happens.
 *
 * Every component independently falls back to the rule-based path, so a missing
 * key, an expired credit, or a rate limit degrades quality rather than breaking
 * the app. Running with `CONTEXTPACK_AGENT=heuristic` produces a fully offline,
 * fully deterministic build — which is also what the test suite uses.
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

  const groqPhraser = groqKey
    ? createGroqReasonPhraser({
        apiKey: groqKey,
        model: env.GROQ_MODEL?.trim() || undefined,
      })
    : undefined;
  const reasonPhraser: ReasonPhraser = groqPhraser ?? heuristicReasonPhraser;

  return {
    contextExtractor,
    exceptionParser,
    reasonPhraser,
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
            : "Templated sentences from real evidence only",
        },
      ];
    },
  };
}
