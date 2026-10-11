import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { admitStartupObservation, reconcileRouteLoadMembership } from "./lib/emitted-route-membership.mjs";

// Deterministic local fixtures. These assertions do not constitute a browser,
// build, deployed-source or selected-profile acceptance result.
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = new Map(Object.entries({
  "index.html": '<script type="module" src="/assets/entry.js"></script><link rel="modulepreload" href="/assets/preload.js">',
  "assets/entry.js": 'import "./shared.js";void import("./boot.js");function unused(){import("./later.js");new Worker(new URL("./worker.js",import.meta.url))}',
  "assets/boot.js": 'import "./shared.js";console.log("boot");',
  "assets/shared.js": 'export const shared = "shared";',
  "assets/later.js": 'console.log("later");',
  "assets/worker.js": 'console.log("worker");',
  "assets/preload.js": 'console.log("preload");',
  "agent-inbox/index.html": '<script type="module" src="/agent-inbox/app.js"></script>',
  "agent-inbox/app.js": 'import "../assets/shared.js";console.log("inbox");',
}).map(([name, text]) => [name, Buffer.from(text)]));
const graph = new Map([
  ["assets/entry.js", { staticImports: ["assets/shared.js"], dynamicImports: ["assets/boot.js", "assets/later.js"], workerImports: ["assets/worker.js"] }],
  ["assets/boot.js", { staticImports: ["assets/shared.js"], dynamicImports: [], workerImports: [] }],
  ["assets/shared.js", { staticImports: [], dynamicImports: [], workerImports: [] }],
]);
const common = { htmlPath: "index.html", entryPaths: ["assets/entry.js"],
  preloadPaths: ["assets/preload.js"], graph, bytesByPath: files };
const epoch = Date.parse("2026-10-11T08:00:00.000Z");
function evidence(html = "index.html", scripts = ["assets/entry.js", "assets/shared.js", "assets/boot.js", "assets/preload.js"]) {
  const route = html === "index.html" ? "/research" :
    "/" + html.replace(/(^|\/)index\.html$/u, "$1").replace(/\/+$/u, "") + "/";
  const rows = [html, ...scripts].map((artifact, index) => ({
    id: index + 1, origin: "http://127.0.0.1:4630", pathname: index === 0 ? route : "/" + artifact,
    method: "GET", resource_type: index === 0 ? "document" : "script", query_bytes: 0,
    query_sha256: hash(Buffer.alloc(0)), state: "FINISHED", status: 200,
    started_epoch_ms: epoch + 1, finished_epoch_ms: epoch + 2,
    service_worker_request: false, from_service_worker: false, completed_by_boundary: true,
    artifact, artifact_matches: true, response_role: "PINNED_STATIC_ASSET",
    decoded_body_bytes: files.get(artifact).length, body_sha256: hash(files.get(artifact)),
  }));
  return { protocol: "eliotr.actual-owner-startup-observation.v1", status: "BOUNDED_ACTUAL_RESEARCH_STARTUP_OBSERVED",
    source_commit: "a".repeat(40), build_sha256: "b".repeat(64), artifact_readback_sha256: "c".repeat(64),
    origin: "http://127.0.0.1:4630", route, profile: "SYNTHETIC_NEGATIVE_CASE_FIXTURE", boundary: "fixture-ready",
    started_at: new Date(epoch).toISOString(), finished_at: new Date(epoch + 10).toISOString(), boundary_epoch_ms: epoch + 5,
    requests: structuredClone(rows), requests_at_boundary: rows,
    observer_errors: [], browser_errors: { page_error_count: 0, console_error_count: 0 },
    context: { fresh: true, storage_state_loaded: false, http_cache: "DISABLED_BY_ROUTE_INTERCEPTION" },
    page_state: { service_worker_controller: null }, service_workers_at_boundary: [] };
}
function admit(value, htmlPath = "index.html") {
  const bytes = Buffer.from(JSON.stringify(value));
  return admitStartupObservation(bytes, { observationSha256: hash(bytes), sourceCommit: value.source_commit,
    buildSha256: value.build_sha256, artifactReadbackSha256: value.artifact_readback_sha256,
    route: value.route, profile: value.profile, boundary: value.boundary, htmlPath,
    artifacts: [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes), rawBytes: bytes.length })) });
}

