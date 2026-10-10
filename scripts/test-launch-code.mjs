import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLaunchCodeComplete, launchCodeBlockers, readCompositionCapabilityProfile, readConfiguredTransport } from "./check-launch-code.mjs";
import { deployCloudflare } from "./deploy-cloudflare.mjs";
const requiredSlices = ["RETRIEVAL", "RESEARCH", "FEDERATION", "WIKI", "ERASURE"];
const composition = (slices = "", operations = "", partial = "", enabled) => {
  const active = enabled ?? requiredSlices.filter((slice) =>
    !slices.includes(JSON.stringify(slice)) && !partial.includes(JSON.stringify(slice)));
  return `function capabilities() { return { enabled_slices: ${JSON.stringify(active)},
    partial_slices: [${partial}], disabled_slices: [${slices}] }; }
    function createApplication() { return { capabilities }; } ${operations}`;
};
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
for (const slice of requiredSlices) {
  assert.deepEqual(launchCodeBlockers(complete, composition("", "const renamedRefusal = () => {};", JSON.stringify(slice))),
    [`partial required slice: ${slice}`], "partial product cannot pass after refusal helper is renamed");
  assert.deepEqual(launchCodeBlockers(complete, composition("", "", "", requiredSlices.filter((value) => value !== slice))),
    [`missing required slice: ${slice}`], "omitted mandatory product cannot pass a complete method registry");
}
assert.deepEqual(launchCodeBlockers(complete, composition("", "", '"OPTIONAL_EXPERIMENT"')), []);
assert.throws(() => launchCodeBlockers(complete, composition('"WIKI"', "", '"WIKI"')), /conflicting capability states/u);
assert.throws(() => launchCodeBlockers(complete, composition("", "", '"WIKI"', requiredSlices)), /conflicting capability states/u);
for (const input of [composition("", "", "...dynamic"), composition("", "", '"WIKI", "WIKI"'),
  composition().replace("partial_slices: []", "partial_slices: [], enabled_slices: []"),
  composition().replace("partial_slices: []", "partial_slices: compute()")]) {
  assert.throws(() => launchCodeBlockers(complete, input));
}
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
  composition() + 'function capabilities() { return { disabled_slices: [] }; }',
  'function createApplication() { invalid( {',
]) assert.throws(() => launchCodeBlockers(complete, input));
assert.throws(() => launchCodeBlockers(complete,
  'function createApplication() { return {}; } const stray = { enabled_slices: ' +
  JSON.stringify(requiredSlices) + ', partial_slices: [], disabled_slices: [] };'), /capability profile/u);
assert.deepEqual(launchCodeBlockers(complete,
  composition() + 'const unrelated = { enabled_slices: [], partial_slices: [], disabled_slices: ["WIKI"] };'), [],
  "unrelated partitions are not the capability profile");
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
assert.ok(capabilityProfile.routes.some((route) => route.path === "/api/v1/system/capabilities"));
assert.deepEqual(Object.keys(capabilityProfile.mandatory_handlers).sort(), ["federation", "owner", "semantic"]);
assert.deepEqual(capabilityProfile.mandatory_handlers.federation,
  ["cancel", "changes", "readBundle", "readBundleManifest", "result", "status", "submit"]);
assert.equal(capabilityProfile.federation_availability, "conditional-denial");
const compositionPath = resolve(repositoryRoot, "apps/eliotr-core/src/composition-root.ts");
const compositionText = sourceMap.get(compositionPath).replace(/\r\n/gu, "\n");
const missingFederationHandler = compositionText
  .replace('    changes: () => denied("federation.changes"),\n', "") +
  '\nconst operationNameOnly = "federation.changes";\n';
assert.notEqual(missingFederationHandler, compositionText, "missing federation handler fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, missingFederationHandler)),
  /Missing mandatory federation handlers: changes/u);
const assertedMissingHandler = compositionText.replace('changes: () => denied("federation.changes"),',
  'changes: undefined as unknown as FederationApi["changes"],');
assert.notEqual(assertedMissingHandler, compositionText, "asserted missing-handler fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, assertedMissingHandler)),
  /Missing mandatory federation handlers: changes/u);
const conditionalFederationHandler = compositionText.replace('changes: () => denied("federation.changes"),',
  'changes: Math.random() > 0 ? () => denied("federation.changes") : undefined as unknown as FederationApi["changes"],');
assert.notEqual(conditionalFederationHandler, compositionText, "conditional-handler fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, conditionalFederationHandler)),
  /Missing mandatory federation handlers: changes/u);
const factoryFallthrough = compositionText.replace('  return {\n    submit: () => denied("federation.submit"),',
  '  if (Math.random() > 0) return {\n    submit: () => denied("federation.submit"),');
assert.notEqual(factoryFallthrough, compositionText, "factory fallthrough fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, factoryFallthrough)),
  /factory has an uncovered or opaque return path/u);
const unclassifiedDenial = compositionText
  .replaceAll("denied", "renamedRefusal")
  .replace('"RESEARCH"],\n    partial_slices: ["WIKI", "FEDERATION"]',
    '"RESEARCH", "FEDERATION"],\n    partial_slices: ["WIKI"]');
assert.notEqual(unclassifiedDenial, compositionText, "conditional federation denial fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, unclassifiedDenial)),
  /Conditional federation denial must be classified in partial_slices/u);
