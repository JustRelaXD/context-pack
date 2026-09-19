import { loadEnvFile } from "./env";
import { createAgentLayer } from "./ai";
import { createApp } from "./app";
import { createService } from "./service";
import { createStore, describeStore } from "./store";
import type { JsonStore } from "./store";
import { createWeatherProviderFromEnv } from "./weather";

/**
 * Server entry point.
 *
 * `.env` is loaded before anything reads `process.env`, so `npm run dev` works
 * on a fresh clone with no shell setup. Everything below degrades instead of
 * failing: no keys means the rule-based agent, no network means no weather.
 */

const envReport = loadEnvFile();
const store = createStore();
const agent = createAgentLayer();
const weather = createWeatherProviderFromEnv();

const service = createService({ store, agent, weather });
const app = createApp({ service, store, serveWeb: true });

const port = Number(process.env.PORT ?? 4000);

const server = app.listen(port, () => {
  const described = describeStore(store);
  console.log(`ContextPack API listening on http://localhost:${port}`);
  console.log(`  store    ${described.adapter}${described.file ? ` (${described.file})` : ""}`);
  console.log(`  weather  ${weather.describe()}`);
  for (const diagnostic of agent.diagnostics()) {
    console.log(`  ${diagnostic.component.padEnd(8)} ${diagnostic.active} — ${diagnostic.detail}`);
  }
  if (envReport.files.length) {
    console.log(
      `  env      loaded ${envReport.appliedKeys.length} key(s) from ${envReport.files.join(", ")}` +
        (envReport.shadowedKeys.length
          ? ` (${envReport.shadowedKeys.length} already set in the shell)`
          : ""),
    );
  } else {
    console.log("  env      no .env file found; relying on the shell environment");
  }
});

/**
 * Make sure the last write reaches disk before we exit. Without this, `Ctrl+C`
 * right after confirming an item could drop the trip you just logged.
 */
async function shutdown(signal: string) {
  console.log(`\n${signal} received — flushing store and exiting.`);
  server.close();
  const json = store as Partial<JsonStore>;
  if (typeof json.flush === "function") {
    try {
      await json.flush();
    } catch (error) {
      console.error("Failed to flush store:", (error as Error).message);
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
