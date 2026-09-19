import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { diagnostics, exception, itemView, learning, tripSummary, tripView } from "./test/fixtures";
import { installMockFetch } from "./test/mock-fetch";

/**
 * These are wiring tests, not design tests: they prove the screens render real
 * server data, that actions hit the right endpoint, and that the trust rules
 * survive into the markup (99% is never 100%).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderApp(options: Parameters<typeof installMockFetch>[0]) {
  const mock = installMockFetch(options);
  render(<App />);
  return mock;
}

describe("quick log", () => {
  it("offers suggestions from past trips and starts a trip with the typed text", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      startTrip: tripView(),
    });

    const input = await screen.findByLabelText("Where are you going?");
    // The most recent trip becomes a one-tap suggestion.
    expect(await screen.findByRole("button", { name: "college for a lab" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "college for a lab" } });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url === "/api/trips");
      expect(post).toBeTruthy();
      expect(post?.body).toMatchObject({ rawInput: "college for a lab", withWeather: true });
    });
  });

  it("shows the server's own error message rather than a generic failure", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      failWith: "I couldn't work out where that is.",
    });

    const input = await screen.findByLabelText("Where are you going?");
    fireEvent.change(input, { target: { value: "college for a lab" } });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));

    // The server writes its errors for humans; the UI passes them through.
    expect(await screen.findByText("I couldn't work out where that is.")).toBeTruthy();
  });

  it("won't start a trip with only whitespace", async () => {
    renderApp({ diagnostics: diagnostics(), trips: { trips: [] } });

    const input = await screen.findByLabelText("Where are you going?");
    fireEvent.change(input, { target: { value: "   " } });
    const submit = screen.getByRole<HTMLButtonElement>("button", { name: "What should I take?" });
    expect(submit.disabled).toBe(true);
  });
});

describe("trip view", () => {
  it("separates the alert worth interrupting for, and never prints 100%", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [tripSummary()] },
      learning: learning(),
      startTrip: tripView(),
    });

    const input = await screen.findByLabelText("Where are you going?");
    fireEvent.change(input, { target: { value: "college for a lab" } });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));

    expect(await screen.findByText("⚠️ Before you leave")).toBeTruthy();
    // 0.999 arriving from the server must render as 99%. The alerted item shows
    // twice (its own card and the full list), hence the *AllBy* queries.
    expect((await screen.findAllByText("99%")).length).toBeGreaterThan(0);
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getAllByText("97%").length).toBeGreaterThan(0);
  });

  it("reveals the reason and its evidence when asked why", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView({ items: [itemView()], alerts: [itemView()] }),
    });

    fireEvent.change(await screen.findByLabelText("Where are you going?"), {
      target: { value: "college for a lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));

    fireEvent.click((await screen.findAllByRole("button", { name: "Why?" }))[0] as HTMLElement);

    expect(
      await screen.findByText("You confirmed your charger on 14 of your last 16 college lab trips."),
    ).toBeTruthy();
    expect(screen.getByText(/Evidence: 14 of 16 logged trips/)).toBeTruthy();
    expect(screen.getByText(/Usually alongside your laptop/)).toBeTruthy();
  });

  it("records a decision by calling feedback with the item and action", async () => {
    const { calls } = renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      feedback: tripView({
        items: [itemView({ userAction: "packed", confirmationSource: "confirmed" })],
        alerts: [],
      }),
    });

    fireEvent.change(await screen.findByLabelText("Where are you going?"), {
      target: { value: "college for a lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Packed" }))[0] as HTMLElement);

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("/feedback"));
      expect(call?.body).toMatchObject({ itemId: "charger", action: "packed" });
    });
    expect(await screen.findByText("✓ Packed")).toBeTruthy();
  });

  it("explains when a correction could not be understood", async () => {
    renderApp({
      diagnostics: diagnostics(),
      trips: { trips: [] },
      learning: learning(),
      startTrip: tripView(),
      interpret: { parsed: null, view: tripView() },
    });

    fireEvent.change(await screen.findByLabelText("Where are you going?"), {
      target: { value: "college for a lab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "What should I take?" }));

    fireEvent.change(await screen.findByLabelText("Tell me what changed"), {
      target: { value: "the weather looks nice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record it" }));

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

    // "college lab" is both the group heading and the exception's context label.
    expect((await screen.findAllByText("college lab")).length).toBeGreaterThan(0);
    expect(screen.getByText("14 of 16 trips")).toBeTruthy();
    // Items outside the closed catalog are disclosed rather than hidden.
    expect(screen.getByText(/projector-remote/)).toBeTruthy();
    // Exceptions are listed with their scope in plain words.
    expect(screen.getByText("just that day")).toBeTruthy();
  });
});
