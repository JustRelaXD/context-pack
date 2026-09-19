import type { ContextException, LearningOverview } from "@contextpack/shared";
import { CATALOG_BY_ID } from "@contextpack/shared";
import { percent, ratio, relativeDay } from "../format";

interface LearnedProps {
  learning: LearningOverview | null;
  exceptions: ContextException[];
  busy: boolean;
  onForget: (exceptionId: string) => void;
}

/**
 * "What I've learned".
 *
 * The counts here are raw: no smoothing, no weighting. This screen exists so the
 * user can audit us — `14 of 16` has to mean fourteen actual trips, or the trust
 * argument is just marketing.
 */
export function Learned({ learning, exceptions, busy, onForget }: LearnedProps) {
  if (!learning) {
    return (
      <section className="stack">
        <div className="card">
          <p className="muted">Loading what I've learned…</p>
        </div>
      </section>
    );
  }

  if (learning.trips === 0) {
    return (
      <section className="stack">
        <div className="card">
          <h2 className="section-title">Nothing learned yet</h2>
          <p className="muted small">
            Log a trip and confirm what you packed. This screen fills up with the patterns behind
            every prediction, including the counts.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="card">
        <h2 className="section-title">What I've learned</h2>
        <div className="stats">
          <Stat value={String(learning.trips)} label="trips" />
          <Stat value={String(learning.decided)} label="decisions" />
          <Stat value={percent(learning.confirmRate)} label="packed" />
        </div>
        <p className="muted tiny">
          Built from {learning.confirmed} confirmations across {learning.decided} of your answers.
          Unanswered predictions are never counted as evidence.
        </p>
      </div>

      {learning.groups.map((group) => (
        <div className="card" key={group.contextKey}>
          <div className="group-head">
            <h3 className="group-title">{group.label}</h3>
            <span className="muted small">
              {group.trips} trip{group.trips === 1 ? "" : "s"} · last {relativeDay(group.lastSeenAt)}
            </span>
          </div>
          <ul className="pattern-list">
            {group.items.map((item) => (
              <li className="pattern" key={item.itemId}>
                <span className="item-emoji" aria-hidden="true">
                  {item.item.emoji}
                </span>
                <span className="pattern-name">{item.item.name}</span>
                <span className="pattern-count muted small">
                  {ratio(item.confirmations, item.observations)} trips
                </span>
                <span className="pattern-percent">{percent(item.probability)}</span>
                <span className="bar bar-thin">
                  <span
                    className="bar-fill tone-medium"
                    style={{ width: `${Math.min(99, item.probability * 100)}%` }}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="card">
        <h2 className="section-title">Things you've told me not to nag about</h2>
        {exceptions.length === 0 ? (
          <p className="muted small">
            Nothing yet. Say “I don't need my laptop today” and it lands here — with “today” being
            just that, not forever.
          </p>
        ) : (
          <ul className="exception-list">
            {exceptions.map((exception) => (
              <li key={exception.id} className="exception">
                <span className="exception-item">
                  {CATALOG_BY_ID.get(exception.itemId)?.emoji ?? "•"}{" "}
                  {CATALOG_BY_ID.get(exception.itemId)?.name ?? exception.itemId}
                </span>
                <span className={`pill ${exception.scope === "recurring" ? "pill-skipped" : ""}`}>
                  {exception.scope === "recurring" ? "every time" : "just that day"}
                </span>
                <span className="muted small">{exception.contextKey.replace("::", " ")}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => onForget(exception.id)}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {learning.unknownItems.length > 0 ? (
        <div className="card note">
          <strong>Some things are outside my list</strong>
          <p className="muted small">
            You've packed {learning.unknownItems.join(", ")} — I can't learn those yet because the
            item list is fixed. Better that than inventing items for you to maintain.
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
