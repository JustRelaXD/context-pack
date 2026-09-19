import { contextLabel, normalizeToken } from "./normalize";
import type { Prediction, TripContext } from "./types";

/**
 * Turn a prediction's evidence into a sentence.
 *
 * This is the deterministic explanation path. It only ever quotes counts that
 * exist in `evidence`, which is the invariant that lets us tell judges "the
 * numbers are never model-generated". An LLM may *rephrase* this text later,
 * but it is never the source of the numbers.
 */
export function explainPrediction(prediction: Prediction, context: TripContext): string {
  const evidence = prediction.evidence;
  const name = prediction.item.name.toLowerCase();
  const label = contextLabel(context);
  const parts: string[] = [];

  if (evidence.observations === 0) {
    return prediction.reason || `Not enough history yet to say anything about your ${name}.`;
  }

  const trips = (count: number) => `trip${count === 1 ? "" : "s"}`;
  const { observations, confirmations } = evidence;

  if (prediction.analogous) {
    parts.push(
      `You confirmed your ${name} on ${confirmations} of your last ${observations} similar ` +
        `${trips(observations)}, even though you haven't logged a "${label}" trip before.`,
    );
  } else if (evidence.weatherRelevant) {
    parts.push(
      `${weatherOpener(context)}, and you confirmed your ${name} on ${confirmations} of your ` +
        `last ${observations} ${weatherWord(context)} ${context.destination} ${trips(observations)}.`,
    );
  } else if (evidence.coOccurrence) {
    parts.push(
      `You confirmed your ${name} on ${confirmations} of your last ${observations} ${label} ` +
        `${trips(observations)} where you also took your ${evidence.coOccurrence.itemName.toLowerCase()}.`,
    );
  } else if (evidence.primaryScope === "global") {
    parts.push(
      `You confirmed your ${name} on ${confirmations} of your last ${observations} logged ` +
        `${trips(observations)}, across different destinations.`,
    );
  } else if (confirmations === 0) {
    parts.push(
      `You haven't confirmed your ${name} on any of your last ${observations} ${label} ` +
        `${trips(observations)}.`,
    );
  } else {
    parts.push(
      `You confirmed your ${name} on ${confirmations} of your last ${observations} ${label} ` +
        `${trips(observations)}.`,
    );
  }

  if (evidence.exceptions > 0) {
    parts.push(
      `You've marked it as not needed on ${evidence.exceptions} similar ` +
        `${trips(evidence.exceptions)}.`,
    );
  }
  if (prediction.alertSuppressed) {
    parts.push(`You already said you don't need it today.`);
  }
  if (prediction.confidence === "low") {
    parts.push(`Not enough history yet for me to be confident.`);
  }

  return parts.join(" ");
}

/**
 * The weather word used in the sentence.
 *
 * Both of these read the same snapshot the predictor conditioned on, so the
 * explanation cannot describe a different day than the arithmetic used.
 */
function weatherCondition(context: TripContext): "clear" | "rain" | "snow" | "hot" | "cold" {
  const snapshot = context.weather;
  if (snapshot && snapshot.source !== "none") return snapshot.condition;
  const tags = context.tags.map(normalizeToken);
  if (tags.includes("snow")) return "snow";
  if (tags.includes("rain")) return "rain";
  return "clear";
}

function weatherOpener(context: TripContext): string {
  switch (weatherCondition(context)) {
    case "rain":
      return "Rain is expected today";
    case "snow":
      return "Snow is expected today";
    case "hot":
      return "It's going to be hot today";
    case "cold":
      return "It's going to be cold today";
    default:
      // Said plainly, because a *negative* weather signal is the reason an
      // umbrella is being talked down and the user deserves to know that.
      return "No rain is expected today";
  }
}

function weatherWord(context: TripContext): string {
  switch (weatherCondition(context)) {
    case "rain":
      return "rainy";
    case "snow":
      return "snowy";
    default:
      return weatherCondition(context);
  }
}
