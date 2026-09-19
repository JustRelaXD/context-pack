import { CATALOG_BY_ID, type WeatherSnapshot } from "@contextpack/shared";
import { createAgentLayer } from "../ai";
import { loadEnvFile } from "../env";
import { createService, DEFAULT_USER_ID } from "../service";
import { createStore, describeStore } from "../store";
import type { JsonStore } from "../store";
import { nullWeatherProvider } from "../weather";

/**
 * Seed a believable history so the app has something to have learned from.
 *
 * This goes through `startTrip` and `recordFeedback` — the real code paths —
 * rather than writing records directly. That costs a little time and buys a lot:
 * if the seed produces good predictions, it is because the product works, not
 * because the fixture was hand-tuned to match the engine.
 *
 * Everything is deterministic (fixed PRNG seed, fixed clock) so the demo numbers
 * are reproducible on any machine.
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

function plan(): PlannedTrip[] {
  const random = mulberry32(SEED);
  const trips: PlannedTrip[] = [];
  // Anchor to today so the seeded history always looks recent.
  const end = new Date();
  end.setSeconds(0, 0);

  for (let day = 0; day < DAYS; day += 1) {
    const offset = DAYS - day;
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

/**
 * Percentages never print 100%.
 *
 * The engine already cannot reach 1.0, but rounding would reintroduce the claim
 * we spent effort avoiding — 0.997 rendering as "100% likely" is exactly the
 * overconfidence the product is supposed to be honest about.
 */
function percent(value: number): string {
  return `${Math.min(99, Math.round(value * 100))}%`;
}

async function main(): Promise<void> {
  loadEnvFile();

  const store = createStore();
  const agent = createAgentLayer({ ...process.env, CONTEXTPACK_AGENT: "heuristic" });
  const described = describeStore(store);

  let clock = new Date();
  let counter = 0;
  const service = createService({
    store,
    agent,
    // Seeds set weather explicitly, so no network call is ever made.
    weather: nullWeatherProvider,
    now: () => new Date(clock),
    newId: () => `seed-${++counter}`,
  });

  console.log(`Seeding ${described.adapter} store${described.file ? ` (${described.file})` : ""}`);
  await store.reset();

  const trips = plan();
  for (const trip of trips) {
    clock = trip.at;
    const view = await service.startTrip({
      rawInput: trip.scenario.rawInput,
      withWeather: false,
      weather: trip.weather,
    });
    for (const decision of trip.decisions) {
      await service.recordFeedback({
        tripId: view.trip.id,
        itemId: decision.itemId,
        action: decision.action,
      });
    }
  }

  const json = store as Partial<JsonStore>;
  if (typeof json.flush === "function") await json.flush();

  const learning = await service.learning(DEFAULT_USER_ID);
  console.log(`\nLogged ${learning.trips} trips with decisions (${trips.length} total).`);
  for (const group of learning.groups) {
    const top = group.items
      .filter((item) => item.observations >= 2)
      .slice(0, 5)
      .map(
        (item) =>
          `${item.item.emoji} ${item.item.name} ${percent(item.probability)} (${item.confirmations}/${item.observations})`,
      );
    if (top.length === 0) continue;
    console.log(`\n${group.label}  —  ${group.trips} trips`);
    for (const line of top) console.log(`   ${line}`);
  }

  // Show what the seeded app predicts *right now*, which is the demo's opening
  // frame: this is the state a returning user would find.
  clock = new Date();
  const dry = await service.startTrip({
    rawInput: "college for a lab",
    withWeather: false,
    weather: CLEAR,
  });
  const wet = await service.startTrip({
    rawInput: "college for a lab",
    withWeather: false,
    weather: RAIN,
  });
  const hackathon = await service.startTrip({
    rawInput: "I'm going to a hackathon",
    withWeather: false,
  });

  const renderView = (title: string, view: typeof dry) => {
    console.log(`\n${title}`);
    for (const item of view.items.slice(0, 6)) {
      const flag = item.alert ? "  <- would alert" : item.analogous ? "  (analogous)" : "";
      console.log(`   ${item.item.emoji} ${percent(item.probability).padStart(4)}  ${item.item.name}${flag}`);
    }
    const alert = view.alerts[0];
    if (alert) console.log(`   why: ${alert.reason}`);
  };

  renderView("Today, clear — \"college for a lab\"", dry);
  renderView("Today, raining — \"college for a lab\"", wet);
  renderView("Never logged before — \"I'm going to a hackathon\"", hackathon);

  console.log(
    "\nThese three seeded trips are left in your history. " +
      'Try "college for a lab" in the app, then tell it "I don\'t need my laptop today".',
  );
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
