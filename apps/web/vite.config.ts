import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dev server proxies `/api` to the local Node server, so the browser only
 * ever talks to one origin. That matters twice over: no CORS surprises in dev,
 * and the production build can be served straight from the API process (see
 * `serveWeb` in the server) with the exact same relative URLs.
 *
 * Test configuration deliberately lives in `vitest.config.ts` instead of here.
 * Importing `vitest/config` from this file made the *production* build load the
 * entire test toolchain — a dependency the deploy does not need, on the one step
 * that has to work in a build container. Vite's build config should depend on
 * Vite and nothing else.
 */
export default defineConfig({
  plugins: [react()],
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
});
