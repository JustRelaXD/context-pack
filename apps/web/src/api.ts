import type {
  CatalogResponse,
  CreateItemRequest,
  CreateItemResponse,
  DemoDataResponse,
  DiagnosticsResponse,
  ExceptionsResponse,
  HistoryResponse,
  InterpretExceptionResponse,
  LearningOverview,
  SuggestionsResponse,
  TripView,
  UserAction,
} from "@contextpack/shared";

/**
 * A thin, typed wrapper over the API.
 *
 * The response types come from `@contextpack/shared`, so if the server changes a
 * field the UI stops compiling instead of silently rendering `undefined`. Errors
 * carry the server's own message through to the screen — the server writes them
 * for humans, and hiding them behind "something went wrong" would throw away the
 * most useful thing in the response.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError("Can't reach the ContextPack server. Is it running on port 4000?", 0);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // A non-JSON body means something answered that is not this API — a proxy
      // error page, or the wrong port. Saying that is more useful than a parse
      // error, which is what the user would otherwise see.
      throw new ApiError(
        `The server sent a response this app can't read (${response.status}).`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const api = {
  diagnostics: () => request<DiagnosticsResponse>("/api/diagnostics"),

  catalog: () => request<CatalogResponse>("/api/catalog"),

  /** The catalog plus this user's own items. */
  items: () => request<CatalogResponse>("/api/items"),

  createItem: (input: CreateItemRequest) =>
    request<CreateItemResponse>("/api/items", { method: "POST", body: JSON.stringify(input) }),

  startTrip: (rawInput: string, withWeather: boolean) =>
    request<TripView>("/api/trips", {
      method: "POST",
      body: JSON.stringify({ rawInput, withWeather }),
    }),

  getTrip: (tripId: string) => request<TripView>(`/api/trips/${tripId}`),

  history: (limit = 30) => request<HistoryResponse>(`/api/trips?limit=${limit}`),

  feedback: (tripId: string, itemId: string, action: UserAction, scope?: "once" | "recurring") =>
    request<TripView>(`/api/trips/${tripId}/feedback`, {
      method: "POST",
      body: JSON.stringify({ itemId, action, ...(scope ? { scope } : {}) }),
    }),

  interpretException: (tripId: string, rawInput: string) =>
    request<InterpretExceptionResponse>(`/api/trips/${tripId}/exception`, {
      method: "POST",
      body: JSON.stringify({ rawInput }),
    }),

  /** Candidate items the agent proposes for this trip. Separate: it is slower. */
  tripSuggestions: (tripId: string) =>
    request<SuggestionsResponse>(`/api/trips/${tripId}/suggestions`),

  learning: () => request<LearningOverview>("/api/learning"),

  exceptions: () => request<ExceptionsResponse>("/api/exceptions"),

  forgetException: (exceptionId: string) =>
    request<{ ok: boolean }>(`/api/exceptions/${exceptionId}`, { method: "DELETE" }),

  /** Generate the example history. Refused by the server once you have your own. */
  loadExample: () => request<DemoDataResponse>("/api/demo", { method: "POST" }),

  /** Wipe everything. Only available when the server was started to allow it. */
  reset: () => request<{ ok: boolean }>("/api/reset", { method: "POST" }),
};
