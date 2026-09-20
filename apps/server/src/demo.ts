import { CATALOG_BY_ID, type WeatherSnapshot } from "@contextpack/shared";
import { createAgentLayer } from "./ai";
import { createService, DEFAULT_USER_ID, type Service } from "./service";
import type { Store } from "./store";
import { nullWeatherProvider } from "./weather";

/**
 * Example history generator.
 *
 * It lives in the server rather than in a script because two callers need it:
 * the CLI (`npm run seed`) and the app itself, where it backs a one-tap "load
 * example history" — which is what makes a fresh install, or a serverless
 * deployment with no database, demonstrable without a terminal.
 *
 * It goes through `startTrip` and `recordFeedback`, the real code paths, with
 * backdated timestamps instead of writing records straight to the store. That
 * costs a little time and buys the only thing worth having: if the generated
 * history yields good predictions, it is because the product works, not because
 * a fixture was hand-tuned to match the engine.
 *
 * Deterministic — fixed PRNG seed, fixed scenarios, rule-based parsing — so the
 * numbers quoted in the README stay true.
 */

const DAYS = 42;
const SEED = 0x5eed1a;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAIN: WeatherSnapshot = { condition: "rain", tempC: 21, source: "api" };
const CLEAR: WeatherSnapshot = { condition: "clear", tempC: 28, source: "api" };

interface PlannedItem {
  itemId: string;
  /** Probability the user carried it on a trip like this. */
  packed: number;
  /** Only ever carried in the rain — the umbrella case. */
  rainOnly?: boolean;
}

/**
 * Every item on a scenario's list gets an answer, carried or not.
 *
 * This is deliberate. Recording only the hits would fabricate a perfect history
 * — a "notebook" listed for labs but left behind half the time would read as
 * 5/5, and the app would start insisting on a notebook. The user of this app
 * answers the prompts, so the seed answers them too.
 */

interface Scenario {
  rawInput: string;
  /** Relative frequency of this outing. */
  weight: number;
  /** Whether to attach a weather snapshot (and sometimes make it rain). */
  weather: "sometimes" | "none";
  items: PlannedItem[];
}

const SCENARIOS: Scenario[] = [
  {
    rawInput: "college for a lab",
    weight: 3,
    weather: "sometimes",
    items: [
      { itemId: "laptop", packed: 0.9 },
      { itemId: "charger", packed: 0.95 },
      { itemId: "id-card", packed: 1 },
      { itemId: "lab-kit", packed: 0.8 },
      { itemId: "notebook", packed: 0.5 },
      { itemId: "umbrella", packed: 0.9, rainOnly: true },
    ],
  },
  {
    rawInput: "going to college",
    weight: 4,
    weather: "sometimes",
    items: [
      { itemId: "laptop", packed: 0.6 },
      { itemId: "charger", packed: 0.8 },
      { itemId: "id-card", packed: 1 },
      { itemId: "water-bottle", packed: 0.7 },
      { itemId: "notebook", packed: 0.4 },
      { itemId: "umbrella", packed: 0.9, rainOnly: true },
    ],
  },
  {
    rawInput: "heading to the gym",
    weight: 3,
    weather: "none",
    items: [
      { itemId: "id-card", packed: 1 },
      { itemId: "water-bottle", packed: 0.95 },
      { itemId: "gym-clothes", packed: 0.9 },
      { itemId: "headphones", packed: 0.6 },
    ],
  },
  {
    // Never called a "hackathon" — which is what lets the analogous-context demo
    // work later.
    rawInput: "going to the studio for a project night",
    weight: 2,
    weather: "none",
    items: [
      { itemId: "laptop", packed: 1 },
      { itemId: "charger", packed: 0.95 },
      { itemId: "headphones", packed: 0.8 },
      { itemId: "extension-board", packed: 0.85 },
      { itemId: "power-bank", packed: 0.5 },
    ],
  },
];

function weightedPick(scenarios: Scenario[], roll: number): Scenario {
  const total = scenarios.reduce((sum, scenario) => sum + scenario.weight, 0);
  let threshold = roll * total;
  for (const scenario of scenarios) {
    threshold -= scenario.weight;
    if (threshold <= 0) return scenario;
  }
  return scenarios[scenarios.length - 1] as Scenario;
}

