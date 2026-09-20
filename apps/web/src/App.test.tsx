import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  catalog,
  diagnostics,
  exception,
  itemView,
  learning,
  suggestion,
  tripSummary,
  tripView,
} from "./test/fixtures";
import { installMockFetch } from "./test/mock-fetch";

/**
 * These are wiring tests, not design tests: they prove the screens render real
 * server data, that a tap hits the right endpoint with the right body, and that
 * the trust rules survive into the markup (99% is never 100%, and a row the user
 * never answered never becomes evidence).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

let lastCalls: Array<{ method: string; url: string; body?: unknown }> = [];

function renderApp(options: Parameters<typeof installMockFetch>[0]) {
  const mock = installMockFetch(options);
  lastCalls = mock.calls;
  render(<App />);
  return mock;
}

/**
 * Wait until the trip screen has settled: mounted, and past the request it makes
 * on mount.
 *
 * This exists because of a real leak. Starting a trip mounts a screen that
 * immediately fetches its own suggestions, and a test that ends as soon as the
 * POST is recorded leaves that request scheduled past teardown — where it runs
 * with the mock already removed and reaches the network. Awaiting the request is
 * also what flushes React's pending effects, so this is the test saying the same
 * thing the app means by "the screen is ready".
 */
async function settleTrip() {
  await waitFor(() => {
    expect(lastCalls.some((call) => call.url.includes("/suggestions"))).toBe(true);
  });
}

/**
 * Start a trip by typing, the way a first-time user would.
 *
 * `settle: false` is for the one test that expects no trip screen at all,
 * because the server refused to start it.
 */
async function startTypedTrip(text = "college for a lab", options: { settle?: boolean } = {}) {
  const input = await screen.findByLabelText("Where are you going?");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Work out what to take" }));
  if (options.settle !== false) {
    await settleTrip();
  }
}

describe("start screen", () => {
  it("starts a trip with one tap on a suggestion from a past trip", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      startTrip: tripView(),
    });

    // A past trip is offered as a suggestion, replacing the canned examples.
    fireEvent.click(await screen.findByRole("button", { name: "college for a lab" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url === "/api/trips");
      expect(post?.body).toMatchObject({ rawInput: "college for a lab", withWeather: true });
    });

    // Wait for the trip *view*, not just the request — see `settleTrip`.
    await settleTrip();
  });

  it("falls back to example trips when there is no history to suggest", async () => {
    renderApp({ diagnostics: diagnostics(), trips: { trips: [] } });

    expect(await screen.findByRole("button", { name: "I'm going to a hackathon" })).toBeTruthy();
  });

  it("starts a trip with the typed text", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
    });

    await startTypedTrip("college for a lab");

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url === "/api/trips");
      expect(post?.body).toMatchObject({ rawInput: "college for a lab" });
    });
    await settleTrip();
  });

  it("shows the server's own error message rather than a generic failure", async () => {
    renderApp({ diagnostics: diagnostics(), trips: { trips: [] }, failWith: "I couldn't work out where that is." });

    // No trip screen here — the server refused to start one — so there is no
    // follow-up request to wait for.
    await startTypedTrip("college for a lab", { settle: false });

    expect(await screen.findByText("I couldn't work out where that is.")).toBeTruthy();
  });

  it("won't start a trip with only whitespace", async () => {
    renderApp({ diagnostics: diagnostics(), trips: { trips: [] } });

    const input = await screen.findByLabelText("Where are you going?");
    fireEvent.change(input, { target: { value: "   " } });
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "Work out what to take" });
    expect(submit.disabled).toBe(true);
  });

  it("offers to load example history when there is nothing to learn from", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics({ canLoadExample: true }),
      trips: { trips: [] },
      learning: { trips: 0, decided: 0, confirmed: 0, confirmRate: 0, groups: [], unknownItems: [] },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load example history" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url === "/api/demo")).toBe(true);
    });
  });
});

