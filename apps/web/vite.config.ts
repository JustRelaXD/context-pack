import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The dev server proxies `/api` to the local Node server, so the browser only
 * ever talks to one origin. That matters twice over: no CORS surprises in dev,
 * and the production build can be served straight from the API process (see
 * `serveWeb` in the server) with the exact same relative URLs.
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
  test: {
    // happy-dom rather than jsdom: same job, noticeably less setup, and the UI
    // tests only need a DOM and a fetch stub.
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
