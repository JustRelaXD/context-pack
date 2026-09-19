import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG, type WeatherSnapshot } from "@contextpack/shared";
import { createAgentLayer } from "./ai";
import { createService, type Service } from "./service";
import { createMemoryStore } from "./store";

/**
 * These tests are the demo script, asserted.
 *
 * They run on the fully offline agent (`CONTEXTPACK_AGENT=heuristic`) so the
 * suite is deterministic and needs no keys — and so a failure here always means
 * the *engine* changed, never that a model had a bad day.
 */

const RAIN: WeatherSnapshot = { condition: "rain", tempC: 22, source: "api" };
const CLEAR: WeatherSnapshot = { condition: "clear", tempC: 24, source: "api" };

function makeService(): { service: Service; advance: (days: number) => void } {
  let clock = new Date("2026-05-01T07:30:00.000Z");
  let counter = 0;
  const service = createService({
    store: createMemoryStore(),
    agent: createAgentLayer({ CONTEXTPACK_AGENT: "heuristic" }),
    now: () => new Date(clock),
    newId: () => `t${(counter += 1)}`,
  });
  return {
    service,
    advance: (days: number) => {
      clock = new Date(clock.getTime() + days * 24 * 60 * 60 * 1000);
    },
  };
}

describe("cold start", () => {
  it("says it is guessing instead of pretending it knows", async () => {
    const { service } = makeService();
    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });

    expect(view.coldStart).toBe(true);
    expect(view.items.length).toBeGreaterThan(0);
    for (const item of view.items) {
      expect(item.predictedProbability).toBeCloseTo(0.5, 5);
      expect(item.alert).toBe(false);
      expect(item.reason).toContain("haven't logged");
      expect(item.userAction).toBe("unanswered");
    }
  });

  it("stores the trip so history works before anything is learned", async () => {
    const { service } = makeService();
    await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const history = await service.listHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.rawInput).toBe("college for a lab");
    expect(history[0]?.unanswered).toBeGreaterThan(0);
  });
});

describe("the learning loop", () => {
  it("turns repeated confirmations into a confident, explained prediction", async () => {
    const { service, advance } = makeService();

    const first = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const firstLaptop = first.items.find((item) => item.itemId === "laptop");
    expect(firstLaptop?.predictedProbability).toBeCloseTo(0.5, 5);

    for (let trip = 0; trip < 8; trip += 1) {
      advance(1);
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      for (const itemId of ["laptop", "charger", "id-card"]) {
        await service.recordFeedback({ tripId: view.trip.id, itemId, action: "packed" });
      }
    }

    advance(1);
    const next = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const laptop = next.items.find((item) => item.itemId === "laptop");
    const idCard = next.items.find((item) => item.itemId === "id-card");

    expect(laptop?.predictedProbability).toBeGreaterThan(0.85);
    expect(laptop?.confidence).toBe("high");
    expect(laptop?.alert).toBe(true);
    expect(laptop?.reason).toContain("laptop".toLowerCase());
    // The claim must be traceable to real confirmations, not a model's memory.
    expect(laptop?.evidence.confirmations).toBe(8);
    expect(idCard?.predictedProbability).toBeGreaterThan(0.9);
    // Never certainty.
    expect(idCard?.predictedProbability).toBeLessThan(1);
  });

  it("raises a rarely-confirmed item far more slowly than a routine one", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 6; trip += 1) {
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "charger", action: "packed" });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "id-card", action: "packed" });
      // An umbrella is carried once in six trips, which is a real signal but a weak one.
      if (trip === 0) {
        await service.recordFeedback({ tripId: view.trip.id, itemId: "umbrella", action: "packed" });
      } else {
        await service.recordFeedback({ tripId: view.trip.id, itemId: "umbrella", action: "not_needed" });
      }
      advance(1);
    }

    const next = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const laptop = next.items.find((item) => item.itemId === "laptop");

    // Carried once in six trips: not worth showing at all, let alone alerting.
    expect(next.items.find((item) => item.itemId === "umbrella")).toBeUndefined();
    expect(laptop?.predictedProbability).toBeGreaterThan(0.85);
  });

  it("lets weather lift an item the user only ever carries in the rain", async () => {
    const { service, advance } = makeService();

    // Six lab trips, four wet and two dry, and the umbrella only on the wet ones.
    // Both weather states need enough trips to condition on, which is the point:
    // "I don't take it when it's dry" should be as much a learned fact as the
    // other direction.
    for (const rainy of [false, false, true, true, true, true]) {
      const view = await service.startTrip({
        rawInput: "college for a lab",
        withWeather: false,
        weather: rainy ? RAIN : CLEAR,
      });
      for (const itemId of ["laptop", "charger", "id-card"]) {
        await service.recordFeedback({ tripId: view.trip.id, itemId, action: "packed" });
      }
      await service.recordFeedback({
        tripId: view.trip.id,
        itemId: "umbrella",
        action: rainy ? "packed" : "not_needed",
      });
      advance(1);
    }

    const dry = await service.startTrip({ rawInput: "college for a lab", withWeather: false, weather: CLEAR });
    const wet = await service.startTrip({ rawInput: "college for a lab", withWeather: false, weather: RAIN });

    const dryUmbrella = dry.items.find((item) => item.itemId === "umbrella");
    const wetUmbrella = wet.items.find((item) => item.itemId === "umbrella");

    // In the rain it is a real prediction, and the reason quotes the rainy
    // subset rather than the whole history.
    expect(wetUmbrella).toBeDefined();
    expect(wetUmbrella!.probability).toBeGreaterThan(0.8);
    expect(wetUmbrella!.evidence.weatherRelevant).toBe(true);
    expect(wetUmbrella!.evidence.observations).toBe(4);
    expect(wetUmbrella!.evidence.confirmations).toBe(4);
    expect(wetUmbrella!.reason).toMatch(/rain is expected/i);

    // On a dry day the same item is not shown at all: it is not something you
    // take when it isn't raining, and a 30%-probability row would be noise.
    expect(dryUmbrella).toBeUndefined();
  });
});

