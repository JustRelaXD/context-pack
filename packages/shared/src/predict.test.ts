import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { predictForContext } from "./predict";
import { defaultPreferences, type ContextException, type LearningSample, type Prediction, type TripContext } from "./types";

function ctx(destination: string, purpose?: string, tags: string[] = []): TripContext {
  return purpose ? { destination, purpose, tags } : { destination, tags };
}

function sample(
  tripId: string,
  context: TripContext,
  packed: string[] = [],
  notNeeded: string[] = [],
  remindLater: string[] = [],
): LearningSample {
  return {
    tripId,
    context,
    startedAt: "2026-09-01T08:00:00.000Z",
    items: [
      ...packed.map((itemId) => ({ itemId, action: "packed" as const, source: "confirmed" as const })),
      ...notNeeded.map((itemId) => ({ itemId, action: "not_needed" as const, source: "confirmed" as const })),
      ...remindLater.map((itemId) => ({ itemId, action: "remind_later" as const, source: "confirmed" as const })),
    ],
  };
}

function run(context: TripContext, history: LearningSample[], exceptions: ContextException[] = [], now = new Date("2026-09-19T08:00:00.000Z")) {
  return predictForContext({
    context,
    history,
    catalog: CATALOG,
    exceptions,
    preferences: defaultPreferences,
    now,
  });
}

function find(predictions: Prediction[], itemId: string): Prediction {
  const match = predictions.find((prediction) => prediction.itemId === itemId);
  if (!match) throw new Error(`no prediction for ${itemId}`);
  return match;
}

const collegeLab = ctx("college", "lab", ["academic", "lab"]);

function collegeLabHistory(count: number, packed = ["laptop", "charger", "id-card"]): LearningSample[] {
  return Array.from({ length: count }, (_, index) => sample(`t${index}`, collegeLab, packed));
}

describe("cold start", () => {
  it("offers bootstrap items at a coin flip and never alerts", () => {
    const predictions = run(collegeLab, []);
    expect(predictions.length).toBeGreaterThan(0);
    for (const prediction of predictions) {
      expect(prediction.probability).toBe(0.5);
      expect(prediction.confidence).toBe("low");
      expect(prediction.alert).toBe(false);
    }
    expect(find(predictions, "laptop").reason).toContain("haven't logged");
  });
});

describe("learning loop", () => {
  it("sharpens confidence as confirmations accumulate", () => {
    const early = find(run(collegeLab, collegeLabHistory(1)), "laptop");
    const later = find(run(collegeLab, collegeLabHistory(8)), "laptop");

    expect(later.probability).toBeGreaterThan(early.probability);
    expect(later.probability).toBeGreaterThan(0.9);
    expect(later.confidence).toBe("high");
    expect(later.alert).toBe(true);
  });

  it("never claims absolute certainty", () => {
    const prediction = find(run(collegeLab, collegeLabHistory(30)), "laptop");
    expect(prediction.probability).toBeLessThan(1);
  });

  it("quotes the real counts in the explanation", () => {
    const prediction = find(run(collegeLab, collegeLabHistory(8)), "laptop");
    expect(prediction.reason).toContain("8 of your last 8");
    expect(prediction.reason).toContain("college lab");
  });

  it("mentions the companion item that best explains the prediction", () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      sample(`t${index}`, collegeLab, ["laptop", "charger", "id-card"]),
    );
    const charger = find(run(collegeLab, history), "charger");
    expect(charger.evidence.coOccurrence?.itemId).toBe("laptop");
    expect(charger.reason).toContain("where you also took your laptop");
  });

  it("lowers the probability when an item is repeatedly marked not needed", () => {
    const history = [
      ...collegeLabHistory(8),
      sample("n0", collegeLab, [], ["laptop"]),
      sample("n1", collegeLab, [], ["laptop"]),
    ];
    const withSkips = find(run(collegeLab, history), "laptop");
    const without = find(run(collegeLab, collegeLabHistory(8)), "laptop");
    expect(withSkips.probability).toBeLessThan(without.probability);
  });

  it("ignores remind_later, which tells us nothing", () => {
    const history = collegeLabHistory(4).map((entry) => ({ ...entry }));
    const withUnanswered = [
      ...history,
      sample("u0", collegeLab, [], [], ["charger"]),
      sample("u1", collegeLab, [], [], ["charger"]),
    ];
    const base = find(run(collegeLab, history), "charger");
    const after = find(run(collegeLab, withUnanswered), "charger");
    expect(after.evidence.observations).toBe(base.evidence.observations);
    expect(after.evidence.confirmations).toBe(base.evidence.confirmations);
  });

  it("keeps a different purpose from borrowing the exact-context score", () => {
    const sportsDay = ctx("college", "sports", ["academic"]);
    const predictions = run(sportsDay, collegeLabHistory(8));
    const laptop = find(predictions, "laptop");
    expect(laptop.evidence.primaryScope).not.toBe("exact");
    expect(laptop.alert).toBe(false);
  });
});

