import { useState } from "react";
import type { TripItemView, UserAction } from "@contextpack/shared";
import { confidenceLabel, percent, ratio } from "../format";

interface ItemRowProps {
  item: TripItemView;
  busy: boolean;
  onDecide: (itemId: string, action: UserAction) => void;
  /** Read-only mode for reviewing a past trip. */
  readOnly?: boolean;
}

/**
 * One predicted item.
 *
 * The "Why?" panel is not decoration — it is the product. The numbers in it come
 * straight from `evidence`, which the server filled from the database, so the
 * reasons are checkable rather than plausible-sounding.
 */
export function ItemRow({ item, busy, onDecide, readOnly = false }: ItemRowProps) {
  const [open, setOpen] = useState(false);
  const decided = item.userAction === "packed" || item.userAction === "not_needed";

  const tone =
    item.confidence === "high" ? "tone-high" : item.confidence === "medium" ? "tone-medium" : "tone-low";

  return (
    <li className={`item ${decided ? "item-decided" : ""} ${item.alert ? "item-alert" : ""}`}>
      <div className="item-head">
        <span className="item-emoji" aria-hidden="true">
          {item.item.emoji}
        </span>
        <div className="item-title">
          <span className="item-name">{item.item.name}</span>
          <span className={`item-confidence ${tone}`}>
            {item.analogous ? "similar trip" : confidenceLabel(item.confidence)}
          </span>
        </div>
        <span className="item-percent">{percent(item.probability)}</span>
      </div>

      <div className="bar" role="img" aria-label={`${percent(item.probability)} likely needed`}>
        <span className={`bar-fill ${tone}`} style={{ width: `${Math.min(99, item.probability * 100)}%` }} />
      </div>

      <div className="item-actions">
        {item.userAction === "packed" ? (
          <span className="pill pill-packed">✓ Packed</span>
        ) : item.userAction === "not_needed" ? (
          <span className="pill pill-skipped">Not needed</span>
        ) : null}

        {readOnly ? (
          <button type="button" className="btn btn-ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide why" : "Why?"}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`btn ${item.userAction === "packed" ? "btn-on" : ""}`}
              disabled={busy}
              onClick={() => onDecide(item.itemId, "packed")}
            >
              Packed
            </button>
            <button
              type="button"
              className={`btn ${item.userAction === "not_needed" ? "btn-on" : ""}`}
              disabled={busy}
              onClick={() => onDecide(item.itemId, "not_needed")}
            >
              Not needed
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen((value) => !value)}>
              {open ? "Hide" : "Why?"}
            </button>
          </>
        )}
      </div>

      {open ? (
        <div className="why">
          <p className="why-reason">{item.reason}</p>
          <ul className="why-evidence">
            <li>
              Evidence: {ratio(item.evidence.confirmations, item.evidence.observations)} logged trips
              {item.evidence.weatherRelevant ? " in this weather" : ""}
            </li>
            <li>Match: {item.evidence.primaryScope === "global" ? "across your trips generally" : item.evidence.primaryScope}</li>
            {item.evidence.coOccurrence ? (
              <li>
                Usually alongside your {item.evidence.coOccurrence.itemName.toLowerCase()} (
                {item.evidence.coOccurrence.trips} trips)
              </li>
            ) : null}
            {item.evidence.exceptions > 0 ? (
              <li>You have said no to this on {item.evidence.exceptions} similar trip(s)</li>
            ) : null}
            {item.predictedProbability !== item.probability ? (
              <li>
                We said {percent(item.predictedProbability)} when this trip started
                {item.reasonSource === "rewritten" ? " (wording by Groq)" : ""}
              </li>
            ) : item.reasonSource === "rewritten" ? (
              <li>Wording rewritten by Groq; the numbers are from your history</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </li>
  );
}
