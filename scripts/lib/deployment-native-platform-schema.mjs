import { projectDeploymentCommentlessSql, SQL_COMMENTLESS_PROTOCOL } from "./deployment-native-sql-representation.mjs";

export const SUPPORTED_SCHEMA_MANIFEST_PROTOCOL = "eliotr.cloudflare-d1.application-schema-manifest.v2";
export const SUPPORTED_SCHEMA_PROVENANCE_PROTOCOL = "eliotr.cloudflare-d1.expected-schema-manifest-provenance.v3";
export const SUPPORTED_SCHEMA_ATTESTATION_PROTOCOL = "eliotr.cloudflare-d1.application-schema-attestation.v2";

// Closed DDL shapes extracted from the pinned vendor constructors, not from a
// deployed catalogue. A shape match never asserts the remote runtime version.
const profiles = Object.freeze({
  "workerd-source-local-bookmark-shape.v1": Object.freeze({
    type: "table", name: "_cf_METADATA", tbl_name: "_cf_METADATA",
    sql: "CREATE TABLE _cf_METADATA (\n        key INTEGER PRIMARY KEY,\n        value BLOB\n      )",
  }),
  "workerd-source-kv-shape.v1": Object.freeze({
    type: "table", name: "_cf_KV", tbl_name: "_cf_KV",
    sql: "CREATE TABLE _cf_KV (\n        key TEXT PRIMARY KEY,\n        value BLOB\n      ) WITHOUT ROWID",
  }),
});
export const SUPPORTED_SCHEMA_REPRESENTATION = Object.freeze({
  protocol: "eliotr.d1-source-schema-representation.v1",
  sql_protocol: SQL_COMMENTLESS_PROTOCOL,
  sql_variants: Object.freeze(["source_raw", "source_commentless"]),
  source_platform_profile: "workerd-source-local-bookmark-shape.v1",
  target_platform_profile: "workerd-source-kv-shape.v1",
  vendor_sources: Object.freeze([
    Object.freeze({ tag: "v1.20260926.1", path: "src/workerd/util/sqlite-kv.c++",
      source_sha256: "f4b97e4f68510df8a63c982eacc0a9de69c1ec92e5609bfc0676611de3e33fe6",
      constructor_sha256: "50f290394b1030cce72c25fab74245ffe8bc5c1c6f8beee9f02a2357baf3b785" }),
    Object.freeze({ tag: "v1.20260926.1", path: "src/workerd/util/sqlite-metadata.c++",
      source_sha256: "d2bb1f60b6956186f094b28452fdc7a09e8b29eff29c590f08b24139820dcd8c",
      constructor_sha256: "1aa368bab7513ad1903dc5e67efac4c234b37634cb1323247372ab56191ac005" }),
  ]),
});
const fail = message => { throw new Error("Supported D1 schema representation rejected: " + message); };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export function validateSupportedSchemaRepresentation(value) {
  if (!record(value) || canonical(value) !== canonical(SUPPORTED_SCHEMA_REPRESENTATION)) fail("unknown descriptor or vendor/profile pins");
  return true;
}
export function deploymentPlatformSchemaObject(profile) {
  if (!Object.hasOwn(profiles, profile)) fail("unknown platform profile");
  return { ...profiles[profile] };
}

// The caller first validates complete raw catalogue shape/sentinel. Retain it
// unchanged in the manifest/receipt. This returns a distinct comparison view.
export function projectSupportedDeploymentSchema(objects, representation, { observed = false } = {}) {
  validateSupportedSchemaRepresentation(representation);
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > 20_000) fail("invalid catalogue size");
  const profile = deploymentPlatformSchemaObject(observed ? representation.target_platform_profile : representation.source_platform_profile);
  const target = deploymentPlatformSchemaObject(representation.target_platform_profile);
  const result = [], seen = new Set();
  let platformCount = 0;
  for (const object of objects) {
    if (!record(object) || Object.keys(object).length !== 4 ||
        !["type", "name", "tbl_name", "sql"].every(key => typeof object[key] === "string") ||
        !["table", "index", "view", "trigger"].includes(object.type) ||
        !object.name || !object.tbl_name || !object.sql) fail("invalid raw schema object");
    const identity = object.type + "\0" + object.name.replace(/[A-Z]/gu, letter => letter.toLowerCase());
    if (seen.has(identity)) fail("duplicate raw object identity");
    seen.add(identity);
    if (/^_cf_/iu.test(object.name)) {
      if (canonical(object) !== canonical(profile) || ++platformCount !== 1) fail("unknown or changed platform object");
      result.push(target);
    } else {
      result.push({ ...object, sql: projectDeploymentCommentlessSql(object.sql).sql });
    }
  }
  if (platformCount !== 1) fail("required platform profile is absent");
  return result;
}

// Observation chooses no expectation. Its raw bytes must equal one of the two
// finite variants derived from the exact source object; arbitrary added or
// changed comments cannot enter the admitted set. Complete membership is exact.
export function matchSupportedDeploymentSchema(sourceObjects, observedObjects, representation) {
  const expected = projectSupportedDeploymentSchema(sourceObjects, representation);
  projectSupportedDeploymentSchema(observedObjects, representation, { observed: true });
  if (sourceObjects.length !== observedObjects.length) fail("catalogue membership differs");
  const observed = new Map(observedObjects.map(object => [object.type + "\0" + object.name, object]));
  for (let index = 0; index < sourceObjects.length; index += 1) {
    const source = sourceObjects[index], projected = expected[index];
    const actual = observed.get(projected.type + "\0" + projected.name);
    const platform = source.name === "_cf_METADATA";
    if (!actual || actual.tbl_name !== projected.tbl_name ||
        (actual.sql !== projected.sql && (platform || actual.sql !== source.sql))) fail("raw object is not a source-derived exact variant");
  }
  return expected;
}
