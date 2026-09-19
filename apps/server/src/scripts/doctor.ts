/**
 * Provider doctor.
 *
 * Run this before relying on a provider for a demo:
 *
 *   npm run doctor -w @contextpack/server
 *
 * It answers the questions we cannot answer from documentation: is this key
 * valid, does the configured base URL actually serve /v1/systemone, and which
 * model names are available. It never prints a key.
 */
import { choice, noul } from "@typesafe-ai/sdk";
import { CATALOG } from "@contextpack/shared";
import { createAgentLayer } from "../ai";
import { numbersIntroduced } from "../ai/types";
import { loadEnvFile } from "../env";
import { DEFAULT_GROQ_MODEL } from "../ai/groq";
import { createJevClient, readChoice, readNoul } from "../ai/jev";
import { TAG_VOCABULARY } from "../ai/tags";

type Status = "ok" | "failed" | "skipped" | "degraded";

interface Result {
  name: string;
  status: Status;
  detail: string;
}

function redact(value: string | undefined): string {
  if (!value) return "(unset)";
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}

async function checkTypeSafe(label: string, apiKey: string, baseURL?: string): Promise<Result> {
  const name = `TypeSafe/Jev — ${label}`;
  try {
    const client = createJevClient({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    });

    const models = await client.models.list();
    const modelNames = models.map((model) => model.name);

    // A model listing alone can be served by anything; this call proves the
    // System One endpoint itself is reachable at this base URL.
    const { answers, model, usage } = await client.systemOne({
      state: "I am going to college for a lab.",
      questions: {
        kind: choice("What kind of outing is this?", {
          academic: "Studying or attending classes",
          project: "Building something with others",
          errand: "A short practical trip",
        }),
        involvesLab: noul("This outing involves laboratory work"),
      },
    });

    const kind = readChoice(answers.kind);
    const involvesLab = readNoul(answers.involvesLab);

    return {
      name,
      status: "ok",
      detail: [
        `base=${baseURL ?? "https://api.typesafe.ai"}`,
        `model=${model}`,
        `tokens=${usage.input_tokens}in/${usage.output_tokens}out`,
        `kind=${kind?.label ?? "?"} (${(kind?.confidence ?? 0).toFixed(2)})`,
        `involvesLab=${involvesLab?.toFixed(2) ?? "?"}`,
        `models=${modelNames.slice(0, 3).join(",") || "none"}`,
      ].join("  "),
    };
  } catch (error) {
    return { name, status: "failed", detail: describeError(error) };
  }
}

async function checkGroq(apiKey: string): Promise<Result> {
  const name = "Groq (sentence rewriting)";
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { name, status: "failed", detail: `HTTP ${response.status} ${response.statusText}` };
    }
    const payload = (await response.json()) as { data?: { id: string }[] };
    const ids = (payload.data ?? []).map((entry) => entry.id);
    const preferred = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
    const hasPreferred = ids.includes(preferred);
    return {
      name,
      status: hasPreferred ? "ok" : "failed",
      detail: hasPreferred
        ? `${ids.length} models available; ${preferred} present`
        : `${preferred} is NOT available. Chat-capable ids: ${chatModelIds(ids).join(", ")}. Set GROQ_MODEL to one of these.`,
    };
  } catch (error) {
    return { name, status: "failed", detail: describeError(error) };
  }
}

/**
 * Open-Meteo is free and keyless, but it is also the only third-party service we
 * depend on for a demo feature, so a slow response must not be reported as a
 * broken setup. Retry once, and treat failure as degraded rather than fatal.
 */
async function checkOpenMeteo(): Promise<Result> {
  const name = "Open-Meteo (weather)";
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=12.97&longitude=77.59&current=weather_code&timezone=auto";

  let lastError = "unknown";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const payload = (await response.json()) as { current?: { weather_code?: number } };
        return {
          name,
          status: "ok",
          detail: `weather_code=${payload.current?.weather_code ?? "?"} (attempt ${attempt})`,
        };
      }
    } catch (error) {
      lastError = describeError(error);
    }
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return {
    name,
    status: "degraded" as Status,
    detail: `${lastError} — weather is unavailable, so trips fall back to the manual rain toggle`,
  };
}

/** Filter out audio, moderation, and speech models that cannot rewrite text. */
function chatModelIds(ids: string[]): string[] {
  return ids.filter(
    (id) =>
      !id.includes("whisper") &&
      !id.includes("prompt-guard") &&
      !id.includes("safeguard") &&
      !id.includes("orpheus") &&
      !id.includes("tts"),
  );
}

/**
 * Exercise the adapters the app actually calls, not just the raw transport.
 * The SDK probe above proves connectivity; this proves our parsing of the
 * answers, the fallbacks, and the Phrase guardrail.
 */
