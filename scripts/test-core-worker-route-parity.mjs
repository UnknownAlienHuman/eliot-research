import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreWorkerRouteParity } from "./lib/core-worker-route-parity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = JSON.parse(await readFile(resolve(root, "apps/eliotr-core/wrangler.jsonc"), "utf8"));
const expectedRoutes = [
  "/healthz",
  "/mcp",
  "/agent-inbox",
  "/agent-inbox/*",
  "/agents",
  "/agents/*",
  "/api/*",
  "/federation/*",
  "/oauth/*",
];

assert.deepEqual(canonical.assets.run_worker_first, expectedRoutes);
assert.notEqual(canonical.assets.run_worker_first, true);

// The provisioner starts from structuredClone(canonicalConfig); exercise the
// same generated-config parity guard before its binding and vars projections.
const generated = structuredClone(canonical);
assert.equal(assertCoreWorkerRouteParity(canonical, generated), generated);

const missingAgentsWildcard = structuredClone(generated);
missingAgentsWildcard.assets.run_worker_first = missingAgentsWildcard.assets.run_worker_first
  .filter((route) => route !== "/agents/*");
assert.throws(
  () => assertCoreWorkerRouteParity(canonical, missingAgentsWildcard),
  /required Core Worker-first route family/u,
);

const globalWorkerFirst = structuredClone(generated);
globalWorkerFirst.assets.run_worker_first = true;
assert.throws(
  () => assertCoreWorkerRouteParity(canonical, globalWorkerFirst),
  /selective Worker-first routing/u,
);

const changedFallback = structuredClone(generated);
changedFallback.assets.not_found_handling = "404-page";
assert.throws(
  () => assertCoreWorkerRouteParity(canonical, changedFallback),
  /static asset fallback configuration/u,
);

console.log("Core Worker-first route parity: PASS");
