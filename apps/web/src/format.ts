import type { ConfidenceTier, TripContext, TripItemView } from "@contextpack/shared";

/**
 * Percentages are capped at 99%, in the UI as well as the engine.
 *
 * The whole product argument is "based on your history, you probably need this"
 * — so a rounded 100% would undercut it in the one place a user actually reads
 * the number. The cap lives here so every screen inherits it.
 */
export function percent(value: number): string {
  return `${Math.min(99, Math.max(0, Math.round(value * 100)))}%`;
}

/**
 * The one-line reason under an item's name.
 *
 * A row has room for about eight words, and the full explanation is a sentence
 * with numbers in it. So the row gets a count and the "Why?" panel gets the
 * sentence — that is the whole reason the panel exists, rather than it being a
 * place to hide the interesting part.
 */
export function evidenceSummary(item: TripItemView): string {
  const { observations, confirmations } = item.evidence;
  if (item.unpredicted) return "You added this yourself";
  if (observations === 0) return "No history yet — first guess";
  const scope =
    item.evidence.primaryScope === "exact"
      ? "trip like this"
      : item.evidence.primaryScope === "sibling"
        ? "similar trips"
        : item.evidence.primaryScope === "destination"
          ? "trips here"
          : "all trips";
  return `${confirmations} of ${observations} ${scope}`;
}

export function ratio(confirmations: number, observations: number): string {
  return `${confirmations} of ${observations}`;
}

export function confidenceLabel(confidence: ConfidenceTier): string {
  switch (confidence) {
    case "high":
      return "lots of history";
    case "medium":
      return "some history";
    default:
      return "thin history";
  }
}

/** Short, human chips describing where the user says they're going. */
export function contextChips(context: TripContext): string[] {
  const chips: string[] = [context.destination];
  if (context.purpose) chips.push(context.purpose);
  for (const tag of context.tags) {
    if (tag === context.destination || tag === context.purpose) continue;
    if (tag === "rain" || tag === "snow" || tag === "hot" || tag === "cold") continue;
    chips.push(tag);
  }
  return chips;
}

export function weatherLabel(context: TripContext): string | null {
  const weather = context.weather;
  if (!weather || weather.source === "none") return null;
  const temp = weather.tempC !== undefined ? ` ${Math.round(weather.tempC)}°C` : "";
  switch (weather.condition) {
    case "rain":
      return `☔ Rain${temp}`;
    case "snow":
      return `❄️ Snow${temp}`;
    case "hot":
      return `🔥 Hot${temp}`;
    case "cold":
      return `🧊 Cold${temp}`;
    default:
      return `☀️ Clear${temp}`;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function relativeDay(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const days = Math.round((startOfToday - startOfThen) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
