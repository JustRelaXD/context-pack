import { describe, expect, it } from "vitest";
import { CATALOG } from "@contextpack/shared";
import { findMentionedItem, heuristicExtractContext, heuristicParseException } from "./heuristic";
import { numbersIntroduced } from "./types";

/**
 * These tests cover the offline path and the trust guardrail. They must pass
 * with no network and no API keys, because that is the configuration the app
 * falls back to when a provider is unavailable.
 */

describe("number guardrail", () => {
  it("accepts a rewrite that only reuses supplied numbers", () => {
    const rewritten = "Your charger came along on 14 of your last 16 college trips.";
    expect(numbersIntroduced(rewritten, [14, 16])).toEqual([]);
  });

  it("accepts a percentage form of a supplied probability", () => {
    expect(numbersIntroduced("I'd say 94% likely.", [0.94])).toEqual([]);
  });

  it("rejects an invented number", () => {
    const hallucinated = "You took your charger on 17 of your last 19 college trips.";
    expect(numbersIntroduced(hallucinated, [14, 16])).toEqual([17, 19]);
  });

  it("rejects an invented number even when the rest matches", () => {
    expect(numbersIntroduced("Confirmed 14 of 16 times, about 2 days ago.", [14, 16])).toEqual([2]);
  });
});

describe("heuristic context extraction", () => {
  it("extracts destination, purpose and tags from one line", () => {
    const context = heuristicExtractContext("I'm going to college for a lab", {
      destinations: [],
      purposes: [],
    });
    expect(context.destination).toBe("college");
    expect(context.purpose).toBe("lab");
    expect(context.tags).toContain("academic");
    expect(context.tags).toContain("lab");
    expect(context.isNewDestination).toBe(true);
    expect(context.source).toBe("heuristic");
  });

  it("prefers a destination it already knows", () => {
    const context = heuristicExtractContext("heading to college today", {
      destinations: ["college"],
      purposes: [],
    });
    expect(context.destination).toBe("college");
    expect(context.isNewDestination).toBe(false);
  });

  it("recognises a hackathon as a project outing", () => {
    const context = heuristicExtractContext("going to a hackathon", {
      destinations: [],
      purposes: [],
    });
    expect(context.tags).toContain("project");
  });

  it("never returns an empty destination", () => {
    const context = heuristicExtractContext("leaving now", { destinations: [], purposes: [] });
    expect(context.destination.length).toBeGreaterThan(0);
  });
});

describe("heuristic exception parsing", () => {
  it("parses a same-day exclusion", () => {
    const parsed = heuristicParseException(
      "I'm going to college but don't need my laptop today",
      CATALOG,
    );
    expect(parsed?.itemId).toBe("laptop");
    expect(parsed?.action).toBe("mark_not_needed");
    expect(parsed?.scope).toBe("once");
  });

  it("parses a durable rule as recurring", () => {
    const parsed = heuristicParseException("I never need my laptop on fridays", CATALOG);
    expect(parsed?.itemId).toBe("laptop");
    expect(parsed?.scope).toBe("recurring");
  });

  it("defaults to once when there is no cue either way", () => {
    const parsed = heuristicParseException("I don't need my charger", CATALOG);
    expect(parsed?.scope).toBe("once");
  });

  it("returns null when the user is not excluding anything", () => {
    expect(heuristicParseException("going to college for a lab", CATALOG)).toBeNull();
  });

  it("does not guess an item that was not mentioned", () => {
    expect(heuristicParseException("I don't need anything", CATALOG)).toBeNull();
  });
});

describe("item mention matching", () => {
  it("resolves simple plurals", () => {
    expect(findMentionedItem("bring my chargers", CATALOG)?.id).toBe("charger");
  });

  it("matches the item id even when it differs from the name", () => {
    expect(findMentionedItem("take the extension board", CATALOG)?.id).toBe("extension-board");
  });

  it("prefers the longest match", () => {
    expect(findMentionedItem("my water bottle and pen", CATALOG)?.id).toBe("water-bottle");
  });

  it("returns nothing for unrelated text", () => {
    expect(findMentionedItem("going to college", CATALOG)).toBeUndefined();
  });
});
