import type { DiagnosticsResponse } from "@contextpack/shared";

interface DataSheetProps {
  diagnostics: DiagnosticsResponse | null;
  busy: boolean;
  onClose: () => void;
  onLoadExample: () => void;
  onReset: () => void;
}

/**
 * The "what's going on under here" sheet.
 *
 * It exists for two reasons. First, a tool that learns from you owes you a
 * straight answer about where your answers went — so the storage line says
 * `memory (resets)` when that is the truth, rather than letting you discover it by
 * losing a trip. Second, it is where the data lives: load the example history, or
 * start over. Both are destructive-ish, so both are behind a deliberate open.
 */
export function DataSheet({ diagnostics, busy, onClose, onLoadExample, onReset }: DataSheetProps) {
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="Data and status"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <h2 className="sheet-title">Data &amp; status</h2>

        {diagnostics ? (
          <dl className="facts">
            {diagnostics.agent.map((entry) => (
              <div className="fact" key={entry.component}>
                <dt>{entry.component === "context" ? "Reading" : entry.component === "exceptions" ? "Corrections" : "Wording"}</dt>
                <dd>
                  <span className={`dot dot-${entry.active}`} aria-hidden="true" />
                  {entry.active}
                </dd>
              </div>
            ))}
            <div className="fact">
              <dt>Storage</dt>
              <dd>
                {diagnostics.store.adapter}
                {diagnostics.store.durable ? "" : " (resets)"}
              </dd>
            </div>
            {diagnostics.store.file ? (
              <div className="fact">
                <dt>File</dt>
                <dd className="mono">{diagnostics.store.file}</dd>
              </div>
            ) : null}
            <div className="fact">
              <dt>Weather</dt>
              <dd>{diagnostics.weather}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted small">Couldn't read the server's status.</p>
        )}

        {diagnostics && !diagnostics.store.durable ? (
          <p className="muted tiny">
            Storage is in-process, so trips won't survive a restart. That's a deployment choice, not a
            bug — a local run keeps everything on disk.
          </p>
        ) : null}

        <div className="sheet-actions">
          <button
            type="button"
            className="btn btn-block"
            disabled={busy || !diagnostics?.canLoadExample}
            onClick={onLoadExample}
          >
            Load example history
          </button>
          <p className="muted tiny">
            {diagnostics?.canLoadExample
              ? "Six weeks of generated trips, so there is something to show."
              : "Unavailable — you have history of your own now, and mixing the two would make every count a lie."}
          </p>

          {diagnostics?.resetEnabled ? (
            <>
              <button type="button" className="btn btn-danger btn-block" disabled={busy} onClick={onReset}>
                Delete everything and start over
              </button>
              <p className="muted tiny">
                Clears every trip, confirmation and exception, both example data and your own.
              </p>
            </>
          ) : (
            <p className="muted tiny">
              Deleting everything is disabled. Start the server with{" "}
              <code>CONTEXTPACK_ALLOW_RESET=1</code> to enable it.
            </p>
          )}
        </div>

        <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
