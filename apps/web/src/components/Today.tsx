import { useState } from "react";
import type { TripItemView, TripView, UserAction } from "@contextpack/shared";
import { contextChips, percent, weatherLabel } from "../format";
import { ItemRow } from "./ItemRow";

interface TodayProps {
  trip: TripView | null;
  suggestions: string[];
  busy: boolean;
  notice: { kind: "info" | "error"; text: string } | null;
  onDismissNotice: () => void;
  onStart: (rawInput: string, withWeather: boolean) => void;
  onDecide: (itemId: string, action: UserAction) => void;
  onTell: (rawInput: string) => void;
  onClearTrip: () => void;
}

export function Today({
  trip,
  suggestions,
  busy,
  notice,
  onDismissNotice,
  onStart,
  onDecide,
  onTell,
  onClearTrip,
}: TodayProps) {
  const [input, setInput] = useState("");
  const [withWeather, setWithWeather] = useState(true);
  const [correction, setCorrection] = useState("");

  if (!trip) {
    return (
      <section className="stack">
        <div className="card hero">
          <h1 className="hero-title">Where are you going?</h1>
          <p className="muted">
            Say it however you'd say it out loud. I'll work out what you usually take and what you
            might forget.
          </p>
          <form
            className="stack-tight"
            onSubmit={(event) => {
              event.preventDefault();
              if (!input.trim() || busy) return;
              onStart(input.trim(), withWeather);
            }}
          >
            <input
              className="input input-lg"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="college for a lab"
              aria-label="Where are you going?"
              autoComplete="off"
              enterKeyHint="go"
            />
            <div className="chips">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip chip-action"
                  onClick={() => setInput(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={withWeather}
                onChange={(event) => setWithWeather(event.target.checked)}
              />
              <span>Check the weather</span>
            </label>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy || !input.trim()}>
              {busy ? "Working it out…" : "What should I take?"}
            </button>
          </form>
        </div>
        {notice ? <Notice notice={notice} onDismiss={onDismissNotice} /> : null}
      </section>
    );
  }

  const { trip: record, items, alerts } = trip;
  const packed = items.filter((item) => item.userAction === "packed");
  const skipped = items.filter((item) => item.userAction === "not_needed");
  const open = items.filter((item) => item.userAction === "unanswered");
  const weather = weatherLabel(record.context);

  return (
    <section className="stack">
      <div className="card trip-head">
        <div className="chips">
          {contextChips(record.context).map((chip) => (
            <span key={chip} className="chip">
              {chip}
            </span>
          ))}
          {weather ? <span className="chip chip-weather">{weather}</span> : null}
        </div>
        <p className="muted small">
          “{record.rawInput}” · understood by {trip.contextSource} ·{' '}
          {record.startedAt ? new Date(record.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : ""}
        </p>
        <button type="button" className="btn btn-ghost" onClick={onClearTrip}>
          Start a different trip
        </button>
      </div>

      {notice ? <Notice notice={notice} onDismiss={onDismissNotice} /> : null}

      {trip.coldStart ? (
        <div className="card note">
          <strong>This is a guess, not a memory.</strong>
          <p className="muted small">
            I haven't logged a trip like this yet, so everything below is a coin flip. Confirm what
            you packed and I'll start noticing patterns.
          </p>
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <div className="card card-alert">
          <h2 className="section-title">⚠️ Before you leave</h2>
          <ul className="item-list">
            {alerts.map((item) => (
              <ItemRow key={item.itemId} item={item} busy={busy} onDecide={onDecide} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <h2 className="section-title">
          {open.length > 0 ? "Everything I think you'll need" : "All decided"}
        </h2>
        <ul className="item-list">
          {items.map((item: TripItemView) => (
            <ItemRow key={item.itemId} item={item} busy={busy} onDecide={onDecide} />
          ))}
        </ul>
        {items.length === 0 ? (
          <p className="muted small">
            Nothing predicted above the noise floor for this trip. Add what you're taking below and
            I'll learn from it.
          </p>
        ) : null}
      </div>

      {packed.length + skipped.length > 0 ? (
        <div className="card summary">
          <span className="pill pill-packed">✓ {packed.length} packed</span>
          <span className="pill pill-skipped">{skipped.length} not needed</span>
          <span className="pill">{open.length} open</span>
        </div>
      ) : null}

      <div className="card">
        <h2 className="section-title">Changed your mind?</h2>
        <p className="muted small">
          Tell me in your own words. I'll record it as an exception for this trip rather than
          assuming you meant forever.
        </p>
        <form
          className="stack-tight"
          onSubmit={(event) => {
            event.preventDefault();
            if (!correction.trim() || busy) return;
            onTell(correction.trim());
            setCorrection("");
          }}
        >
          <input
            className="input"
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="I don't need my laptop today"
            aria-label="Tell me what changed"
            autoComplete="off"
          />
          <button className="btn btn-block" type="submit" disabled={busy || !correction.trim()}>
            Record it
          </button>
        </form>
      </div>

      <p className="muted tiny center">
        {packed.length > 0
          ? `You've confirmed ${packed.length} item(s) — that's what tomorrow's predictions learn from.`
          : "Nothing confirmed yet on this trip. Decisions are what the learning runs on."}
      </p>
    </section>
  );
}

function Notice({
  notice,
  onDismiss,
}: {
  notice: { kind: "info" | "error"; text: string };
  onDismiss: () => void;
}) {
  return (
    <div className={`card notice notice-${notice.kind}`}>
      <p>{notice.text}</p>
      <button type="button" className="btn btn-ghost" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
