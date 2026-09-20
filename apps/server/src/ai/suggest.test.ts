import { describe, expect, it, vi } from "vitest";
import { cleanName, createItemSuggester, parseCandidates } from "./suggest";
import { heuristicSuggestItems } from "./heuristic";
import type { SuggestionRequest } from "./types";

/**
 * Suggestion tests.
 *
 * Two things worth checking here, and they are different in kind. First, that what
 * a model writes is constrained before it reaches a screen — length, category
 * vocabulary, duplicates, exclusion. Second, that every failure mode degrades to
 * the rule-based list instead of producing an empty section or a crash, because
 * this runs while someone is leaving the house.
 */

const request = (overrides: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  destination: "college",
  purpose: "lab",
  tags: ["academic", "lab"],
  exclude: [],
  limit: 6,
  ...overrides,
});

function groqReturning(content: string, ok = true) {
  return vi.fn(async () =>
    ({
      ok,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response,
  );
}

describe("parsing what the model wrote", () => {
  it("reads a plain JSON array and assigns an emoji per category", () => {
    const items = parseCandidates('[{"name":"Lab coat","category":"clothing"},{"name":"Batteries","category":"tech"}]');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "Lab coat", category: "clothing", emoji: "👕", source: "groq" });
    expect(items[1]).toMatchObject({ name: "Batteries", category: "tech" });
  });

  it("survives the model wrapping it in prose or a code fence", () => {
    const items = parseCandidates('Sure!\n```json\n[{"name":"Lab coat","category":"clothing"}]\n```');
    expect(items.map((item) => item.name)).toEqual(["Lab coat"]);
  });

  it("reads the object shape that JSON mode returns", () => {
    const items = parseCandidates('{"items":[{"name":"Lab coat","category":"clothing"}]}');
    expect(items.map((item) => item.name)).toEqual(["Lab coat"]);
  });

  it("salvages a list that was cut off mid-object", () => {
    // Measured, not hypothetical: at the default reasoning effort the model spent
    // the whole token budget thinking and returned either nothing or a list that
    // stopped mid-entry. Without this, the feature silently fell back to generic
    // advice and looked like it was working.
    const truncated =
      '[{"name":"Lab coat","category":"clothing"},{"name":"Safety goggles","cate';
    expect(parseCandidates(truncated).map((item) => item.name)).toEqual(["Lab coat"]);
  });

  it("refuses anything that is not a usable item name", () => {
    const items = parseCandidates(
      JSON.stringify([
        { name: "a", category: "tech" },
        { name: "   ", category: "tech" },
        { name: "12345", category: "tech" },
        { name: `A${"b".repeat(60)}`, category: "tech" },
        { name: "Lab coat", category: "clothing" },
      ]),
    );
    expect(items.map((item) => item.name)).toEqual(["Lab coat"]);
  });

  it("falls back to a real category when the model invents one", () => {
    const items = parseCandidates('[{"name":"Lab coat","category":"outerwear"}]');
    expect(items[0]?.category).toBe("misc");
    expect(items[0]?.emoji).toBe("📦");
  });

  it("deduplicates case-insensitively", () => {
    const items = parseCandidates('[{"name":"Lab coat","category":"clothing"},{"name":"lab coat","category":"misc"}]');
    expect(items).toHaveLength(1);
  });

  it("rejects malformed JSON without throwing", () => {
    expect(parseCandidates("[{oops")).toEqual([]);
    expect(parseCandidates("no array here at all")).toEqual([]);
  });

  it("strips quotes and control characters from a name", () => {
    expect(cleanName('  Lab\tcoat  ')).toBe("Lab coat");
    expect(cleanName('"Lab coat"')).toBe("Lab coat");
  });
});