describe("exceptions", () => {
  it("damps a prediction when the user says the pattern does not apply", () => {
    const exception: ContextException = {
      id: "e1",
      userId: "u1",
      itemId: "laptop",
      contextKey: "college::lab",
      scope: "recurring",
      reason: "Fridays I don't need it",
      createdAt: "2026-09-18T08:00:00.000Z",
    };
    const damped = find(run(collegeLab, collegeLabHistory(8), [exception]), "laptop");
    const base = find(run(collegeLab, collegeLabHistory(8)), "laptop");
    expect(damped.probability).toBeLessThan(base.probability);
    expect(damped.alert).toBe(false);
    expect(damped.evidence.exceptions).toBe(1);
    expect(damped.reason).toContain("not needed on 1 similar trip");
  });

  it("does not alert again after a same-day opt-out", () => {
    const exception: ContextException = {
      id: "e2",
      userId: "u1",
      itemId: "laptop",
      contextKey: "college::lab",
      scope: "once",
      reason: "don't need it today",
      createdAt: "2026-09-19T07:00:00.000Z",
    };
    const prediction = find(run(collegeLab, collegeLabHistory(8), [exception]), "laptop");
    expect(prediction.alert).toBe(false);
    expect(prediction.alertSuppressed).toBe(true);
    expect(prediction.reason).toContain("already said you don't need it today");
  });
});

describe("analogous context", () => {
  it("recognises a new destination as similar and suggests, rather than insists", () => {
    const projectNight = ctx("college", "project night", ["project", "event"]);
    const history = Array.from({ length: 3 }, (_, index) =>
      sample(`p${index}`, projectNight, ["laptop", "charger", "headphones", "extension-board"]),
    );

    const hackathon = ctx("hackathon-hall", "project night", ["project", "event"]);
    const extensionBoard = find(run(hackathon, history), "extension-board");

    expect(extensionBoard.analogous).toBe(true);
    expect(extensionBoard.evidence.primaryScope).toBe("sibling");
    expect(extensionBoard.probability).toBeGreaterThan(0.5);
    expect(extensionBoard.alert).toBe(false);
    expect(extensionBoard.reason).toContain("similar trips");
  });
});