interface PlannedTrip {
  at: Date;
  scenario: Scenario;
  weather: WeatherSnapshot | null;
  decisions: Array<{ itemId: string; action: "packed" | "not_needed" }>;
}

function plan(days: number, endingAt: Date): PlannedTrip[] {
  const random = mulberry32(SEED);
  const trips: PlannedTrip[] = [];
  // Anchor to the end date so the generated history always looks recent.
  const end = new Date(endingAt);
  end.setSeconds(0, 0);

  for (let day = 0; day < days; day += 1) {
    const offset = days - day;
    const tripsToday = random() < 0.35 ? 2 : 1;

    for (let index = 0; index < tripsToday; index += 1) {
      const scenario = weightedPick(SCENARIOS, random());
      const at = new Date(end);
      at.setDate(at.getDate() - offset);
      at.setHours(index === 0 ? 7 : 17, index === 0 ? 40 : 10, 0, 0);

      let weather: WeatherSnapshot | null = null;
      if (scenario.weather === "sometimes") {
        // Roughly a third of trips rainy, which is enough rainy history for the
        // weather conditioning to have real evidence behind it.
        weather = random() < 0.35 ? RAIN : CLEAR;
      }
      const rainy = weather?.condition === "rain";

      const decisions: PlannedTrip["decisions"] = [];
      for (const item of scenario.items) {
        if (!CATALOG_BY_ID.has(item.itemId)) continue;
        // An umbrella is not "forgotten" on a dry day; it simply is not needed.
        const chance = item.rainOnly && !rainy ? 0 : item.packed;
        const carried = random() < chance;
        decisions.push({ itemId: item.itemId, action: carried ? "packed" : "not_needed" });
      }

      trips.push({ at, scenario, weather, decisions });
    }
  }

  return trips.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface DemoHistoryOptions {
  service: Service;
  userId?: string;
  /** How many days of history to generate. Defaults to six weeks. */
  days?: number;
  /** The day the history ends; defaults to today. */
  endingAt?: Date;
}

export interface DemoHistoryResult {
  /** Trips that carry at least one decision, i.e. the ones that teach us. */
  trips: number;
  decisions: number;
  contextGroups: number;
}

/**
 * Replay a believable history into whatever store the service is using.
 *
 * The caller picks the service, which matters more than it looks: both callers
 * build one whose agent layer is forced to the rule-based path. That keeps this
 * offline and instant (no model call per trip), and keeps it reproducible.
 */
export async function generateDemoHistory(options: DemoHistoryOptions): Promise<DemoHistoryResult> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const { service } = options;
  const planned = plan(options.days ?? DAYS, options.endingAt ?? new Date());

  let decisions = 0;
  for (const trip of planned) {
    const view = await service.startTrip({
      userId,
      rawInput: trip.scenario.rawInput,
      withWeather: false,
      weather: trip.weather,
      at: trip.at,
    });
    for (const decision of trip.decisions) {
      await service.recordFeedback({
        userId,
        tripId: view.trip.id,
        itemId: decision.itemId,
        action: decision.action,
        at: trip.at,
      });
      decisions += 1;
    }
  }

  const learning = await service.learning(userId);
  return { trips: learning.trips, decisions, contextGroups: learning.groups.length };
}

/**
 * A service that talks to a store through the rule-based agent only.
 *
 * Used for generating example history: no keys needed, no network in the loop,
 * and the same output every time.
 */
export function createOfflineService(store: Store, salt = "demo"): Service {
  let counter = 0;
  return createService({
    store,
    agent: createAgentLayer({ ...process.env, CONTEXTPACK_AGENT: "heuristic" }),
    // Weather is set explicitly per trip, so no forecast call is ever made.
    weather: nullWeatherProvider,
    newId: () => `${salt}-${++counter}`,
  });
}

export const DEMO_RAIN: WeatherSnapshot = RAIN;
export const DEMO_CLEAR: WeatherSnapshot = CLEAR;

/**
 * Percentages never print 100%.
 *
 * The engine already cannot reach 1.0, but rounding would reintroduce the claim
 * we spent effort avoiding — 0.997 rendering as "100% likely" is exactly the
 * overconfidence this product is supposed to be honest about.
 */
export function percent(value: number): string {
  return `${Math.min(99, Math.round(value * 100))}%`;
}
