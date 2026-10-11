import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCoreWorkerRouteParity } from "./lib/core-worker-route-parity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { parseConfigFileTextToJson } = createRequire(import.meta.url)("typescript");
const parsed = parseConfigFileTextToJson("wrangler.jsonc", await readFile(resolve(root, "apps/eliotr-core/wrangler.jsonc"), "utf8"));
assert.equal(parsed.error, undefined, "Canonical Wrangler JSONC must parse");
const canonical = parsed.config;
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
assert.equal(canonical.assets.directory, "../eliotr-pwa/dist");

// The provisioner starts from structuredClone(canonicalConfig); exercise the
// same generated-config parity guard before its binding and vars projections.
const generated = structuredClone(canonical);
assert.equal(assertCoreWorkerRouteParity(canonical, generated), generated);
assert.equal(assertCoreWorkerRouteParity(canonical, generated, { assetProfile: "legacy" }), generated);

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

const ownerGenerated = structuredClone(canonical);
ownerGenerated.assets.directory = "../eliotr-web/dist/client";
assert.equal(assertCoreWorkerRouteParity(canonical, ownerGenerated, { assetProfile: "owner-web" }), ownerGenerated);
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerGenerated),
  /Generated Wrangler config changed the Core static asset fallback configuration/u);
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerGenerated, { assetProfile: "constructor" }),
  /asset profile is invalid/u);
assert.throws(() => assertCoreWorkerRouteParity(canonical, generated, { assetProfile: "owner-web" }),
  /Generated Wrangler config changed the Core static asset fallback configuration/u);
const changedCanonical = structuredClone(canonical);
changedCanonical.assets.directory = "../eliotr-web/dist/client";
assert.throws(() => assertCoreWorkerRouteParity(changedCanonical, ownerGenerated, { assetProfile: "owner-web" }),
  /Canonical Wrangler config changed the Core static asset fallback configuration/u);

const ownerFixtureOutput = structuredClone(ownerGenerated);
ownerFixtureOutput.assets.directory = "../eliotr-web/dist";
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerFixtureOutput, { assetProfile: "owner-web" }),
  /Generated Wrangler config changed the Core static asset fallback configuration/u);
const ownerRawVitePath = structuredClone(ownerGenerated);
ownerRawVitePath.assets.directory = "../client";
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerRawVitePath, { assetProfile: "owner-web" }),
  /Generated Wrangler config changed the Core static asset fallback configuration/u);
const ownerMissingAgents = structuredClone(ownerGenerated);
ownerMissingAgents.assets.run_worker_first = ownerMissingAgents.assets.run_worker_first.filter((route) => route !== "/agents");
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerMissingAgents, { assetProfile: "owner-web" }),
  /required Core Worker-first route family/u);
const ownerMissingAgentsWildcard = structuredClone(ownerGenerated);
ownerMissingAgentsWildcard.assets.run_worker_first = ownerMissingAgentsWildcard.assets.run_worker_first
  .filter((route) => route !== "/agents/*");
assert.throws(() => assertCoreWorkerRouteParity(canonical, ownerMissingAgentsWildcard, { assetProfile: "owner-web" }),
  /required Core Worker-first route family/u);

console.log("Core Worker-first route parity: PASS");
