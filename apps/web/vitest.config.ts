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
    environmentOptions: {
      happyDOM: {
        // happy-dom defaults to `http://localhost:3000`, and it dials that URL
        // itself when the window is torn down. The result was a real
        // `ECONNREFUSED 127.0.0.1:3000` in the test output that looked like our
        // client leaking a request but wasn't — the app's own fetches are all
        // mocked. A `.test` host is reserved by RFC 2606, so it can never
        // resolve to anything real, and the noise is gone.
        url: "http://contextpack.test/",
      },
    },
    globals: true,
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
