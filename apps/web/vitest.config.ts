import { defineConfig } from "vitest/config";

/**
 * Test configuration, kept separate from `vite.config.ts` so the production
 * build never has to resolve the test toolchain.
 *
 * There is no React plugin here, on purpose. `jsx: react-jsx` in tsconfig means
 * esbuild compiles the JSX, which is exactly what `vite build` does, so the
 * tests exercise the same transform that ships. The plugin only adds React Fast
 * Refresh, which is a dev-server feature and has no meaning under test — and
 * loading it here previously made the tests depend on a package the build can
 * do without.
 */
export default defineConfig({
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
