import { useEffect, useState } from "react";
import type { TripSummary, TripView, UserAction } from "@contextpack/shared";
import { api } from "../api";
import { contextChips, relativeDay } from "../format";
import { ItemRow } from "./ItemRow";

interface HistoryProps {
  trips: TripSummary[];
  /** Item ids with a request in flight, so a row locks only while it is saving. */
  pending: Record<string, boolean>;
  /** Bumped by the parent after any mutation, so an open detail view reloads. */
  revision: number;
  onDecide: (itemId: string, action: UserAction, tripId: string) => void;
}

/**
 * Past trips.
 *
 * Reopening a trip shows the probabilities **as they were recorded that day**
 * (`predictedProbability`), which the "Why?" panel reports. Showing only the
 * current estimate would quietly rewrite history — and "the app said 40% and I
 * ignored it" is a fact the user is entitled to.
 */
export function History({ trips, pending, revision, onDecide }: HistoryProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<TripView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getTrip(expanded)
      .then((view) => {
        if (!cancelled) setDetail(view);
      })
      .catch((caught: Error) => {
        if (!cancelled) setError(caught.message);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, revision]);

  if (trips.length === 0) {
    return (
      <section className="screen">
        <div className="card">
          <h2 className="card-title">No trips yet</h2>
          <p className="muted small">Log one on the Today tab and it shows up here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen">
      {trips.map((trip) => {
        const isOpen = expanded === trip.id;
        return (
          <div className={`card card-trip ${isOpen ? "card-open" : ""}`} key={trip.id}>
            <button
              type="button"
              className="trip-row"
              aria-expanded={isOpen}
              onClick={() => setExpanded(isOpen ? null : trip.id)}
            >
              <span className="trip-row-text">
                <span className="trip-row-title">{trip.rawInput}</span>
                <span className="muted tiny">
                  {relativeDay(trip.startedAt)} · {contextChips(trip.context).join(" · ")}
                </span>
              </span>
              <span className="trip-row-counts">
                <span className="count count-packed">✓ {trip.packed}</span>
                {trip.notNeeded > 0 ? <span className="count">✕ {trip.notNeeded}</span> : null}
                {trip.unanswered > 0 ? <span className="count">{trip.unanswered} open</span> : null}
              </span>
              <span className="chev" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>

            {isOpen ? (
              <div className="trip-detail">
                {error ? <p className="muted small">{error}</p> : null}
                {!detail && !error ? <p className="muted small">Loading…</p> : null}
                {detail ? (
                  <>
                    <p className="muted tiny">
                      Predicted at {detail.trip.startedAt.slice(11, 16)} UTC · read by{" "}
                      {detail.contextSource}
                    </p>
                    <ul className="rows rows-compact">
                      {detail.items.map((item) => (
                        <ItemRow
                          key={item.itemId}
                          item={item}
                          pending={Boolean(pending[item.itemId])}
                          onDecide={(itemId, action) => onDecide(itemId, action, detail.trip.id)}
                        />
                      ))}
                    </ul>
                    {detail.items.length === 0 ? (
                      <p className="muted small">Nothing was predicted for this trip.</p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
