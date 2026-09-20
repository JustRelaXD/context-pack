#!/usr/bin/env node
/**
 * The deploy build, written to Vercel's Build Output API.
 *
 * This exists because the platform's default pipeline cannot express what this
 * repo needs. Two failures, both from the same cause — the function was shipped
 * with its imports left unresolved:
 *
 *   1. `@contextpack/shared` is a workspace package whose entry is TypeScript
 *      source. The platform's builder traced the import, rewrote it to
 *      `node_modules/@contextpack/shared/src/index.ts`, and shipped the bundle
 *      without that file, so the function died on import:
 *      `ERR_MODULE_NOT_FOUND ... /var/task/node_modules/@contextpack/shared/src/index.ts`.
 *   2. The install produced a tree that resolved `vite` but not the plugin next
 *      to it in the same package.json, which no install command explains.
 *
 * So the build states its own output instead of trusting detection. The function
 * is **one bundled file with no runtime imports**, which is also what a
 * serverless function should be: nothing to resolve at invocation, and a cold
 * start that does not walk a node_modules tree.
 *
 * Produces:
 *   .vercel/output/static/                     the built UI
 *   .vercel/output/functions/api.func/index.js the API, self-contained
 *   .vercel/output/config.json                 how requests reach both
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".vercel", "output");
const fnDir = join(outDir, "functions", "api.func");
const webDist = join(root, "apps", "web", "dist");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error(`\n[deploy] "${command} ${args.join(" ")}" exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("[deploy] building the UI");
run("npm", ["run", "build", "-w", "@contextpack/web"]);

if (!existsSync(join(webDist, "index.html"))) {
  console.error(`[deploy] the web build produced no index.html at ${webDist}`);
  process.exit(1);
}

console.log("[deploy] bundling the API function");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(fnDir, { recursive: true });

await esbuild({
  entryPoints: [join(root, "api", "index.ts")],
  outfile: join(fnDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  // Matches the runtime declared below. Bundling makes this a low-stakes choice:
  // there is no dependency tree to be compatible with, only our own syntax.
  target: "node22",
  sourcemap: "inline",
  logLevel: "warning",
  // `module.exports` ends up as the handler itself, with every named export copied
  // onto it. Launchers differ on whether they read `mod.default` or call `mod`
  // directly; this satisfies both, so the entry point cannot be the reason a
  // deploy fails again.
  footer: {
    js: "module.exports = Object.assign(module.exports.default, module.exports);",
  },
});

writeFileSync(
  join(fnDir, ".vc-config.json"),
  `${JSON.stringify(
    {
      // Node 22: the major this repo declares in `engines`, and an LTS line.
      runtime: "nodejs22.x",
      handler: "index.js",
      launcherType: "Nodejs",
    },
    null,
    2,
  )}\n`,
);

console.log("[deploy] assembling the output");
cpSync(webDist, join(outDir, "static"), { recursive: true });

writeFileSync(
  join(outDir, "config.json"),
  `${JSON.stringify(
    {
      version: 3,
      routes: [
        // Everything under /api goes to the one function, which routes internally
        // with Express. The path is preserved, and the function also normalises it,
        // so this cannot be the thing that breaks.
        { src: "/api/(.*)", dest: "/api" },
        // Built assets, then the SPA entry for anything else.
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  )}\n`,
);

console.log("[deploy] wrote .vercel/output (static + functions/api.func + config.json)");