describe("trip view", () => {
  it("warns about the item you usually forget without printing 100%", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      startTrip: tripView(),
    });

    await startTypedTrip();

    // The alert is now a marked row rather than a duplicated second list.
    expect(await screen.findByText(/You usually take this/)).toBeTruthy();
    expect(screen.getAllByText("99%").length).toBeGreaterThan(0);
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByText("97%")).toBeTruthy();
    expect(screen.getByText("2 things I'd take — tap the ones you have")).toBeTruthy();
  });

  it("reveals the reason and its evidence behind the percentage", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
    });

    await startTypedTrip();
    fireEvent.click(await screen.findByRole("button", { name: "Why 97% likely?" }));

    expect(
      await screen.findByText("You confirmed your charger on 14 of your last 16 college lab trips."),
    ).toBeTruthy();
    expect(screen.getByText(/14 of 16 logged trips/)).toBeTruthy();
    expect(screen.getByText(/Usually alongside your laptop/)).toBeTruthy();
  });

  it("records a decision by calling feedback with the item and action", async () => {
    const packedView = tripView({
      items: [itemView({ userAction: "packed", confirmationSource: "confirmed" }), tripView().items[1]!],
    });
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      feedback: packedView,
    });

    await startTypedTrip();
    fireEvent.click(await screen.findByRole("button", { name: "Mark Charger as packed" }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("/feedback"));
      expect(call?.body).toMatchObject({ itemId: "charger", action: "packed" });
    });
    // The row reflects it, and the progress line counts it.
    expect((await screen.findByRole("button", { name: "Unpack Charger" })).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByText("1 of 2 checked")).toBeTruthy();
  });

  it("marks an item not needed without asking a follow-up question", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      feedback: tripView({ items: [itemView({ userAction: "not_needed" }), tripView().items[1]!] }),
    });

    await startTypedTrip();
    fireEvent.click(await screen.findByRole("button", { name: "I don't need my Charger today" }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("/feedback"));
      expect(call?.body).toMatchObject({ itemId: "charger", action: "not_needed" });
    });
  });

  it("adds a new item and marks it packed in the same gesture", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      createdItem: {
        item: { id: "retainer", name: "Retainer", category: "misc", emoji: "📦", custom: true },
        created: true,
      },
      feedback: tripView(),
    });

    await startTypedTrip();
    fireEvent.click(await screen.findByRole("button", { name: /Add something else/ }));
    fireEvent.change(await screen.findByLabelText("Name of the item you're taking"), {
      target: { value: "Retainer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === "POST" && call.url === "/api/items");
      expect(created?.body).toMatchObject({ name: "Retainer" });
      const packed = calls.find((entry) => entry.url.includes("/feedback"));
      expect(packed?.body).toMatchObject({ itemId: "retainer", action: "packed" });
    });
  });

  it("offers proposed items in words, with no percentage to mistake for a prediction", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      suggestions: { suggestions: [suggestion()], source: "groq" },
      createdItem: {
        item: { id: "lab-coat", name: "Lab coat", category: "clothing", emoji: "👕", custom: true },
        created: true,
      },
      feedback: tripView(),
    });

    await startTypedTrip();

    expect(await screen.findByText("Also worth considering")).toBeTruthy();
    expect(screen.getByText("proposed by AI")).toBeTruthy();
    // Jev's rubric as a word, never as a number that looks like a probability.
    expect(screen.getByText("usually taken")).toBeTruthy();
    expect(screen.queryByText("91%")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Lab coat and mark it packed" }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === "POST" && call.url === "/api/items");
      expect(created?.body).toMatchObject({ name: "Lab coat" });
      const packed = calls.find((entry) => entry.url.includes("/feedback"));
      expect(packed?.body).toMatchObject({ itemId: "lab-coat", action: "packed" });
    });
    // Once adopted it leaves the suggestion list rather than lingering as a duplicate.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add Lab coat and mark it packed" })).toBeNull();
    });
  });

  it("says where a rule-based list came from instead of claiming AI wrote it", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      suggestions: { suggestions: [suggestion({ source: "heuristic", plausibility: undefined })], source: "heuristic" },
    });

    await startTypedTrip();

    expect(await screen.findByText("common for this kind of trip")).toBeTruthy();
    expect(screen.getByText("suggested")).toBeTruthy();
  });

  it("explains when a correction could not be understood", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      interpret: { parsed: null, view: tripView() },
    });

    await startTypedTrip();
    fireEvent.click(await screen.findByRole("button", { name: /Words are easier/ }));
    fireEvent.change(await screen.findByLabelText("Tell me what changed"), {
      target: { value: "the weather looks nice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));

    expect(await screen.findByText(/couldn't tell which item/)).toBeTruthy();
  });
});

describe("learned tab", () => {
  it("shows the raw counts behind a pattern, not just a percentage", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      exceptions: { exceptions: [exception()] },
    });

    fireEvent.click(await screen.findByRole("button", { name: /Learned/ }));

    expect((await screen.findAllByText("college lab")).length).toBeGreaterThan(0);
    expect(screen.getByText("14 of 16")).toBeTruthy();
    // Items outside the closed catalog are disclosed rather than hidden.
    expect(screen.getByText(/projector-remote/)).toBeTruthy();
    // Exceptions are listed with their scope in plain words.
    expect(screen.getByText(/just that day/)).toBeTruthy();
    // ...and resolved through the full item list, not just the built-in catalog.
    expect(screen.getByText(/Laptop/)).toBeTruthy();
  });
});

describe("history tab", () => {
  it("reopens a past trip and shows what it predicted at the time", async () => {
    const mock = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      getTrip: tripView(),
    });

    fireEvent.click(await screen.findByRole("button", { name: /History/ }));
    fireEvent.click(await screen.findByRole("button", { name: /college for a lab/ }));

    await waitFor(() => {
      expect(mock.calls.some((call) => call.url === "/api/trips/trip-1")).toBe(true);
    });
    const detail = await screen.findByText(/Predicted at/);
    expect(within(detail.closest(".trip-detail") as HTMLElement).getByText("Charger")).toBeTruthy();
  });
});