describe("weather", () => {
  it("raises an item using only rainy trips, and quotes only those", () => {
    const rainy = ctx("college", "lab", ["academic", "lab", "rain"]);
    const clear = ctx("college", "lab", ["academic", "lab"]);
    const history = [
      ...Array.from({ length: 4 }, (_, index) => sample(`r${index}`, rainy, ["laptop", "charger", "umbrella"])),
      ...Array.from({ length: 4 }, (_, index) => sample(`c${index}`, clear, ["laptop", "charger"])),
    ];

    const umbrella = find(run(rainy, history), "umbrella");
    expect(umbrella.evidence.weatherRelevant).toBe(true);
    expect(umbrella.evidence.observations).toBe(4);
    expect(umbrella.evidence.confirmations).toBe(4);
    expect(umbrella.reason).toContain("Rain is expected today");
    expect(umbrella.reason).toContain("4 of your last 4 rainy college trips");
  });

  it("talks an item down on a dry day when that is what the history says", () => {
    // A recorded snapshot, which is how the app really logs weather — a trip with
    // no weather recorded is "unknown", deliberately not "clear".
    const rainy = ctx("college", "lab", ["academic", "lab", "rain"]);
    rainy.weather = { condition: "rain", tempC: 18, source: "api" };
    const clear = ctx("college", "lab", ["academic", "lab"]);
    clear.weather = { condition: "clear", tempC: 30, source: "api" };
    const history = [
      ...Array.from({ length: 4 }, (_, index) => sample(`r${index}`, rainy, ["laptop", "umbrella"])),
      ...Array.from({ length: 3 }, (_, index) => sample(`c${index}`, clear, ["laptop"], ["umbrella"])),
    ];

    const dryUmbrella = find(run(clear, history), "umbrella");
    const wetUmbrella = find(run(rainy, history), "umbrella");

    // Same item, same history — only the weather differs.
    expect(wetUmbrella.probability).toBeGreaterThan(dryUmbrella.probability);
    expect(dryUmbrella.evidence.weatherRelevant).toBe(true);
    expect(dryUmbrella.evidence.observations).toBe(3);
    expect(dryUmbrella.evidence.confirmations).toBe(0);
    expect(dryUmbrella.reason).toContain("No rain is expected today");
    expect(dryUmbrella.reason).toContain("0 of your last 3 clear college trips");
  });

  it("will not condition on a weather state it has barely seen", () => {
    const rainy = ctx("college", "lab", ["academic", "lab", "rain"]);
    const clear = ctx("college", "lab", ["academic", "lab"]);
    const history = [
      // One wet trip, four dry ones. That is not a rainy-day pattern yet.
      sample("r0", rainy, ["laptop", "umbrella"]),
      ...Array.from({ length: 4 }, (_, index) => sample(`c${index}`, clear, ["laptop"])),
    ];

    const umbrella = find(run(rainy, history), "umbrella");
    expect(umbrella.evidence.weatherRelevant).toBe(false);
    expect(umbrella.reason).not.toContain("Rain is expected");
    // The lone wet trip must not swing anything: the estimate is identical to
    // what we would say with no weather information at all.
    const withoutWeatherInfo = find(
      run(ctx("college", "lab", ["academic", "lab"]), history),
      "umbrella",
    );
    expect(umbrella.probability).toBeCloseTo(withoutWeatherInfo.probability, 10);
  });

  it("ignores weather entirely when the day's conditions are unknown", () => {
    const unknown = ctx("college", "lab", ["academic", "lab"]);
    const rainy = ctx("college", "lab", ["academic", "lab", "rain"]);
    const history = Array.from({ length: 4 }, (_, index) =>
      sample(`r${index}`, rainy, ["laptop", "umbrella"]),
    );

    const umbrella = find(run(unknown, history), "umbrella");
    expect(umbrella.evidence.weatherRelevant).toBe(false);
  });

});

describe("demo scenario", () => {
  it("holds the narrative: a guess becomes a confident, explained prediction", () => {
    // Trip 1: nothing learned.
    const first = find(run(collegeLab, []), "laptop");
    expect(first.probability).toBe(0.5);
    expect(first.confidence).toBe("low");

    // After five logged trips the habit is visible.
    const afterFive = find(run(collegeLab, collegeLabHistory(5)), "laptop");
    expect(afterFive.probability).toBeGreaterThan(0.85);
    expect(afterFive.alert).toBe(true);

    // After twelve it is a confident prediction, with the reason attached.
    const afterTwelve = find(run(collegeLab, collegeLabHistory(12)), "laptop");
    expect(afterTwelve.probability).toBeGreaterThan(0.94);
    expect(afterTwelve.confidence).toBe("high");
    expect(afterTwelve.reason).toContain("12 of your last 12");

    // Strictly increasing across the loop.
    expect(afterFive.probability).toBeGreaterThan(first.probability);
    expect(afterTwelve.probability).toBeGreaterThan(afterFive.probability);
  });
});

describe("determinism", () => {
  it("produces identical output for identical input", () => {
    const history = collegeLabHistory(5);
    const first = run(collegeLab, history);
    const second = run(collegeLab, history);
    expect(first).toEqual(second);
  });

  it("sorts predictions by descending probability", () => {
    const predictions = run(collegeLab, collegeLabHistory(6, ["laptop", "charger"]));
    const probabilities = predictions.map((prediction) => prediction.probability);
    expect(probabilities).toEqual([...probabilities].sort((a, b) => b - a));
  });
});