describe("the two-stage suggester", () => {
  it("uses Groq's list and Jev's rubric, keeping only what it rates plausible", async () => {
    const fetchImpl = groqReturning(
      JSON.stringify([
        { name: "Lab coat", category: "clothing" },
        { name: "Souvenir mug", category: "misc" },
      ]),
    );

    // Scores arrive keyed by question name, as the SDK returns them.
    const systemOne = vi.fn(async () => ({
      answers: {
        item0: { type: "score", score: 2, confidence: 0.8 },
        item1: { type: "score", score: 0, confidence: 0.7 },
      },
    }));

    const suggester = createItemSuggester({
      groq: { apiKey: "test", fetchImpl: fetchImpl as unknown as typeof fetch },
      jevClient: { systemOne } as never,
    });

    const items = await suggester.suggest(request());
    expect(suggester.name).toBe("groq");
    expect(items.map((item) => item.name)).toEqual(["Lab coat"]);
    expect(items[0]?.plausibility).toBeCloseTo(1);
    // One request for all candidates, not one per candidate.
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("keeps everything unscored when Jev could not be asked", async () => {
    const suggester = createItemSuggester({
      groq: {
        apiKey: "test",
        fetchImpl: groqReturning('[{"name":"Lab coat","category":"clothing"}]') as unknown as typeof fetch,
      },
      jevClient: {
        systemOne: vi.fn(async () => {
          throw new Error("rate limited");
        }),
      } as never,
    });

    const items = await suggester.suggest(request());
    expect(items.map((item) => item.name)).toEqual(["Lab coat"]);
    expect(items[0]?.plausibility).toBeUndefined();
  });

  it("falls back to the rule-based list when generation fails", async () => {
    const suggester = createItemSuggester({
      groq: { apiKey: "test", fetchImpl: groqReturning("", false) as unknown as typeof fetch },
    });

    const items = await suggester.suggest(request());
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.source === "heuristic")).toBe(true);
    expect(items.map((item) => item.name)).toContain("Lab kit");
  });

  it("never proposes something the user already has", async () => {
    const suggester = createItemSuggester({
      groq: {
        apiKey: "test",
        fetchImpl: groqReturning('[{"name":"Lab coat","category":"clothing"}]') as unknown as typeof fetch,
      },
    });

    const items = await suggester.suggest(request({ exclude: ["lab coat"] }));
    expect(items).toEqual([]);
  });

  it("asks for JSON and low reasoning effort", async () => {
    const fetchImpl = groqReturning('[{"name":"Lab coat","category":"clothing"}]');
    const suggester = createItemSuggester({
      groq: { apiKey: "test", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    await suggester.suggest(request());

    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown[])[1] &&
      ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning_effort).toBe("low");
  });

  it("retries without the provider extensions rather than losing the feature", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const tuned = String(init?.body).includes("reasoning_effort");
      return {
        ok: !tuned,
        json: async () => ({ choices: [{ message: { content: '[{"name":"Lab coat","category":"clothing"}]' } }] }),
      } as unknown as Response;
    });

    const suggester = createItemSuggester({
      groq: { apiKey: "test", fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(await suggester.suggest(request())).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("respects the limit it was given", async () => {
    const many = JSON.stringify(
      Array.from({ length: 10 }, (_, index) => ({ name: `Thing ${String.fromCharCode(97 + index)}`, category: "misc" })),
    );
    const suggester = createItemSuggester({
      groq: { apiKey: "test", fetchImpl: groqReturning(many) as unknown as typeof fetch },
    });

    expect(await suggester.suggest(request({ limit: 3 }))).toHaveLength(3);
  });
});

describe("the rule-based list", () => {
  it("knows what a gym trip involves", () => {
    const items = heuristicSuggestItems(request({ destination: "gym", purpose: undefined, tags: ["gym"] }));
    expect(items.map((item) => item.name)).toContain("Gym clothes");
  });

  it("matches on tags too, so a new destination still gets sensible items", () => {
    const items = heuristicSuggestItems(
      request({ destination: "somewhere", purpose: undefined, tags: ["project"] }),
    );
    expect(items.map((item) => item.name)).toContain("Extension board");
  });

  it("still offers a starting list for a context it has never heard of", () => {
    const items = heuristicSuggestItems(request({ destination: "aquarium", purpose: undefined, tags: [] }));
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.map((item) => item.name)).toContain("ID card");
  });

  it("honours the exclude list and the limit", () => {
    const items = heuristicSuggestItems(request({ exclude: ["Laptop"], limit: 2 }));
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.name)).not.toContain("Laptop");
  });
});
