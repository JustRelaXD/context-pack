import { normalizeToken } from "./normalize";
import type { Item, LearningSample, Pattern } from "./types";

/**
 * "What I've learned" summarisation.
 *
 * This reads the same records the predictor reads — it is a *view* of the
 * history, not a second source of truth. That matters for the trust story: if
 * this screen says "you confirmed your charger on 14 of 16", the prediction for
 * the next trip is derived from exactly those 16 trips.
 *
 * Counts here are deliberately raw, unlike the weighted evidence in
 * `predict.ts`. This screen is about what the user actually did, so no
 * smoothing belongs in the numbers we show them.
 */

export interface PatternItem {
  itemId: string;
  item: Item;
  observations: number;
  confirmations: number;
  /** Raw confirm rate, with a neutral prior so 0/1 does not read as 0%. */
  probability: number;
}

export interface PatternGroup {
  contextKey: string;
  /** Human label, e.g. "college lab". */
  label: string;
  /** Trips logged in this context that carried at least one decision. */
  trips: number;
  lastSeenAt: string;
  items: PatternItem[];
}

const PRIOR_RATE = 0.5;
const PRIOR_WEIGHT = 1;

export function contextKeyOf(sample: LearningSample): string {
  const destination = normalizeToken(sample.context.destination);
  const purpose = sample.context.purpose ? normalizeToken(sample.context.purpose) : "*";
  return `${destination}::${purpose}`;
}

export function labelOf(contextKey: string): string {
  const [destination = "", purpose = ""] = contextKey.split("::");
  return purpose && purpose !== "*" ? `${destination} ${purpose}` : destination;
}

function isDecided(action: string): boolean {
  return action === "packed" || action === "not_needed";
}

export function computePatternGroups(samples: LearningSample[], catalog: Item[]): PatternGroup[] {
  const itemsById = new Map(catalog.map((item) => [item.id, item] as const));

  interface Accumulator {
    trips: number;
    lastSeenAt: string;
    items: Map<string, { observations: number; confirmations: number }>;
  }

  const groups = new Map<string, Accumulator>();

  for (const sample of samples) {
    const decided = sample.items.filter((entry) => isDecided(entry.action));
    if (decided.length === 0) continue;

    const key = contextKeyOf(sample);
    const group = groups.get(key) ?? { trips: 0, lastSeenAt: sample.startedAt, items: new Map() };
    group.trips += 1;
    if (sample.startedAt > group.lastSeenAt) group.lastSeenAt = sample.startedAt;

    for (const entry of decided) {
      const bucket = group.items.get(entry.itemId) ?? { observations: 0, confirmations: 0 };
      bucket.observations += 1;
      if (entry.action === "packed") bucket.confirmations += 1;
      group.items.set(entry.itemId, bucket);
    }

    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([contextKey, group]): PatternGroup => {
      const items: PatternItem[] = [];
      for (const [itemId, counts] of group.items) {
        const item = itemsById.get(itemId);
        if (!item) continue;
        items.push({
          itemId,
          item,
          observations: counts.observations,
          confirmations: counts.confirmations,
          probability:
            (counts.confirmations + PRIOR_RATE * PRIOR_WEIGHT) /
            (counts.observations + PRIOR_WEIGHT),
        });
      }
      items.sort((a, b) => b.probability - a.probability || b.confirmations - a.confirmations);
      return { contextKey, label: labelOf(contextKey), trips: group.trips, lastSeenAt: group.lastSeenAt, items };
    })
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/** Flatten to the persisted `Pattern` shape, one row per (context, item). */
export function toPatternRows(groups: PatternGroup[], userId: string): Pattern[] {
  return groups.flatMap((group) =>
    group.items.map((item): Pattern => ({
      userId,
      itemId: item.itemId,
      contextKey: group.contextKey,
      observations: item.observations,
      confirmations: item.confirmations,
      probability: item.probability,
      updatedAt: group.lastSeenAt,
    })),
  );
}

/** Convenience: the flat rows straight from history. */
export function computePatterns(
  samples: LearningSample[],
  catalog: Item[],
  userId: string,
): Pattern[] {
  return toPatternRows(computePatternGroups(samples, catalog), userId);
}

/**
 * Items the user carried that our closed catalog has never heard of.
 *
 * We cannot learn about these (the predictor may only choose from the catalog),
 * so surfacing them is the honest alternative to silently dropping them.
 */
export function unknownItemIds(samples: LearningSample[], catalog: Item[]): string[] {
  const known = new Set(catalog.map((item) => item.id));
  const seen = new Set<string>();
  for (const sample of samples) {
    for (const entry of sample.items) if (!known.has(entry.itemId)) seen.add(entry.itemId);
  }
  return [...seen].sort();
}
