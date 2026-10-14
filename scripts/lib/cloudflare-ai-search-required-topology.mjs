// AI Search required topology: which manifest instances the assembled
// runtime actually selects, and which are deferred design records.
//
// Official Cloudflare limits (developers.cloudflare.com/ai-search/platform/
// limits-pricing/, page "Last updated Oct 1, 2026") allow 100 AI Search
// instances per account on Workers Free and 5,000 on Workers Paid. The
// instance ceiling is therefore never a reason to create four unconnected
// profiles in advance. This module separates the runtime required topology
// from dormant profiles so check-only, verify-existing and apply paths never
// fail on a resource whose projection producer, query consumer and named
// instance do not exist yet.
//
// A required instance has four assembled facts: a projection delivery
// producer, a runtime-read consumer, a named primary instance in compiled
// source, and a query selection rule. The assembled product selects exactly
// one instance today; every other manifest entry is a deferred design record
// and stays recorded intent, never deleted and never provisioned by this
// classification alone.
//
// This module never contacts Cloudflare, never mints authority and never
// authorizes a mutation. It only classifies the committed manifest.

export const AI_SEARCH_TOPOLOGY_PROTOCOL = "eliotr.ai-search-required-topology.v1";
const MANIFEST_PROTOCOL = "eliotr.ai-search-generation.v1";
const MANIFEST_NAMESPACE = "eliotr";

// The single instance the assembled runtime selects today. The authoritative
// binding lives in packages/cloudflare-projection/src/ai-search-primary-profile.ts
// as AI_SEARCH_PRIMARY_INSTANCE_ID; this module classifies the manifest and must
// stay exactly aligned with that compiled constant.
export const RUNTIME_SELECTED_INSTANCE_ID = "private-prose-g2";

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
 * instance ids. Pure: no ambient state, no clock, no network, no I/O.
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
  if (seen[RUNTIME_SELECTED_INSTANCE_ID] !== true) {
    fail("manifest is missing the runtime-selected instance " + RUNTIME_SELECTED_INSTANCE_ID);
  }
  const required = [];
  const deferred = [];
  for (const entry of manifest.instances) {
    if (entry.id === RUNTIME_SELECTED_INSTANCE_ID) required[required.length] = entry.id;
    else deferred[deferred.length] = entry.id;
  }
  return Object.freeze({
    protocol: AI_SEARCH_TOPOLOGY_PROTOCOL,
    namespace: manifest.namespace,
    generation: typeof manifest.generation === "string" ? manifest.generation : null,
    runtime_selected_instance_id: RUNTIME_SELECTED_INSTANCE_ID,
    required: Object.freeze(required),
    deferred: Object.freeze(deferred),
  });
}

/** The instance id the assembled runtime selects today. */
export function runtimeSelectedInstanceId() {
  return RUNTIME_SELECTED_INSTANCE_ID;
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