describe("analogous contexts", () => {
  it("predicts an unseen outing from a similar one, and labels it as analogous", async () => {
    const { service, advance } = makeService();

    // The user has never been to a hackathon, but they do log project nights.
    for (let trip = 0; trip < 5; trip += 1) {
      const view = await service.startTrip({
        rawInput: "going to the studio for a project night",
        withWeather: false,
      });
      for (const itemId of ["laptop", "charger", "extension-board"]) {
        await service.recordFeedback({ tripId: view.trip.id, itemId, action: "packed" });
      }
      advance(1);
    }

    advance(1);
    const hackathon = await service.startTrip({ rawInput: "I'm going to a hackathon", withWeather: false });
    const extension = hackathon.items.find((item) => item.itemId === "extension-board");

    expect(extension).toBeDefined();
    expect(extension?.evidence.primaryScope).toBe("sibling");
    expect(extension?.analogous).toBe(true);
    // Support came from elsewhere, so we suggest rather than interrupt.
    expect(extension?.alert).toBe(false);
    expect(extension?.reason).toContain("similar");
  });
});

describe("exceptions", () => {
  it("records an explicit 'not needed today' as an exception, not a mistake", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 5; trip += 1) {
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
      advance(1);
    }

    advance(1);
    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });

    const parsed = await service.interpretException({
      tripId: view.trip.id,
      rawInput: "I don't need my laptop today",
    });

    expect(parsed.parsed?.itemId).toBe("laptop");
    expect(parsed.parsed?.action).toBe("mark_not_needed");
    // Absent an explicit cue, an exception must not become a permanent rule.
    expect(parsed.parsed?.scope).toBe("once");

    const laptop = parsed.view.items.find((item) => item.itemId === "laptop");
    expect(laptop?.userAction).toBe("not_needed");
    expect(laptop?.alert).toBe(false);

    const exceptions = await service.listExceptions();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.contextKey).toBe("college::lab");
  });

  it("does not alert on an item the user has just said they do not need", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 6; trip += 1) {
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      for (const itemId of ["laptop", "charger", "id-card"]) {
        await service.recordFeedback({ tripId: view.trip.id, itemId, action: "packed" });
      }
      advance(1);
    }

    advance(1);
    const today = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    expect(today.alerts.map((item) => item.itemId)).toContain("laptop");

    await service.recordFeedback({ tripId: today.trip.id, itemId: "laptop", action: "not_needed" });
    const after = await service.getTrip(today.trip.id);
    expect(after?.alerts.map((item) => item.itemId)).not.toContain("laptop");
  });

  it("lets a durable rule damp a prediction without erasing it", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 6; trip += 1) {
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
      advance(1);
    }

    advance(1);
    const before = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const beforeLaptop = before.items.find((item) => item.itemId === "laptop")?.probability ?? 0;

    // "from now on" is the cue that makes it durable.
    const parsed = await service.interpretException({
      tripId: before.trip.id,
      rawInput: "I don't need my laptop on lab days from now on",
    });
    expect(parsed.parsed?.scope).toBe("recurring");

    const after = await service.getTrip(before.trip.id);
    const afterLaptop = after?.items.find((item) => item.itemId === "laptop");

    expect(afterLaptop!.probability).toBeLessThan(beforeLaptop);
    // Damped, not deleted: the user may still want it on other days.
    expect(afterLaptop!.probability).toBeGreaterThan(0);
    expect(afterLaptop!.alert).toBe(false);
    expect(afterLaptop!.reason).toMatch(/not needed/i);
    // ...and what we originally claimed is still on the record.
    expect(afterLaptop!.predictedProbability).toBeCloseTo(beforeLaptop, 5);
  });

  it("returns null rather than guessing when the sentence is not an exception", async () => {
    const { service } = makeService();
    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const result = await service.interpretException({
      tripId: view.trip.id,
      rawInput: "the weather looks nice",
    });
    expect(result.parsed).toBeNull();
    expect(await service.listExceptions()).toHaveLength(0);
  });
});

