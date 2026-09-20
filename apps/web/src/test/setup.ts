import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * A net under the mocks.
 *
 * `vi.stubGlobal("fetch", ...)` restores whatever value was installed *before*
 * the mock, so this wrapper becomes the live `fetch` the instant a test's mock
 * is removed. A request that escapes a test — a component that fires one after
 * the assertion, or a suite that forgot to install the mock — then lands here
 * and fails loudly, instead of quietly reaching the network and passing for a
 * reason nobody intended.
 *
 * It is installed underneath the mocks rather than over them, so the mocked
 * calls a test asserts on are never affected.
 */
const escaped: string[] = [];
const nativeFetch = globalThis.fetch;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  escaped.push(`${init?.method ?? "GET"} ${String(input)}`);
  return nativeFetch(input, init);
}) as typeof fetch;

/**
 * React Testing Library's automatic cleanup relies on a global `afterEach`,
 * which only exists when `globals` is enabled. Being explicit here means the
 * tests behave the same either way, and a leaking DOM can't quietly make a
 * later assertion pass.
 *
 * Cleanup and the leak check share one hook, in that order, on purpose: a
 * thrown assertion in a later hook skips the hooks after it, so splitting them
 * would let one leaked request leave React mounted and turn the *next* test's
 * queries into "found multiple elements" noise. Teardown first, then the
 * verdict.
 */
afterEach(() => {
  cleanup();

  if (escaped.length > 0) {
    const calls = escaped.splice(0).join(", ");
    throw new Error(
      `A request escaped the mock fetch: ${calls}. Wait for the view to settle before the test ends, so follow-up requests happen while the mock is installed.`,
    );
  }
});
