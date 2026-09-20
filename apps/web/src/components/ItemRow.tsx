import { useState } from "react";
import type { TripItemView, UserAction } from "@contextpack/shared";
import { confidenceLabel, evidenceSummary, percent, ratio } from "../format";

interface ItemRowProps {
  item: TripItemView;
  /** True while this row's own request is in flight. */
  pending?: boolean;
  onDecide: (itemId: string, action: UserAction) => void;
  /** Read-only mode for reviewing a past trip. */
  readOnly?: boolean;
}

/**
 * One predicted item.
 *
 * The interaction is deliberately lopsided. Packing is what happens on almost
 * every row, and it happens while you are standing up with one hand free — so the
 * entire left of the row is one big tap target for it, rather than a "Packed"
 * button sharing space with two others. "Not needed" is a smaller, quieter
 * control because it is the rarer answer, and "Why?" moved onto the number, which
 * is the thing you were already looking at when you started doubting it.
 *
 * That also explains why there is no checkbox to find: the row itself is the
 * checkbox, and the tick appears where your thumb already is.
 */
export function ItemRow({ item, pending = false, onDecide, readOnly = false }: ItemRowProps) {
  const [open, setOpen] = useState(false);

  const packed = item.userAction === "packed";
  const skipped = item.userAction === "not_needed";
  const decided = packed || skipped;
  const tone =
    item.confidence === "high"
      ? "tone-high"
      : item.confidence === "medium"
        ? "tone-medium"
        : "tone-low";

  // Tapping an answered row undoes it; tapping a skipped row means "actually,
  // I do have it". Both are the same gesture, so neither needs explaining.
  const nextAction: UserAction = packed ? "unanswered" : "packed";

  const className = [
    "row",
    packed ? "row-packed" : "",
    skipped ? "row-skipped" : "",
    item.alert && !decided ? "row-alert" : "",
    pending ? "row-pending" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className}>
      <div className="row-top">
        <button
          type="button"
          className="row-main"
          disabled={pending || readOnly}
          aria-pressed={packed}
          aria-label={
            packed ? `Unpack ${item.item.name}` : `Mark ${item.item.name} as packed`
          }
          onClick={() => onDecide(item.itemId, nextAction)}
        >
          <span className="row-check" aria-hidden="true">
            {packed ? "✓" : skipped ? "–" : ""}
          </span>
          <span className="row-emoji" aria-hidden="true">
            {item.item.emoji}
          </span>
          <span className="row-text">
            <span className="row-name">{item.item.name}</span>
            <span className="row-sub">
              {skipped ? "Not needed today" : evidenceSummary(item)}
              {item.analogous && !skipped ? " · similar trip" : ""}
            </span>
          </span>
        </button>

        <button
          type="button"
          className={`row-pct ${tone}`}
          aria-expanded={open}
          aria-label={`Why ${percent(item.probability)} likely?`}
          onClick={() => setOpen((value) => !value)}
        >
          {percent(item.probability)}
        </button>

        {skipped || readOnly ? null : (
          <button
            type="button"
            className="row-skip"
            disabled={pending}
            aria-label={`I don't need my ${item.item.name} today`}
            onClick={() => onDecide(item.itemId, "not_needed")}
          >
            ✕
          </button>
        )}
      </div>

      {item.alert && !decided ? (
        <p className="row-alert-note">⚠️ You usually take this. Tap to confirm it's in your bag.</p>
      ) : null}

      {open ? (
        <div className="why">
          <p className="why-reason">{item.reason}</p>
          <ul className="why-evidence">
            <li>
              {ratio(item.evidence.confirmations, item.evidence.observations)} logged trips
              {item.evidence.weatherRelevant ? " in this weather" : ""}
            </li>
            <li>
              Matched on{" "}
              {item.evidence.primaryScope === "global"
                ? "your trips generally"
                : item.evidence.primaryScope === "sibling"
                  ? "similar trips to this one"
                  : item.evidence.primaryScope === "destination"
                    ? "trips to this place"
                    : "this exact kind of trip"}
            </li>
            {item.evidence.coOccurrence ? (
              <li>
                Usually alongside your {item.evidence.coOccurrence.itemName.toLowerCase()} (
                {item.evidence.coOccurrence.trips} trips)
              </li>
            ) : null}
            {item.evidence.exceptions > 0 ? (
              <li>You've said no to this on {item.evidence.exceptions} similar trip(s)</li>
            ) : null}
            {item.predictedProbability !== item.probability ? (
              <li>We said {percent(item.predictedProbability)} when this trip started</li>
            ) : null}
            {item.reasonSource === "rewritten" ? (
              <li>Wording rewritten by Groq — the numbers come from your history</li>
            ) : null}
            <li>{confidenceLabel(item.confidence)}</li>
          </ul>
        </div>
      ) : null}
    </li>
  );
}
