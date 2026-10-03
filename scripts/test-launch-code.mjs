import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLaunchCodeComplete, launchCodeBlockers, readCompositionCapabilityProfile, readConfiguredTransport } from "./check-launch-code.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
const composition = (slices = "", operations = "") =>
  `function createApplication() { return { disabled_slices: [${slices}] }; } ${operations}`;
const profile = { protocol: "eliotr.release-profile.v1", google_external_transport: "gemini-mcp" };
assert.equal(readConfiguredTransport({ vars: { GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp" }, env: {
  test: { vars: { GOOGLE_EXTERNAL_TRANSPORT: "drive-exchange" } },
} }), "gemini-mcp", "unselected Wrangler environment may retain a separate profile");
assert.throws(() => readConfiguredTransport({ vars: { GOOGLE_EXTERNAL_TRANSPORT: "gemini-and-drive" } }));
const registry = { protocol: "eliotr.implementation-status.v1", release_profile: profile, entries: [
  { id: "workflow", path: "apps/workflow.ts", state: "SCAFFOLD_FAIL_CLOSED" },
  { id: "session", path: "apps/session.ts", state: "IN_PROGRESS" },
] };
assert.deepEqual(launchCodeBlockers(registry, composition('', 'unavailable("research.query");')), [
  "google gemini-mcp: Workspace candidate admission/readback qualification is incomplete",
  "research.query", "session: apps/session.ts", "workflow: apps/workflow.ts",
]);
assert.throws(() => launchCodeBlockers({}, "createApplication"));
assert.throws(() => launchCodeBlockers({ ...registry, entries: [{ id: "x", path: "x", state: "DONE" }] }, "createApplication"));
const complete = { ...registry, entries: [
  { id: "test", path: "test.ts", state: "IMPLEMENTED_NOT_LIVE" },
  { id: "workspace-candidate-admission", path: "test-workspace.ts", state: "LIVE_QUALIFIED" },
  { id: "implemented-006", path: "test-gemini.ts", state: "LIVE_QUALIFIED" },
] };
assert.deepEqual(launchCodeBlockers(complete, composition()), []);
// A complete method registry is insufficient while a mandatory product is disabled.
for (const slice of ["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "ERASURE"]) {
  assert.deepEqual(launchCodeBlockers(complete, composition(JSON.stringify(slice))), [`disabled required slice: ${slice}`]);
}
assert.deepEqual(launchCodeBlockers({ ...complete, release_profile: { ...profile, google_external_transport: "drive-exchange" }, entries: [
  ...complete.entries, { id: "pending-drive-exchange", path: "test-drive.ts", state: "LIVE_QUALIFIED" },
] }, composition(JSON.stringify("DRIVE_EXCHANGE"))), ["disabled required slice: DRIVE_EXCHANGE"]);
assert.deepEqual(launchCodeBlockers(complete, composition(JSON.stringify("DRIVE_EXCHANGE"))), []);
assert.deepEqual(launchCodeBlockers(complete, composition('"OPTIONAL_EXPERIMENT"')), []);
assert.deepEqual(launchCodeBlockers(complete, composition('', '// unavailable("comment.only")')), []);
assert.deepEqual(launchCodeBlockers(complete, composition('', `const example = 'unavailable("string.only")';`)), []);
for (const input of [
  'function createApplication() { return {}; }',
  'function createApplication() { return { disabled_slices: compute() }; }',
  'function createApplication() { return { ["disabled_slices"]: [] }; }',
  composition('...dynamic'), composition('"DRIVE_EXCHANGE", "DRIVE_EXCHANGE"'),
  composition('null'), composition('"bad slice"'), composition('', 'unavailable(operation);'),
  composition() + 'const extra = { disabled_slices: [] };',
  'function createApplication() { invalid( {',
]) assert.throws(() => launchCodeBlockers(complete, input));
assert.throws(() => launchCodeBlockers({ ...complete, release_profile: { protocol: "eliotr.release-profile.v1", google_external_transport: "gemini-and-drive" } }, composition()));
assert.throws(() => launchCodeBlockers({ ...complete, entries: [
  ...complete.entries, { id: "common-entry", path: "test-common.ts", state: "IMPLEMENTED_NOT_LIVE", required_for_transports: ["gemini-mcp"] },
] }, composition()));
// A Google-free release still checks every common product and actual unavailable operation.
const withoutGoogle = { ...complete, release_profile: { ...profile, google_external_transport: "disabled" }, entries: [
  { id: "test", path: "test.ts", state: "IMPLEMENTED_NOT_LIVE" },
  { id: "workspace-candidate-admission", path: "test-workspace.ts", state: "IN_PROGRESS", required_for_transports: ["gemini-mcp"] },
  { id: "pending-drive-exchange", path: "test-drive.ts", state: "IN_PROGRESS", required_for_transports: ["drive-exchange"] },
] };
assert.equal(readConfiguredTransport({ vars: { GOOGLE_EXTERNAL_TRANSPORT: "disabled" } }), "disabled");
assert.deepEqual(launchCodeBlockers(withoutGoogle, composition('"DRIVE_EXCHANGE"')), []);
for (const slice of ["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "ERASURE"]) {
  assert.deepEqual(launchCodeBlockers(withoutGoogle, composition(JSON.stringify(slice))), [`disabled required slice: ${slice}`]);
}
assert.deepEqual(launchCodeBlockers(withoutGoogle, composition('', 'unavailable("research.query");')), ["research.query"]);
assert.deepEqual(launchCodeBlockers({ ...withoutGoogle, entries: registry.entries }, composition()), [
  "session: apps/session.ts", "workflow: apps/workflow.ts",
]);
for (const transport of ["gemini-mcp", "drive-exchange"]) {
  const blockers = launchCodeBlockers({ ...withoutGoogle, release_profile: { ...profile, google_external_transport: transport } }, composition());
  assert.ok(blockers.some((blocker) => blocker.startsWith(`google ${transport}:`)), "selected integrations retain their own readiness requirements");
}
const current = JSON.parse(await readFile(new URL("../docs/implementation/implementation-status.json", import.meta.url), "utf8"));
const drive = current.entries.find((entry) => entry.path === "packages/google-drive-exchange/src/reconciler.ts");
assert.ok(drive, "The normative Drive implementation must be explicitly inventoried");
if (drive.state === "IN_PROGRESS" || drive.state === "SCAFFOLD_FAIL_CLOSED") {
  assert.ok(launchCodeBlockers({ ...complete, entries: [drive] }, composition()).includes(`${drive.id}: ${drive.path}`));
}
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const routePath = resolve(repositoryRoot, "packages/interfaces/src/routes.ts");
const sourceFiles = ["apps/eliotr-core/src/composition-root.ts", "packages/interfaces/src/routes.ts",
  "packages/contracts/src/research.ts", "packages/cloudflare-navigation/src/orientation-input.ts"];
const sourceMap = new Map(await Promise.all(sourceFiles.map(async (path) => {
  const absolute = resolve(repositoryRoot, path);
  return [absolute, await readFile(absolute, "utf8")];
})));
const profileRead = async (changed = sourceMap) => readCompositionCapabilityProfile({ root: repositoryRoot,
  read: async (path) => {
    const text = changed.get(resolve(path));
    if (text === undefined) throw new Error("missing fixture source");
    return text;
  } });
const capabilityProfile = await profileRead();
assert.equal(capabilityProfile.protocol, "eliotr.capabilities.v1");
assert.equal(capabilityProfile.routes.length, 105);
assert.ok(capabilityProfile.routes.some((route) => route.path === "/api/v1/system/capabilities"));
const routeText = sourceMap.get(routePath);
await assert.rejects(profileRead(new Map(sourceMap).set(routePath,
  routeText.replace("{ RESEARCH_REQUEST_MAX_BYTES }", "{ RESEARCH_REQUEST_MAX_BYTES as REQUEST_BYTES }"))), /may not be aliased/u);
await assert.rejects(profileRead(new Map(sourceMap).set(routePath, `${routeText}\nROUTES.push({});\n`)), /executable or dynamic expansion/u);
const firstRoute = routeText.split("\n").find((line) => line.startsWith("  { method:"));
assert.ok(firstRoute);
await assert.rejects(profileRead(new Map(sourceMap).set(routePath,
  routeText.replace("] as const;", `${firstRoute}\n] as const;`))), /routes contain duplicates/u);
await assert.rejects(readCompositionCapabilityProfile({ root: repositoryRoot,
  read: async () => { throw new Error("source unavailable"); } }), /source unavailable/u);
await assert.rejects(assertLaunchCodeComplete(), /LIVE_DEPLOY_BLOCKED/);
const forbidden = () => assert.fail("unfinished code must fail before any command, credential readback or remote effect");
await assert.rejects(deployCloudflare({ confirmLive: true, environment: {}, execute: forbidden,
  captureCommand: forbidden, fetchImpl: forbidden, save: forbidden, archive: forbidden }), /LIVE_DEPLOY_BLOCKED/);
console.log("Launch guard: current unfinished product blocked before all release effects; no implicit live qualification.");
