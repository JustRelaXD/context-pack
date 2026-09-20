import { useState } from "react";
import type { Item, ItemSuggestion, TripItemView, TripView, UserAction } from "@contextpack/shared";
import { contextChips, weatherLabel } from "../format";
import { AddItem } from "./AddItem";
import { ItemRow } from "./ItemRow";
import { NoticeBar, type Notice } from "./Notice";
import { Suggestions } from "./Suggestions";

interface TodayProps {
  trip: TripView | null;
  /** Recent trips, offered as one-tap starting points. */
  recentTrips: string[];
  starting: boolean;
  /** Item ids with a request in flight, so only that row locks. */
  pending: Record<string, boolean>;
  notice: Notice | null;
  onDismissNotice: () => void;
  onStart: (rawInput: string, withWeather: boolean) => void;
  onDecide: (itemId: string, action: UserAction) => void;
  onTell: (rawInput: string) => void;
  onAddItem: (name: string) => void;
  onClearTrip: () => void;
  /** Candidate items the agent proposed for this trip, fetched after it loads. */
  suggestions: ItemSuggestion[];
  suggestionsSource: "jev" | "groq" | "heuristic";
  suggestionsNote?: string;
  suggestedAdded: string[];
  /** The catalog plus the user's own items, for flagging an already-owned one. */
  allItems: Item[];
  /** Nothing has been logged yet at all — the point of the welcome card. */
  showWelcome: boolean;
  canLoadExample: boolean;
  onLoadExample: () => void;
  exampleBusy: boolean;
}

/**
 * The screen you actually open.
 *
 * It has two states and no ceremony between them: you either say where you're
 * going, or you are looking at the list and tapping what you have. Everything
 * that isn't one of those two things — adding an item, correcting a prediction,
 * the weather option — is one tap away rather than on screen competing for
 * attention.
 */