async function checkAdapters(): Promise<Result[]> {
  const layer = createAgentLayer();
  const results: Result[] = [];

  const college = await layer.contextExtractor.extract("I'm going to college for a lab today", {
    destinations: ["college"],
    purposes: ["lab"],
  });
  const collegeOk =
    college.destination === "college" && college.purpose === "lab" && college.tags.includes("lab");
  results.push({
    name: `context adapter (${layer.contextExtractor.name}) — known college lab`,
    status: collegeOk ? "ok" : "failed",
    detail: `destination=${college.destination} purpose=${college.purpose ?? "-"} tags=[${college.tags.join(",")}] source=${college.source}`,
  });

  const hackathon = await layer.contextExtractor.extract("going to a hackathon", {
    destinations: ["college"],
    purposes: [],
  });
  results.push({
    name: "context adapter — unseen hackathon",
    status: hackathon.tags.includes("project") ? "ok" : "failed",
    detail: `destination=${hackathon.destination} new=${hackathon.isNewDestination} tags=[${hackathon.tags.join(",")}]`,
  });

  const sameDay = await layer.exceptionParser.parse(
    "I'm going to college but I don't need my laptop today",
    CATALOG,
  );
  results.push({
    name: `exception adapter (${layer.exceptionParser.name}) — same day only`,
    status: sameDay?.itemId === "laptop" && sameDay.scope === "once" ? "ok" : "failed",
    detail: sameDay
      ? `item=${sameDay.itemId} action=${sameDay.action} scope=${sameDay.scope} source=${sameDay.source}`
      : "returned null",
  });

  const recurring = await layer.exceptionParser.parse("I never need my laptop on fridays", CATALOG);
  results.push({
    name: "exception adapter — durable rule",
    status:
      recurring?.itemId === "laptop" && recurring.scope === "recurring" ? "ok" : "failed",
    detail: recurring
      ? `item=${recurring.itemId} action=${recurring.action} scope=${recurring.scope} source=${recurring.source}`
      : "returned null",
  });

  const templated = "You confirmed your charger on 14 of your last 16 college lab trips.";
  const phrased = await layer.reasonPhraser.phrase(templated, [14, 16]);
  const introduced = numbersIntroduced(phrased, [14, 16]);
  results.push({
    name: `reason phraser (${layer.reasonPhraser.name}) — number guardrail`,
    status: introduced.length === 0 ? "ok" : "failed",
    detail:
      introduced.length === 0
        ? phrased
        : `REJECTED, invented ${introduced.join(", ")}: ${phrased}`,
  });

  return results;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    return status ? `${error.name} (HTTP ${status}): ${error.message}` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function print(result: Result): void {
  const icons: Record<Status, string> = { ok: "PASS", failed: "FAIL", skipped: "SKIP", degraded: "WARN" };
  const icon = icons[result.status];
  console.log(`[${icon}] ${result.name}`);
  console.log(`       ${result.detail}`);
}

async function main(): Promise<void> {
  const env = loadEnvFile();

  console.log("ContextPack provider doctor");
  console.log("===========================");
  console.log(
    env.files.length > 0
      ? `env file           ${env.files.join(", ")} (${env.appliedKeys.length} applied` +
          (env.shadowedKeys.length > 0
            ? `, ${env.shadowedKeys.length} shadowed by the shell: ${env.shadowedKeys.join(", ")}`
            : "") +
          ")"
      : "env file           (none found — using the shell environment only)",
  );
  console.log(`TYPESAFE_API_KEY   ${redact(process.env.TYPESAFE_API_KEY)}`);
  console.log(`TYPESAFE_BASE_URL  ${process.env.TYPESAFE_BASE_URL?.trim() || "(default: https://api.typesafe.ai)"}`);
  console.log(`TYPESAFE_DEFAULT_MODEL ${process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "(default: jev-latest)"}`);
  console.log(`GROQ_API_KEY       ${redact(process.env.GROQ_API_KEY)}`);
  console.log(`GROK_API_KEY       ${redact(process.env.GROK_API_KEY)}`);
  console.log(`CONTEXTPACK_AGENT  ${process.env.CONTEXTPACK_AGENT?.trim() || "(unset)"}`);
  console.log(`tag vocabulary     ${TAG_VOCABULARY.length} tags: ${TAG_VOCABULARY.join(", ")}`);
  console.log("");

  const results: Result[] = [];

  const typeSafeKey = process.env.TYPESAFE_API_KEY?.trim();
  const baseURL = process.env.TYPESAFE_BASE_URL?.trim();

  if (typeSafeKey) {
    // If a custom base URL is set we probe it *and* the canonical endpoint, so a
    // gateway that does not serve /v1/systemone is distinguishable from a bad key.
    if (baseURL) {
      results.push(await checkTypeSafe("custom base URL", typeSafeKey, baseURL));
      results.push(await checkTypeSafe("canonical api.typesafe.ai", typeSafeKey));
    } else {
      results.push(await checkTypeSafe("api.typesafe.ai", typeSafeKey));
    }
  } else {
    results.push({
      name: "TypeSafe/Jev",
      status: "skipped",
      detail: "TYPESAFE_API_KEY not set — context falls back to keyword parsing",
    });
  }

  const groqKey = (process.env.GROQ_API_KEY ?? process.env.GROK_API_KEY)?.trim();
  results.push(
    groqKey
      ? await checkGroq(groqKey)
      : {
          name: "Groq (sentence rewriting)",
          status: "skipped",
          detail: "no key set — reasons stay as deterministic templates",
        },
  );

  results.push(await checkOpenMeteo());

  console.log("");
  console.log("Providers");
  console.log("=========");
  for (const result of results) print(result);

  console.log("");
  console.log("Adapter integration");
  console.log("===================");
  const adapterResults = await checkAdapters();
  for (const result of adapterResults) print(result);

  const all = [...results, ...adapterResults];
  const failures = all.filter((result) => result.status === "failed");
  const degraded = all.filter((result) => result.status === "degraded");
  console.log("");
  if (failures.length === 0 && degraded.length === 0) {
    console.log("All configured providers are working. The app is demo-ready.");
  } else {
    if (failures.length > 0) {
      console.log(`${failures.length} check(s) failed — those components fall back to the offline path.`);
    }
    if (degraded.length > 0) {
      console.log(`${degraded.length} check(s) degraded — a feature is reduced, not the app.`);
    }
  }
}

main().catch((error: unknown) => {
  console.error("doctor crashed:", error);
  process.exitCode = 1;
});
