import type { WeatherCondition, WeatherSnapshot } from "@contextpack/shared";

/**
 * Weather via Open-Meteo.
 *
 * Chosen because it needs no API key and no account, which means the demo works
 * on a fresh machine and there is no credential to leak in a screen recording.
 *
 * Two rules shape this module:
 *  1. Weather is a *modifier*, never a prerequisite. Every failure path returns
 *     `null` and the trip proceeds exactly as it would have.
 *  2. We cache per destination, because the user logging three trips in a row
 *     should not mean three geocoding round-trips (and Open-Meteo is a free
 *     service we have no business hammering).
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 4000;

export interface WeatherOptions {
  /** Fixed coordinates, skipping geocoding entirely. */
  latitude?: number;
  longitude?: number;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}

interface CacheEntry {
  value: WeatherSnapshot | null;
  expiresAt: number;
}

/** WMO weather interpretation codes -> our four-ish conditions. */
export function conditionFromCode(code: number | undefined): WeatherCondition {
  if (code === undefined) return "clear";
  if (code >= 71 && code <= 77) return "snow";
  if (code === 85 || code === 86) return "snow";
  if (code >= 51 && code <= 67) return "rain";
  if (code >= 80 && code <= 82) return "rain";
  if (code >= 95) return "rain";
  return "clear";
}

/** Rain and snow outrank temperature: "cold" cannot explain an umbrella. */
export function applyTemperature(condition: WeatherCondition, tempC: number | undefined): WeatherCondition {
  if (condition !== "clear" || tempC === undefined) return condition;
  if (tempC >= 32) return "hot";
  if (tempC <= 5) return "cold";
  return condition;
}

/**
 * Only notable conditions become tags.
 *
 * "Clear" is deliberately dropped: every clear trip already matches every other
 * clear trip by destination and purpose, so the tag would add noise to the UI
 * without changing a single prediction.
 */
export function weatherTagsFor(snapshot: WeatherSnapshot | undefined): string[] {
  if (!snapshot || snapshot.source === "none" || snapshot.condition === "clear") return [];
  return [snapshot.condition];
}

export interface WeatherProvider {
  /** Returns null whenever weather is unavailable. Never throws. */
  lookup(destination: string): Promise<WeatherSnapshot | null>;
  describe(): string;
}

export function createWeatherProvider(options: WeatherOptions = {}): WeatherProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  async function getJson(url: string): Promise<unknown | null> {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      // Timeout, DNS failure, sandbox with no network: all equally fine here.
      return null;
    }
  }

  async function coordinates(
    destination: string,
  ): Promise<{ latitude: number; longitude: number } | null> {
    if (options.latitude !== undefined && options.longitude !== undefined) {
      return { latitude: options.latitude, longitude: options.longitude };
    }
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`;
    const body = await getJson(url);
    const first = (body as { results?: Array<{ latitude?: number; longitude?: number }> } | null)
      ?.results?.[0];
    if (!first || typeof first.latitude !== "number" || typeof first.longitude !== "number") {
      return null;
    }
    return { latitude: first.latitude, longitude: first.longitude };
  }

  return {
    async lookup(destination: string): Promise<WeatherSnapshot | null> {
      const key = destination.trim().toLowerCase();
      if (!key) return null;

      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;

      const point = await coordinates(key);
      let value: WeatherSnapshot | null = null;

      if (point) {
        const url =
          `${FORECAST_URL}?latitude=${point.latitude}&longitude=${point.longitude}` +
          `&current=temperature_2m,weather_code&timezone=auto`;
        const body = await getJson(url);
        const current = (
          body as { current?: { temperature_2m?: number; weather_code?: number } } | null
        )?.current;
        if (current) {
          const tempC = typeof current.temperature_2m === "number" ? current.temperature_2m : undefined;
          const condition = applyTemperature(conditionFromCode(current.weather_code), tempC);
          value = {
            condition,
            ...(tempC !== undefined ? { tempC } : {}),
            source: "api",
          };
        }
      }

      // Cache failures briefly too, so an unreachable network does not make
      // every trip wait on a doomed request.
      cache.set(key, {
        value,
        expiresAt: Date.now() + (value ? ttlMs : Math.min(ttlMs, 60_000)),
      });
      return value;
    },

    describe() {
      if (options.latitude !== undefined && options.longitude !== undefined) {
        return `Open-Meteo at fixed coordinates ${options.latitude},${options.longitude}`;
      }
      return "Open-Meteo (geocode destination, then current conditions)";
    },
  };
}

/** Disabled provider, used when CONTEXTPACK_WEATHER=off or in tests. */
export const nullWeatherProvider: WeatherProvider = {
  async lookup() {
    return null;
  },
  describe() {
    return "Disabled (CONTEXTPACK_WEATHER=off)";
  },
};

export function createWeatherProviderFromEnv(env: NodeJS.ProcessEnv = process.env): WeatherProvider {
  const flag = (env.CONTEXTPACK_WEATHER ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return nullWeatherProvider;

  const latitude = Number(env.CONTEXTPACK_LAT);
  const longitude = Number(env.CONTEXTPACK_LON);
  const useFixed = Number.isFinite(latitude) && Number.isFinite(longitude);
  return createWeatherProvider(useFixed ? { latitude, longitude } : {});
}
