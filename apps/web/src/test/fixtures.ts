import type {
  ContextException,
  DiagnosticsResponse,
  LearningOverview,
  TripItemView,
  TripSummary,
  TripView,
} from "@contextpack/shared";

/** Fixtures for the UI tests. Deliberately awkward in one place each. */

export function itemView(overrides: Partial<TripItemView> = {}): TripItemView {
  return {
    itemId: "charger",
    item: { id: "charger", name: "Charger", category: "tech", emoji: "🔌" },
    probability: 0.97,
    predictedProbability: 0.97,
    userAction: "unanswered",
    confirmationSource: "inferred",
    alert: true,
    analogous: false,
    alertSuppressed: false,
    confidence: "high",
    reason: "You confirmed your charger on 14 of your last 16 college lab trips.",
    reasonSource: "engine",
    evidence: {
      itemId: "charger",
      primaryScope: "exact",
      probability: 0.97,
      observations: 16,
      confirmations: 14,
      evidenceMass: 16,
      exceptions: 0,
      weatherRelevant: false,
      coOccurrence: { itemId: "laptop", itemName: "Laptop", trips: 14 },
    },
    unpredicted: false,
    ...overrides,
  };
}

export function tripView(overrides: Partial<TripView> = {}): TripView {
  const items = overrides.items ?? [
    itemView(),
    itemView({
      itemId: "id-card",
      item: { id: "id-card", name: "ID card", category: "identity", emoji: "🪪" },
      // Deliberately not 1.0: the UI must still render 99%, never 100%.
      probability: 0.999,
      predictedProbability: 0.999,
      alert: false,
    }),
  ];
  return {
    trip: {
      id: "trip-1",
      userId: "local-user",
      rawInput: "college for a lab",
      context: { destination: "college", purpose: "lab", tags: ["academic", "lab"] },
      startedAt: "2026-09-19T07:40:00.000Z",
      contextSource: "jev",
    },
    items,
    alerts: items.filter((item) => item.alert && item.userAction === "unanswered"),
    contextSource: "jev",
    weather: null,
    coldStart: false,
    ...overrides,
  };
}

export function tripSummary(overrides: Partial<TripSummary> = {}): TripSummary {
  return {
    id: "trip-1",
    rawInput: "college for a lab",
    context: { destination: "college", purpose: "lab", tags: ["academic", "lab"] },
    startedAt: "2026-09-19T07:40:00.000Z",
    packed: 3,
    notNeeded: 1,
    unanswered: 0,
    highlights: [{ itemId: "charger", name: "Charger", emoji: "🔌", probability: 0.97 }],
    ...overrides,
  };
}

export function diagnostics(): DiagnosticsResponse {
  return {
    store: { adapter: "memory" },
    weather: "Open-Meteo",
    agent: [
      { component: "context", active: "jev", detail: "Jev" },
      { component: "exceptions", active: "jev", detail: "Jev" },
      { component: "reasoning", active: "groq", detail: "Groq" },
    ],
    keys: { TYPESAFE_API_KEY: true },
  };
}

export function learning(): LearningOverview {
  return {
    trips: 16,
    decided: 40,
    confirmed: 30,
    confirmRate: 0.75,
    groups: [
      {
        contextKey: "college::lab",
        label: "college lab",
        trips: 16,
        lastSeenAt: "2026-09-18T07:40:00.000Z",
        items: [
          {
            itemId: "charger",
            item: { id: "charger", name: "Charger", category: "tech", emoji: "🔌" },
            observations: 16,
            confirmations: 14,
            probability: 0.85,
          },
        ],
      },
    ],
    unknownItems: ["projector-remote"],
  };
}

export function exception(): ContextException {
  return {
    id: "ex-1",
    userId: "local-user",
    itemId: "laptop",
    contextKey: "college::lab",
    scope: "once",
    reason: "I don't need my laptop today",
    createdAt: "2026-09-19T07:45:00.000Z",
  };
}
