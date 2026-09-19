import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * React Testing Library's automatic cleanup relies on a global `afterEach`,
 * which only exists when `globals` is enabled. Being explicit here means the
 * tests behave the same either way, and a leaking DOM can't quietly make a
 * later assertion pass.
 */
afterEach(() => {
  cleanup();
});