const overBudgetOnly = process.argv.includes("--over-budget-only");
const aggregationOnly = process.argv.includes("--aggregation-only");
const integrationOnly = process.argv.includes("--integration-only") || overBudgetOnly || aggregationOnly;
const unitOnly = process.argv.includes("--unit-only");
if (!integrationOnly) {
const absent = reconcileRouteLoadMembership(common);
assert.equal(absent.status, "NOT_MEASURED");
assert.equal(absent.initialJavaScript.gzipBytes, null);
assert.deepEqual([...absent.staticImportPaths].sort(), ["assets/entry.js", "assets/shared.js"]);
assert.equal(absent.staticImportPaths.has("assets/worker.js"), false);
assert.equal(absent.staticImportPaths.has("assets/preload.js"), false);
assert.equal(absent.lazyJavaScript.gzipBytes, null);
const observed = reconcileRouteLoadMembership({ ...common, startupObservation: admit(evidence()) });
assert.equal(observed.status, "MEASURED");
assert.ok(observed.initialPaths.has("assets/boot.js"));
assert.equal(observed.measurement.moduleEvaluation, "NOT_MEASURED");
assert.equal(observed.lazyJavaScript.status, "NOT_MEASURED");
assert.deepEqual(observed.unobservedDynamicJavaScript.map((row) => row.path), ["assets/later.js"]);
const expectedGzip = observed.initialJavaScript.resources.reduce((sum, row) => sum + gzipSync(files.get(row.path), { level: 9 }).length, 0);
assert.equal(observed.initialJavaScript.gzipBytes, expectedGzip);
assert.equal(reconcileRouteLoadMembership({ ...common, startupObservation: {} }).status, "NOT_MEASURED");

for (const [name, corrupt] of [
  ["changed response body", (o) => { o.requests_at_boundary[2].body_sha256 = "0".repeat(64); }],
  ["missing boundary request", (o) => { o.requests_at_boundary.pop(); }],
  ["late script", (o) => { o.requests_at_boundary[1].finished_epoch_ms = epoch + 6; }],
  ["service worker response", (o) => { o.requests_at_boundary[1].from_service_worker = true; }],
  ["duplicate request", (o) => { o.requests_at_boundary.push(structuredClone(o.requests_at_boundary[1])); }],
  ["wrong document", (o) => { o.requests_at_boundary[0].pathname = "/other"; }],
]) {
  const value = evidence(); corrupt(value);
  const result = reconcileRouteLoadMembership({ ...common, startupObservation: admit(value) });
  assert.equal(result.status, "NOT_MEASURED", name);
  assert.equal(result.initialJavaScript.gzipBytes, null, name);
}
const stale = new Map(files); stale.set("assets/later.js", Buffer.from("changed unobserved artifact"));
assert.equal(reconcileRouteLoadMembership({ ...common, bytesByPath: stale, startupObservation: admit(evidence()) }).status, "NOT_MEASURED");
const duplicate = evidence(); const row = structuredClone(duplicate.requests[2]); row.id = 50;
duplicate.requests.push(structuredClone(row)); duplicate.requests_at_boundary.push(row);
assert.equal(reconcileRouteLoadMembership({ ...common, startupObservation: admit(duplicate) }).initialJavaScript.gzipBytes, expectedGzip);
console.log("Membership unit fixtures PASS: absent/forged/stale/body/boundary/SW/dedup/preload/worker");
}
if (unitOnly) process.exit(0);
const { inspectPwaBuild, inspectWebBuild } = await import("./lib/emitted-build-budget-evidence.mjs");
const { projectRetainedOwnerWebAnalysis } = await import("./lib/emitted-owner-web-reuse.mjs");
if (aggregationOnly) {
  files.set("settings/index.html", Buffer.from('<script type="module" src="/assets/entry.js"></script>'));
}
if (overBudgetOnly) {
  let state = 123456789;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chars = [];
  for (let index = 0; index < 950000; index += 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    chars.push(alphabet[(state >>> 0) % 64]);
  }
  files.set("assets/boot.js", Buffer.from('import "./shared.js";export const payload=' + JSON.stringify(chars.join("")) + ";"));
}
const expectedGzip = ["assets/entry.js", "assets/shared.js", "assets/boot.js", "assets/preload.js"]
  .reduce((sum, path) => sum + gzipSync(files.get(path), { level: 9 }).length, 0);

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  overBudgetOnly ? "../fixtures/three-consumers-over-budget" : aggregationOnly
    ? "../fixtures/three-consumers-aggregation" : "../fixtures/three-consumers");
