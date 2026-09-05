import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertLaunchCodeComplete, launchCodeBlockers } from "./check-launch-code.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
const composition = (slices = "", operations = "") =>
  `function createApplication() { return { disabled_slices: [${slices}] }; } ${operations}`;
const registry = { protocol: "eliotr.implementation-status.v1", entries: [
  { id: "workflow", path: "apps/workflow.ts", state: "SCAFFOLD_FAIL_CLOSED" },
  { id: "session", path: "apps/session.ts", state: "IN_PROGRESS" },
] };
assert.deepEqual(launchCodeBlockers(registry, composition('', 'unavailable("research.query");')), [
  "research.query", "session: apps/session.ts", "workflow: apps/workflow.ts",
]);
assert.throws(() => launchCodeBlockers({}, "createApplication"));
assert.throws(() => launchCodeBlockers({ ...registry, entries: [{ id: "x", path: "x", state: "DONE" }] }, "createApplication"));
const complete = { ...registry, entries: [{ id: "test", path: "test.ts", state: "IMPLEMENTED_NOT_LIVE" }] };
assert.deepEqual(launchCodeBlockers(complete, composition()), []);
// A complete method registry is insufficient while a mandatory product is disabled.
for (const slice of ["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "DRIVE_EXCHANGE", "ERASURE"]) {
  assert.deepEqual(launchCodeBlockers(complete, composition(JSON.stringify(slice))), [`disabled required slice: ${slice}`]);
}
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
const current = JSON.parse(await readFile(new URL("../docs/implementation/implementation-status.json", import.meta.url), "utf8"));
const drive = current.entries.find((entry) => entry.path === "packages/google-drive-exchange/src/reconciler.ts");
assert.ok(drive, "The normative Drive implementation must be explicitly inventoried");
if (drive.state === "IN_PROGRESS" || drive.state === "SCAFFOLD_FAIL_CLOSED") {
  assert.ok(launchCodeBlockers({ ...complete, entries: [drive] }, composition()).includes(`${drive.id}: ${drive.path}`));
}
await assert.rejects(assertLaunchCodeComplete(), /LIVE_DEPLOY_BLOCKED/);
const forbidden = () => assert.fail("unfinished code must fail before any command, credential readback or remote effect");
await assert.rejects(deployCloudflare({ confirmLive: true, environment: {}, execute: forbidden,
  captureCommand: forbidden, fetchImpl: forbidden, save: forbidden, archive: forbidden }), /LIVE_DEPLOY_BLOCKED/);
console.log("Launch guard: current unfinished product blocked before all release effects; no implicit live qualification.");
