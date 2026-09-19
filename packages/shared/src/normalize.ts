import type { EvidenceScope, TripContext } from "./types";

/** Canonical, comparable form of a single label. */
export function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * A context key deliberately drops weather: "college + rain" should still
 * learn from "college + clear", with weather acting as a modifier rather than
 * a separate context.
 */
export function contextKey(context: TripContext): string {
  const destination = normalizeToken(context.destination);
  const purpose = context.purpose ? normalizeToken(context.purpose) : "*";
  return `${destination}::${purpose}`;
}

export function destinationOf(contextKeyValue: string): string {
  return contextKeyValue.split("::")[0] ?? "";
}

/** Jaccard similarity of two tag sets, in [0, 1]. */
export function tagsMatch(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a.map(normalizeToken));
  const right = new Set(b.map(normalizeToken));
  let intersection = 0;
  for (const tag of left) if (right.has(tag)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Threshold above which two tag sets count as "the same kind of outing". */
const TAG_SIMILARITY_THRESHOLD = 0.34;

/**
 * How specific is a historical sample relative to what is happening now?
 *
 * - `exact`        same destination, same purpose or overlapping tags
 * - `destination`  same destination, different purpose
 * - `sibling`      a *different* destination that is similar in purpose/tags
 *                  — this is where analogous-context prediction comes from
 * - `global`       unrelated, contributes only as a weak prior
 */
export function scopeOf(current: TripContext, past: TripContext): EvidenceScope {
  const sameDestination =
    normalizeToken(current.destination) === normalizeToken(past.destination);
  const samePurpose =
    Boolean(current.purpose) &&
    Boolean(past.purpose) &&
    normalizeToken(current.purpose as string) === normalizeToken(past.purpose as string);
  const tagSimilarity = tagsMatch(current.tags, past.tags);

  if (sameDestination) {
    if (samePurpose) return "exact";
    // If both trips state a purpose and they disagree, that disagreement wins
    // over any tag overlap. "College for sports" is not "college for a lab"
    // just because both are at college and both are academic.
    const explicitPurposeConflict = Boolean(current.purpose) && Boolean(past.purpose);
    if (!explicitPurposeConflict && tagSimilarity >= TAG_SIMILARITY_THRESHOLD) return "exact";
    return "destination";
  }
  if (samePurpose || tagSimilarity >= TAG_SIMILARITY_THRESHOLD) return "sibling";
  return "global";
}

/** Human-readable label used in explanations, e.g. "college lab". */
export function contextLabel(context: TripContext): string {
  const destination = normalizeToken(context.destination);
  return context.purpose ? `${destination} ${normalizeToken(context.purpose)}` : destination;
}

/** The weather tag currently in play, if any. */
export function weatherTag(context: TripContext): string | undefined {
  return context.tags.map(normalizeToken).find((tag) => tag === "rain" || tag === "snow");
}
