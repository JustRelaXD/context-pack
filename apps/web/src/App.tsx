import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ContextException,
  DiagnosticsResponse,
  Item,
  ItemSuggestion,
  LearningOverview,
  TripSummary,
  TripView,
  UserAction,
} from "@contextpack/shared";
import { api } from "./api";
import { DataSheet } from "./components/DataSheet";
import { History } from "./components/History";
import { Learned } from "./components/Learned";
import { type Notice } from "./components/Notice";
import { Today } from "./components/Today";

type Tab = "today" | "learned" | "history";

/** Shown when there is no history to suggest from, so the box is never a dead end. */
const EXAMPLE_TRIPS = ["college for a lab", "I'm going to a hackathon", "heading to the gym"];

/**
 * The shell.
 *
 * All fetching lives here and the screens stay presentational. Two details are
 * worth knowing before reading further:
 *
 *  1. Decisions are optimistic. Tapping a row flips it immediately and the
 *     response settles it, because a checkmark that waits 400ms for a serverless
 *     round trip reads as a broken button.
 *  2. `pending` is per item, not per screen. One slow row must not freeze the
 *     other eleven while the user is trying to get out of the door.
 */
export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [trip, setTrip] = useState<TripView | null>(null);
  const [history, setHistory] = useState<TripSummary[]>([]);
  const [learning, setLearning] = useState<LearningOverview | null>(null);
  const [exceptions, setExceptions] = useState<ContextException[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [optimistic, setOptimistic] = useState<Record<string, UserAction>>({});
  const [exampleBusy, setExampleBusy] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revision, setRevision] = useState(0);
  const [suggestions, setSuggestions] = useState<ItemSuggestion[]>([]);
  const [suggestionsSource, setSuggestionsSource] = useState<"jev" | "groq" | "heuristic">(
    "heuristic",
  );
  const [suggestionsNote, setSuggestionsNote] = useState<string | undefined>(undefined);
  const [suggestedAdded, setSuggestedAdded] = useState<string[]>([]);

  const refreshSummaries = useCallback(async () => {
    const [historyResult, learningResult, exceptionsResult, itemsResult, diagnosticsResult] =
      await Promise.all([
        api.history(40),
        api.learning(),
        api.exceptions(),
        api.items(),
        api.diagnostics(),
      ]);
    setHistory(historyResult.trips);
    setLearning(learningResult);
    setExceptions(exceptionsResult.exceptions);
    setItems(itemsResult.items);
    setDiagnostics(diagnosticsResult);
  }, []);

  useEffect(() => {
    refreshSummaries().catch((error: Error) => setNotice({ kind: "error", text: error.message }));
  }, [refreshSummaries]);

  /**
   * Proposals for the trip that is open.
   *
   * Fetched after the trip rather than with it, because it costs a model call and
   * the real predictions should never wait behind it. A failure here is silent on
   * purpose: the trip screen is complete without suggestions, and a red banner
   * about a missing extra list would make a working screen look broken.
   */
  const tripId = trip?.trip.id;
  useEffect(() => {
    setSuggestedAdded([]);
    if (!tripId) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    api
      .tripSuggestions(tripId)
      .then((result) => {
        if (cancelled) return;
        setSuggestions(result.suggestions);
        setSuggestionsSource(result.source);
        setSuggestionsNote(result.note);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const fail = useCallback((error: unknown) => {
    setNotice({ kind: "error", text: (error as Error).message });
  }, []);

  const handleStart = useCallback(
    (rawInput: string, withWeather: boolean) =>
      (async () => {
        setStarting(true);
        try {
          setTrip(await api.startTrip(rawInput, withWeather));
          setOptimistic({});
          setNotice(null);
          setRevision((value) => value + 1);
          void refreshSummaries().catch(() => undefined);
        } catch (error) {
          fail(error);
        } finally {
          setStarting(false);
        }
      })(),
    [fail, refreshSummaries],
  );

  const handleDecide = useCallback(
    (itemId: string, action: UserAction, tripId?: string) => {
      const target = tripId ?? trip?.trip.id;
      if (!target) return;
      setOptimistic((current) => ({ ...current, [itemId]: action }));
      setPending((current) => ({ ...current, [itemId]: true }));

      void (async () => {
        try {
          const view = await api.feedback(target, itemId, action);
          if (!tripId || tripId === trip?.trip.id) setTrip(view);
          setRevision((value) => value + 1);
          void refreshSummaries().catch(() => undefined);
        } catch (error) {
          fail(error);
        } finally {
          // Drop the override either way: on success the server's own value is
          // now in `trip`, and on failure the optimistic tick was a lie.
          setOptimistic((current) => {
            const next = { ...current };
            delete next[itemId];
            return next;
          });
          setPending((current) => {
            const next = { ...current };
            delete next[itemId];
            return next;
          });
        }
      })();
    },
    [fail, refreshSummaries, trip?.trip.id],
  );

  const handleTell = useCallback(
    (rawInput: string) => {
      if (!trip) return;
      void (async () => {
        setStarting(true);
        try {
          const result = await api.interpretException(trip.trip.id, rawInput);
          setTrip(result.view);
          setRevision((value) => value + 1);
          setNotice(
            result.parsed
              ? {
                  kind: "info",
                  text:
                    result.parsed.action === "mark_needed"
                      ? `Got it — you're taking the ${result.parsed.itemName.toLowerCase()} after all.`
                      : `Recorded: no ${result.parsed.itemName.toLowerCase()} ${
                          result.parsed.scope === "recurring" ? "on trips like this" : "today"
                        }. I'll stop pushing it.`,
                }
              : {
                  kind: "info",
                  text: "I couldn't tell which item that was about. Try naming it, like \"I don't need my charger today\".",
                },
          );
          void refreshSummaries().catch(() => undefined);
        } catch (error) {
          fail(error);
        } finally {
          setStarting(false);
        }
      })();
    },
    [fail, refreshSummaries, trip],
  );

  const handleAddItem = useCallback(
    (name: string) => {
      void (async () => {
        setPending((current) => ({ ...current, __add__: true }));
        try {
          const { item, created } = await api.createItem({ name });
          // Adding it while looking at a trip means you have it in your hand, so
          // record that too rather than asking again.
          if (trip) {
            const view = await api.feedback(trip.trip.id, item.id, "packed");
            setTrip(view);
          }
          setSuggestedAdded((current) => (current.includes(item.id) ? current : [...current, item.id]));
          setNotice({
            kind: "info",
            text: created
              ? `Added ${item.name} and marked it packed.`
              : `${item.name} was already on your list — marked it packed.`,
          });
          setRevision((value) => value + 1);
          void refreshSummaries().catch(() => undefined);
        } catch (error) {
          fail(error);
        } finally {
          setPending((current) => {
            const next = { ...current };
            delete next.__add__;
            return next;
          });
        }
      })();
    },
    [fail, refreshSummaries, trip],
  );

  const handleForget = useCallback(
    (exceptionId: string) => {
      void (async () => {
        try {
          await api.forgetException(exceptionId);
          await refreshSummaries();
          setNotice({ kind: "info", text: "Forgotten — I'll start predicting it again." });
        } catch (error) {
          fail(error);
        }
      })();
    },
    [fail, refreshSummaries],
  );

  const handleLoadExample = useCallback(() => {
    void (async () => {
      setExampleBusy(true);
      try {
        const result = await api.loadExample();
        await refreshSummaries();
        setSheetOpen(false);
        setNotice({
          kind: "info",
          text: `Loaded ${result.created.trips} example trips across ${result.contextGroups} kinds of outing. Everything here says where it came from.`,
        });
      } catch (error) {
        fail(error);
      } finally {
        setExampleBusy(false);
      }
    })();
  }, [fail, refreshSummaries]);

  const handleReset = useCallback(() => {
    void (async () => {
      setExampleBusy(true);
      try {
        await api.reset();
        setTrip(null);
        await refreshSummaries();
        setSheetOpen(false);
        setNotice({ kind: "info", text: "Everything cleared. It's a fresh start." });
      } catch (error) {
        fail(error);
      } finally {
        setExampleBusy(false);
      }
    })();
  }, [fail, refreshSummaries]);

  /** What the user actually sees: the server's view plus any in-flight taps. */
  const visibleTrip = useMemo(() => {
    if (!trip) return null;
    if (Object.keys(optimistic).length === 0) return trip;
    return {
      ...trip,
      items: trip.items.map((item) =>
        optimistic[item.itemId] ? { ...item, userAction: optimistic[item.itemId]! } : item,
      ),
    };
  }, [optimistic, trip]);

  const recentTrips = useMemo(() => {
    const seen: string[] = [];
    for (const entry of history) {
      const candidate = entry.rawInput.trim();
      if (!candidate || seen.includes(candidate)) continue;
      seen.push(candidate);
      if (seen.length === 4) break;
    }
    return seen.length > 0 ? seen : EXAMPLE_TRIPS;
  }, [history]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">
            Context<span className="brand-accent">Pack</span>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Data and status"
            onClick={() => setSheetOpen(true)}
          >
            ⋯
          </button>
        </div>
      </header>

      <main className="main">
        {tab === "today" ? (
          <Today
            trip={visibleTrip}
            recentTrips={recentTrips}
            starting={starting}
            pending={pending}
            notice={notice}
            onDismissNotice={() => setNotice(null)}
            onStart={handleStart}
            onDecide={handleDecide}
            onTell={handleTell}
            onAddItem={handleAddItem}
            onClearTrip={() => {
              setTrip(null);
              setOptimistic({});
              setNotice(null);
            }}
            suggestions={suggestions}
            suggestionsSource={suggestionsSource}
            {...(suggestionsNote ? { suggestionsNote } : {})}
            suggestedAdded={suggestedAdded}
            allItems={items}
            showWelcome={history.length === 0}
            canLoadExample={diagnostics?.canLoadExample ?? false}
            onLoadExample={handleLoadExample}
            exampleBusy={exampleBusy}
          />
        ) : null}

        {tab === "learned" ? (
          <Learned
            learning={learning}
            exceptions={exceptions}
            items={items}
            busy={starting}
            onForget={handleForget}
          />
        ) : null}

        {tab === "history" ? (
          <History
            trips={history}
            pending={pending}
            revision={revision}
            onDecide={(itemId, action, tripId) => handleDecide(itemId, action, tripId)}
          />
        ) : null}
      </main>

      <nav className="tabbar">
        <TabButton active={tab === "today"} onClick={() => setTab("today")} label="Trip" />
        <TabButton
          active={tab === "learned"}
          onClick={() => setTab("learned")}
          label="Learned"
          badge={learning && learning.groups.length > 0 ? String(learning.groups.length) : undefined}
        />
        <TabButton
          active={tab === "history"}
          onClick={() => setTab("history")}
          label="History"
          badge={history.length > 0 ? String(history.length) : undefined}
        />
      </nav>

      {sheetOpen ? (
        <DataSheet
          diagnostics={diagnostics}
          busy={exampleBusy}
          onClose={() => setSheetOpen(false)}
          onLoadExample={handleLoadExample}
          onReset={handleReset}
        />
      ) : null}
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
    <button
      type="button"
      className={`tab ${active ? "tab-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {label}
      {badge ? <span className="tab-badge">{badge}</span> : null}
    </button>
  );
}
