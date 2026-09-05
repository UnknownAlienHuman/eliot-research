import assert from "node:assert/strict";
import { assertLaunchCodeComplete, launchCodeBlockers } from "./check-launch-code.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
const registry = { protocol: "eliotr.implementation-status.v1", entries: [
  { id: "workflow", path: "apps/workflow.ts", state: "SCAFFOLD_FAIL_CLOSED" },
  { id: "session", path: "apps/session.ts", state: "IN_PROGRESS" },
] };
assert.deepEqual(launchCodeBlockers(registry, 'createApplication; return unavailable("research.query");'), [
  "research.query", "session: apps/session.ts", "workflow: apps/workflow.ts",
]);
assert.throws(() => launchCodeBlockers({}, "createApplication"));
assert.throws(() => launchCodeBlockers({ ...registry, entries: [{ id: "x", path: "x", state: "DONE" }] }, "createApplication"));
const complete = { ...registry, entries: [{ id: "test", path: "test.ts", state: "IMPLEMENTED_NOT_LIVE" }] };
assert.deepEqual(launchCodeBlockers(complete, "createApplication; composedService();"), []);
await assert.rejects(assertLaunchCodeComplete(), /LIVE_DEPLOY_BLOCKED/);
const forbidden = () => assert.fail("unfinished code must fail before any command, credential readback or remote effect");
await assert.rejects(deployCloudflare({ confirmLive: true, environment: {}, execute: forbidden,
  captureCommand: forbidden, fetchImpl: forbidden, save: forbidden, archive: forbidden }), /LIVE_DEPLOY_BLOCKED/);
console.log("Launch guard: current unfinished product blocked before all release effects; no implicit live qualification.");