describe("honesty guarantees", () => {
  it("never stores an unanswered prediction as evidence", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 4; trip += 1) {
      await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      advance(1);
    }
    const learning = await service.learning();
    expect(learning.trips).toBe(0);
    expect(learning.decided).toBe(0);

    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
    expect((await service.learning()).trips).toBe(1);
  });

  it("marks packed as confirmed and everything else as only inferred", async () => {
    const { service } = makeService();
    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });

    const packed = await service.recordFeedback({
      tripId: view.trip.id,
      itemId: "laptop",
      action: "packed",
    });
    expect(packed.items.find((item) => item.itemId === "laptop")?.confirmationSource).toBe("confirmed");

    const skipped = await service.recordFeedback({
      tripId: view.trip.id,
      itemId: "charger",
      action: "not_needed",
    });
    expect(skipped.items.find((item) => item.itemId === "charger")?.confirmationSource).toBe("inferred");
  });

  it("keeps the probability it showed at the time, even after history changes", async () => {
    const { service, advance } = makeService();
    const first = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    const firstLaptop = first.items.find((item) => item.itemId === "laptop")?.predictedProbability ?? 0;
    await service.recordFeedback({ tripId: first.trip.id, itemId: "laptop", action: "packed" });

    for (let trip = 0; trip < 5; trip += 1) {
      advance(1);
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
    }

    // The snapshot is frozen, while the live estimate keeps moving.
    const reread = await service.getTrip(first.trip.id);
    const laptop = reread?.items.find((item) => item.itemId === "laptop");
    expect(laptop?.predictedProbability).toBeCloseTo(firstLaptop, 5);
    expect(laptop!.probability).toBeGreaterThan(laptop!.predictedProbability);
  });

  it("reports the catalog item count as a closed set the agent cannot exceed", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    expect(new Set(CATALOG.map((item) => item.id)).size).toBe(CATALOG.length);
  });
});

describe("feedback input validation", () => {
  let service: Service;
  beforeEach(() => {
    ({ service } = makeService());
  });

  it("rejects an item outside the catalog", async () => {
    const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
    await expect(
      service.recordFeedback({ tripId: view.trip.id, itemId: "jetpack", action: "packed" }),
    ).rejects.toThrow(/not in the item catalog/);
  });

  it("rejects an unknown trip", async () => {
    await expect(
      service.recordFeedback({ tripId: "nope", itemId: "laptop", action: "packed" }),
    ).rejects.toThrow(/Unknown trip/);
  });

  it("refuses an empty trip", async () => {
    await expect(service.startTrip({ rawInput: "   " })).rejects.toThrow(/Tell me where/);
  });
});

describe("learning overview", () => {
  it("summarises what was learned without smoothing the user's own counts", async () => {
    const { service, advance } = makeService();
    for (let trip = 0; trip < 3; trip += 1) {
      const view = await service.startTrip({ rawInput: "college for a lab", withWeather: false });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "laptop", action: "packed" });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "charger", action: "packed" });
      await service.recordFeedback({ tripId: view.trip.id, itemId: "umbrella", action: "not_needed" });
      advance(1);
    }

    const learning = await service.learning();
    expect(learning.trips).toBe(3);
    expect(learning.decided).toBe(9);
    expect(learning.confirmed).toBe(6);
    expect(learning.confirmRate).toBeCloseTo(6 / 9, 5);

    const group = learning.groups.find((candidate) => candidate.contextKey === "college::lab");
    expect(group?.trips).toBe(3);
    expect(group?.items.find((item) => item.itemId === "laptop")).toMatchObject({
      observations: 3,
      confirmations: 3,
    });
    expect(group?.items.find((item) => item.itemId === "umbrella")?.confirmations).toBe(0);
  });
});
