import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const RESEARCH_RUNTIME_CONFIGURATION_KEYS = Object.freeze([
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
  "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
  "ELIOTR_MODEL_SPEND_POLICY_JSON",
  "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
  "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
  "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
  "ELIOTR_WORKSPACE_OWNER_BINDINGS_JSON",
  "ELIOTR_NAMESPACE_BOOTSTRAP_PROFILES_JSON",
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF",
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256",
]);
export const RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON";
export const RESEARCH_RUNTIME_SEMANTIC_CONFIG_REF_KEY = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF";
export const RESEARCH_RUNTIME_SEMANTIC_CONFIG_SHA256_KEY = "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256";
export const RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_CHUNK_KEYS = Object.freeze([
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0",
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1",
]);
/** Every Worker var the semantic configuration can travel as; never forwarded generically. */
export const RESEARCH_RUNTIME_SEMANTIC_TRANSPORT_KEYS = Object.freeze([
  RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY,
  ...RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_CHUNK_KEYS,
  RESEARCH_RUNTIME_SEMANTIC_CONFIG_REF_KEY,
  RESEARCH_RUNTIME_SEMANTIC_CONFIG_SHA256_KEY,
]);
export const RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES = 4_000;
export const RESEARCH_RUNTIME_SEMANTIC_MAX_TRANSPORT_BYTES =
  RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES * RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_CHUNK_KEYS.length;
const allowed = new Set(RESEARCH_RUNTIME_CONFIGURATION_KEYS);
const required = RESEARCH_RUNTIME_CONFIGURATION_KEYS.slice(0, 7);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (label) => { throw new Error(`Research runtime configuration is invalid (${label})`); };

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  return value;
}
function serialized(key, value) {
  if (key.endsWith("_JSON")) {
    let parsed = value;
    if (typeof value === "string") {
      try { parsed = JSON.parse(value); } catch { invalid(key); }
    }
    if (!object(parsed)) invalid(key);
    const result = JSON.stringify(ordered(parsed));
    if (Buffer.byteLength(result) > 65536) invalid(key);
    return result;
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) invalid(key);
  return value;
}

/**
 * Canonical semantic configuration bytes: the exact bytes whose SHA-256
 * identifies the immutable revision. Shared by the migration script and the
 * revision store so the operator-computed digest always matches the stored
 * bytes.
 */
export function canonicalResearchSemanticConfiguration(value) {
  return serialized(RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY, value);
}

/**
 * Encode one canonical semantic configuration into the two bounded Wrangler
 * text vars. The installed runtime envelope remains the single canonical JSON
 * object; these chunks are only a deployment transport representation.
 */
export function splitResearchSemanticConfiguration(value) {
  const canonical = serialized(RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY, value);
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength === 0 || bytes.byteLength > RESEARCH_RUNTIME_SEMANTIC_MAX_TRANSPORT_BYTES) {
    invalid("semantic configuration transport size");
  }

  let boundary = bytes.byteLength;
  if (bytes.byteLength > RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES) {
    // Choose a UTF-8 boundary that leaves both chunks within the limit. A
    // malformed multibyte boundary is rejected rather than repaired.
    const minimumFirstBytes = bytes.byteLength - RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES;
    boundary = RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES;
    while (boundary > minimumFirstBytes && (bytes[boundary] & 0xc0) === 0x80) boundary -= 1;
    if (boundary < minimumFirstBytes || (bytes[boundary] & 0xc0) === 0x80) {
      invalid("semantic configuration UTF-8 chunk boundary");
    }
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const first = decoder.decode(bytes.slice(0, boundary));
  const second = decoder.decode(bytes.slice(boundary));
  if (new TextEncoder().encode(first).byteLength > RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES ||
      new TextEncoder().encode(second).byteLength > RESEARCH_RUNTIME_SEMANTIC_CHUNK_BYTES ||
      first + second !== canonical) {
    invalid("semantic configuration chunks");
  }
  return Object.freeze({
    [RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_CHUNK_KEYS[0]]: first,
    [RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_CHUNK_KEYS[1]]: second,
  });
}

/**
 * Choose the Worker transport for the semantic configuration. A migrated
 * envelope carries the immutable revision identity (ref + digest) and the
 * revision wins deliberately: no chunk vars are emitted, so the Worker can
 * never see mixed sources. Otherwise the legacy JSON is split into the
 * bounded chunk vars as before.
 */
export function semanticConfigurationTransport(environment) {
  const ref = environment[RESEARCH_RUNTIME_SEMANTIC_CONFIG_REF_KEY];
  const digest = environment[RESEARCH_RUNTIME_SEMANTIC_CONFIG_SHA256_KEY];
  if (typeof ref === "string" && typeof digest === "string") {
    return Object.freeze({ kind: "revision",
      vars: Object.freeze({
        [RESEARCH_RUNTIME_SEMANTIC_CONFIG_REF_KEY]: ref,
        [RESEARCH_RUNTIME_SEMANTIC_CONFIG_SHA256_KEY]: digest,
      }) });
  }
  const json = environment[RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY];
  if (typeof json === "string") {
    return Object.freeze({ kind: "legacy", vars: splitResearchSemanticConfiguration(json) });
  }
  return Object.freeze({ kind: "absent", vars: Object.freeze({}) });
}

/** Explicit installed settings only. This loader neither chooses models nor grants approval. */
export async function loadResearchRuntimeEnvironment(environment, root) {
  const requested = environment.ELIOTR_RESEARCH_CONFIG_FILE;
  if (requested !== undefined && (typeof requested !== "string" || requested.trim() === "")) invalid("file path");
  const path = resolve(root, requested ?? ".eliotr-state/research-runtime.json");
  let raw;
  try {
    if ((await stat(path)).size > 1024 * 1024) invalid("file size");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && requested === undefined) return { ...environment };
    if (error.code === "ENOENT") invalid("configured file is missing");
    throw error;
  }
  if (Buffer.byteLength(raw) > 1024 * 1024) invalid("file size");
  let config;
  try { config = JSON.parse(raw); } catch { invalid("JSON"); }
  if (!object(config) || Object.keys(config).length !== 2 ||
      config.protocol !== "eliotr.research-runtime.v1" || !object(config.vars)) invalid("protocol");
  if (Object.keys(config.vars).some((key) => !allowed.has(key))) invalid("unknown variable");
  if (Object.keys(config.vars).length === 0) invalid("no configuration supplied");
  // The semantic configuration is satisfied by the legacy JSON or, after the
  // S29 migration, by the immutable revision identity (ref + digest).
  const semanticPresent = Object.hasOwn(config.vars, RESEARCH_RUNTIME_SEMANTIC_CONFIGURATION_KEY) ||
    (Object.hasOwn(config.vars, RESEARCH_RUNTIME_SEMANTIC_CONFIG_REF_KEY) &&
      Object.hasOwn(config.vars, RESEARCH_RUNTIME_SEMANTIC_CONFIG_SHA256_KEY));
  const restRequired = required.slice(1);
  if ((semanticPresent || restRequired.some((key) => Object.hasOwn(config.vars, key))) &&
      (!semanticPresent || restRequired.some((key) => !Object.hasOwn(config.vars, key)))) {
    invalid("incomplete model configuration");
  }
  const result = { ...environment };
  for (const [key, value] of Object.entries(config.vars)) {
    const text = serialized(key, value);
    if (Object.hasOwn(environment, key) && serialized(key, environment[key]) !== text) invalid(`conflicting environment ${key}`);
    result[key] = text;
  }
  return result;
}
