import assert from "node:assert/strict";
import { computeResearchBackendFingerprint, ResearchBackendFingerprintError } from "./lib/research-backend-fingerprint.mjs";

const manifest = [
  "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tapps/eliotr-core/src/index.ts",
  "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tpackages/domain/src/index.ts",
].join("\n") + "\n";
function captureFactory({ dirty = "", tree = manifest } = {}) {
  return (_command, args) => args[0] === "status" ? dirty : tree;
}
const config = {
  name: "eliotr-core",
  compatibility_date: "2026-08-28",
  compatibility_flags: ["nodejs_compat"],
  vars: { DEPLOYMENT_GENERATION: "git-a", ENVIRONMENT: "staging", ROUTE_REF: "route-1" },
  assets: { directory: "../eliotr-pwa/dist" },
  d1_databases: [{ binding: "CORE_DB", database_id: "db-1" }],
};
const first = computeResearchBackendFingerprint({ root: ".", generated_config: config, capture: captureFactory() });
const pwaOnly = computeResearchBackendFingerprint({ root: ".", generated_config: {
  ...config, vars: { ...config.vars, DEPLOYMENT_GENERATION: "git-b" }, assets: { directory: "../eliotr-pwa/other" },
}, capture: captureFactory() });
assert.equal(first, pwaOnly, "PWA assets and exact deployment generation must not affect the backend fingerprint");
const changedCode = computeResearchBackendFingerprint({ root: ".", generated_config: config,
  capture: captureFactory({ tree: manifest.replace(/^100644 blob a+/u, "100644 blob cccccccccccccccccccccccccccccccccccccccc") }) });
assert.notEqual(changedCode, first);
const changedBinding = computeResearchBackendFingerprint({ root: ".", generated_config: {
  ...config, d1_databases: [{ binding: "CORE_DB", database_id: "db-2" }],
}, capture: captureFactory() });
assert.notEqual(changedBinding, first);
assert.throws(() => computeResearchBackendFingerprint({ root: ".", generated_config: config,
  capture: captureFactory({ dirty: " M apps/eliotr-core/src/index.ts\n" }) }),
  (error) => error instanceof ResearchBackendFingerprintError && error.code === "RESEARCH_BACKEND_FINGERPRINT_DIRTY");
console.log("research backend fingerprint tests passed");
