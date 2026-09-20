import { defineConfig } from "vite";

/**
 * The dev server proxies `/api` to the local Node server, so the browser only
 * ever talks to one origin. That matters twice over: no CORS surprises in dev,
 * and the production build can be served straight from the API process (see
 * `serveWeb` in the server) with the exact same relative URLs.
 *
 * The React plugin is loaded by the dev server only, and dynamically, so that
 * `vite build` never resolves it. Fast Refresh is a dev-server feature; the
 * build does not need it, because `jsx: react-jsx` in tsconfig means esbuild —
 * which ships with Vite — compiles the JSX. This is not a micro-optimisation:
 * the production build runs in a container we do not control, and it failed
 * there with "Cannot find package '@vitejs/plugin-react'" when the platform's
 * install produced a partial dev tree. A build that cannot start without a dev
 * package it does not use is a build with a dependency that isn't real.
 *
 * Test configuration deliberately lives in `vitest.config.ts` instead of here.
 * Importing `vitest/config` from this file made the *production* build load the
 * entire test toolchain — the same mistake, one step earlier. The build config
 * should depend on Vite and nothing else.
 */
export default defineConfig(async ({ command }) => ({
  plugins: command === "serve" ? [(await import("@vitejs/plugin-react")).default()] : [],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.CONTEXTPACK_API ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
}));
