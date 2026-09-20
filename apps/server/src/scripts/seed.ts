import { loadEnvFile } from "../env";
import {
  createOfflineService,
  DEMO_CLEAR,
  DEMO_RAIN,
  generateDemoHistory,
  percent,
} from "../demo";
import { createStore, describeStore } from "../store";
import type { JsonStore } from "../store";
import { DEFAULT_USER_ID, type TripView } from "../service";

/**
 * Generate a believable history so the app has something to have learned from:
 *
 *   npm run seed
 *
 * The generator itself lives in `src/demo.ts` because the app calls it too —
 * see the "load example history" action on first run. This file is only the
 * terminal: pick a store, wipe it, generate, then print what the app would say
 * right now. That preview matters, because it is the demo's opening frame and
 * the only way to check the generated history actually produces good advice.
 */
async function main(): Promise<void> {
  loadEnvFile();

  const store = createStore();
  const described = describeStore(store);
  const service = createOfflineService(store, "seed");

  console.log(`Seeding ${described.adapter} store${described.file ? ` (${described.file})` : ""}`);
  await store.reset();

  const started = Date.now();
  const result = await generateDemoHistory({ service, userId: DEFAULT_USER_ID });
  const elapsed = Date.now() - started;

  const json = store as Partial<JsonStore>;
  if (typeof json.flush === "function") await json.flush();

  console.log(
    `\nLogged ${result.trips} trips with decisions, ${result.decisions} decisions, ` +
      `${result.contextGroups} contexts (${elapsed}ms).`,
  );

  const learning = await service.learning(DEFAULT_USER_ID);
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

  const renderView = (title: string, view: TripView) => {
    console.log(`\n${title}`);
    for (const item of view.items.slice(0, 6)) {
      const flag = item.alert ? "  <- would alert" : item.analogous ? "  (analogous)" : "";
      console.log(
        `   ${item.item.emoji} ${percent(item.probability).padStart(4)}  ${item.item.name}${flag}`,
      );
    }
    const alert = view.alerts[0];
    if (alert) console.log(`   why: ${alert.reason}`);
  };

  // What a returning user would find on opening the app.
  const ask = (rawInput: string, weather: typeof DEMO_CLEAR | null) =>
    service.startTrip({ userId: DEFAULT_USER_ID, rawInput, withWeather: false, weather });

  renderView('Today, clear — "college for a lab"', await ask("college for a lab", DEMO_CLEAR));
  renderView('Today, raining — "college for a lab"', await ask("college for a lab", DEMO_RAIN));
  renderView('Never logged before — "I\'m going to a hackathon"', await ask("I'm going to a hackathon", null));

  console.log(
    "\nOpen the app with `npm run dev`, then tell it \"I don't need my laptop today\" and " +
      "watch the laptop alert stand down.",
  );
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
