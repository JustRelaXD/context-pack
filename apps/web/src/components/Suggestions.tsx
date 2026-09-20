import type { ItemSuggestion, Item } from "@contextpack/shared";
import { contextChips } from "../format";

interface SuggestionsProps {
  suggestions: ItemSuggestion[];
  source: "jev" | "groq" | "heuristic";
  note?: string;
  context: { destination: string; purpose?: string; tags: string[] };
  /** Names already added from this list, so they disappear on tap. */
  added: string[];
  busy: boolean;
  onAdd: (name: string) => void;
  /** The full item list, so a proposed item that already exists can be flagged. */
  items: Item[];
}

/**
 * Items the agent proposes for this trip.
 *
 * This is the part that means nobody has to type a checklist. It is also the one
 * place a model writes something the user reads, so the honesty rules are visible
 * rather than buried:
 *
 *  - no percentages here, ever. These items have no observations behind them, so
 *    a probability would be indistinguishable from a real prediction on the same
 *    screen. Jev's plausibility is a different claim and gets different words.
 *  - the source is on screen: "proposed by AI" when a model wrote the list, and
 *    "common for this trip" when the rule-based table did.
 *  - nothing is saved until it is tapped. A suggestion is not evidence and does
 *    not touch the learning until the user adopts it.
 */
export function Suggestions({
  suggestions,
  source,
  note,
  context,
  added,
  busy,
  onAdd,
  items,
}: SuggestionsProps) {
  const remaining = suggestions.filter((suggestion) => !added.includes(suggestion.id));
  if (remaining.length === 0 && !note) return null;

  const known = new Set(items.map((item) => item.id));
  const where = contextChips(context).slice(0, 2).join(" ") || context.destination;

  return (
    <div className="card suggest">
      <div className="card-head">
        <h2 className="card-title">Also worth considering</h2>
        <span className="muted tiny">
          {source === "groq" ? "proposed by AI" : "common for this kind of trip"}
        </span>
      </div>
      <p className="muted tiny">
        {remaining.length > 0
          ? `Guesses for a ${where}, not from your history. Tap one to add it and tick it off.`
          : (note ?? "")}
      </p>
      {remaining.length > 0 ? (
        <ul className="suggest-list">
          {remaining.map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                className="suggest-row"
                disabled={busy}
                aria-label={`Add ${suggestion.name} and mark it packed`}
                onClick={() => onAdd(suggestion.name)}
              >
                <span className="suggest-emoji" aria-hidden="true">
                  {suggestion.emoji}
                </span>
                <span className="suggest-name">
                  {suggestion.name}
                  {known.has(suggestion.id) ? <span className="suggest-known">on your list</span> : null}
                </span>
                <span className="muted tiny">{plausibilityWord(suggestion.plausibility)}</span>
                <span className="suggest-plus" aria-hidden="true">
                  ＋
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Jev's rubric in words.
 *
 * Deliberately not a number and deliberately not the word "likely" on its own:
 * these are the model's opinion about the outing, and saying so is what keeps them
 * distinguishable from "you took this 14 of 16 times".
 */
function plausibilityWord(plausibility: number | undefined): string {
  if (plausibility === undefined) return "suggested";
  if (plausibility >= 0.9) return "usually taken";
  if (plausibility >= 0.75) return "often taken";
  return "sometimes taken";
}
