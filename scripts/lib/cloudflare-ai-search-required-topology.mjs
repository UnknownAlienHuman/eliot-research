import { readFileSync } from "node:fs";
import ts from "typescript";

// The producer and consumer in project-search.ts both select through
// PROJECT_SEARCH_INSTANCES. Read that declaration rather than maintaining a
// second instance registry. No module execution, Cloudflare calls or authority
// are involved; unsupported source shapes fail closed.

export const AI_SEARCH_TOPOLOGY_PROTOCOL = "eliotr.ai-search-required-topology.v1";
const MANIFEST_PROTOCOL = "eliotr.ai-search-generation.v1";
const MANIFEST_NAMESPACE = "eliotr";

export function parseRuntimeProjectSearchInstances(source) {
  if (typeof source !== "string") fail("runtime source must be text");
  const file = ts.createSourceFile("project-search.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length !== 0) fail("runtime source has syntax errors");
  const declarations = file.statements.filter(statement => ts.isVariableStatement(statement) &&
    statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
    (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "PROJECT_SEARCH_INSTANCES");
  if (declarations.length !== 1) fail("runtime must export exactly one PROJECT_SEARCH_INSTANCES constant");
  const initializer = declarations[0].initializer;
  if (!initializer || !ts.isCallExpression(initializer) || initializer.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      !ts.isIdentifier(initializer.expression.expression) || initializer.expression.expression.text !== "Object" ||
      initializer.expression.name.text !== "freeze") fail("runtime instance mapping must be Object.freeze of a literal");
  const argument = initializer.arguments[0];
  const literal = ts.isAsExpression(argument) ? argument.expression : argument;
  if (!ts.isObjectLiteralExpression(literal)) fail("runtime instance mapping must be a literal");
  const lanes = new Map();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
        !ts.isStringLiteral(property.initializer) || property.initializer.text.length === 0) {
      fail("runtime lanes must have literal names and non-empty instance ids");
    }
    const lane = property.name.text;
    if (lanes.has(lane)) fail("runtime declares a duplicate lane " + lane);
    lanes.set(lane, property.initializer.text);
  }
  if (!lanes.has("prose") || !lanes.has("literal")) fail("runtime must declare both prose and literal lanes");
  return Object.freeze(Object.fromEntries(lanes));
}

export const RUNTIME_SELECTED_INSTANCE_IDS = Object.freeze([...new Set(Object.values(
  parseRuntimeProjectSearchInstances(readFileSync(new URL("../../packages/cloudflare-ai/src/project-search.ts", import.meta.url), "utf8")),
))]);

function fail(message) {
  const error = new Error("AI Search required topology: " + message);
  error.code = "AI_SEARCH_REQUIRED_TOPOLOGY_INVALID";
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify a desired-state manifest into runtime-required and deferred
 * instance ids against the source-derived runtime mapping. No network or writes.
 * Throws a typed error when the manifest is not the exact committed shape.
 */
export function classifyAiSearchRequiredTopology(manifest) {
  if (!isObject(manifest)) fail("manifest must be an object");
  if (manifest.protocol !== MANIFEST_PROTOCOL) {
    fail("manifest protocol must be " + MANIFEST_PROTOCOL);
  }
  if (manifest.namespace !== MANIFEST_NAMESPACE) {
    fail("manifest namespace must be " + MANIFEST_NAMESPACE);
  }
  if (!Array.isArray(manifest.instances) || manifest.instances.length === 0) {
    fail("manifest must declare at least one instance");
  }
  const seen = Object.create(null);
  for (const entry of manifest.instances) {
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id === "") {
      fail("manifest instance entries must carry a non-empty string id");
    }
    if (seen[entry.id] === true) {
      fail("manifest declares duplicate instance id " + entry.id);
    }
    seen[entry.id] = true;
  }
  for (const id of RUNTIME_SELECTED_INSTANCE_IDS) {
    if (seen[id] !== true) fail("manifest is missing the runtime-selected instance " + id);
  }
  const required = [];
  const deferred = [];
  for (const entry of manifest.instances) {
    if (RUNTIME_SELECTED_INSTANCE_IDS.includes(entry.id)) required[required.length] = entry.id;
    else deferred[deferred.length] = entry.id;
  }
  return Object.freeze({
    protocol: AI_SEARCH_TOPOLOGY_PROTOCOL,
    namespace: manifest.namespace,
    generation: typeof manifest.generation === "string" ? manifest.generation : null,
    runtime_selected_instance_ids: RUNTIME_SELECTED_INSTANCE_IDS,
    required: Object.freeze(required),
    deferred: Object.freeze(deferred),
  });
}

/** Shared instance ids selected by the actual producer and consumer. */
export function runtimeSelectedInstanceIds() {
  return RUNTIME_SELECTED_INSTANCE_IDS;
}

/**
 * Split observed provider instance ids against a topology. Absent deferred
 * instances are never reported, so a dormant profile never blocks a release.
 * Foreign ids are reported as drift without implying deletion.
 */
export function partitionObservedInstances(topology, observedIds) {
  if (!isObject(topology) || !Array.isArray(topology.required) || !Array.isArray(topology.deferred)) {
    fail("topology must be the result of classifyAiSearchRequiredTopology");
  }
  if (!Array.isArray(observedIds)) fail("observed ids must be an array");
  const deferredSet = Object.create(null);
  for (const id of topology.deferred) deferredSet[id] = true;
  const requiredSet = Object.create(null);
  for (const id of topology.required) requiredSet[id] = true;
  const observed = Object.create(null);
  for (const id of observedIds) {
    if (typeof id !== "string" || id === "") fail("observed ids must be non-empty strings");
    if (observed[id] === true) fail("provider reported duplicate instance id " + id);
    observed[id] = true;
  }
  const presentRequired = [];
  const missingRequired = [];
  for (const id of topology.required) {
    if (observed[id] === true) presentRequired[presentRequired.length] = id;
    else missingRequired[missingRequired.length] = id;
  }
  const presentDeferred = [];
  const foreign = [];
  for (const id of observedIds) {
    if (deferredSet[id] === true) presentDeferred[presentDeferred.length] = id;
    else if (requiredSet[id] !== true) foreign[foreign.length] = id;
  }
  return Object.freeze({
    present_required: Object.freeze(presentRequired),
    missing_required: Object.freeze(missingRequired),
    present_deferred: Object.freeze(presentDeferred),
    foreign: Object.freeze(foreign),
  });
}