const directRefusalAlias = compositionText
  .replace('  const denied = (operation: string): Promise<never> =>\n    Promise.reject(new CapabilityUnavailableError(operation));',
    '  const renamedRefusal = (): Promise<never> =>\n    Promise.reject(new CapabilityUnavailableError("federation.refused"));')
  .replaceAll(/\(\) => denied\("federation\.[^"]+"\)/gu, "renamedRefusal")
  .replace('"RESEARCH"],\n    partial_slices: ["WIKI", "FEDERATION"]',
    '"RESEARCH", "FEDERATION"],\n    partial_slices: ["WIKI"]');
assert.notEqual(directRefusalAlias, compositionText, "direct refusal alias fixture must change the source");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, directRefusalAlias)),
  /Conditional federation denial must be classified in partial_slices/u);
const disabledStart = compositionText.indexOf("function disabledFederationApi()");
const disabledEnd = compositionText.indexOf("function federationApi(", disabledStart);
assert.ok(disabledStart > 0 && disabledEnd > disabledStart);
const disabledSource = compositionText.slice(disabledStart, disabledEnd);
const disabledFixture = (replacement) => {
  assert.notEqual(replacement, disabledSource, "operation factory fixture must change the source");
  return compositionText.slice(0, disabledStart) + replacement + compositionText.slice(disabledEnd);
};
const frozenDisabled = disabledSource.replace("  return {", "  return Object.freeze({")
  .replace("  };\n}", "  });\n}");
assert.equal((await profileRead(new Map(sourceMap).set(compositionPath,
  disabledFixture(frozenDisabled)))).federation_availability, "conditional-denial",
"intrinsic Object.freeze preserves source handler composition");
for (const invalidFreeze of [
  frozenDisabled.replace("Object.freeze({", "Object?.freeze({"),
  frozenDisabled.replace("Object.freeze({", "Object.freeze?.({"),
  frozenDisabled.replace("  return Object.freeze", "  const Object = { freeze(value: unknown) { return value; } };\n  return Object.freeze"),
  frozenDisabled.replace("  return Object.freeze", "  const custom = { freeze(value: unknown) { return value; } };\n  return custom.freeze"),
  frozenDisabled.replace(/return Object\.freeze\(\{[\s\S]*?\}\);/u, "return Object.freeze();"),
  frozenDisabled.replace("  });\n}", "  }, {});\n}"),
  frozenDisabled.replace("return Object.freeze({", "return Object.freeze(...[{")
    .replace("  });\n}", "  }]);\n}"),
]) {
  await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, disabledFixture(invalidFreeze))),
    /Application handler factory is not a source function/u);
}
const castedShorthand = disabledSource.replace("  return {",
  '  const changes = undefined as unknown as FederationApi["changes"];\n  return {')
  .replace('changes: () => denied("federation.changes"),', "changes,");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, disabledFixture(castedShorthand))),
  /Missing mandatory federation handlers: changes/u);
const shorthandRefusal = disabledSource.replace("  return {",
  '  const changes = () => denied("federation.changes");\n  return {')
  .replace('changes: () => denied("federation.changes"),', "changes,");
assert.equal((await profileRead(new Map(sourceMap).set(compositionPath,
  disabledFixture(shorthandRefusal)))).federation_availability, "conditional-denial");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, disabledFixture(shorthandRefusal)
  .replace('"RESEARCH"],\n    partial_slices: ["WIKI", "FEDERATION"]',
    '"RESEARCH", "FEDERATION"],\n    partial_slices: ["WIKI"]'))),
  /Conditional federation denial must be classified in partial_slices/u);
const chainedShorthandRefusal = disabledSource.replace("  return {",
  '  const refusal = () => denied("federation.changes");\n  const alias = refusal;\n  const changes = alias;\n  return {')
  .replace('changes: () => denied("federation.changes"),', "changes,");
await assert.rejects(profileRead(new Map(sourceMap).set(compositionPath, disabledFixture(chainedShorthandRefusal)
  .replace('"RESEARCH"],\n    partial_slices: ["WIKI", "FEDERATION"]',
    '"RESEARCH", "FEDERATION"],\n    partial_slices: ["WIKI"]'))),
  /Conditional federation denial must be classified in partial_slices/u);
for (const expected of [
  { method: "GET", path: "/agents/research-session/:session_id", operation: "research.session.transport",
    auth: "owner", maximum_request_bytes: 0, response_mode: "stream" },
  { method: "GET", path: "/agents/research-session/:session_id/get-messages", operation: "research.session.transport",
    auth: "owner", maximum_request_bytes: 0, response_mode: "stream" },
  { method: "GET", path: "/api/v1/projects/:project_id/model-provider-key", operation: "project.provider-key-configuration.read",
    auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "POST", path: "/api/v1/projects/:project_id/model-provider-key", operation: "project.provider-key-configuration.create",
    auth: "owner", maximum_request_bytes: 8192, response_mode: "json" },
  { method: "POST", path: "/api/v1/projects/:project_id/model-provider-key/:key_operation_id/check-and-use",
    operation: "project.provider-key-model-use.start", auth: "owner", maximum_request_bytes: 2048, response_mode: "json" },
  { method: "GET", path: "/api/v1/projects/:project_id/model-provider-key/model-use/:operation_id",
    operation: "project.provider-key-model-use.read", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
  { method: "GET", path: "/api/v1/system/backup-primary/inventory", operation: "system.backup-primary.inventory",
    auth: "owner", maximum_request_bytes: 0, response_mode: "json" },
]) {
  assert.deepEqual(capabilityProfile.routes.find((route) => route.method === expected.method && route.path === expected.path), expected);
}
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
  // Input sealing has its own fixtures; this case isolates the unfinished-code gate.
  captureBuildInputs: async () => Object.freeze({ files: [] }),
  captureCommand: forbidden, fetchImpl: forbidden, save: forbidden, archive: forbidden }), /LIVE_DEPLOY_BLOCKED/);
console.log("Launch guard: current unfinished product blocked before all release effects; no implicit live qualification.");
