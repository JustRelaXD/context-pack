import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Test configuration, kept separate from `vite.config.ts` so the production
 * build never has to resolve the test toolchain.
 *
 * The React plugin is repeated here on purpose: tests render `.tsx`, so the JSX
 * transform needs to be present in this config too, and sharing it would mean
 * reintroducing the coupling this file exists to remove.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom rather than jsdom: same job, noticeably less setup, and the UI
    // tests only need a DOM and a fetch stub.
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
