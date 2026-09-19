import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ContextException,
  DiagnosticsResponse,
  LearningOverview,
  TripSummary,
  TripView,
  UserAction,
} from "@contextpack/shared";
import { api } from "./api";
import { History } from "./components/History";
import { Learned } from "./components/Learned";
import { Today } from "./components/Today";

type Tab = "today" | "learned" | "history";

interface Notice {
  kind: "info" | "error";
  text: string;
}

/**
 * The shell.
 *
 * All fetching lives here and the screens stay presentational, which keeps the
 * "which layer is actually answering" question in one place: the status strip
 * under the title reports whether Jev or the rule-based parser read the context,
 * so nobody has to guess whether the model was involved.
 */
export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [trip, setTrip] = useState<TripView | null>(null);
  const [history, setHistory] = useState<TripSummary[]>([]);
  const [learning, setLearning] = useState<LearningOverview | null>(null);
  const [exceptions, setExceptions] = useState<ContextException[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revision, setRevision] = useState(0);

  const refreshSummaries = useCallback(async () => {
    const [historyResult, learningResult, exceptionsResult] = await Promise.all([
      api.history(40),
      api.learning(),
      api.exceptions(),
    ]);
    setHistory(historyResult.trips);
    setLearning(learningResult);
    setExceptions(exceptionsResult.exceptions);
  }, []);

  useEffect(() => {
    api.diagnostics().then(setDiagnostics).catch(() => setDiagnostics(null));
    refreshSummaries().catch((error: Error) => setNotice({ kind: "error", text: error.message }));
  }, [refreshSummaries]);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      try {
        await work();
      } catch (error) {
        setNotice({ kind: "error", text: (error as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleStart = useCallback(
    (rawInput: string, withWeather: boolean) =>
      run(async () => {
        const view = await api.startTrip(rawInput, withWeather);
        setTrip(view);
        setNotice(null);
        setRevision((value) => value + 1);
        void refreshSummaries();
      }),
    [refreshSummaries, run],
  );

  const handleDecide = useCallback(
    (itemId: string, action: UserAction, tripId?: string) =>
      run(async () => {
        const target = tripId ?? trip?.trip.id;
        if (!target) return;
        const view = await api.feedback(target, itemId, action);
        if (!tripId || tripId === trip?.trip.id) setTrip(view);
        setRevision((value) => value + 1);
        void refreshSummaries();
      }),
    [refreshSummaries, run, trip?.trip.id],
  );

  const handleTell = useCallback(
    (rawInput: string) =>
      run(async () => {
        if (!trip) return;
        const result = await api.interpretException(trip.trip.id, rawInput);
        setTrip(result.view);
        setRevision((value) => value + 1);
        if (!result.parsed) {
          setNotice({
            kind: "info",
            text: `I couldn't tell which item that was about. Try naming it, like "I don't need my charger today".`,
          });
        } else {
          setNotice({
            kind: "info",
            text:
              result.parsed.action === "mark_needed"
                ? `Got it — you're taking the ${result.parsed.itemName.toLowerCase()} after all.`
                : `Recorded: no ${result.parsed.itemName.toLowerCase()} ${
                    result.parsed.scope === "recurring" ? "on trips like this" : "today"
                  }. I'll stop pushing it.`,
          });
        }
        void refreshSummaries();
      }),
    [refreshSummaries, run, trip],
  );

  const handleForget = useCallback(
    (exceptionId: string) =>
      run(async () => {
        await api.forgetException(exceptionId);
        await refreshSummaries();
        setNotice({ kind: "info", text: "Forgotten — I'll start predicting it again." });
      }),
    [refreshSummaries, run],
  );

  const suggestions = useMemo(() => {
    const seen: string[] = [];
    for (const entry of history) {
      const candidate = entry.rawInput.trim();
      if (!candidate || seen.includes(candidate)) continue;
      seen.push(candidate);
      if (seen.length === 3) break;
    }
    for (const fallback of ["college for a lab", "I'm going to a hackathon", "heading to the gym"]) {
      if (seen.length >= 3) break;
      if (!seen.includes(fallback)) seen.push(fallback);
    }
    return seen;
  }, [history]);

  const status = describeStatus(diagnostics);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            Context<span className="brand-accent">Pack</span>
          </span>
          <span className="muted tiny status">{status}</span>
        </div>
      </header>

      <main className="main">
        {tab === "today" ? (
          <Today
            trip={trip}
            suggestions={suggestions}
            busy={busy}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            onStart={handleStart}
            onDecide={(itemId, action) => handleDecide(itemId, action)}
            onTell={handleTell}
            onClearTrip={() => {
              setTrip(null);
              setNotice(null);
            }}
          />
        ) : null}

        {tab === "learned" ? (
          <Learned
            learning={learning}
            exceptions={exceptions}
            busy={busy}
            onForget={handleForget}
          />
        ) : null}

        {tab === "history" ? (
          <History
            trips={history}
            busy={busy}
            revision={revision}
            onDecide={(itemId, action, tripId) => handleDecide(itemId, action, tripId)}
          />
        ) : null}
      </main>

      <nav className="tabbar">
        <TabButton active={tab === "today"} onClick={() => setTab("today")} label="Today" />
        <TabButton
          active={tab === "learned"}
          onClick={() => setTab("learned")}
          label="Learned"
          badge={learning ? String(learning.groups.length) : undefined}
        />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          label="History"
          badge={history.length ? String(history.length) : undefined}
        />
      </nav>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: string;
}) {
  return (
    <button type="button" className={`tab ${active ? "tab-active" : ""}`} onClick={onClick}>
      {label}
      {badge ? <span className="tab-badge">{badge}</span> : null}
    </button>
  );
}

/**
 * One line that answers "is the AI actually on?".
 *
 * Naming the provider rather than saying "AI-powered" is the honest version, and
 * it is also the fastest way to debug a demo: if this says `heuristic`, no model
 * is being called.
 */
function describeStatus(diagnostics: DiagnosticsResponse | null): string {
  if (!diagnostics) return "connecting…";
  const context = diagnostics.agent.find((entry) => entry.component === "context");
  const reasoning = diagnostics.agent.find((entry) => entry.component === "reasoning");
  // Say out loud when storage is in-process: on a serverless deployment the
  // user's confirmations genuinely do not survive, and discovering that by
  // losing a trip is much worse than reading it here.
  const store = diagnostics.store.durable
    ? diagnostics.store.adapter
    : `${diagnostics.store.adapter} (resets)`;
  return [
    `reads: ${context?.active ?? "?"}`,
    `words: ${reasoning?.active ?? "?"}`,
    `store: ${store}`,
  ].join(" · ");
}
