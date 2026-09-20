import type { ContextException, Item, LearningOverview } from "@contextpack/shared";
import { percent, ratio, relativeDay } from "../format";

interface LearnedProps {
  learning: LearningOverview | null;
  exceptions: ContextException[];
  /** The catalog plus the user's own items, so custom items resolve too. */
  items: Item[];
  busy: boolean;
  onForget: (exceptionId: string) => void;
}

/**
 * "What I've learned".
 *
 * Every count here is raw: no smoothing, no weighting, nothing rounded into
 * flattering shape. This screen exists so the user can audit us — `14 of 16` has
 * to mean fourteen actual confirmed trips, or the trust argument is marketing.
 */
export function Learned({ learning, exceptions, items, busy, onForget }: LearnedProps) {
  const byId = new Map(items.map((item) => [item.id, item] as const));

  if (!learning) {
    return (
      <section className="screen">
        <div className="card">
          <p className="muted">Loading…</p>
        </div>
      </section>
    );
  }

  if (learning.trips === 0) {
    return (
      <section className="screen">
        <div className="card">
          <h2 className="card-title">Nothing learned yet</h2>
          <p className="muted small">
            Confirm what you packed on a trip or two and this fills in — including the counts behind
            every prediction.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="screen">
      <div className="stats">
        <Stat value={String(learning.trips)} label="trips" />
        <Stat value={String(learning.decided)} label="answers" />
        <Stat value={percent(learning.confirmRate)} label="packed" />
      </div>
      <p className="muted tiny">
        {learning.confirmed} confirmations out of {learning.decided} answers. Unanswered rows never
        count as evidence.
      </p>

      {learning.groups.map((group) => (
        <div className="card" key={group.contextKey}>
          <div className="card-head">
            <h3 className="card-title">{group.label}</h3>
            <span className="muted tiny">
              {group.trips} trip{group.trips === 1 ? "" : "s"} · last {relativeDay(group.lastSeenAt)}
            </span>
          </div>
          <ul className="patterns">
            {group.items.map((item) => (
              <li className="pattern" key={item.itemId}>
                <span className="pattern-emoji" aria-hidden="true">
                  {item.item.emoji}
                </span>
                <span className="pattern-name">{item.item.name}</span>
                <span className="muted tiny">{ratio(item.confirmations, item.observations)}</span>
                <span className="pattern-meter" aria-hidden="true">
                  <span
                    className="pattern-meter-fill"
                    style={{ width: `${Math.min(99, item.probability * 100)}%` }}
                  />
                </span>
                <span className="pattern-pct">{percent(item.probability)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="card">
        <h2 className="card-title">Things you've told me to leave alone</h2>
        {exceptions.length === 0 ? (
          <p className="muted small">
            Nothing yet. Say “I don't need my laptop today” and it lands here — with “today” meaning
            just that.
          </p>
        ) : (
          <ul className="exception-list">
            {exceptions.map((exception) => {
              const item = byId.get(exception.itemId);
              return (
                <li key={exception.id} className="exception">
                  <span className="exception-item">
                    {item?.emoji ?? "•"} {item?.name ?? exception.itemId}
                  </span>
                  <span className="muted tiny">
                    {exception.scope === "recurring" ? "every time" : "just that day"} ·{" "}
                    {exception.contextKey.replace("::", " ")}
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() => onForget(exception.id)}
                  >
                    Forget
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {learning.unknownItems.length > 0 ? (
        <div className="banner banner-info">
          <strong>Some things are outside my list</strong>
          <p>
            You've packed {learning.unknownItems.join(", ")} — those aren't predictable yet. Better
            than inventing items for you to maintain.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
