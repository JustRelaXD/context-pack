/**
 * Vercel serverless entry point.
 *
 * Vercel treats every file in `api/` as a function, so this is the single
 * deployment target for the whole API. Express does its own routing inside, and
 * `vercel.json` rewrites `/api/*` here — which is why all of our routes keep
 * their existing paths and nothing else in the codebase has to know this file
 * exists.
 *
 * The real work lives in `apps/server/src/vercel.ts`, so the platform-specific
 * shim stays three lines and the logic stays testable without Vercel.
 */
export { default } from "../apps/server/src/vercel";
