import type { Item } from "./types";

/**
 * The item catalog.
 *
 * Kept deliberately small and explicit: the agent may only ever choose from
 * this list, which is what stops it from inventing "lab equipment" that the
 * user then has to maintain.
 */
export const CATALOG: Item[] = [
  { id: "laptop", name: "Laptop", category: "tech", emoji: "💻" },
  { id: "charger", name: "Charger", category: "tech", emoji: "🔌" },
  { id: "headphones", name: "Headphones", category: "tech", emoji: "🎧" },
  { id: "power-bank", name: "Power bank", category: "tech", emoji: "🔋" },
  { id: "usb-drive", name: "USB drive", category: "tech", emoji: "💾" },
  { id: "extension-board", name: "Extension board", category: "tech", emoji: "🔌" },

  { id: "id-card", name: "ID card", category: "identity", emoji: "🪪" },
  { id: "wallet", name: "Wallet", category: "identity", emoji: "👛" },
  { id: "keys", name: "Keys", category: "identity", emoji: "🔑" },

  { id: "notebook", name: "Notebook", category: "stationery", emoji: "📓" },
  { id: "pen", name: "Pen", category: "stationery", emoji: "🖊️" },
  { id: "calculator", name: "Calculator", category: "stationery", emoji: "🧮" },
  { id: "textbook", name: "Textbook", category: "stationery", emoji: "📕" },

  { id: "lab-kit", name: "Lab kit", category: "misc", emoji: "🥽" },
  { id: "sports-kit", name: "Sports kit", category: "sports", emoji: "🏸" },
  { id: "gym-clothes", name: "Gym clothes", category: "clothing", emoji: "👕" },
  { id: "jacket", name: "Jacket", category: "clothing", emoji: "🧥" },

  { id: "water-bottle", name: "Water bottle", category: "food", emoji: "💧" },
  { id: "snack", name: "Snack", category: "food", emoji: "🍫" },

  { id: "umbrella", name: "Umbrella", category: "misc", emoji: "☔" },
];

export const CATALOG_BY_ID: ReadonlyMap<string, Item> = new Map(
  CATALOG.map((item) => [item.id, item] as const),
);

/**
 * Shown on a brand-new context, when we have nothing learned yet. These are
 * presented as a 50/50 starting guess, never as a recommendation.
 */
export const BOOTSTRAP_ITEM_IDS: readonly string[] = [
  "laptop",
  "charger",
  "id-card",
  "water-bottle",
];

/** Tags that, when present, make weather-based predictions meaningful. */
export const WEATHER_TAGS: readonly string[] = ["rain", "snow", "hot", "cold"];