for (const dist of ["apps/eliotr-pwa/dist", "apps/eliotr-web/dist/client"]) {
  for (const [name, bytes] of files) {
    const file = path.join(fixture, dist, name);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { flag: "wx" });
  }
}
const options = { startupObservations: new Map([
  ["index.html", admit(evidence())],
  ["agent-inbox/index.html", admit(evidence("agent-inbox/index.html", ["agent-inbox/app.js", "assets/shared.js"]), "agent-inbox/index.html")],
]) };
if (aggregationOnly) {
  options.startupObservations.set("settings/index.html", admit(evidence("settings/index.html"), "settings/index.html"));
}
const pwa = await inspectPwaBuild(fixture, new Date(epoch).toISOString(), options);
const web = await inspectWebBuild(fixture, new Date(epoch).toISOString(), options);
const projected = await inspectWebBuild(fixture, new Date(epoch).toISOString(), { ...options, analysisProjection: projectRetainedOwnerWebAnalysis });
const expectedStatus = overBudgetOnly ? "FAIL" : "PASS";
assert.equal(pwa.status, expectedStatus, JSON.stringify(pwa.issues));
assert.equal(web.status, expectedStatus, JSON.stringify(web.issues));
assert.equal(projected.status, expectedStatus, JSON.stringify(projected.issues));
if (overBudgetOnly) {
  assert.ok(expectedGzip > 614400);
  console.log("Three consumer over-budget fixtures FAIL correctly: " + expectedGzip + " > 614400 gzip bytes");
  process.exit(0);
}
for (const report of [pwa, web, projected]) {
  const root = report.routes.find((route) => route.htmlPath === "index.html" || route.route === "/");
  assert.equal(root.initialJavaScript.gzipBytes, expectedGzip);
  assert.equal(root.lazyJavaScript.status, "NOT_MEASURED");
  assert.ok(root.initialJavaScript.resources.some((row) => row.path.endsWith("assets/boot.js")));
}
assert.equal(web.metric.gzipBytes, expectedGzip);
assert.equal(projected.metric.gzipBytes, expectedGzip);
if (aggregationOnly) {
  assert.equal(web.metric.entryHtmlPath, "index.html");
  assert.equal(web.agentInbox.htmlPath, "agent-inbox/index.html");
  assert.ok(web.agentInbox.initialJavaScript.gzipBytes > 0);
  assert.equal(projected.sharedInitialJavaScript.resources.length, 4);
  assert.equal(new Set(projected.sharedInitialJavaScript.resources.map((row) => row.path)).size, 4);
  const allRoutes = web.routes.reduce((sum, row) => sum + row.initialJavaScript.gzipBytes, 0);
  assert.ok(allRoutes > web.metric.gzipBytes);
  console.log("Owner entry aggregation PASS: shared chunks counted once, other owner entry and inbox kept separate");
  process.exit(0);
}
const noNetwork = await inspectWebBuild(fixture, new Date(epoch).toISOString());
assert.equal(noNetwork.status, "NOT_MEASURED");
assert.equal(noNetwork.metric.gzipBytes, null);
console.log("Three consumer fixtures PASS: immediate dynamic included; static/preload/worker inventory separated; missing network NOT_MEASURED");