export function Today({
  trip,
  recentTrips,
  starting,
  pending,
  notice,
  onDismissNotice,
  onStart,
  onDecide,
  onTell,
  onAddItem,
  onClearTrip,
  suggestions,
  suggestionsSource,
  suggestionsNote,
  suggestedAdded,
  allItems,
  showWelcome,
  canLoadExample,
  onLoadExample,
  exampleBusy,
}: TodayProps) {
  const [input, setInput] = useState("");
  const [withWeather, setWithWeather] = useState(true);

  if (!trip) {
    const go = (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || starting) return;
      setInput("");
      onStart(trimmed, withWeather);
    };

    return (
      <section className="screen start">
        <h1 className="start-title">Where are you going?</h1>
        <p className="muted">
          Say it the way you'd say it out loud. I'll work out what you usually take — and what you
          usually forget.
        </p>

        <form
          className="ask"
          onSubmit={(event) => {
            event.preventDefault();
            go(input);
          }}
        >
          <input
            className="ask-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="college for a lab"
            aria-label="Where are you going?"
            autoComplete="off"
            autoFocus
            enterKeyHint="go"
          />
          <button
            className="ask-go"
            type="submit"
            disabled={starting || !input.trim()}
            aria-label="Work out what to take"
          >
            {starting ? "…" : "→"}
          </button>
        </form>

        {recentTrips.length > 0 ? (
          <div className="chips">
            {recentTrips.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="chip chip-action"
                disabled={starting}
                onClick={() => go(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        <label className="switch">
          <input
            type="checkbox"
            checked={withWeather}
            onChange={(event) => setWithWeather(event.target.checked)}
          />
          <span>Check the weather where I'm going</span>
        </label>

        {notice ? <NoticeBar notice={notice} onDismiss={onDismissNotice} /> : null}

        {showWelcome ? (
          <div className="welcome">
            <h2 className="welcome-title">Nothing to learn from yet</h2>
            <p>
              Confirm what you take on a few trips and this fills itself in. If you'd rather see the
              finished thing before putting in the effort, load six weeks of example trips.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={exampleBusy || !canLoadExample}
              onClick={onLoadExample}
            >
              {exampleBusy ? "Building the history…" : "Load example history"}
            </button>
            <p className="muted tiny">
              {canLoadExample
                ? "Example trips are generated locally and labelled as example data. Nothing is sent anywhere."
                : "Already unavailable — you have history of your own."}
            </p>
          </div>
        ) : null}
      </section>
    );
  }

  const { trip: record, items } = trip;
  const packed = items.filter((item) => item.userAction === "packed");
  const skipped = items.filter((item) => item.userAction === "not_needed");
  const answered = packed.length + skipped.length;
  const weather = weatherLabel(record.context);
  const chips = contextChips(record.context);
  // Counted from `items` rather than read off `trip.alerts` so it stays correct
  // while a tap is still in flight.
  const done = items.length > 0 && answered === items.length;

  return (
    <section className="screen">
      <header className="trip-head">
        <div className="trip-headline">
          <h1 className="trip-title">{recordTitle(chips)}</h1>
          <p className="trip-meta">
            {weather ? <span className="trip-weather">{weather}</span> : null}
            <span className="muted tiny">
              read by {trip.contextSource}
              {record.startedAt ? ` · ${timeOf(record.startedAt)}` : ""}
            </span>
          </p>
        </div>
        <button type="button" className="link" onClick={onClearTrip}>
          Change
        </button>
      </header>

      {notice ? <NoticeBar notice={notice} onDismiss={onDismissNotice} /> : null}

      {trip.coldStart ? (
        <div className="banner banner-info">
          <strong>This is a guess, not a memory.</strong>
          <p>I haven't seen a trip like this yet, so everything sits at 50/50 until you answer.</p>
        </div>
      ) : null}

      <div className="progress">
        <div className="progress-track" role="presentation">
          <span
            className="progress-fill"
            style={{ width: `${items.length === 0 ? 0 : (answered / items.length) * 100}%` }}
          />
        </div>
        <p className="progress-text">{progressText(answered, items.length)}</p>
      </div>

      <ul className="rows">
        {items.map((item: TripItemView) => (
          <ItemRow
            key={item.itemId}
            item={item}
            pending={Boolean(pending[item.itemId])}
            onDecide={onDecide}
          />
        ))}
      </ul>

      {items.length === 0 ? (
        <p className="muted small">
          Nothing worth predicting for this trip yet. Add what you're taking and I'll learn from it.
        </p>
      ) : null}

      <Suggestions
        suggestions={suggestions}
        source={suggestionsSource}
        {...(suggestionsNote ? { note: suggestionsNote } : {})}
        context={record.context}
        added={suggestedAdded}
        busy={Boolean(pending["__add__"])}
        onAdd={onAddItem}
        items={allItems}
      />

      <div className="row-tools">
        <AddItem onAdd={onAddItem} busy={Boolean(pending["__add__"])} />
      </div>

      <CorrectionForm onTell={onTell} busy={starting} />

      <p className="muted tiny center">
        {done
          ? "Every answer here is what tomorrow's predictions are built from."
          : "Rows you don't answer stay unknown — I only learn from what you confirm."}
      </p>
    </section>
  );
}

/**
 * The escape hatch for "that's not what I meant".
 *
 * Collapsed by default, because the common case is tapping rows — this is for the
 * times the list is wrong about the day rather than about an item, and it accepts
 * a sentence rather than making you find the right item first.
 */
function CorrectionForm({ onTell, busy }: { onTell: (rawInput: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  if (!open) {
    return (
      <button type="button" className="add-toggle" onClick={() => setOpen(true)}>
        Words are easier? Tell me what changed
      </button>
    );
  }

  return (
    <form
      className="add-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        onTell(trimmed);
        setText("");
        setOpen(false);
      }}
    >
      <input
        className="input"
        value={text}
        autoFocus
        autoComplete="off"
        placeholder="I don't need my laptop today"
        aria-label="Tell me what changed"
        onChange={(event) => setText(event.target.value)}
      />
      <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
        Record
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

function progressText(answered: number, total: number): string {
  if (total > 0 && answered === total) return "All checked. Have a good one.";
  if (answered === 0) return `${total} things I'd take — tap the ones you have`;
  return `${answered} of ${total} checked`;
}

/** "college · lab" — the destination carries the heading, the rest is context. */
function recordTitle(chips: string[]): string {
  return chips.length === 0 ? "Wherever you're off to" : chips.join(" · ");
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
