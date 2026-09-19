import { useEffect, useState } from "react";
import type { TripSummary, TripView, UserAction } from "@contextpack/shared";
import { api } from "../api";
import { contextChips, percent, relativeDay } from "../format";
import { ItemRow } from "./ItemRow";

interface HistoryProps {
  trips: TripSummary[];
  busy: boolean;
  /** Bumped by the parent after any mutation, so an open detail view reloads. */
  revision: number;
  onDecide: (itemId: string, action: UserAction, tripId: string) => void;
}

/**
 * Past trips.
 *
 * Reopening a trip shows the probabilities **as they were recorded that day**
 * (`predictedProbability`), together with what the engine would say now. Showing
 * only the current estimate would quietly rewrite history — and "the app told me
 * 40% and I ignored it" is a fact the user is entitled to.
 */
export function History({ trips, busy, revision, onDecide }: HistoryProps) {
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
      <section className="stack">
        <div className="card">
          <h2 className="section-title">No trips yet</h2>
          <p className="muted small">Log one on the Today tab and it will show up here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="stack">
      {trips.map((trip) => {
        const isOpen = expanded === trip.id;
        return (
          <div className="card" key={trip.id}>
            <button
              type="button"
              className="history-head"
              aria-expanded={isOpen}
              onClick={() => setExpanded(isOpen ? null : trip.id)}
            >
              <div className="stack-tight">
                <span className="history-title">{trip.rawInput}</span>
                <span className="muted small">
                  {relativeDay(trip.startedAt)} · {contextChips(trip.context).join(" · ")}
                </span>
                <span className="history-counts">
                  <span className="pill pill-packed">{trip.packed} packed</span>
                  {trip.notNeeded > 0 ? <span className="pill">{trip.notNeeded} skipped</span> : null}
                  {trip.unanswered > 0 ? <span className="pill">{trip.unanswered} open</span> : null}
                </span>
                {trip.highlights.length > 0 ? (
                  <span className="history-highlights">
                    {trip.highlights.map((highlight) => (
                      <span key={highlight.itemId} title={`${highlight.name} ${percent(highlight.probability)}`}>
                        {highlight.emoji}
                      </span>
                    ))}
                  </span>
                ) : null}
              </div>
              <span className="chevron" aria-hidden="true">
                {isOpen ? "▾" : "▸"}
              </span>
            </button>

            {isOpen ? (
              <div className="history-detail">
                {error ? <p className="muted small">{error}</p> : null}
                {!detail && !error ? <p className="muted small">Loading…</p> : null}
                {detail ? (
                  <>
                    <p className="muted tiny">
                      Predicted at {detail.trip.startedAt.slice(11, 16)} UTC · context read by {detail.contextSource}
                    </p>
                    <ul className="item-list">
                      {detail.items.map((item) => (
                        <ItemRow
                          key={item.itemId}
                          item={item}
                          busy={busy}
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
