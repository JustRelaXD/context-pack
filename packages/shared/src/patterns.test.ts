import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { computePatternGroups, computePatterns, labelOf, unknownItemIds } from "./patterns";
import type { LearningSample } from "./types";

function sample(
  tripId: string,
  destination: string,
  purpose: string | undefined,
  startedAt: string,
  items: Array<[string, "packed" | "not_needed"]>,
): LearningSample {
  return {
    tripId,
    context: { destination, ...(purpose ? { purpose } : {}), tags: [] },
    startedAt,
    items: items.map(([itemId, action]) => ({ itemId, action, source: "confirmed" as const })),
  };
}

const LAB_TRIPS: LearningSample[] = [
  sample("t1", "college", "lab", "2026-01-01T08:00:00Z", [
    ["laptop", "packed"],
    ["charger", "packed"],
    ["id-card", "packed"],
  ]),
  sample("t2", "college", "lab", "2026-01-02T08:00:00Z", [
    ["laptop", "packed"],
    ["charger", "packed"],
    ["id-card", "packed"],
  ]),
  sample("t3", "college", "lab", "2026-01-03T08:00:00Z", [
    ["laptop", "not_needed"],
    ["charger", "packed"],
    ["id-card", "packed"],
  ]),
];

describe("computePatternGroups", () => {
  it("counts raw observations and confirmations per context", () => {
    const [group] = computePatternGroups(LAB_TRIPS, CATALOG);
    expect(group?.contextKey).toBe("college::lab");
    expect(group?.label).toBe("college lab");
    expect(group?.trips).toBe(3);

    const laptop = group?.items.find((item) => item.itemId === "laptop");
    expect(laptop?.observations).toBe(3);
    expect(laptop?.confirmations).toBe(2);
    // (2 + 0.5) / (3 + 1)
    expect(laptop?.probability).toBeCloseTo(0.625, 5);
  });

  it("keeps the destination-level context separate from a specific purpose", () => {
    const groups = computePatternGroups(
      [
        ...LAB_TRIPS,
        sample("t4", "college", undefined, "2026-01-04T08:00:00Z", [["laptop", "packed"]]),
      ],
      CATALOG,
    );
    expect(groups.map((group) => group.contextKey).sort()).toEqual(["college::*", "college::lab"]);
  });

  it("ignores trips with no decided items so unanswered predictions cannot inflate counts", () => {
    const groups = computePatternGroups(
      [sample("t5", "gym", undefined, "2026-01-05T08:00:00Z", [["id-card", "packed"]])].concat([
        {
          tripId: "t6",
          context: { destination: "gym", tags: [] },
          startedAt: "2026-01-06T08:00:00Z",
          items: [{ itemId: "laptop", action: "unanswered" as const, source: "inferred" as const }],
        },
      ]),
      CATALOG,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.trips).toBe(1);
  });

  it("drops ids that are not in the catalog", () => {
    const groups = computePatternGroups(
      [sample("t7", "college", "lab", "2026-01-07T08:00:00Z", [["ghost-item" as string, "packed"]])],
      CATALOG,
    );
    expect(groups[0]?.items).toHaveLength(0);
  });

  it("orders the most recent context first", () => {
    const groups = computePatternGroups(
      [
        sample("old", "college", "lab", "2026-01-01T08:00:00Z", [["laptop", "packed"]]),
        sample("new", "gym", undefined, "2026-03-01T08:00:00Z", [["id-card", "packed"]]),
      ],
      CATALOG,
    );
    expect(groups[0]?.contextKey).toBe("gym::*");
  });
});

describe("computePatterns", () => {
  it("producing flat rows keeps the engine's inputs and the summary screen agreeing", () => {
    const rows = computePatterns(LAB_TRIPS, CATALOG, "u1");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.userId).toBe("u1");
      expect(row.observations).toBe(3);
      expect(row.updatedAt).toBe("2026-01-03T08:00:00Z");
    }
    const charger = rows.find((row) => row.itemId === "charger");
    expect(charger?.confirmations).toBe(3);
    expect(charger?.probability).toBeCloseTo(0.875, 5);
  });
});

describe("labelOf", () => {
  it("falls back to the destination when the purpose is unknown", () => {
    expect(labelOf("college::*")).toBe("college");
    expect(labelOf("college::lab")).toBe("college lab");
  });
});

describe("unknownItemIds", () => {
  it("reports carried items outside the closed catalog instead of hiding them", () => {
    const ids = unknownItemIds(
      [
        sample("t1", "college", "lab", "2026-01-01T08:00:00Z", [
          ["laptop", "packed"],
          ["projector-remote" as string, "packed"],
        ]),
      ],
      CATALOG,
    );
    expect(ids).toEqual(["projector-remote"]);
  });
});
